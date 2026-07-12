import { all, get, run, jsonOrNull, transaction } from "../db.ts";
import { codexJson } from "../ai/codex.ts";
import { briefPrompt, type BriefEvidenceInput } from "../ai/prompts.ts";
import { ZBrief, JBrief, type Brief } from "../ai/schemas.ts";
import { nowSec, truncate } from "../lib/text.ts";
import { fingerprint, cosine, DUPLICATE_THRESHOLD, type Fingerprint } from "../lib/similarity.ts";
import { selectDiverseEvidence } from "../lib/evidence.ts";
import type { AppSettings } from "../settings.ts";
import type { JudgeVerdict } from "../ai/schemas.ts";

export class DuplicateOpportunityError extends Error {
  constructor(
    public duplicateOf: { id: number; title: string },
    public similarity: number
  ) {
    super(
      `this cluster describes the same problem as existing opportunity #${duplicateOf.id} "${duplicateOf.title}" (similarity ${(similarity * 100).toFixed(0)}%)`
    );
  }
}

function clusterFingerprint(clusterId: number): Fingerprint {
  const c = get<{ name: string; summary: string | null; category: string | null; persona: string | null }>(
    "SELECT name, summary, category, persona FROM clusters WHERE id=?",
    clusterId
  );
  const statements = all<{ statement: string }>(
    `SELECT p.statement FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id
     WHERE cp.cluster_id=? LIMIT 10`,
    clusterId
  ).map((r) => r.statement);
  return fingerprint([c?.name ?? "", c?.summary ?? "", c?.category ?? "", c?.persona ?? "", ...statements]);
}

/** Most-similar existing opportunity from a DIFFERENT cluster (any scan). */
export function findDuplicateOpportunity(
  clusterId: number
): { id: number; title: string; similarity: number } | null {
  const existing = all<{ id: number; title: string; cluster_id: number }>(
    "SELECT id, title, cluster_id FROM opportunities WHERE cluster_id != ?",
    clusterId
  );
  if (existing.length === 0) return null;
  const fp = clusterFingerprint(clusterId);
  let best: { id: number; title: string; similarity: number } | null = null;
  for (const opp of existing) {
    const sim = cosine(fp, clusterFingerprint(opp.cluster_id));
    if (!best || sim > best.similarity) best = { id: opp.id, title: opp.title, similarity: sim };
  }
  return best && best.similarity >= DUPLICATE_THRESHOLD ? best : null;
}

interface ClusterRow {
  id: number;
  scan_id: number;
  name: string;
  summary: string | null;
  distinct_authors: number;
  platform_list_json: string | null;
  judge_json: string | null;
  paid_intent_json: string | null;
  demand_score: number;
  validated: number;
  engagement: number;
}

function marketContextFor(scanId: number, clusterId: number): string[] {
  const clusterFp = clusterFingerprint(clusterId);
  const candidates: { label: string; fp: Fingerprint }[] = [];
  const marketItems = all<{ source: string; title: string; body: string }>(
    `SELECT source, title, body FROM items WHERE scan_id=? AND meta_json LIKE '%"kind":"market"%' LIMIT 100`,
    scanId
  );
  for (const m of marketItems) {
    const label = m.source === "g2" ? "G2 category leader" : "Product Hunt launch";
    candidates.push({
      label: `${label}: ${m.title} — ${truncate(m.body, 100)}`,
      fp: fingerprint([m.title, m.body]),
    });
  }
  const apps = all<{ meta_json: string; title: string; body: string }>(
    `SELECT meta_json, title, body FROM items
     WHERE scan_id=? AND source IN ('playstore','appstore') AND meta_json IS NOT NULL LIMIT 200`,
    scanId
  );
  const seenApps = new Set<string>();
  for (const a of apps) {
    const meta = jsonOrNull<{ appTitle?: string }>(a.meta_json);
    if (meta?.appTitle && !seenApps.has(meta.appTitle)) {
      seenApps.add(meta.appTitle);
      candidates.push({
        label: `Existing app seen in low-star review evidence: ${meta.appTitle}`,
        fp: fingerprint([meta.appTitle, a.title, a.body]),
      });
    }
  }
  return candidates
    .map((candidate) => ({ ...candidate, relevance: cosine(clusterFp, candidate.fp) }))
    .filter((candidate) => candidate.relevance >= 0.08)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10)
    .map((candidate) => candidate.label);
}

