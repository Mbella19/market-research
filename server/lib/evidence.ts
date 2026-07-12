/**
 * Select a compact evidence sample without letting one platform or one viral
 * thread crowd out the rest. Input order is irrelevant.
 */
export function selectDiverseEvidence<T extends {
  source: string;
  created_utc: number | null;
  score: number;
  comments: number;
}>(rows: T[], limit: number, perSource = 4): T[] {
  if (limit <= 0 || rows.length === 0) return [];

  const ranked = [...rows].sort((a, b) => {
    const engagement = (b.score + b.comments) - (a.score + a.comments);
    if (engagement !== 0) return engagement;
    return (b.created_utc ?? 0) - (a.created_utc ?? 0);
  });
  const chosen: T[] = [];
  const used = new Set<T>();
  const bySource = new Map<string, number>();

  // First pass guarantees breadth across the available sources.
  for (const row of ranked) {
    if (chosen.length >= limit) break;
    if ((bySource.get(row.source) ?? 0) > 0) continue;
    chosen.push(row);
    used.add(row);
    bySource.set(row.source, 1);
  }

  // Include the newest dated item when the engagement-first pass missed it.
  const newest = [...ranked]
    .filter((row) => row.created_utc !== null)
    .sort((a, b) => (b.created_utc ?? 0) - (a.created_utc ?? 0))[0];
  if (newest && !used.has(newest) && chosen.length < limit) {
    chosen.push(newest);
    used.add(newest);
    bySource.set(newest.source, (bySource.get(newest.source) ?? 0) + 1);
  }

  for (const row of ranked) {
    if (chosen.length >= limit) break;
    if (used.has(row) || (bySource.get(row.source) ?? 0) >= perSource) continue;
    chosen.push(row);
    used.add(row);
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
  }
  return chosen;
}
