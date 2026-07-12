import { all, get, run, jsonOrNull } from "../db.ts";
import { getSettings } from "../settings.ts";
import { codexJson } from "../ai/codex.ts";
import { trendClassifyPrompt, trendAnglesPrompt, type TrendCandidateInput } from "../ai/prompts.ts";
import { ZTrendClassify, JTrendClassify, ZTrendAngles, JTrendAngles } from "../ai/schemas.ts";
import { nowSec, truncate } from "../lib/text.ts";
import {
  groupTrendSignals,
  trendCandidateValue,
  trendMomentum,
  type TrendCandidate,
} from "../lib/trendmetrics.ts";
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

type Candidate = TrendCandidate<TrendSignal>;

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
): Promise<{ classified: Classified[]; engine: "ai" | "heuristic" | "mixed" }> {
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
  let aiCount = 0;
  let heuristicCount = 0;
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
      const byId = new Map<number, (typeof data.trends)[number]>();
      for (const trend of data.trends) {
        if (batch.some((input) => input.id === trend.id) && !byId.has(trend.id)) byId.set(trend.id, trend);
      }
      for (const inp of batch) {
        const t = byId.get(inp.id);
        const cand = candidates.find((c) => c.id === inp.id)!;
        if (t?.name) {
          out.push({ id: inp.id, name: t.name, category: t.category, summary: t.summary, softwareFit: t.softwareFit, fitReason: t.fitReason });
          aiCount++;
        } else {
          out.push(heuristicClassify(cand));
          heuristicCount++;
        }
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
        heuristicCount++;
      }
      return { classified: out, engine: aiCount > 0 ? "mixed" : "heuristic" };
    }
  }
  return { classified: out, engine: heuristicCount > 0 ? "mixed" : "ai" };
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
  if (!settings.ai.enabled) throw new Error("AI engine is disabled in Settings — trend angles require it");
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
  let candidates = groupTrendSignals(allSignals);
  candidates.sort((a, b) => trendCandidateValue(b) - trendCandidateValue(a));
  candidates = candidates.slice(0, depth.maxCandidates);
  // Re-id after the cut so AI batches reference a dense range.
  candidates.forEach((c, i) => (c.id = i + 1));
  ctx.updateProgress({ candidates: candidates.length });
  ctx.log(`grouped into ${candidates.length} candidate trends — classifying (software-only filter)`);

  const { classified, engine } = await classifyCandidates(candidates, ctx);
  run("UPDATE scans SET ai_mode=? WHERE id=?", engine, scan.id);

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
    const { score, status } = trendMomentum(cand);
    rows.push({ candidate: cand, cls, score, status });
  }
  rows.sort((a, b) => b.score - a.score);
  ctx.log(`kept ${rows.length} software-rideable trends · filtered ${rejected} (hardware/news/entertainment)`);

  run("DELETE FROM trends WHERE scan_id=?", scan.id);
  const trendIds: number[] = [];
  for (const r of rows) {
    const { lastId } = run(
      `INSERT INTO trends (scan_id, name, category, summary, status, momentum_score, software_fit, fit_reason,
       signals_json, engine, created_at, source_count, signal_strength)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scan.id,
      r.cls.name,
      r.cls.category,
      r.cls.summary,
      r.status,
      r.score,
      r.cls.softwareFit,
      r.cls.fitReason,
      JSON.stringify(r.candidate.signals.map((s) => ({
        source: s.source,
        label: s.label,
        metric: s.metric,
        url: s.url,
        strength: Number(s.strength.toFixed(4)),
        detail: s.detail ?? null,
      }))),
      engine,
      nowSec(),
      new Set(r.candidate.signals.map((signal) => signal.source)).size,
      Number(trendMomentum(r.candidate).strength.toFixed(4))
    );
    run("UPDATE trends SET metrics_version=2 WHERE id=?", lastId);
    trendIds.push(lastId);
  }
  const surging = rows.filter((r) => r.status === "surging").length;
  ctx.updateProgress({ trends: rows.length, surging });

  // ---- 4. report: build angles for the top software-fit trends ----
  ctx.setStage("report");
  const targets = settings.ai.enabled ? all<{ id: number; name: string }>(
    `SELECT id, name FROM trends WHERE scan_id=?
     ORDER BY (software_fit='strong') DESC, momentum_score DESC LIMIT ?`,
    scan.id,
    Math.max(0, settings.trendAnglesPerScan)
  ) : [];
  if (!settings.ai.enabled && settings.trendAnglesPerScan > 0) {
    ctx.log("AI disabled — stored trend evidence without drafting build angles", "warn");
  }
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
