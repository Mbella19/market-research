import { all, run, get, jsonOrNull } from "../db.ts";
import { codexJson } from "../ai/codex.ts";
import { judgePrompt, type JudgeEvidenceInput } from "../ai/prompts.ts";
import { ZJudge, JJudge } from "../ai/schemas.ts";
import { nowSec, truncate } from "../lib/text.ts";
import { normalizeEngagement, paidIntentScore, type PaidIntentSummary } from "../lib/demand.ts";
import { matchScore, buildVocab } from "../lib/paidintent.ts";
import { topicTrends } from "../connectors/trends.ts";
import type { AppSettings } from "../settings.ts";
import type { QueryPlan } from "../ai/schemas.ts";

interface EvidenceRow {
  item_id: number;
  source: string;
  url: string;
  title: string;
  quote: string | null;
  author_hash: string | null;
  score: number;
  comments: number;
  created_utc: number | null;
}

export interface GateCheck {
  key: string;
  label: string;
  value: number;
  threshold: number;
  pass: boolean;
}

function evidenceFor(clusterId: number): EvidenceRow[] {
  return all<EvidenceRow>(
    `SELECT DISTINCT i.id AS item_id, i.source, i.url, i.title, p.quote, i.author_hash, i.score, i.comments, i.created_utc
     FROM cluster_problems cp
     JOIN problems p ON p.id = cp.problem_id
     JOIN items i ON i.id = p.item_id
     WHERE cp.cluster_id = ?`,
    clusterId
  );
}

