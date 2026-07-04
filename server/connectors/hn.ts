import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson } from "../lib/http.ts";
import { stripHtml, truncate, nowSec } from "../lib/text.ts";

/** Hacker News via the keyless Algolia search API — stories AND comments. */

interface HnHit {
  objectID: string;
  title?: string;
  story_title?: string;
  story_text?: string;
  comment_text?: string;
  url?: string;
  points?: number;
  num_comments?: number;
  author?: string;
  created_at_i?: number;
  story_id?: number;
}

async function hnSearch(
  params: string,
  ctx: HarvestContext
): Promise<HnHit[]> {
  try {
    const res = await fetchJson<{ hits?: HnHit[] }>(
      `https://hn.algolia.com/api/v1/search?${params}`,
      { minIntervalMs: 300, cacheTtlMs: 15 * 60_000, signal: ctx.signal }
    );
    return res.hits ?? [];
  } catch (err) {
    ctx.log(`hn: search failed (${err instanceof Error ? err.message : err})`, "warn");
    return [];
  }
}

export const hn: Connector = {
  id: "hn",
  label: "Hacker News",
  weight: 0.18,
  status: () => "ready",

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const items: RawItem[] = [];
    const seen = new Set<string>();
    const since = nowSec() - ctx.settings.recencyWindowMonths * 30 * 86400;
    const numeric = `numericFilters=created_at_i>${since}`;

    const push = (hits: HnHit[], kind: "story" | "comment") => {
      for (const h of hits) {
        if (items.length >= ctx.limit) return;
        if (seen.has(h.objectID)) continue;
        seen.add(h.objectID);
        if (kind === "story") {
          if (!h.title) continue;
          items.push({
            source: "hn",
            externalId: h.objectID,
            url: `https://news.ycombinator.com/item?id=${h.objectID}`,
            title: h.title,
            body: truncate(stripHtml(h.story_text ?? ""), 2400),
            author: h.author ?? null,
            score: h.points ?? 0,
            comments: h.num_comments ?? 0,
            createdUtc: h.created_at_i ?? null,
          });
        } else {
          const text = stripHtml(h.comment_text ?? "");
          if (text.length < 80) continue; // skip one-liners
          items.push({
            source: "hn",
            externalId: h.objectID,
            url: `https://news.ycombinator.com/item?id=${h.objectID}`,
            title: `Comment on: ${h.story_title ?? "HN thread"}`,
            body: truncate(text, 2400),
            author: h.author ?? null,
            score: h.points ?? 1,
            comments: 0,
            createdUtc: h.created_at_i ?? null,
            meta: { kind: "comment", storyId: h.story_id },
          });
        }
      }
    };

    const queries = [...ctx.plan.painQueries.slice(0, 8), ...ctx.plan.keywords.slice(0, 3)];
    for (const q of queries) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      const enc = encodeURIComponent(q);
      push(await hnSearch(`query=${enc}&tags=story&hitsPerPage=100&${numeric}`, ctx), "story");
      if (items.length < ctx.limit) {
        push(await hnSearch(`query=${enc}&tags=comment&hitsPerPage=60&${numeric}`, ctx), "comment");
      }
    }

    // Ask HN is a dedicated pain well.
    if (items.length < ctx.limit && !ctx.signal?.aborted) {
      const kw = ctx.plan.keywords[0] ?? ctx.topic ?? "how do you deal with";
      push(
        await hnSearch(
          `query=${encodeURIComponent(kw)}&tags=ask_hn&hitsPerPage=60&${numeric}`,
          ctx
        ),
        "story"
      );
    }

    ctx.log(`hn: collected ${items.length} stories/comments`);
    return items;
  },
};
