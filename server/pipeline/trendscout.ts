import { all, get, run, jsonOrNull } from "../db.ts";
import { getSettings } from "../settings.ts";
import { codexJson } from "../ai/codex.ts";
import { trendClassifyPrompt, trendAnglesPrompt, type TrendCandidateInput } from "../ai/prompts.ts";
import { ZTrendClassify, JTrendClassify, ZTrendAngles, JTrendAngles } from "../ai/schemas.ts";
import { tokenize, nowSec, truncate } from "../lib/text.ts";
import { SCOUTS, TREND_SOURCES, type ScoutContext, type TrendSignal, type TrendSourceId } from "../trends/sources.ts";

/**
 * Trend-scout pipeline: scout → classify → rank → report.
 *
 * Philosophically separate from the pain pipeline: NOTHING here checks pain,
 * demand, or willingness-to-pay. A trend earns its place purely through
 * measured growth (star velocity, story-count deltas, launch clusters,
 * breakout searches). The AI's only powers are naming, describing, and
 * REJECTING what software can't ride (hardware, physical, news, celebrity).
 */

const TREND_DEPTHS: Record<string, { windowDays: number; ghPages: number; hnHits: number; maxCandidates: number }> = {
  quick: { windowDays: 14, ghPages: 1, hnHits: 1000, maxCandidates: 24 },
  standard: { windowDays: 30, ghPages: 2, hnHits: 3000, maxCandidates: 36 },
  deep: { windowDays: 90, ghPages: 3, hnHits: 5000, maxCandidates: 48 },
};

const HARDWARE_RE =
  /\b(hardware|device|robot(s|ics)?|drone(s)?|chip(s|set)?|semiconductor|gpu(s)?|battery|batteries|wearable(s)?|headset(s)?|glasses|smartphone|laptop(s)?|console(s)?|printer(s)?|camera(s)?|sensor(s)?|vehicle(s)?|electric vehicle|rocket(s)?|satellite(s)?|biotech|implant(s)?|factory|manufacturing)\b/i;
const NOISE_RE =
  /\b(election(s)?|senator|president|congress|celebrity|actor|actress|singer|rapper|nfl|nba|mlb|nhl|ufc|premier league|world cup|olympics|weather|hurricane|earthquake|wildfire|movie(s)?|trailer|album|concert|tour|kardashian|taylor swift|game of|season \d|episode)\b/i;

interface ScanRow {
  id: number;
  topic: string | null;
  mode: string;
  depth: string;
  sources_json: string;
}

export interface TrendPipelineCtx {
  signal: AbortSignal;
  log: (msg: string, type?: "log" | "warn") => void;
  setStage: (stage: string) => void;
  updateProgress: (patch: Record<string, unknown>) => void;
}

interface Candidate {
  id: number;
  label: string;
  tokens: Set<string>;
  signals: TrendSignal[];
}

/** Light stem so "agents"/"agent" group together without a stemming library. */
function keyTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(s)) out.add(t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t);
  return out;
}

function containment(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  let sharedLong = 0;
  for (const t of small) {
    if (big.has(t)) {
      shared++;
      if (t.length >= 4) sharedLong++;
    }
  }
  return sharedLong > 0 ? shared / small.size : 0;
}

/** Group cross-source signals into candidate trends (union-find on containment). */
function groupSignals(signals: TrendSignal[]): Candidate[] {
  const parent = signals.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const tokens = signals.map((s) => keyTokens(s.key));
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      if (containment(tokens[i]!, tokens[j]!) >= 0.7) union(i, j);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < signals.length; i++) {
    const r = find(i);
    const list = byRoot.get(r) ?? [];
    list.push(i);
    byRoot.set(r, list);
  }

  const candidates: Candidate[] = [];
  let nextId = 1;
  for (const memberIdx of byRoot.values()) {
    const members = memberIdx.map((i) => signals[i]!).sort((a, b) => b.strength - a.strength);
    // Short human terms (hn/gtrends/producthunt/twitter) name the trend better
    // than repo slugs; fall back to the strongest signal's label.
    const named = members.find((m) => m.source !== "github") ?? members[0]!;
    const merged = new Set<string>();
    for (const i of memberIdx) for (const t of tokens[i]!) merged.add(t);
    candidates.push({ id: nextId++, label: named.label, tokens: merged, signals: members });
  }
  return candidates;
}

