import "./lib/env.ts";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT, env } from "./lib/env.ts";
import { all, get, run, jsonOrNull, closeDatabase } from "./db.ts";
import {
  getSettings,
  updateSettings,
  publicSettings,
  pipelineConfigSnapshot,
  SettingsValidationError,
  type Effort,
} from "./settings.ts";
import { codexHealth } from "./ai/codex.ts";
import { codexJson } from "./ai/codex.ts";
import { askPrompt, type AskEvidenceInput } from "./ai/prompts.ts";
import { ZAsk, JAsk } from "./ai/schemas.ts";
import { CONNECTORS } from "./connectors/index.ts";
import {
  startScan,
  startReanalyze,
  cloneForReanalysis,
  cancelScan,
  cancelAllScans,
  runningScanCount,
  isRunning,
} from "./pipeline/orchestrator.ts";
import { generateBrief, DuplicateOpportunityError } from "./pipeline/synthesize.ts";
import { generateTrendAngles } from "./pipeline/trendscout.ts";
import { onScanEvent } from "./lib/events.ts";
import { nowSec, truncate } from "./lib/text.ts";
import { selectDiverseEvidence } from "./lib/evidence.ts";

// ---- restart recovery: in-process scans die with the process — say so honestly ----
const orphaned = run(
  "UPDATE scans SET status='error', error='interrupted by server restart — use Re-analyze to create a safe child run from stored items', finished_at=? WHERE status='running'",
  nowSec()
);
if (orphaned.changes > 0) {
  console.log(`recovery: marked ${orphaned.changes} orphaned running scan(s) as interrupted`);
}

const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

await app.register(helmet, {
  crossOriginEmbedderPolicy: false,
  frameguard: { action: "deny" },
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
});

// ---------------- health & meta ----------------

app.get("/api/health", async () => {
  const s = getSettings();
  return { ok: true, name: "Lodestone", version: "0.1.0", aiEnabled: s.ai.enabled, model: s.ai.model };
});

app.get("/api/sources", async () => {
  const s = getSettings();
  return CONNECTORS.map((c) => ({ id: c.id, label: c.label, weight: c.weight, status: c.status(s) }));
});

app.get("/api/stats", async () => {
  const counts = {
    scans: get<{ n: number }>("SELECT COUNT(*) AS n FROM scans")?.n ?? 0,
    items: get<{ n: number }>("SELECT COUNT(*) AS n FROM items")?.n ?? 0,
    problems: get<{ n: number }>("SELECT COUNT(*) AS n FROM problems")?.n ?? 0,
    validated: get<{ n: number }>("SELECT COUNT(*) AS n FROM clusters WHERE validated=1")?.n ?? 0,
    opportunities: get<{ n: number }>("SELECT COUNT(*) AS n FROM opportunities")?.n ?? 0,
  };
  const recentScans = all(
    `SELECT s.*,
       (SELECT COUNT(*) FROM items WHERE scan_id=s.id) AS item_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id AND validated=1) AS validated_count,
       (SELECT COUNT(*) FROM opportunities WHERE scan_id=s.id) AS brief_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id) AS trend_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id AND status='surging') AS surging_count
     FROM scans s ORDER BY s.created_at DESC LIMIT 6`
  );
  const topClusters = all(
    `SELECT c.*, s.topic AS scan_topic FROM clusters c JOIN scans s ON s.id=c.scan_id
     WHERE c.validated=1 ORDER BY c.demand_score DESC LIMIT 6`
  );
  const topOpportunities = all(
    `SELECT o.id, o.title, o.one_liner, o.cluster_id, o.scan_id, o.created_at, c.demand_score, c.tier,
            c.distinct_authors
     FROM opportunities o JOIN clusters c ON c.id=o.cluster_id ORDER BY c.demand_score DESC LIMIT 6`
  );
  return { counts, recentScans, topClusters, topOpportunities };
});

// ---------------- scans ----------------

const PAIN_SOURCE_IDS = CONNECTORS.map((connector) => connector.id);
const TREND_SOURCE_IDS = ["github", "hn", "producthunt", "gtrends", "twitter"] as const;
const ZCreateScan = z
  .object({
    topic: z.string().trim().max(200).optional(),
    mode: z.enum(["topic", "discovery", "trends"]).default("topic"),
    depth: z.enum(["quick", "standard", "deep"]).default("standard"),
    sources: z.array(z.string().min(1)).max(20).optional(),
  })
  .strict();

