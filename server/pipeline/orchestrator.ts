import { all, get, run, jsonOrNull } from "../db.ts";
import { emitScanEvent } from "../lib/events.ts";
import { sha256, hashAuthor, nowSec } from "../lib/text.ts";
import { nearDuplicateIndexes } from "../lib/dedupe.ts";
import { getSettings } from "../settings.ts";
import { CONNECTORS, connectorById, DEPTH_BUDGETS } from "../connectors/index.ts";
import type { HarvestContext, RawItem, SourceId } from "../connectors/types.ts";
import { buildPlan } from "./plan.ts";
import { extractProblems } from "./extract.ts";
import { clusterProblems } from "./cluster.ts";
import { validateClusters } from "./validate.ts";
import { synthesizeBriefs } from "./synthesize.ts";
import { runTrendScout } from "./trendscout.ts";
import type { QueryPlan } from "../ai/schemas.ts";

const controllers = new Map<number, AbortController>();

export function isRunning(scanId: number): boolean {
  return controllers.has(scanId);
}

export function cancelScan(scanId: number): boolean {
  const controller = controllers.get(scanId);
  if (!controller) return false;
  controller.abort();
  return true;
}

interface ScanRow {
  id: number;
  topic: string | null;
  mode: string;
  depth: string;
  sources_json: string;
  status: string;
  plan_json: string | null;
}

function setStage(scanId: number, stage: string): void {
  run("UPDATE scans SET stage=? WHERE id=?", stage, scanId);
  emitScanEvent(scanId, "stage", stage);
}

function updateProgress(scanId: number, patch: Record<string, unknown>): void {
  const row = get<{ progress_json: string | null }>(
    "SELECT progress_json FROM scans WHERE id=?",
    scanId
  );
  const progress = { ...(jsonOrNull<Record<string, unknown>>(row?.progress_json ?? null) ?? {}), ...patch };
  run("UPDATE scans SET progress_json=? WHERE id=?", JSON.stringify(progress), scanId);
  emitScanEvent(scanId, "progress", "progress", progress);
}

async function harvest(
  scan: ScanRow,
  plan: QueryPlan,
  signal: AbortSignal,
  log: (msg: string, type?: "log" | "warn") => void
): Promise<number> {
  const settings = getSettings();
  const requestedIds = (jsonOrNull<SourceId[]>(scan.sources_json) ?? []).filter((id) =>
    connectorById.has(id)
  );
  const wanted = (requestedIds.length ? requestedIds : CONNECTORS.map((c) => c.id)).map(
    (id) => connectorById.get(id)!
  );
  const enabled = wanted.filter((c) => c.status(settings) === "ready");
  const skipped = wanted.filter((c) => c.status(settings) !== "ready").map((c) => c.id);

  const budget = DEPTH_BUDGETS[scan.depth] ?? DEPTH_BUDGETS.standard!;
  const totalWeight = enabled.reduce((s, c) => s + c.weight, 0) || 1;
  const bySource: Record<string, number> = {};
  const statusBySource: Record<string, "ok" | "empty" | "crashed"> = {};
  for (const c of enabled) bySource[c.id] = 0;
  updateProgress(scan.id, { bySource });

  await Promise.allSettled(
    enabled.map(async (connector) => {
      const limit = Math.max(10, Math.ceil((budget * connector.weight) / totalWeight));
      const ctx: HarvestContext = {
        topic: scan.topic,
        plan,
        limit,
        settings,
        signal,
        log: (msg, type) => emitScanEvent(scan.id, type ?? "log", msg),
      };
      try {
        const items = await connector.harvest(ctx);
        let inserted = 0;
        for (const item of items) {
          if (insertItem(scan.id, item)) inserted++;
        }
        bySource[connector.id] = inserted;
        statusBySource[connector.id] = inserted > 0 ? "ok" : "empty";
        updateProgress(scan.id, { bySource });
      } catch (err) {
        statusBySource[connector.id] = "crashed";
        if (!signal.aborted) {
          log(`${connector.id}: harvest crashed (${err instanceof Error ? err.message : err})`, "warn");
        }
      }
    })
  );

  // ---- source-health summary: a validation is only as good as its coverage ----
  const delivered = Object.values(statusBySource).filter((s) => s === "ok").length;
  const issues = [
    ...Object.entries(statusBySource)
      .filter(([, s]) => s !== "ok")
      .map(([id, s]) => `${id}: ${s === "empty" ? "0 items" : "failed"}`),
    ...skipped.map((id) => `${id}: no API key`),
  ];
  const sourceHealth = { requested: wanted.length, delivered, issues };
  updateProgress(scan.id, { sourceHealth });
  log(
    `source health: ${delivered}/${wanted.length} sources delivered${issues.length ? ` (${issues.join(" · ")})` : ""}`,
    delivered < Math.ceil(wanted.length / 2) ? "warn" : "log"
  );

  // Near-duplicate removal (crossposts, mirrored complaints) — keep the higher-engagement copy.
  // Paid-intent hiring posts are exempt: similar wording across job posts is normal,
  // and each post is an independent buyer.
  const rows = all<{ id: number; title: string; body: string }>(
    "SELECT id, title, body FROM items WHERE scan_id=? AND (meta_json IS NULL OR (meta_json NOT LIKE '%\"kind\":\"market\"%' AND meta_json NOT LIKE '%\"kind\":\"paid-intent\"%')) ORDER BY (score+comments) DESC",
    scan.id
  );
  const dupes = nearDuplicateIndexes(rows.map((r) => `${r.title} ${r.body}`));
  if (dupes.size > 0) {
    for (const idx of dupes) run("DELETE FROM items WHERE id=?", rows[idx]!.id);
    log(`deduplicated ${dupes.size} near-identical items`);
  }

  const count = get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE scan_id=?", scan.id)?.n ?? 0;
  return count;
}

