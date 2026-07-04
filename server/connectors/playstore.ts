import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { truncate } from "../lib/text.ts";
import { throttled } from "../lib/ratelimit.ts";

/** Google Play 1–3★ reviews of the apps this audience already uses — complaint mining. */

export const playstore: Connector = {
  id: "playstore",
  label: "Google Play",
  weight: 0.1,
  status: () => "ready",

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const items: RawItem[] = [];
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const gplay: any = (await import("google-play-scraper")).default;
      const terms = ctx.plan.storeTerms.slice(0, 3);
      const apps: any[] = [];
      const seenApp = new Set<string>();

      for (const term of terms) {
        if (ctx.signal?.aborted) break;
        try {
          const found: any[] = await throttled("play.google.com", 1200, () =>
            gplay.search({ term, num: 6 })
          );
          for (const app of found ?? []) {
            if (!seenApp.has(app.appId) && apps.length < 10) {
              seenApp.add(app.appId);
              apps.push(app);
            }
          }
        } catch (err) {
          ctx.log(`playstore: search "${term}" failed (${err instanceof Error ? err.message : err})`, "warn");
        }
      }

      for (const app of apps) {
        if (items.length >= ctx.limit || ctx.signal?.aborted) break;
        try {
          // NEWEST keeps complaints about the app as it is TODAY (helpfulness skews old).
          const res: any = await throttled("play.google.com", 1200, () =>
            gplay.reviews({ appId: app.appId, sort: gplay.sort.NEWEST, num: 150 })
          );
          const reviews: any[] = res?.data ?? [];
          for (const review of reviews) {
            if (items.length >= ctx.limit) break;
            if ((review.score ?? 5) > 3) continue; // complaints only
            const text: string = review.text ?? "";
            if (text.length < 60) continue;
            items.push({
              source: "playstore",
              externalId: `${app.appId}-${review.id}`,
              url: review.url ?? app.url ?? `https://play.google.com/store/apps/details?id=${app.appId}`,
              title: `${app.title} — ${review.score}★ Play Store review`,
              body: truncate(text, 1500),
              author: review.userName ?? null,
              score: review.thumbsUp ?? 0,
              comments: 0,
              createdUtc: review.date ? Math.floor(Date.parse(review.date) / 1000) : null,
              meta: { appId: app.appId, appTitle: app.title, rating: review.score },
            });
          }
        } catch (err) {
          ctx.log(`playstore: reviews for ${app.appId} failed (${err instanceof Error ? err.message : err})`, "warn");
        }
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    } catch (err) {
      ctx.log(`playstore: unavailable (${err instanceof Error ? err.message : err}) — skipped`, "warn");
    }

    ctx.log(`playstore: collected ${items.length} low-star reviews`);
    return items;
  },
};