function candidateValue(c: Candidate): number {
  const spread = new Set(c.signals.map((s) => s.source)).size;
  return c.signals.reduce((sum, s) => sum + s.strength, 0) + spread;
}

function momentumOf(c: Candidate): { score: number; status: string; spread: number } {
  const spread = new Set(c.signals.map((s) => s.source)).size;
  const best = Math.max(...c.signals.map((s) => s.strength));
  // Single-source trends cap at 60 — cross-platform confirmation is what
  // separates "surging" from "one repo went viral".
  const score = Math.round(100 * (0.6 * best + 0.4 * Math.min(1, (spread - 1) / 2)));
  const status = score >= 62 ? "surging" : score >= 32 ? "rising" : "early";
  return { score, status, spread };
}

interface Classified {
  id: number;
  name: string;
  category: string;
  summary: string;
  softwareFit: "strong" | "possible" | "rejected";
  fitReason: string;
}

function heuristicClassify(c: Candidate): Classified {
  const text = `${c.label} ${c.signals.map((s) => `${s.key} ${s.detail ?? ""}`).join(" ")}`;
  const rejected = NOISE_RE.test(text) || HARDWARE_RE.test(text);
  return {
    id: c.id,
    name: c.label,
    category: "unclassified",
    summary: `Detected via ${c.signals
      .slice(0, 3)
      .map((s) => `${s.source}: ${s.metric}`)
      .join(" · ")}`,
    softwareFit: rejected ? "rejected" : "possible",
    fitReason: rejected
      ? "Keyword filter: looks like hardware/news/entertainment (heuristic — AI was unavailable)"
      : "Unverified by AI — heuristic pass only",
  };
}

async function classifyCandidates(
  candidates: Candidate[],
  ctx: TrendPipelineCtx
): Promise<{ classified: Classified[]; engine: "ai" | "heuristic" }> {
  const settings = getSettings();
  if (!settings.ai.enabled) {
    ctx.log("AI disabled — classifying trends heuristically (labeled)", "warn");
    return { classified: candidates.map(heuristicClassify), engine: "heuristic" };
  }

  const inputs: TrendCandidateInput[] = candidates.map((c) => ({
    id: c.id,
    label: c.label,
    signals: c.signals
      .slice(0, 5)
      .map((s) => truncate(`${s.source}: ${s.label} — ${s.metric}${s.detail ? ` — ${s.detail}` : ""}`, 200)),
  }));

  const out: Classified[] = [];
  const batchSize = 20;
  for (let i = 0; i < inputs.length; i += batchSize) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const batch = inputs.slice(i, i + batchSize);
    try {
      const { data, latencyMs } = await codexJson(
        {
          task: `trend-classify ${i / batchSize + 1}`,
          prompt: trendClassifyPrompt(batch),
          effort: settings.ai.efforts.cluster,
          schema: JTrendClassify,
          timeoutMs: 15 * 60_000,
          signal: ctx.signal,
        },
        ZTrendClassify
      );
      const byId = new Map(data.trends.map((t) => [t.id, t]));
      for (const inp of batch) {
        const t = byId.get(inp.id);
        const cand = candidates.find((c) => c.id === inp.id)!;
        out.push(
          t && t.name
            ? { id: inp.id, name: t.name, category: t.category, summary: t.summary, softwareFit: t.softwareFit, fitReason: t.fitReason }
            : heuristicClassify(cand)
        );
      }
      ctx.log(`AI classified ${Math.min(i + batchSize, inputs.length)}/${inputs.length} trend candidates (${(latencyMs / 1000).toFixed(0)}s)`);
    } catch (err) {
      if (ctx.signal.aborted) throw new Error("aborted");
      ctx.log(
        `AI classify failed (${err instanceof Error ? err.message : err}) — heuristic labels for remaining candidates`,
        "warn"
      );
      for (const inp of inputs.slice(i)) {
        out.push(heuristicClassify(candidates.find((c) => c.id === inp.id)!));
      }
      return { classified: out, engine: "heuristic" };
    }
  }
  return { classified: out, engine: "ai" };
}

