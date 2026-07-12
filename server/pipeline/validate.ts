import { all, run, get, jsonOrNull } from "../db.ts";
import { codexJson } from "../ai/codex.ts";
import { judgePrompt, type JudgeEvidenceInput } from "../ai/prompts.ts";
import { ZJudge, JJudge } from "../ai/schemas.ts";
import { nowSec, truncate } from "../lib/text.ts";
import { normalizeEngagement, paidIntentScore, type PaidIntentSummary } from "../lib/demand.ts";
import { assignPaidIntentMatches } from "../lib/paidintent.ts";
import { selectDiverseEvidence } from "../lib/evidence.ts";
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

function lastMonthKeys(count: number, nowSecValue: number): string[] {
  const now = new Date(nowSecValue * 1000);
  const out: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const COMPARABLE_GROWTH_SOURCES = new Set(["github", "hn", "reddit", "lemmy", "youtube"]);

export async function validateClusters(
  scanId: number,
  settings: AppSettings,
  signal: AbortSignal | undefined,
  log: (msg: string, type?: "log" | "warn") => void,
  onProgress: (judged: number, toJudge: number) => void
): Promise<{ validated: number; engine: "ai" | "heuristic" | "mixed" | "none" }> {
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
    text: string;
    url: string;
    budgetAmount: number | null;
    budgetCurrency: "USD" | "GBP" | "EUR" | null;
    budgetKind: "fixed" | "hourly" | "monthly" | "weekly" | null;
    budgetUsd: number | null;
  }
  const paidPosts: PaidPost[] = all<{ id: number; title: string; body: string; url: string; meta_json: string }>(
    `SELECT id, title, body, url, meta_json FROM items WHERE scan_id=? AND meta_json LIKE '%"kind":"paid-intent"%'`,
    scanId
  ).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    text: `${r.title} ${r.body.slice(0, 800)}`,
    url: r.url,
    budgetAmount:
      jsonOrNull<{ budgetAmount?: number | null; budgetUsd?: number | null }>(r.meta_json)?.budgetAmount ??
      jsonOrNull<{ budgetUsd?: number | null }>(r.meta_json)?.budgetUsd ??
      null,
    budgetCurrency:
      (jsonOrNull<{ budgetCurrency?: "USD" | "GBP" | "EUR" | null }>(r.meta_json)?.budgetCurrency ??
        (jsonOrNull<{ budgetUsd?: number | null }>(r.meta_json)?.budgetUsd ? "USD" : null)),
    budgetKind:
      jsonOrNull<{ budgetKind?: "fixed" | "hourly" | "monthly" | "weekly" | null }>(r.meta_json)
        ?.budgetKind ?? null,
    budgetUsd: jsonOrNull<{ budgetUsd?: number | null }>(r.meta_json)?.budgetUsd ?? null,
  }));
  if (paidPosts.length > 0) log(`paid-intent pool: ${paidPosts.length} hiring posts to match against clusters`);

  const statementsByCluster = new Map<number, string[]>();
  for (const cluster of clusters) {
    statementsByCluster.set(
      cluster.id,
      all<{ statement: string }>(
        `SELECT p.statement FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id
         WHERE cp.cluster_id=? ORDER BY p.id LIMIT 20`,
        cluster.id
      ).map((row) => row.statement)
    );
  }
  const paidMatches = assignPaidIntentMatches(
    clusters.map((cluster) => ({
      id: cluster.id,
      text: [
        cluster.name,
        cluster.name,
        cluster.category ?? "",
        cluster.persona ?? "",
        ...(statementsByCluster.get(cluster.id) ?? []),
      ].join(" "),
    })),
    paidPosts
  );
  const paidByCluster = new Map<number, typeof paidMatches>();
  for (const match of paidMatches) {
    const list = paidByCluster.get(match.clusterId) ?? [];
    list.push(match);
    paidByCluster.set(match.clusterId, list);
  }
  if (paidPosts.length > 0) {
    log(
      `paid-intent matching: ${paidMatches.length}/${paidPosts.length} budgeted posts assigned exclusively to ${paidByCluster.size} clusters`
    );
  }

  interface Computed {
    id: number;
    name: string;
    summary: string;
    distinctAuthors: number;
    platforms: string[];
    engagement: number;
    topItemShare: number;
    paid: PaidIntentSummary | null;
    recencyRatio: number;
    datedRatio: number;
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
    const timeline = new Map(lastMonthKeys(24, now).map((key) => [key, 0]));

    for (const ev of evidence) {
      if (ev.author_hash) authors.add(ev.author_hash);
      if (ev.source !== "producthunt") platforms.add(ev.source);
      if (ev.created_utc) {
        dated++;
        if (ev.created_utc >= yearAgo) recent++;
        const k = monthKey(ev.created_utc);
        if (timeline.has(k)) {
          timeline.set(k, (timeline.get(k) ?? 0) + 1);
        }
      }
    }

    // Normalized + viral/platform-capped engagement (see lib/demand.ts).
    const eng = normalizeEngagement(
      evidence.map((ev) => ({ source: ev.source, engagement: Math.max(0, ev.score) + Math.max(0, ev.comments) }))
    );
    const engagement = eng.counted;

    // Each budgeted hiring post is assigned to at most one clear best cluster.
    const matched = paidByCluster.get(cluster.id) ?? [];
    const comparableFixedUsd = matched
      .map((match) => match.post)
      .filter((post) => post.budgetCurrency === "USD" && post.budgetKind === "fixed")
      .map((post) => post.budgetUsd)
      .filter((budget): budget is number => budget !== null && budget > 0)
      .sort((a, b) => a - b);
    const paid: PaidIntentSummary | null = matched.length
      ? {
          count: matched.length,
          budgetCount: comparableFixedUsd.length,
          totalBudgetUsd: comparableFixedUsd.reduce((sum, budget) => sum + budget, 0),
          medianBudgetUsd: comparableFixedUsd.length
            ? comparableFixedUsd.length % 2
              ? comparableFixedUsd[Math.floor(comparableFixedUsd.length / 2)]!
              : Math.round(
                  (comparableFixedUsd[comparableFixedUsd.length / 2 - 1]! +
                    comparableFixedUsd[comparableFixedUsd.length / 2]!) /
                    2
                )
            : 0,
        }
      : null;

    const distinctAuthors = authors.size;
    const recencyRatio = evidence.length > 0 ? recent / evidence.length : 0;
    const datedRatio = evidence.length > 0 ? dated / evidence.length : 0;
    // Compare like-for-like sources with approximately complete 12-month access.
    const sixMonthsAgo = now - 182 * 86400;
    const twelveMonthsAgo = now - 365 * 86400;
    const sourceWindows = new Map<string, { last6: number; prior6: number }>();
    for (const ev of evidence) {
      if (!ev.created_utc || !COMPARABLE_GROWTH_SOURCES.has(ev.source)) continue;
      const counts = sourceWindows.get(ev.source) ?? { last6: 0, prior6: 0 };
      if (ev.created_utc >= sixMonthsAgo) counts.last6++;
      else if (ev.created_utc >= twelveMonthsAgo) counts.prior6++;
      sourceWindows.set(ev.source, counts);
    }
    const comparableGrowth = [...sourceWindows.values()]
      .filter(({ last6, prior6 }) => last6 + prior6 >= 3)
      .map(({ last6, prior6 }) => Math.max(-1, Math.min(2, (last6 + 1) / (prior6 + 1) - 1)));
    const growth = comparableGrowth.length
      ? comparableGrowth.reduce((sum, value) => sum + value, 0) / comparableGrowth.length
      : 0;

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
      {
        key: "dated",
        label: "dated evidence coverage",
        value: Math.round(datedRatio * 100),
        threshold: Math.round(gate.minDatedRatio * 100),
        pass: datedRatio >= gate.minDatedRatio,
      },
    ];
    const gatePassed = checks.every((c) => c.pass);

    // persist metrics + timeline immediately (judge fills the rest later)
    const timelineArr = [...timeline.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    run(
      `UPDATE clusters SET distinct_authors=?, platforms=?, platform_list_json=?, engagement=?, voices=?,
       recency_ratio=?, dated_ratio=?, growth_rate=?, evidence_items=?, metrics_version=2,
       timeline_json=?, gate_json=?, paid_intent_json=? WHERE id=?`,
      distinctAuthors,
      platforms.size,
      JSON.stringify([...platforms]),
      engagement,
      distinctAuthors,
      recencyRatio,
      datedRatio,
      growth,
      evidence.length,
      JSON.stringify(timelineArr),
      JSON.stringify({
        checks,
        passed: gatePassed,
        engagementRaw: eng.raw,
        engagementNormalized: eng.normalized,
        engagementBySource: eng.bySource,
        viralCapApplied: eng.viralCapApplied,
        platformCapApplied: eng.platformCapApplied,
        topItemShare: Number(eng.topItemShare.toFixed(2)),
      }),
      paid
        ? JSON.stringify({
            ...paid,
            samples: matched.slice(0, 5).map((match) => ({
              title: truncate(match.post.title, 120),
              budgetAmount: match.post.budgetAmount,
              budgetCurrency: match.post.budgetCurrency,
              budgetKind: match.post.budgetKind,
              budgetUsd: match.post.budgetUsd,
              url: match.post.url,
              matchScore: Number(match.score.toFixed(3)),
              sharedTerms: match.sharedTerms,
            })),
          })
        : null,
      cluster.id
    );

    computed.push({
      id: cluster.id,
      name: cluster.name,
      summary: cluster.summary ?? "",
      distinctAuthors,
      platforms: [...platforms],
      engagement,
      topItemShare: eng.topItemShare,
      paid,
      recencyRatio,
      datedRatio,
      growth,
      gatePassed,
      checks,
      evidence,
    });
  }

  // ---- AI demand judge for gate-passing clusters ----
  const toJudge = computed
    .filter((c) => c.gatePassed)
    .sort((a, b) => b.distinctAuthors - a.distinctAuthors)
    .slice(0, settings.judgedClustersPerScan);
  let judgedCount = 0;

  for (const c of toJudge) {
    if (signal?.aborted) throw new Error("aborted");
    if (!settings.ai.enabled) break;
    const evidencePayload: JudgeEvidenceInput[] = selectDiverseEvidence(c.evidence, 15)
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
              recencyRatio: Number(c.recencyRatio.toFixed(2)),
              datedRatio: Number(c.datedRatio.toFixed(2)),
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

    const peopleScore = Math.min(1, Math.log10(c.distinctAuthors + 1) / Math.log10(201));
    const engagementScore = Math.min(1, Math.log10(c.engagement + 1) / 4);
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
        (0.22 * peopleScore +
          0.14 * engagementScore +
          0.1 * platformScore +
          0.1 * recencyScore +
          0.08 * growthScore +
          0.14 * (judge.painIntensity / 10) +
          0.1 * (judge.wtpEvidence / 10) +
          0.12 * paidScore);
    } else {
      demandScore =
        100 *
        (0.34 * peopleScore +
          0.2 * engagementScore +
          0.14 * platformScore +
          0.14 * recencyScore +
          0.08 * growthScore +
          0.1 * paidScore);
    }

    const aiRejected = judge?.verdict === "rejected";
    const aiValidated = judge?.verdict === "validated";
    const validated = c.gatePassed && aiValidated;
    const t = settings.tiers;
    const tier = aiRejected
      ? "rejected"
      : c.gatePassed && !judge
        ? "unjudged"
      : !validated
        ? "insufficient"
        : c.distinctAuthors >= t.goldAuthors && c.platforms.length >= t.goldPlatforms
          ? "gold"
          : c.distinctAuthors >= t.silverAuthors
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
  const engine =
    toJudge.length === 0
      ? "none"
      : judgedCount === toJudge.length
        ? "ai"
        : judgedCount > 0
          ? "mixed"
          : "heuristic";
  return { validated: validatedCount, engine };
}