function insertItem(scanId: number, item: RawItem): boolean {
  const hash = sha256(`${item.source}:${item.externalId}`);
  const { changes } = run(
    `INSERT OR IGNORE INTO items (scan_id, source, external_id, url, title, body, author_hash, score, comments, views, created_utc, meta_json, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    scanId,
    item.source,
    item.externalId,
    item.url,
    item.title,
    item.body,
    hashAuthor(item.source, item.author),
    Math.max(0, Math.round(item.score)),
    Math.max(0, Math.round(item.comments)),
    item.views ?? null,
    item.createdUtc,
    item.meta ? JSON.stringify(item.meta) : null,
    hash
  );
  return changes > 0;
}

async function runPipeline(scanId: number, fromStage: "plan" | "extract"): Promise<void> {
  const controller = new AbortController();
  controllers.set(scanId, controller);
  const signal = controller.signal;
  const log = (msg: string, type: "log" | "warn" = "log") => emitScanEvent(scanId, type, msg);

  try {
    const scan = get<ScanRow>("SELECT * FROM scans WHERE id=?", scanId);
    if (!scan) throw new Error(`scan ${scanId} not found`);

    // Trend scans run their own scout→classify→rank→report pipeline —
    // no pain extraction, no demand gate (momentum evidence only).
    if (scan.mode === "trends") {
      if (fromStage !== "plan") throw new Error("trend scans cannot be re-analyzed — run a fresh scout");
      const summary = await runTrendScout(scan, {
        signal,
        log,
        setStage: (st) => setStage(scanId, st),
        updateProgress: (p) => updateProgress(scanId, p),
      });
      setStage(scanId, "done");
      run("UPDATE scans SET status='done', finished_at=? WHERE id=?", nowSec(), scanId);
      emitScanEvent(scanId, "done", "trend scout complete", summary);
      return;
    }

    const settings = getSettings();
    let itemCount = 0;

    if (fromStage === "plan") {
      // ---- 1. plan ----
      setStage(scanId, "plan");
      const { plan, engine } = await buildPlan(scan.topic, settings, signal, log);
      run("UPDATE scans SET plan_json=?, ai_mode=? WHERE id=?", JSON.stringify(plan), engine === "ai" ? "ai" : engine === "pack" ? "ai" : "heuristic", scanId);

      // ---- 2. harvest ----
      setStage(scanId, "harvest");
      itemCount = await harvest(scan, plan, signal, log);
      log(`harvest complete: ${itemCount} unique items`);
      updateProgress(scanId, { items: itemCount });
      if (itemCount === 0) throw new Error("no items harvested — try different sources or topic phrasing");
    } else {
      // re-analyze path: wipe derived data, keep items
      run("DELETE FROM problems WHERE scan_id=?", scanId);
      run("DELETE FROM clusters WHERE scan_id=?", scanId);
      run("DELETE FROM opportunities WHERE scan_id=?", scanId);
      itemCount = get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE scan_id=?", scanId)?.n ?? 0;
      log(`re-analyzing ${itemCount} stored items with current engine settings`);
    }

    // ---- 3. extract ----
    setStage(scanId, "extract");
    const extractRes = await extractProblems(scanId, scan.topic, settings, signal, log, (done, total, problems) =>
      updateProgress(scanId, { extractBatch: { done, total }, problems })
    );
    if (extractRes.engine !== "ai") {
      run("UPDATE scans SET ai_mode=? WHERE id=?", extractRes.engine === "mixed" ? "mixed" : "heuristic", scanId);
    }
    updateProgress(scanId, { problems: extractRes.problems });

    // ---- 4. cluster ----
    setStage(scanId, "cluster");
    const clusterRes = await clusterProblems(scanId, scan.topic, settings, signal, log);
    updateProgress(scanId, { clusters: clusterRes.clusters });

    // ---- 5. validate ----
    setStage(scanId, "validate");
    const validateRes = await validateClusters(scanId, settings, signal, log, (judged, toJudge) =>
      updateProgress(scanId, { judge: { done: judged, total: toJudge } })
    );
    updateProgress(scanId, { validated: validateRes.validated });

    // ---- 6. synthesize ----
    setStage(scanId, "synthesize");
    const briefRes = await synthesizeBriefs(scanId, settings, signal, log, (done, total) =>
      updateProgress(scanId, { briefs: { done, total } })
    );

    // ---- done ----
    setStage(scanId, "done");
    run("UPDATE scans SET status='done', finished_at=? WHERE id=?", nowSec(), scanId);
    const summary = {
      items: itemCount,
      problems: extractRes.problems,
      clusters: clusterRes.clusters,
      validated: validateRes.validated,
      briefs: briefRes.briefs,
    };
    emitScanEvent(scanId, "done", "scan complete", summary);
  } catch (err) {
    const aborted = controller.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    if (aborted) {
      run("UPDATE scans SET status='cancelled', finished_at=? WHERE id=?", nowSec(), scanId);
      emitScanEvent(scanId, "error", "scan cancelled");
    } else {
      run("UPDATE scans SET status='error', error=?, finished_at=? WHERE id=?", message, nowSec(), scanId);
      emitScanEvent(scanId, "error", message);
    }
  } finally {
    controllers.delete(scanId);
  }
}

export function startScan(scanId: number): void {
  void runPipeline(scanId, "plan");
}

export function startReanalyze(scanId: number): void {
  run("UPDATE scans SET status='running', error=NULL, finished_at=NULL, ai_mode='ai' WHERE id=?", scanId);
  void runPipeline(scanId, "extract");
}
