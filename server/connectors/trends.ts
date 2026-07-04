import { fetchJson } from "../lib/http.ts";

/**
 * Trend signals (not a pain connector):
 * - Wikipedia Pageviews API (keyless, reliable) as an interest-over-time proxy
 *   for the niche's core entities.
 * - The complaint-frequency timeline per cluster is computed from our own
 *   harvested evidence in the validate stage — the most honest demand curve.
 */

export interface TrendSeries {
  entity: string;
  labels: string[]; // YYYY-MM
  values: number[]; // monthly views
  slope: number; // last-6-months vs previous-6-months ratio - 1 (e.g. +0.4 = growing)
}

function ym(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function wikipediaTrend(entity: string, signal?: AbortSignal): Promise<TrendSeries | null> {
  const title = entity.trim().replace(/\s+/g, "_");
  if (!title) return null;
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); // first of this month
  const start = new Date(Date.UTC(end.getUTCFullYear() - 2, end.getUTCMonth(), 1));
  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/` +
    `${encodeURIComponent(title)}/monthly/${ym(start)}0100/${ym(end)}0100`;
  try {
    const res = await fetchJson<{ items?: { timestamp: string; views: number }[] }>(url, {
      minIntervalMs: 300,
      cacheTtlMs: 24 * 60 * 60_000,
      signal,
      headers: { Accept: "application/json" },
    });
    const rows = res.items ?? [];
    if (rows.length < 6) return null;
    const labels = rows.map((r) => `${r.timestamp.slice(0, 4)}-${r.timestamp.slice(4, 6)}`);
    const values = rows.map((r) => r.views);
    const half = 6;
    const recent = values.slice(-half).reduce((a, b) => a + b, 0);
    const prior = values.slice(-half * 2, -half).reduce((a, b) => a + b, 0) || 1;
    return { entity, labels, values, slope: recent / prior - 1 };
  } catch {
    return null;
  }
}

export async function topicTrends(entities: string[], signal?: AbortSignal): Promise<TrendSeries[]> {
  const out: TrendSeries[] = [];
  for (const entity of entities.slice(0, 3)) {
    const series = await wikipediaTrend(entity, signal);
    if (series) out.push(series);
  }
  return out;
}
