import { all, run } from "../db.ts";
import { codexJson, CodexError } from "../ai/codex.ts";
import { extractPrompt, type ExtractItemInput } from "../ai/prompts.ts";
import { ZExtract, JExtract, type ExtractResult } from "../ai/schemas.ts";
import { containsVerbatim, truncate, collapseWs } from "../lib/text.ts";
import { mapLimit } from "../lib/ratelimit.ts";
import type { AppSettings } from "../settings.ts";

interface ItemRow {
  id: number;
  source: string;
  title: string;
  body: string;
  meta_json: string | null;
}

/** Regex fallback used when the AI engine is unavailable — always labeled "heuristic". */
const PAIN_PATTERNS: [RegExp, number][] = [
  [/is there (a|an|any) (tool|app|software|service|way)/i, 3],
  [/i wish (there was|i could|it (would|could))/i, 3],
  [/why (is there no|isn'?t there|can'?t i|does no)/i, 3],
  [/frustrat|infuriat|drives me (crazy|insane|nuts)/i, 4],
  [/nightmare|unusable|horrible|terrible|worst/i, 4],
  [/hate (that|when|how|this)/i, 3],
  [/waste[sd]? (of )?(so much )?(time|hours|money)/i, 4],
  [/manual(ly)? (enter|copy|track|updat|process)/i, 3],
  [/spreadsheet (hell|chaos|mess)|still (using|doing).*spreadsheet/i, 3],
  [/can'?t find (a|an|any)|looking for (a|an) (tool|app|alternative)/i, 3],
  [/fed up|sick of|tired of/i, 3],
  [/tedious|painful|clunky|cumbersome/i, 3],
  [/(doesn'?t|does not|won'?t) (work|sync|support|export|integrate)/i, 3],
  [/lost (hours|days|money|data)/i, 4],
  [/(no|zero) (support|response|way to)/i, 2],
  [/workaround|hack(y|ed) together/i, 2],
];

const WTP_EXPLICIT = /i('| wou|would| )?d? ?pay|take my money|happily pay|worth \$|price[d]? (it|this)|subscription/i;
const WTP_HINTED = /paying for|expensive|costs? (too much|a fortune)|cheaper|pricing/i;

function heuristicExtract(item: ItemRow): ExtractResult | null {
  const text = `${item.title}\n${item.body}`;
  const meta = item.meta_json ? (JSON.parse(item.meta_json) as Record<string, unknown>) : {};
  const isReview = item.source === "playstore" || item.source === "appstore";

  let severity = 0;
  let hits = 0;
  for (const [re, sev] of PAIN_PATTERNS) {
    if (re.test(text)) {
      hits++;
      severity = Math.max(severity, sev);
    }
  }
  if (isReview && item.body.length >= 60) {
    hits = Math.max(hits, 1);
    severity = Math.max(severity, 3);
  }
  if (hits === 0) return null;

  // Quote: first sentence that triggered a pattern.
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 25);
  const quote =
    sentences.find((s) => PAIN_PATTERNS.some(([re]) => re.test(s))) ?? sentences[0] ?? item.title;

  const statement = isReview
    ? `Users of ${String(meta.appTitle ?? "this app")} report: ${truncate(collapseWs(item.body), 120)}`
    : truncate(collapseWs(item.title), 160);

  return {
    id: item.id,
    isPain: true,
    statement,
    category: "general",
    persona: typeof meta.subreddit === "string" ? `r/${meta.subreddit} members` : "unknown",
    severity: Math.min(5, Math.max(2, severity)) as number,
    wtp: WTP_EXPLICIT.test(text) ? "explicit" : WTP_HINTED.test(text) ? "hinted" : "none",
    quote: truncate(collapseWs(quote), 220),
  };
}

function insertProblem(scanId: number, item: ItemRow, r: ExtractResult, engine: "ai" | "heuristic"): void {
  if (!r.isPain || !r.statement.trim()) return;
  const haystack = `${item.title}\n${item.body}`;
  let quote = r.quote.trim();
  let verified = 0;
  if (quote && containsVerbatim(haystack, quote)) {
    verified = 1;
  } else {
    quote = truncate(collapseWs(item.body || item.title), 200);
  }
  run(
    `INSERT INTO problems (scan_id, item_id, statement, category, persona, severity, wtp, quote, quote_verified, engine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    scanId,
    item.id,
    truncate(r.statement.trim(), 300),
    r.category.trim().toLowerCase() || "general",
    r.persona.trim() || "unknown",
    r.severity,
    r.wtp,
    quote,
    verified,
    engine
  );
}

export async function extractProblems(
  scanId: number,
  topic: string | null,
  settings: AppSettings,
  signal: AbortSignal | undefined,
  log: (msg: string, type?: "log" | "warn") => void,
  onBatch: (done: number, total: number, problems: number) => void
): Promise<{ engine: "ai" | "heuristic" | "mixed"; problems: number }> {
  // market items = competitor context; paid-intent items = hiring posts.
  // Neither is a complaint, so neither goes through pain extraction.
  const items = all<ItemRow>(
    `SELECT id, source, title, body, meta_json FROM items
     WHERE scan_id = ? AND (meta_json IS NULL OR (meta_json NOT LIKE '%"kind":"market"%' AND meta_json NOT LIKE '%"kind":"paid-intent"%'))
     ORDER BY (score + comments) DESC`,
    scanId
  );
  if (items.length === 0) return { engine: "ai", problems: 0 };

  const batchSize = Math.max(10, Math.min(80, settings.ai.extractBatchSize));
  const batches: ItemRow[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  let problems = 0;
  let aiBatches = 0;
  let heuristicBatches = 0;
  let aiDead = !settings.ai.enabled; // once codex hard-fails we stop trying (quota/auth won't heal mid-scan)
  let aiDeadReason = settings.ai.enabled ? "" : "AI disabled in settings";
  let done = 0;

  await mapLimit(batches, 2, async (batch) => {
    if (signal?.aborted) return;
    let results: ExtractResult[] | null = null;

    if (!aiDead) {
      try {
        const payload: ExtractItemInput[] = batch.map((it) => ({
          id: it.id,
          source: it.source,
          title: it.title,
          body: it.body,
        }));
        const { data } = await codexJson(
          {
            task: `extract-batch(${batch.length})`,
            prompt: extractPrompt(payload, topic),
            effort: settings.ai.efforts.extract,
            schema: JExtract,
            timeoutMs: 20 * 60_000,
            signal,
          },
          ZExtract
        );
        const expected = new Set(batch.map((item) => item.id));
        const seen = new Set<number>();
        const valid: ExtractResult[] = [];
        for (const result of data.results) {
          if (!expected.has(result.id) || seen.has(result.id)) continue;
          seen.add(result.id);
          valid.push(result);
        }
        results = valid;
        if (valid.length !== batch.length) {
          log(
            `AI extraction returned ${valid.length}/${batch.length} exact item IDs — missing items use the labeled heuristic fallback`,
            "warn"
          );
        }
        aiBatches++;
      } catch (err) {
        if (signal?.aborted) return;
        const msg = err instanceof CodexError ? `${err.message} ${err.detail}` : String(err);
        // Usage-limit / auth / launch failures affect every future call too.
        if (/usage limit|401|403|authentication|unauthorized|failed to launch|ENOENT/i.test(msg)) {
          aiDead = true;
          aiDeadReason = msg.slice(0, 300);
          log(`AI extraction unavailable — switching to heuristic engine (${aiDeadReason})`, "warn");
        } else {
          log(`AI batch failed (${msg.slice(0, 160)}) — heuristic for this batch`, "warn");
        }
      }
    }

    const byId = new Map(batch.map((it) => [it.id, it]));
    if (results) {
      const returned = new Set(results.map((result) => result.id));
      for (const r of results) {
        const item = byId.get(r.id);
        if (!item) continue;
        insertProblem(scanId, item, r, "ai");
      }
      const missing = batch.filter((item) => !returned.has(item.id));
      if (missing.length > 0) {
        heuristicBatches++;
        for (const item of missing) {
          const fallback = heuristicExtract(item);
          if (fallback) insertProblem(scanId, item, fallback, "heuristic");
        }
      }
    } else {
      heuristicBatches++;
      for (const item of batch) {
        const r = heuristicExtract(item);
        if (r) insertProblem(scanId, item, r, "heuristic");
      }
    }

    problems = (all<{ n: number }>("SELECT COUNT(*) AS n FROM problems WHERE scan_id = ?", scanId)[0]?.n ?? 0);
    done++;
    onBatch(done, batches.length, problems);
  });

  const engine = aiBatches > 0 && heuristicBatches > 0 ? "mixed" : aiBatches > 0 ? "ai" : "heuristic";
  log(
    `extraction done: ${problems} problems from ${items.length} items (${aiBatches} AI batches, ${heuristicBatches} heuristic)`
  );
  return { engine, problems };
}
