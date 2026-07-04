import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson, HttpError } from "../lib/http.ts";
import { truncate } from "../lib/text.ts";

/**
 * X/Twitter recent search with the user's bearer token.
 * Verified live 2026-07-03: this project has a 2,000,000 posts/month read cap
 * (old Elevated tier), so we run several pain queries per scan at 100 results
 * each — still trivial against the cap, still 24h-cached. Recent search only
 * covers the LAST 7 DAYS (platform limit), so yields track this week's chatter.
 * Every failure degrades gracefully; the first 429 stops the scan's X calls.
 */

interface Tweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
  };
}

const PAIN_WORDS = `(frustrating OR nightmare OR annoying OR "wish there was" OR "is there a tool" OR "waste of time" OR hate OR manually)`;

export const twitter: Connector = {
  id: "twitter",
  label: "X / Twitter",
  weight: 0.06,
  status: (s) => (s.keys.twitterBearer ? "ready" : "needs-key"),

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const bearer = ctx.settings.keys.twitterBearer;
    if (!bearer) {
      ctx.log("twitter: no bearer token — skipped", "warn");
      return [];
    }

    // Several query shapes: pain phrases verbatim + keyword × pain-word groups.
    const queries: string[] = [];
    for (const kw of ctx.plan.keywords.slice(0, 3)) {
      queries.push(`${kw.slice(0, 60)} ${PAIN_WORDS} -is:retweet lang:en`);
    }
    for (const pq of ctx.plan.painQueries.slice(0, 5)) {
      queries.push(`"${pq.slice(0, 60)}" -is:retweet lang:en`);
    }
    if (queries.length === 0 && ctx.topic) {
      queries.push(`${ctx.topic.slice(0, 60)} ${PAIN_WORDS} -is:retweet lang:en`);
    }

    const items: RawItem[] = [];
    const seen = new Set<string>();
    for (const query of queries.slice(0, 8)) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      try {
        // Paginate up to 3 pages per query — the user's 2M/month cap makes
        // this trivial, and relevancy ordering surfaces engaged tweets first.
        let nextToken: string | undefined;
        for (let page = 0; page < 3; page++) {
          if (items.length >= ctx.limit || ctx.signal?.aborted) break;
          const res = await fetchJson<{ data?: Tweet[]; meta?: { next_token?: string } }>(
            `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(
              query
            )}&max_results=100&sort_order=relevancy&tweet.fields=public_metrics,created_at,author_id${
              nextToken ? `&next_token=${nextToken}` : ""
            }`,
            {
              headers: { Authorization: `Bearer ${bearer}` },
              minIntervalMs: 1500,
              retries: 0, // rate-limit handling is ours, not blind retries
              cacheTtlMs: 24 * 60 * 60_000,
              cacheKeyExtra: bearer.slice(-6),
              signal: ctx.signal,
            }
          );
          for (const tweet of res.data ?? []) {
            if (items.length >= ctx.limit) break;
            if (seen.has(tweet.id) || tweet.text.length < 50) continue;
            seen.add(tweet.id);
            const pm = tweet.public_metrics ?? {};
            items.push({
              source: "twitter",
              externalId: tweet.id,
              url: `https://x.com/i/status/${tweet.id}`,
              title: truncate(tweet.text, 120),
              body: truncate(tweet.text, 1000),
              author: tweet.author_id ?? null,
              score: (pm.like_count ?? 0) + (pm.retweet_count ?? 0) + (pm.quote_count ?? 0),
              comments: pm.reply_count ?? 0,
              createdUtc: tweet.created_at ? Math.floor(Date.parse(tweet.created_at) / 1000) : null,
            });
          }
          nextToken = res.meta?.next_token;
          if (!nextToken) break;
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) {
          ctx.log("twitter: this API tier has no search access (403) — skipped, scan continues", "warn");
          break;
        } else if (err instanceof HttpError && err.status === 429) {
          ctx.log("twitter: rate/quota limit hit (429) — stopping X queries for this scan", "warn");
          break;
        } else if (err instanceof HttpError && err.status === 401) {
          ctx.log("twitter: bearer token rejected (401) — check the key in Settings", "warn");
          break;
        }
        ctx.log(`twitter: query failed (${err instanceof Error ? err.message : err}) — continuing`, "warn");
      }
    }

    ctx.log(`twitter: collected ${items.length} posts (last 7 days — X platform limit)`);
    return items;
  },
};
