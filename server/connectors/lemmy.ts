import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson } from "../lib/http.ts";
import { truncate } from "../lib/text.ts";

/** Lemmy (federated Reddit alternative) — lemmy.world public search API, no key. */

interface LemmyPostView {
  post: { id: number; name: string; body?: string; ap_id?: string; published?: string; nsfw?: boolean };
  creator?: { name?: string };
  counts?: { score?: number; comments?: number };
}

export const lemmy: Connector = {
  id: "lemmy",
  label: "Lemmy",
  weight: 0.05,
  status: () => "ready",

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const items: RawItem[] = [];
    const seen = new Set<number>();
    const queries = [...ctx.plan.keywords.slice(0, 3), ...ctx.plan.painQueries.slice(0, 4)];

    for (const q of queries) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      try {
        const res = await fetchJson<{ posts?: LemmyPostView[] }>(
          `https://lemmy.world/api/v3/search?q=${encodeURIComponent(
            q
          )}&type_=Posts&listing_type=All&sort=TopYear&limit=50`,
          { minIntervalMs: 900, cacheTtlMs: 60 * 60_000, signal: ctx.signal }
        );
        for (const pv of res.posts ?? []) {
          if (items.length >= ctx.limit) break;
          if (!pv.post?.name || pv.post.nsfw || seen.has(pv.post.id)) continue;
          seen.add(pv.post.id);
          items.push({
            source: "lemmy",
            externalId: String(pv.post.id),
            url: pv.post.ap_id ?? `https://lemmy.world/post/${pv.post.id}`,
            title: pv.post.name,
            body: truncate(pv.post.body ?? "", 2400),
            author: pv.creator?.name ?? null,
            score: pv.counts?.score ?? 0,
            comments: pv.counts?.comments ?? 0,
            createdUtc: pv.post.published ? Math.floor(Date.parse(pv.post.published) / 1000) : null,
          });
        }
      } catch (err) {
        ctx.log(`lemmy: search failed (${err instanceof Error ? err.message : err})`, "warn");
      }
    }

    ctx.log(`lemmy: collected ${items.length} posts`);
    return items;
  },
};