app.post("/api/scans", async (req, reply) => {
  const parsed = ZCreateScan.safeParse(req.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.issues.map((issue) => issue.message).join("; ") });
  }
  const body = parsed.data;
  const mode = body.mode;
  // Trend scans take an OPTIONAL focus ("AI", "health") — empty means full sweep.
  const topic = mode === "discovery" ? null : (body.topic ?? "").trim() || null;
  if (mode === "topic" && (!topic || topic.length < 3)) {
    return reply.code(400).send({ error: "topic must be at least 3 characters (or use discovery mode)" });
  }
  const allowed = new Set<string>(mode === "trends" ? TREND_SOURCE_IDS : PAIN_SOURCE_IDS);
  const defaultSources = mode === "trends" ? [...TREND_SOURCE_IDS] : [...PAIN_SOURCE_IDS];
  const sources = body.sources ?? defaultSources;
  if (sources.length === 0) return reply.code(400).send({ error: "select at least one source" });
  if (new Set(sources).size !== sources.length || sources.some((source) => !allowed.has(source))) {
    return reply.code(400).send({ error: "sources contain duplicates or IDs invalid for this scan mode" });
  }
  if (mode !== "trends" && !sources.some((source) => source !== "producthunt" && source !== "g2")) {
    return reply.code(400).send({ error: "select at least one pain-evidence source (Product Hunt and G2 are context only)" });
  }
  const { lastId } = run(
    `INSERT INTO scans
     (topic, mode, depth, sources_json, status, stage, created_at, config_json, pipeline_version)
     VALUES (?, ?, ?, ?, 'running', 'plan', ?, ?, 2)`,
    topic,
    mode,
    body.depth,
    JSON.stringify(sources),
    nowSec(),
    JSON.stringify(pipelineConfigSnapshot())
  );
  startScan(lastId);
  return get("SELECT * FROM scans WHERE id=?", lastId);
});

app.get("/api/scans", async () => {
  return all(
    `SELECT s.*,
       (SELECT COUNT(*) FROM items WHERE scan_id=s.id) AS item_count,
       (SELECT COUNT(*) FROM problems WHERE scan_id=s.id) AS problem_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id) AS cluster_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id AND validated=1) AS validated_count,
       (SELECT COUNT(*) FROM opportunities WHERE scan_id=s.id) AS brief_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id) AS trend_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id AND status='surging') AS surging_count
     FROM scans s ORDER BY s.created_at DESC`
  );
});

app.get("/api/scans/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const scan = get(
    `SELECT s.*,
       (SELECT COUNT(*) FROM items WHERE scan_id=s.id) AS item_count,
       (SELECT COUNT(*) FROM problems WHERE scan_id=s.id) AS problem_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id) AS cluster_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id AND validated=1) AS validated_count,
       (SELECT COUNT(*) FROM opportunities WHERE scan_id=s.id) AS brief_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id) AS trend_count
     FROM scans s WHERE s.id=?`,
    id
  );
  if (!scan) return reply.code(404).send({ error: "scan not found" });
  const events = all("SELECT * FROM events WHERE scan_id=? ORDER BY id DESC LIMIT 80", id).reverse();
  return { ...scan, events, running: isRunning(id) };
});

app.post("/api/scans/:id/cancel", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!cancelScan(id)) return reply.code(409).send({ error: "scan is not running" });
  return { ok: true };
});

app.post("/api/scans/:id/reanalyze", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const scan = get<{ status: string; mode: string }>("SELECT status, mode FROM scans WHERE id=?", id);
  if (!scan) return reply.code(404).send({ error: "scan not found" });
  if (scan.mode === "trends") {
    return reply.code(409).send({ error: "trend scans have no stored raw signals — run a fresh trend scout instead" });
  }
  if (isRunning(id)) return reply.code(409).send({ error: "scan is already running" });
  const activeChild = get<{ id: number }>(
    "SELECT id FROM scans WHERE parent_scan_id=? AND status='running' ORDER BY id DESC LIMIT 1",
    id
  );
  if (activeChild) {
    return reply.code(409).send({ error: `re-analysis is already running as scan ${activeChild.id}` });
  }
  const items = get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE scan_id=?", id)?.n ?? 0;
  if (items === 0) return reply.code(409).send({ error: "scan has no stored items to re-analyze" });
  const childId = cloneForReanalysis(id);
  startReanalyze(childId);
  return reply.code(202).send({ ok: true, id: childId, parentScanId: id });
});

app.delete("/api/scans/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (isRunning(id)) return reply.code(409).send({ error: "cancel the scan before deleting it" });
  run("DELETE FROM events WHERE scan_id=?", id);
  const { changes } = run("DELETE FROM scans WHERE id=?", id);
  if (!changes) return reply.code(404).send({ error: "scan not found" });
  return { ok: true };
});

// ---------------- live progress (SSE) ----------------