function renderAnglesMd(angles: { title: string; oneLiner: string; mvp: string; trendFit: string }[]): string {
  return angles
    .filter((a) => a.title)
    .map(
      (a, i) =>
        `### ${i + 1}. ${a.title}\n\n${a.oneLiner}\n\n**MVP (2–4 weeks):** ${a.mvp}\n\n**Why it rides the trend:** ${a.trendFit}`
    )
    .join("\n\n");
}

/** Generate (or regenerate) build angles for one stored trend. Used by the report stage and the API. */
export async function generateTrendAngles(trendId: number, signal?: AbortSignal): Promise<string> {
  const settings = getSettings();
  const trend = get<{ id: number; name: string; category: string; summary: string; signals_json: string }>(
    "SELECT id, name, category, summary, signals_json FROM trends WHERE id=?",
    trendId
  );
  if (!trend) throw new Error("trend not found");
  const signals = (jsonOrNull<{ source: string; label: string; metric: string }[]>(trend.signals_json) ?? []).map(
    (s) => `${s.source}: ${s.label} — ${s.metric}`
  );
  const { data } = await codexJson(
    {
      task: `trend-angles #${trendId}`,
      prompt: trendAnglesPrompt(trend.name, trend.category, trend.summary, signals),
      effort: settings.ai.efforts.brief,
      schema: JTrendAngles,
      timeoutMs: 20 * 60_000,
      signal,
    },
    ZTrendAngles
  );
  const md = renderAnglesMd(data.angles);
  if (!md) throw new Error("AI returned no usable angles");
  run("UPDATE trends SET angles_md=? WHERE id=?", md, trendId);
  return md;
}

