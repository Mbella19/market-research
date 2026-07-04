import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson } from "../lib/http.ts";
import { truncate, parseCount } from "../lib/text.ts";

/** Apple App Store — iTunes Search API + customer-reviews RSS (both keyless). */

interface ItunesApp {
  trackId: number;
  trackName: string;
  trackViewUrl?: string;
  userRatingCount?: number;
}

type RssLabel = { label?: string } | undefined;
interface RssEntry {
  author?: { name?: RssLabel };
  "im:rating"?: RssLabel;
  "im:voteSum"?: RssLabel;
  title?: RssLabel;
  content?: RssLabel;
  updated?: RssLabel;
  id?: RssLabel;
}

const label = (v: RssLabel): string => v?.label ?? "";

export const appstore: Connector = {
  id: "appstore",
  label: "App Store",
  weight: 0.07,
  status: () => "ready",

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const items: RawItem[] = [];
    const apps: ItunesApp[] = [];
    const seenApp = new Set<number>();

    for (const term of ctx.plan.storeTerms.slice(0, 3)) {
      if (ctx.signal?.aborted) break;
      try {
        const res = await fetchJson<{ results?: ItunesApp[] }>(
          `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&limit=6&country=us`,
          { minIntervalMs: 600, cacheTtlMs: 6 * 60 * 60_000, signal: ctx.signal }
        );
        const ranked = (res.results ?? [])
          .filter((a) => (a.userRatingCount ?? 0) > 200) // apps with real review volume
          .sort((a, b) => (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0));
        for (const app of ranked.slice(0, 3)) {
          if (!seenApp.has(app.trackId) && apps.length < 8) {
            seenApp.add(app.trackId);
            apps.push(app);
          }
        }
      } catch (err) {
        ctx.log(`appstore: search "${term}" failed (${err instanceof Error ? err.message : err})`, "warn");
      }
    }

    for (const app of apps) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      for (const page of [1, 2, 3, 4]) {
        if (items.length >= ctx.limit) break;
        try {
          const res = await fetchJson<{ feed?: { entry?: RssEntry | RssEntry[] } }>(
            `https://itunes.apple.com/us/rss/customerreviews/page=${page}/id=${app.trackId}/sortby=mostrecent/json`,
            { minIntervalMs: 600, cacheTtlMs: 6 * 60 * 60_000, signal: ctx.signal }
          );
          const raw = res.feed?.entry;
          const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
          for (const entry of entries) {
            if (items.length >= ctx.limit) break;
            const rating = Number(label(entry["im:rating"]));
            const text = label(entry.content);
            if (!rating || rating > 3 || text.length < 60) continue;
            const reviewId = label(entry.id) || `${app.trackId}-${page}-${items.length}`;
            items.push({
              source: "appstore",
              externalId: reviewId,
              url: app.trackViewUrl ?? `https://apps.apple.com/us/app/id${app.trackId}`,
              title: `${app.trackName} — ${rating}★ App Store review: ${truncate(label(entry.title), 80)}`,
              body: truncate(text, 1500),
              author: label(entry.author?.name) || null,
              score: parseCount(label(entry["im:voteSum"])),
              comments: 0,
              createdUtc: label(entry.updated) ? Math.floor(Date.parse(label(entry.updated)) / 1000) : null,
              meta: { appId: app.trackId, appTitle: app.trackName, rating },
            });
          }
        } catch {
          break; // no more review pages for this app
        }
      }
    }

    ctx.log(`appstore: collected ${items.length} low-star reviews`);
    return items;
  },
};
