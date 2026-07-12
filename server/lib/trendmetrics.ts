import { STOPWORDS } from "./text.ts";

export interface MetricTrendSignal {
  source: string;
  key: string;
  label: string;
  strength: number;
}

export interface TrendCandidate<T extends MetricTrendSignal = MetricTrendSignal> {
  id: number;
  label: string;
  tokens: Set<string>;
  signals: T[];
}

function keyTokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const raw of value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (raw.length < 3 && !["ai", "ml", "vr", "ar", "3d", "5g"].includes(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
  }
  return out;
}

function containment(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const token of small) if (big.has(token)) shared++;
  return shared / small.size;
}

function similarity(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]).size;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return 0.7 * containment(a, b) + 0.3 * (union ? shared / union : 0);
}

/** Greedy complete-link grouping prevents transitive A↔B↔C mega-clusters. */
export function groupTrendSignals<T extends MetricTrendSignal>(signals: T[]): TrendCandidate<T>[] {
  const tokens = signals.map((signal) => keyTokens(signal.key));
  const groups: number[][] = [];
  const ordered = signals.map((_, index) => index).sort((a, b) => signals[b]!.strength - signals[a]!.strength);
  for (const index of ordered) {
    let best: number[] | undefined;
    let bestAverage = 0;
    for (const group of groups) {
      const scores = group.map((member) => similarity(tokens[index]!, tokens[member]!));
      const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      if (Math.min(...scores) >= 0.58 && average > bestAverage) {
        best = group;
        bestAverage = average;
      }
    }
    if (best) best.push(index);
    else groups.push([index]);
  }

  return groups.map((indexes, groupIndex) => {
    const members = indexes.map((index) => signals[index]!).sort((a, b) => b.strength - a.strength);
    const named = members.find((member) => member.source !== "github") ?? members[0]!;
    return {
      id: groupIndex + 1,
      label: named.label,
      tokens: new Set(indexes.flatMap((index) => [...tokens[index]!])),
      signals: members,
    };
  });
}

export function trendCandidateValue(candidate: TrendCandidate): number {
  const spread = new Set(candidate.signals.map((signal) => signal.source)).size;
  return candidate.signals.reduce((sum, signal) => sum + signal.strength, 0) + spread;
}

export function trendMomentum(candidate: TrendCandidate): {
  score: number;
  status: "surging" | "rising" | "early";
  spread: number;
  strength: number;
} {
  const spread = new Set(candidate.signals.map((signal) => signal.source)).size;
  const best = Math.max(...candidate.signals.map((signal) => signal.strength));
  const mean = candidate.signals.reduce((sum, signal) => sum + signal.strength, 0) / candidate.signals.length;
  const confirmation = Math.min(1, Math.max(0, spread - 1) / 3);
  const strength = 0.5 * best + 0.2 * mean + 0.3 * confirmation;
  const score = Math.round(100 * strength * 10) / 10;
  const status = spread >= 2 && score >= 62 ? "surging" : score >= 32 ? "rising" : "early";
  return { score, status, spread, strength };
}