export async function runTrendScout(scan: ScanRow, ctx: TrendPipelineCtx): Promise<Record<string, number>> {
  const settings = getSettings();
  const depth = TREND_DEPTHS[scan.depth] ?? TREND_DEPTHS.standard!;

  // ---- 1. scout ----
  ctx.setStage("scout");
  ctx.log(
    `trend scout: ${depth.windowDays}-day lookback${scan.topic ? ` · focus "${scan.topic}"` : " · no focus (full sweep)"}`
  );
  const requested = jsonOrNull<TrendSourceId[]>(scan.sources_json) ?? [];
  const enabled = TREND_SOURCES.filter((s) => (requested.length ? requested.includes(s.id) : true)).filter((s) => {
    if (s.needsKey === "github") return Boolean(settings.keys.githubToken);
    if (s.needsKey === "twitter") return Boolean(settings.keys.twitterBearer);
    return true;
  });

  const scoutCtx: ScoutContext = {
    windowDays: depth.windowDays,
    ghPages: depth.ghPages,
    hnHits: depth.hnHits,
    settings,
    signal: ctx.signal,
    log: ctx.log,
    focus: scan.topic,
  };

  const bySource: Record<string, number> = {};
  for (const s of enabled) bySource[s.id] = 0;
  ctx.updateProgress({ bySource });

  const allSignals: TrendSignal[] = [];
  await Promise.allSettled(
    enabled.map(async (src) => {
      try {
        const signals = await SCOUTS[src.id](scoutCtx);
        allSignals.push(...signals);
        bySource[src.id] = signals.length;
        ctx.updateProgress({ bySource, signals: allSignals.length });
      } catch (err) {
        if (!ctx.signal.aborted) {
          ctx.log(`trend/${src.id}: scout crashed (${err instanceof Error ? err.message : err})`, "warn");
        }
      }
    })
  );
  if (ctx.signal.aborted) throw new Error("aborted");
  ctx.log(`scout complete: ${allSignals.length} growth signals across ${Object.values(bySource).filter((n) => n > 0).length} sources`);
  ctx.updateProgress({ signals: allSignals.length });
  if (allSignals.length === 0) {
    throw new Error("no growth signals found — check source keys, or drop the focus filter");
  }

  // ---- 2. classify ----
  ctx.setStage("classify");
  let candidates = groupSignals(allSignals);
  candidates.sort((a, b) => candidateValue(b) - candidateValue(a));
  candidates = candidates.slice(0, depth.maxCandidates);
  // Re-id after the cut so AI batches reference a dense range.
  candidates.forEach((c, i) => (c.id = i + 1));
  ctx.updateProgress({ candidates: candidates.length });
  ctx.log(`grouped into ${candidates.length} candidate trends — classifying (software-only filter)`);

  const { classified, engine } = await classifyCandidates(candidates, ctx);
  if (engine !== "ai") run("UPDATE scans SET ai_mode='heuristic' WHERE id=?", scan.id);

  // ---- 3. rank ----
  ctx.setStage("rank");
  const byId = new Map(classified.map((c) => [c.id, c]));
  let rejected = 0;
  const rows: { candidate: Candidate; cls: Classified; score: number; status: string }[] = [];
  for (const cand of candidates) {
    const cls = byId.get(cand.id);
    if (!cls) continue;
    if (cls.softwareFit === "rejected") {
      rejected++;
      continue;
    }
    const { score, status } = momentumOf(cand);
    rows.push({ candidate: cand, cls, score, status });
  }
  rows.sort((a, b) => b.score - a.score);
  ctx.log(`kept ${rows.length} software-rideable trends · filtered ${rejected} (hardware/news/entertainment)`);

  run("DELETE FROM trends WHERE scan_id=?", scan.id);
  const trendIds: number[] = [];
  for (const r of rows) {
    const { lastId } = run(
      `INSERT INTO trends (scan_id, name, category, summary, status, momentum_score, software_fit, fit_reason, signals_json, engine, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scan.id,
      r.cls.name,
      r.cls.category,
      r.cls.summary,
      r.status,
      r.score,
      r.cls.softwareFit,
      r.cls.fitReason,
      JSON.stringify(r.candidate.signals.map((s) => ({ source: s.source, label: s.label, metric: s.metric, url: s.url }))),
      engine,
      nowSec()
    );
    trendIds.push(lastId);
  }
  const surging = rows.filter((r) => r.status === "surging").length;
  ctx.updateProgress({ trends: rows.length, surging });

  // ---- 4. report: build angles for the top software-fit trends ----
  ctx.setStage("report");
  const targets = all<{ id: number; name: string }>(
    `SELECT id, name FROM trends WHERE scan_id=?
     ORDER BY (software_fit='strong') DESC, momentum_score DESC LIMIT ?`,
    scan.id,
    Math.max(0, settings.trendAnglesPerScan)
  );
  let drafted = 0;
  ctx.updateProgress({ angles: { done: 0, total: targets.length } });
  for (const t of targets) {
    if (ctx.signal.aborted) throw new Error("aborted");
    try {
      await generateTrendAngles(t.id, ctx.signal);
      drafted++;
      ctx.log(`build angles drafted: ${t.name}`);
    } catch (err) {
      if (ctx.signal.aborted) throw new Error("aborted");
      ctx.log(
        `angles for "${t.name}" failed (${err instanceof Error ? err.message : err}) — draft later from the trend board`,
        "warn"
      );
      break; // AI is down/limited: don't burn the remaining calls
    }
    ctx.updateProgress({ angles: { done: drafted, total: targets.length } });
  }

  return { signals: allSignals.length, candidates: candidates.length, trends: rows.length, surging, angles: drafted };
}
