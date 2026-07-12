/**
 * Demand-score arithmetic — pure functions, no DB, fully unit-testable.
 *
 * Fixes the two analytical biases of the v1 score:
 *  1. Engagement units are NOT equivalent across platforms (a Twitter like is
 *     cheaper than a GitHub 👍) → per-source unit weights normalize to rough
 *     "reddit-upvote equivalents".
 *  2. One viral thread could dominate a cluster → per-item winsorizing plus a
 *     single-platform share cap ensure no single thread or platform can carry
 *     a validation on its own.
 */

/** Engagement-unit weight per source (≈ how much intent one unit signals). */
export const SOURCE_ENGAGEMENT_WEIGHT: Record<string, number> = {
  reddit: 1,
  hn: 1.2,
  github: 2.5, // a 👍 on a feature request is deliberate, rare, on-topic
  stackexchange: 1.5,
  lemmy: 1,
  youtube: 0.5,
  twitter: 0.4, // likes are the cheapest signal on the list
  playstore: 1.5, // review helpful-votes
  appstore: 1.5,
  producthunt: 0.5,
  g2: 0, // market context only — never demand evidence
};

export interface EngagementItem {
  source: string;
  engagement: number;
}

export interface NormalizedEngagement {
  /** Straight sum of raw platform units (kept for transparency). */
  raw: number;
  /** After per-source unit weights, before caps. */
  normalized: number;
  /** What the gate/score actually count: normalized + viral & platform caps. */
  counted: number;
  viralCapApplied: boolean;
  platformCapApplied: boolean;
  /** Share of counted engagement carried by the single biggest item (0..1). */
  topItemShare: number;
  /** Final counted contribution by source, after every cap. */
  bySource: Record<string, number>;
}

export function normalizeEngagement(items: EngagementItem[]): NormalizedEngagement {
  const weighted = items.map((it) => ({
    source: it.source,
    value: Math.max(0, it.engagement) * (SOURCE_ENGAGEMENT_WEIGHT[it.source] ?? 1),
  }));
  const raw = items.reduce((s, it) => s + Math.max(0, it.engagement), 0);
  const normalized = weighted.reduce((s, w) => s + w.value, 0);

  // Winsorize: one item may not exceed 3× the median nonzero item, nor 35% of
  // the cluster total. The 35% arm catches the "single viral thread plus
  // silent comments" shape where the median is the outlier itself.
  const nonzero = weighted
    .map((w) => w.value)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const median = nonzero.length
    ? nonzero.length % 2
      ? nonzero[Math.floor(nonzero.length / 2)]!
      : (nonzero[nonzero.length / 2 - 1]! + nonzero[nonzero.length / 2]!) / 2
    : 0;
  const itemCap = Math.min(median * 3, normalized * 0.35);
  let viralCapApplied = false;
  const capped = weighted.map((w) => {
    if (w.value > itemCap) {
      viralCapApplied = true;
      return { ...w, value: itemCap };
    }
    return w;
  });

  // Platform-share cap: with 2+ platforms present, no single platform may
  // contribute more than 60% of counted engagement (x ≤ 1.5 × rest).
  const perSource = new Map<string, number>();
  for (const w of capped) perSource.set(w.source, (perSource.get(w.source) ?? 0) + w.value);
  const originalPerSource = new Map(perSource);
  let platformCapApplied = false;
  const sourceScale = new Map<string, number>();
  for (const source of perSource.keys()) sourceScale.set(source, 1);
  if (perSource.size >= 2) {
    for (const [src, v] of originalPerSource) {
      const rest = [...originalPerSource.entries()].reduce((s, [k, x]) => (k === src ? s : s + x), 0);
      const maxAllowed = 1.5 * rest;
      if (rest > 0 && v > maxAllowed) {
        perSource.set(src, maxAllowed);
        sourceScale.set(src, maxAllowed / v);
        platformCapApplied = true;
      }
    }
  }
  const finalItems = capped.map((item) => ({
    ...item,
    value: item.value * (sourceScale.get(item.source) ?? 1),
  }));
  const counted = finalItems.reduce((sum, item) => sum + item.value, 0);
  const topItem = finalItems.reduce((m, item) => Math.max(m, item.value), 0);

  return {
    raw,
    normalized: Math.round(normalized),
    counted: Math.round(counted),
    viralCapApplied,
    platformCapApplied,
    topItemShare: counted > 0 ? Math.min(1, topItem / counted) : 0,
    bySource: Object.fromEntries([...perSource].map(([source, value]) => [source, Math.round(value)])),
  };
}

export interface PaidIntentSummary {
  count: number;
  budgetCount?: number;
  totalBudgetUsd: number;
  medianBudgetUsd: number;
}

/** 0..1 paid-intent axis: hiring posts matched to this cluster, budget-boosted. */
export function paidIntentScore(paid: PaidIntentSummary | null): number {
  if (!paid || paid.count <= 0) return 0;
  const base = Math.min(1, paid.count / 5);
  return paid.medianBudgetUsd >= 100 ? Math.min(1, base + 0.25) : base;
}