app.get("/api/scans/:id/stream", (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const scan = get("SELECT * FROM scans WHERE id=?", id);
  const events = all("SELECT * FROM events WHERE scan_id=? ORDER BY id DESC LIMIT 60", id).reverse();
  send("snapshot", { scan, events, running: isRunning(id) });

  const off = onScanEvent(id, (ev) => send(ev.type, ev));
  const ping = setInterval(() => reply.raw.write(":ping\n\n"), 15_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    off();
  });
});

// ---------------- trends (trend-scout scans) ----------------

app.get("/api/scans/:id/trends", async (req) => {
  const id = Number((req.params as { id: string }).id);
  return all("SELECT * FROM trends WHERE scan_id=? ORDER BY momentum_score DESC, id ASC", id);
});

app.post("/api/trends/:id/angles", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const settings = getSettings();
  if (!settings.ai.enabled) return reply.code(503).send({ error: "AI engine is disabled in Settings" });
  try {
    const angles_md = await generateTrendAngles(id);
    return { id, angles_md };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(msg === "trend not found" ? 404 : 503).send({ error: msg });
  }
});

// ---------------- clusters & evidence ----------------

app.get("/api/scans/:id/clusters", async (req) => {
  const id = Number((req.params as { id: string }).id);
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM cluster_problems WHERE cluster_id=c.id) AS problem_count,
       (SELECT COUNT(*) FROM opportunities WHERE cluster_id=c.id) AS brief_count
     FROM clusters c WHERE c.scan_id=? ORDER BY c.demand_score DESC`,
    id
  );
});

app.get("/api/clusters/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const cluster = get("SELECT * FROM clusters WHERE id=?", id);
  if (!cluster) return reply.code(404).send({ error: "cluster not found" });
  const evidence = all(
    `SELECT p.id AS problem_id, p.statement, p.severity, p.wtp, p.quote, p.quote_verified, p.engine,
            i.id AS item_id, i.source, i.url, i.title, i.score, i.comments, i.created_utc
     FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id JOIN items i ON i.id=p.item_id
     WHERE cp.cluster_id=? ORDER BY (i.score+i.comments) DESC LIMIT 200`,
    id
  );
  const brief = get("SELECT id, title, one_liner, created_at FROM opportunities WHERE cluster_id=?", id);
  return { ...cluster, evidence, brief: brief ?? null };
});

app.post("/api/clusters/:id/ask", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { question } = (req.body ?? {}) as { question?: string };
  if (!question?.trim()) return reply.code(400).send({ error: "question is required" });
  const cluster = get<{ name: string }>("SELECT name FROM clusters WHERE id=?", id);
  if (!cluster) return reply.code(404).send({ error: "cluster not found" });
  const settings = getSettings();
  if (!settings.ai.enabled) return reply.code(503).send({ error: "AI engine is disabled in Settings" });

  const evidenceRows = all<{
    item_id: number;
    source: string;
    created_utc: number | null;
    score: number;
    comments: number;
    title: string;
    quote: string | null;
    statement: string;
    url: string;
  }>(
    `SELECT i.id AS item_id, i.source, i.created_utc, i.score, i.comments, i.title, p.quote, p.statement, i.url
     FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id JOIN items i ON i.id=p.item_id
     WHERE cp.cluster_id=?`,
    id
  );
  const selectedRows = selectDiverseEvidence(evidenceRows, 25, 6);
  const evidence: AskEvidenceInput[] = selectedRows.map((r) => ({
    itemId: r.item_id,
    source: r.source,
    date: r.created_utc ? new Date(r.created_utc * 1000).toISOString().slice(0, 10) : "undated",
    engagement: r.score + r.comments,
    title: truncate(r.title, 120),
    quote: truncate(r.quote ?? "", 220),
    statement: truncate(r.statement, 200),
  }));

  try {
    const { data } = await codexJson(
      {
        task: "ask-evidence",
        prompt: askPrompt(question.trim().slice(0, 500), cluster.name, evidence),
        effort: settings.ai.efforts.ask,
        schema: JAsk,
        timeoutMs: 10 * 60_000,
      },
      ZAsk
    );
    const allowedById = new Map(selectedRows.map((row) => [row.item_id, row]));
    const invalidCitation = data.citedItemIds.find((itemId) => !allowedById.has(itemId));
    const missingInline = data.citedItemIds.find((itemId) => !data.answer.includes(`[#${itemId}]`));
    const inlineIds = [...data.answer.matchAll(/\[#(\d+)\]/g)].map((match) => Number(match[1]));
    const unlistedInline = inlineIds.find((itemId) => !data.citedItemIds.includes(itemId));
    const unsupportedUncitedAnswer =
      data.citedItemIds.length === 0 &&
      !/cannot answer|insufficient|missing|does not (?:show|contain|establish)|no evidence/i.test(data.answer);
    if (
      invalidCitation !== undefined ||
      missingInline !== undefined ||
      unlistedInline !== undefined ||
      inlineIds.some((itemId) => !allowedById.has(itemId)) ||
      unsupportedUncitedAnswer
    ) {
      return reply.code(502).send({ error: "AI answer did not satisfy the cluster citation invariants" });
    }
    const cited = [...new Set(data.citedItemIds)]
      .map((itemId) => allowedById.get(itemId))
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .map((row) => ({ id: row.item_id, url: row.url, title: row.title, source: row.source }));
    return { answer: data.answer, citations: cited };
  } catch (err) {
    return reply.code(503).send({ error: `AI unavailable: ${err instanceof Error ? err.message : err}` });
  }
});

app.post("/api/clusters/:id/brief", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { steer, force } = (req.body ?? {}) as { steer?: string; force?: boolean };
  if (steer !== undefined && (typeof steer !== "string" || steer.length > 2_000)) {
    return reply.code(400).send({ error: "steering must be a string of at most 2,000 characters" });
  }
  if (force !== undefined && typeof force !== "boolean") {
    return reply.code(400).send({ error: "force must be boolean" });
  }
  try {
    const result = await generateBrief(id, getSettings(), undefined, steer?.trim() || undefined, force === true);
    return result;
  } catch (err) {
    if (err instanceof DuplicateOpportunityError) {
      return reply.code(409).send({
        error: err.message,
        duplicateOf: err.duplicateOf,
        similarity: err.similarity,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/cluster \d+ not found/.test(message)) return reply.code(404).send({ error: message });
    if (/briefs require/.test(message)) return reply.code(409).send({ error: message });
    if (/AI brief did not/.test(message)) return reply.code(502).send({ error: message });
    return reply.code(503).send({ error: message });
  }
});

// ---------------- opportunities ----------------

app.get("/api/opportunities", async (req) => {
  const scanId = Number((req.query as { scanId?: string }).scanId ?? 0);
  const where = scanId ? "WHERE o.scan_id=?" : "";
  const params = scanId ? [scanId] : [];
  return all(
    `SELECT o.id, o.scan_id, o.cluster_id, o.title, o.one_liner, o.created_at,
            c.demand_score, c.tier, c.distinct_authors, c.name AS cluster_name
     FROM opportunities o JOIN clusters c ON c.id=o.cluster_id ${where} ORDER BY c.demand_score DESC`,
    ...params
  );
});

app.get("/api/opportunities/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const opp = get(
    `SELECT o.*, c.name AS cluster_name, c.demand_score, c.tier, c.distinct_authors,
            c.platform_list_json, c.gate_json, c.judge_json, s.topic AS scan_topic
     FROM opportunities o JOIN clusters c ON c.id=o.cluster_id JOIN scans s ON s.id=o.scan_id
     WHERE o.id=?`,
    id
  );
  if (!opp) return reply.code(404).send({ error: "opportunity not found" });
  return opp;
});

// ---------------- settings & AI ----------------

app.get("/api/settings", async () => publicSettings());

app.put("/api/settings", async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Masked key values ("••••…") must never overwrite the real ones.
  const keys = body.keys;
  if (keys && typeof keys === "object" && !Array.isArray(keys)) {
    for (const k of Object.keys(keys)) {
      const record = keys as Record<string, unknown>;
      if (typeof record[k] !== "string" || record[k]!.includes("•")) delete record[k];
    }
  }
  try {
    updateSettings(body);
    return publicSettings();
  } catch (error) {
    if (error instanceof SettingsValidationError) return reply.code(400).send({ error: error.message });
    throw error;
  }
});

app.post("/api/ai/smoketest", async (req, reply) => {
  const { effort } = (req.body ?? {}) as { effort?: Effort };
  const allowed: Effort[] = ["none", "low", "medium", "high", "xhigh"];
  if (effort !== undefined && !allowed.includes(effort)) {
    return reply.code(400).send({ error: "invalid effort" });
  }
  return codexHealth(effort ?? "low");
});

// ---------------- static frontend (production) ----------------

const dist = join(ROOT, "web", "dist");
if (existsSync(dist)) {
  // wildcard route (default) serves files dynamically — survives rebuilds while running
  const fastifyStatic = (await import("@fastify/static")).default;
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

const port = Number(env("PORT", "5058"));
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: stopping scans and closing cleanly`);
  cancelAllScans();
  const deadline = Date.now() + 10_000;
  while (runningScanCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await app.close();
  closeDatabase();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`Lodestone API listening on http://127.0.0.1:${port}`);
} catch (error) {
  console.error(error);
  closeDatabase();
  process.exitCode = 1;
}