function monthKey(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function validateClusters(
  scanId: number,
  settings: AppSettings,
  signal: AbortSignal | undefined,
  log: (msg: string, type?: "log" | "warn") => void,
  onProgress: (judged: number, toJudge: number) => void
): Promise<{ validated: number; engine: "ai" | "heuristic" }> {
  const clusters = all<{ id: number; name: string; summary: string | null; category: string | null; persona: string | null }>(
    "SELECT id, name, summary, category, persona FROM clusters WHERE scan_id = ?",
    scanId
  );
  const now = nowSec();
  const yearAgo = now - 365 * 86400;

  // Paid-intent evidence: [Hiring] posts with budgets, matched to clusters by
  // vocabulary overlap. A separate axis — never mixed into engagement.
  interface PaidPost {
    id: number;
    title: string;
    body: string;
    url: string;
    budgetUsd: number | null;
  }
  const paidPosts: PaidPost[] = all<{ id: number; title: string; body: string; url: string; meta_json: string }>(
    `SELECT id, title, body, url, meta_json FROM items WHERE scan_id=? AND meta_json LIKE '%"kind":"paid-intent"%'`,
    scanId
  ).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    url: r.url,
    budgetUsd: jsonOrNull<{ budgetUsd?: number | null }>(r.meta_json)?.budgetUsd ?? null,
  }));
  if (paidPosts.length > 0) log(`paid-intent pool: ${paidPosts.length} hiring posts to match against clusters`);

  interface Computed {
    id: number;
    name: string;
    summary: string;
    voices: number;
    distinctAuthors: number;
    platforms: string[];
    engagement: number;
    topItemShare: number;
    paid: PaidIntentSummary | null;
    recencyRatio: number;
    growth: number;
    gatePassed: boolean;
    checks: GateCheck[];
    evidence: EvidenceRow[];
  }
  const computed: Computed[] = [];

  for (const cluster of clusters) {
    const evidence = evidenceFor(cluster.id);
    const authors = new Set<string>();
    const platforms = new Set<string>();
    let dated = 0;
    let recent = 0;
    const timeline = new Map<string, number>();

    for (const ev of evidence) {
      if (ev.author_hash) authors.add(ev.author_hash);
      if (ev.source !== "producthunt") platforms.add(ev.source);
      if (ev.created_utc) {
        dated++;
        if (ev.created_utc >= yearAgo) recent++;
        if (ev.created_utc >= now - 24 * 30 * 86400) {
          const k = monthKey(ev.created_utc);
          timeline.set(k, (timeline.get(k) ?? 0) + 1);
        }
      }
    }

    // Normalized + viral/platform-capped engagement (see lib/demand.ts).
    const eng = normalizeEngagement(
      evidence.map((ev) => ({ source: ev.source, engagement: Math.max(0, ev.score) + Math.max(0, ev.comments) }))
    );
    const engagement = eng.counted;

    // Match paid-intent posts to this cluster (≥2 shared meaningful tokens).
    const statements = all<{ statement: string }>(
      `SELECT p.statement FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id
       WHERE cp.cluster_id=? LIMIT 12`,
      cluster.id
    ).map((r) => r.statement);
    const vocab = buildVocab([cluster.name, cluster.category ?? "", cluster.persona ?? "", ...statements]);
    const matched = paidPosts.filter((p) => matchScore(vocab, `${p.title} ${p.body}`) >= 2);
    const budgets = matched.map((p) => p.budgetUsd).filter((b): b is number => b !== null && b > 0).sort((a, b) => a - b);
    const paid: PaidIntentSummary | null = matched.length
      ? {
          count: matched.length,
          totalBudgetUsd: budgets.reduce((s, b) => s + b, 0),
          medianBudgetUsd: budgets.length ? budgets[Math.floor(budgets.length / 2)]! : 0,
        }
      : null;

    const distinctAuthors = authors.size;
    const voices = distinctAuthors + engagement;
    const recencyRatio = dated > 0 ? recent / dated : 0.5; // neutral when undated
    // growth: complaints in last 6 months vs the 6 before
    const sixMonthsAgo = now - 182 * 86400;
    const twelveMonthsAgo = now - 365 * 86400;
    let last6 = 0;
    let prior6 = 0;
    for (const ev of evidence) {
      if (!ev.created_utc) continue;
      if (ev.created_utc >= sixMonthsAgo) last6++;
      else if (ev.created_utc >= twelveMonthsAgo) prior6++;
    }
    const growth = prior6 > 0 ? last6 / prior6 - 1 : last6 > 2 ? 0.5 : 0;

    const gate = settings.gate;
    const checks: GateCheck[] = [
      {
        key: "authors",
        label: "distinct complainers",
        value: distinctAuthors,
        threshold: gate.minAuthors,
        pass: distinctAuthors >= gate.minAuthors,
      },
      {
        key: "platforms",
        label: "platforms",
        value: platforms.size,
        threshold: gate.minPlatforms,
        pass: platforms.size >= gate.minPlatforms,
      },
      {
        key: "engagement",
        label: "normalized engagement",
        value: engagement,
        threshold: gate.minEngagement,
        pass: engagement >= gate.minEngagement,
      },
      {
        key: "recency",
        label: "evidence from last 12mo",
        value: Math.round(recencyRatio * 100),
        threshold: Math.round(gate.minRecencyRatio * 100),
        pass: recencyRatio >= gate.minRecencyRatio,
      },
    ];
    const gatePassed = checks.every((c) => c.pass);

    // persist metrics + timeline immediately (judge fills the rest later)
    const timelineArr = [...timeline.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    run(
      `UPDATE clusters SET distinct_authors=?, platforms=?, platform_list_json=?, engagement=?, voices=?,
       recency_ratio=?, timeline_json=?, gate_json=?, paid_intent_json=? WHERE id=?`,
      distinctAuthors,
      platforms.size,
      JSON.stringify([...platforms]),
      engagement,
      voices,
      recencyRatio,
      JSON.stringify(timelineArr),
      JSON.stringify({
        checks,
        passed: gatePassed,
        engagementRaw: eng.raw,
        viralCapApplied: eng.viralCapApplied,
        platformCapApplied: eng.platformCapApplied,
        topItemShare: Number(eng.topItemShare.toFixed(2)),
      }),
      paid
        ? JSON.stringify({
            ...paid,
            samples: matched.slice(0, 5).map((p) => ({ title: truncate(p.title, 120), budgetUsd: p.budgetUsd, url: p.url })),
          })
        : null,
      cluster.id
    );

    computed.push({
      id: cluster.id,
      name: cluster.name,
      summary: cluster.summary ?? "",
      voices,
      distinctAuthors,
      platforms: [...platforms],
      engagement,
      topItemShare: eng.topItemShare,
      paid,
      recencyRatio,
      growth,
      gatePassed,
      checks,
      evidence,
    });
  }

  // ---- AI demand judge for gate-passing clusters ----
  const toJudge = computed
    .filter((c) => c.gatePassed)
    .sort((a, b) => b.voices - a.voices)
    .slice(0, settings.judgedClustersPerScan);
  let engine: "ai" | "heuristic" = "heuristic";
  let judgedCount = 0;

  for (const c of toJudge) {
    if (signal?.aborted) throw new Error("aborted");
    if (!settings.ai.enabled) break;
    const evidencePayload: JudgeEvidenceInput[] = c.evidence
      .sort((a, b) => b.score + b.comments - (a.score + a.comments))
      .slice(0, 15)
      .map((ev) => ({
        source: ev.source,
        date: ev.created_utc ? new Date(ev.created_utc * 1000).toISOString().slice(0, 10) : "undated",
        engagement: ev.score + ev.comments,
        title: truncate(ev.title, 120),
        quote: truncate(ev.quote ?? "", 220),
      }));
    try {
      const { data } = await codexJson(
        {
          task: `judge(${c.name.slice(0, 30)})`,
          prompt: judgePrompt(
            c.name,
            c.summary,
            {
              distinctAuthors: c.distinctAuthors,
              platforms: c.platforms,
              engagement: c.engagement,
              voices: c.voices,
              recencyRatio: Number(c.recencyRatio.toFixed(2)),
              topThreadShare: Number(c.topItemShare.toFixed(2)),
              paidIntentPosts: c.paid?.count ?? 0,
              paidMedianBudgetUsd: c.paid?.medianBudgetUsd ?? 0,
            },
            evidencePayload
          ),
          effort: settings.ai.efforts.judge,
          schema: JJudge,
          timeoutMs: 25 * 60_000,
          signal,
        },
        ZJudge
      );
      run("UPDATE clusters SET judge_json=? WHERE id=?", JSON.stringify(data), c.id);
      engine = "ai";
      judgedCount++;
      onProgress(judgedCount, toJudge.length);
    } catch (err) {
      if (signal?.aborted) throw err;
      log(
        `AI judge unavailable for "${c.name.slice(0, 40)}" (${err instanceof Error ? err.message.slice(0, 120) : err})`,
        "warn"
      );
      break; // codex is down/limited — don't hammer it for every cluster
    }
  }

  // ---- scores + tiers ----
  let validatedCount = 0;
  for (const c of computed) {
    const judge = jsonOrNull<{ painIntensity: number; wtpEvidence: number; verdict: string }>(
      get<{ judge_json: string | null }>("SELECT judge_json FROM clusters WHERE id=?", c.id)?.judge_json
    );

    const voicesScore = Math.min(1, Math.log10(c.voices + 1) / 4); // 10k voices ≈ 1.0
    const platformScore = Math.min(1, c.platforms.length / 4);
    const recencyScore = c.recencyRatio;
    const growthScore = Math.min(1, Math.max(0, c.growth));
    const paidScore = paidIntentScore(c.paid);

    // Recency + growth carry real weight: the user wants what people complain
    // about NOW and what's rising, not durable-but-stale pain. Paid intent
    // (hiring posts with budgets) is the strongest per-unit signal we have.
    let demandScore: number;
    if (judge) {
      demandScore =
        100 *
        (0.26 * voicesScore +
          0.12 * platformScore +
          0.11 * recencyScore +
          0.12 * growthScore +
          0.14 * (judge.painIntensity / 10) +
          0.13 * (judge.wtpEvidence / 10) +
          0.12 * paidScore);
    } else {
      demandScore =
        100 * (0.4 * voicesScore + 0.14 * platformScore + 0.17 * recencyScore + 0.17 * growthScore + 0.12 * paidScore);
    }

    const aiRejected = judge?.verdict === "rejected";
    const validated = c.gatePassed && !aiRejected;
    const t = settings.tiers;
    const tier = aiRejected
      ? "rejected"
      : !validated
        ? "insufficient"
        : c.voices >= t.goldVoices && c.platforms.length >= t.goldPlatforms
          ? "gold"
          : c.voices >= t.silverVoices
            ? "silver"
            : "bronze";
    if (validated) validatedCount++;

    run(
      "UPDATE clusters SET demand_score=?, tier=?, validated=? WHERE id=?",
      Math.round(demandScore * 10) / 10,
      tier,
      validated ? 1 : 0,
      c.id
    );
  }

  // ---- niche trend series (Wikipedia pageviews proxy) attached to the scan ----
  try {
    const scan = get<{ plan_json: string | null }>("SELECT plan_json FROM scans WHERE id=?", scanId);
    const plan = jsonOrNull<QueryPlan & { trends?: unknown }>(scan?.plan_json ?? null);
    if (plan?.wikipediaEntities?.length) {
      const trends = await topicTrends(plan.wikipediaEntities, signal);
      if (trends.length) {
        run("UPDATE scans SET plan_json=? WHERE id=?", JSON.stringify({ ...plan, trends }), scanId);
        log(`trend data attached for ${trends.map((t) => t.entity).join(", ")}`);
      }
    }
  } catch {
    /* trends are auxiliary — never fail the scan */
  }

  log(`demand gate: ${validatedCount} validated of ${computed.length} clusters (${judgedCount} AI-judged)`);
  return { validated: validatedCount, engine };
}