function evidenceForBrief(clusterId: number): BriefEvidenceInput[] {
  const rows = all<{
    source: string;
    title: string;
    quote: string | null;
    score: number;
    comments: number;
    url: string;
    created_utc: number | null;
  }>(
    `SELECT DISTINCT i.source, i.title, p.quote, i.score, i.comments, i.url, i.created_utc
     FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id JOIN items i ON i.id=p.item_id
     WHERE cp.cluster_id=?`,
    clusterId
  );
  return selectDiverseEvidence(rows, 12).map((r) => ({
    source: r.source,
    title: truncate(r.title, 120),
    quote: truncate(r.quote ?? "", 200),
    engagement: r.score + r.comments,
    url: r.url,
  }));
}

export function renderBriefMd(brief: Brief, cluster: ClusterRow, evidence: BriefEvidenceInput[]): string {
  const platforms = jsonOrNull<string[]>(cluster.platform_list_json) ?? [];
  const paid = jsonOrNull<{ count: number; medianBudgetUsd: number; totalBudgetUsd: number }>(cluster.paid_intent_json);
  const lines: string[] = [
    `# ${brief.title}`,
    ``,
    `> ${brief.oneLiner}`,
    ``,
    `**Validated problem:** ${cluster.name}  `,
    `**Demand evidence:** ${cluster.distinct_authors} observed distinct authors · ${cluster.engagement.toLocaleString()} normalized engagement units · ${platforms.length} platforms (${platforms.join(", ")}) · demand score ${cluster.demand_score}/100`,
    ``,
    `## Validation ladder`,
    `What this brief does and does not prove — climb the rungs before betting months on it:`,
    ``,
    `- [x] **Online pain validated** — ${cluster.distinct_authors} distinct observed authors across ${platforms.length} platforms passed the configured gate and skeptical AI judge (linked below)`,
    paid && paid.count > 0
      ? `- [x] **Paid intent detected** — ${paid.count} hiring post${paid.count === 1 ? "" : "s"} asking to pay for this${paid.medianBudgetUsd ? ` (median budget ~$${paid.medianBudgetUsd.toLocaleString()})` : ""}`
      : `- [ ] **Paid intent** — no hiring posts matched this problem in the harvested sources`,
    `- [ ] **Customer interviews** — talk to 5-10 of the people quoted in the evidence trail`,
    `- [ ] **Landing-page interest** — test the one-liner against real traffic`,
    `- [ ] **Pre-orders / pilot payments** — the only rung that proves pricing`,
    ``,
    `## Problem`,
    brief.problem,
    ``,
    `## Target user`,
    brief.targetUser,
    ``,
    `## MVP (4–6 weeks)`,
    ...brief.mvpFeatures.map((f, i) => `${i + 1}. ${f}`),
    ``,
    `## Differentiation`,
    brief.differentiation,
    ``,
    `## Monetization (hypothesis — untested until the pre-order rung)`,
    brief.monetization,
    ``,
    `## Go-to-market (first 100 customers)`,
    ...brief.gtm.map((g) => `- ${g}`),
    ``,
    `## Competition`,
    ...(brief.competitors.length
      ? brief.competitors.map((c) => `- **${c.name}** — ${c.note}`)
      : ["- No direct competitors visible in the harvested evidence."]),
    ``,
    `## Risks`,
    ...brief.risks.map((r) => `- ${r}`),
    ``,
    `## Why now`,
    brief.whyNow || "—",
    ``,
    `## 90-day success metrics`,
    ...brief.successMetrics.map((m) => `- ${m}`),
    ``,
    `## Evidence trail`,
    ...evidence.map(
      (e) => `- [${e.source}] "${e.quote || e.title}" (${e.engagement} engagement) — ${e.url}`
    ),
    ``,
    `---`,
    `*Generated by Lodestone from real harvested evidence. Every quote above links to its source.*`,
  ];
  return lines.join("\n");
}

export async function generateBrief(
  clusterId: number,
  settings: AppSettings,
  signal: AbortSignal | undefined,
  steer?: string,
  force = false
): Promise<{ id: number; title: string }> {
  const cluster = get<ClusterRow>(
    `SELECT id, scan_id, name, summary, distinct_authors, platform_list_json, judge_json, paid_intent_json,
            demand_score, validated, engagement
     FROM clusters WHERE id=?`,
    clusterId
  );
  if (!cluster) throw new Error(`cluster ${clusterId} not found`);
  if (!settings.ai.enabled) throw new Error("AI engine is disabled in Settings — briefs require it");
  const storedJudge = jsonOrNull<JudgeVerdict>(cluster.judge_json);
  if (!cluster.validated || storedJudge?.verdict !== "validated") {
    throw new Error("briefs require a gate-passing cluster with an explicit validated judge verdict");
  }

  if (!force) {
    const dup = findDuplicateOpportunity(clusterId);
    if (dup) throw new DuplicateOpportunityError({ id: dup.id, title: dup.title }, dup.similarity);
  }

  const judge = storedJudge;
  const evidence = evidenceForBrief(clusterId);
  if (evidence.length === 0) throw new Error("briefs require a non-empty cluster evidence trail");
  const platforms = jsonOrNull<string[]>(cluster.platform_list_json) ?? [];

  const { data } = await codexJson(
    {
      task: `brief(${cluster.name.slice(0, 30)})`,
      prompt: briefPrompt(
        cluster.name,
        cluster.summary ?? "",
        { buyerPersona: judge.buyerPersona, competition: judge.competition, whyNow: judge.whyNow },
        { distinctAuthors: cluster.distinct_authors, engagement: cluster.engagement, platforms },
        evidence,
        marketContextFor(cluster.scan_id, cluster.id),
        steer
      ),
      effort: settings.ai.efforts.brief,
      schema: JBrief,
      timeoutMs: 25 * 60_000,
      signal,
    },
    ZBrief
  );

  if (!/hypoth|test|validat|assum/i.test(data.monetization)) {
    throw new Error("AI brief did not label pricing as an unvalidated hypothesis");
  }

  const md = renderBriefMd(data, cluster, evidence);
  const id = transaction(() => {
    const existing = get<{ id: number }>("SELECT id FROM opportunities WHERE cluster_id=?", clusterId);
    if (existing) {
      run(
        `UPDATE opportunities SET title=?, one_liner=?, brief_md=?, brief_json=?, created_at=? WHERE id=?`,
        data.title.slice(0, 160),
        data.oneLiner.slice(0, 300),
        md,
        JSON.stringify(data),
        nowSec(),
        existing.id
      );
      return existing.id;
    }
    return run(
      `INSERT INTO opportunities (scan_id, cluster_id, title, one_liner, brief_md, brief_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      cluster.scan_id,
      clusterId,
      data.title.slice(0, 160),
      data.oneLiner.slice(0, 300),
      md,
      JSON.stringify(data),
      nowSec()
    ).lastId;
  });
  return { id, title: data.title };
}

export async function synthesizeBriefs(
  scanId: number,
  settings: AppSettings,
  signal: AbortSignal | undefined,
  log: (msg: string, type?: "log" | "warn") => void,
  onProgress: (done: number, total: number) => void
): Promise<{ briefs: number }> {
  // Fetch extra candidates so duplicate-skips don't shrink the brief count.
  const candidates = all<{ id: number; name: string }>(
    `SELECT id, name FROM clusters WHERE scan_id=? AND validated=1 ORDER BY demand_score DESC LIMIT ?`,
    scanId,
    settings.briefsPerScan * 3
  );
  if (candidates.length === 0) {
    log("no validated clusters — no opportunity briefs to write");
    return { briefs: 0 };
  }
  if (!settings.ai.enabled) {
    log("AI disabled — skipping opportunity briefs (they require the reasoning engine)", "warn");
    return { briefs: 0 };
  }

  let done = 0;
  for (const cluster of candidates) {
    if (done >= settings.briefsPerScan) break;
    if (signal?.aborted) throw new Error("aborted");

    // Cross-scan duplicate guard: the same problem rediscovered by a later
    // scan must not mint a second product brief.
    const dup = findDuplicateOpportunity(cluster.id);
    if (dup) {
      log(
        `skipping "${cluster.name.slice(0, 50)}" — same problem as opportunity #${dup.id} "${dup.title}" (${(dup.similarity * 100).toFixed(0)}% match)`
      );
      continue;
    }

    try {
      const { title } = await generateBrief(cluster.id, settings, signal);
      done++;
      log(`brief ready: "${title}"`);
      onProgress(done, Math.min(candidates.length, settings.briefsPerScan));
    } catch (err) {
      if (signal?.aborted) throw err;
      log(
        `brief failed for "${cluster.name.slice(0, 40)}" (${err instanceof Error ? err.message.slice(0, 140) : err})`,
        "warn"
      );
      break; // AI likely unavailable — stop instead of hammering
    }
  }
  return { briefs: done };
}
