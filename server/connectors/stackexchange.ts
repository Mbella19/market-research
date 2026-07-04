import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson } from "../lib/http.ts";
import { stripHtml, truncate } from "../lib/text.ts";
import { STACK_SITES } from "../ai/prompts.ts";

/**
 * Stack Exchange public API (no key, 300 req/day/IP — we use a handful per scan).
 * softwarerecs.stackexchange.com is literally people asking for software that
 * doesn't exist for them yet — a demand goldmine.
 */

interface SeQuestion {
  question_id: number;
  title: string;
  body?: string;
  score?: number;
  view_count?: number;
  answer_count?: number;
  link: string;
  creation_date?: number;
  owner?: { display_name?: string };
}

export const stackexchange: Connector = {
  id: "stackexchange",
  label: "Stack Exchange",
  weight: 0.1,
  status: () => "ready",

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const items: RawItem[] = [];
    const seen = new Set<number>();
    const sites = (ctx.plan.stackSites.length ? ctx.plan.stackSites : ["softwarerecs"])
      .filter((s) => STACK_SITES.includes(s))
      .slice(0, 4);
    if (!sites.includes("softwarerecs")) sites.unshift("softwarerecs");
    const queries = [ctx.plan.keywords[0], ctx.plan.keywords[1], ctx.plan.keywords[2], ctx.plan.keywords[3]]
      .filter((q): q is string => Boolean(q))
      .slice(0, 4);
    if (queries.length === 0 && ctx.topic) queries.push(ctx.topic);

    for (const site of sites) {
      for (const q of queries) {
        if (items.length >= ctx.limit || ctx.signal?.aborted) break;
        try {
          const fromdate = Math.floor(Date.now() / 1000) - ctx.settings.recencyWindowMonths * 30 * 86400;
          const res = await fetchJson<{ items?: SeQuestion[]; backoff?: number }>(
            `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(
              q
            )}&site=${site}&pagesize=100&filter=withbody&fromdate=${fromdate}`,
            { minIntervalMs: 700, cacheTtlMs: 60 * 60_000, signal: ctx.signal }
          );
          if (res.backoff) {
            ctx.log(`stackexchange: backoff ${res.backoff}s requested`, "warn");
            await new Promise((r) => setTimeout(r, res.backoff! * 1000));
          }
          for (const question of res.items ?? []) {
            if (items.length >= ctx.limit) break;
            if (seen.has(question.question_id)) continue;
            seen.add(question.question_id);
            items.push({
              source: "stackexchange",
              externalId: `${site}-${question.question_id}`,
              url: question.link,
              title: stripHtml(question.title),
              body: truncate(stripHtml(question.body ?? ""), 2400),
              author: question.owner?.display_name ?? null,
              score: Math.max(0, question.score ?? 0),
              comments: question.answer_count ?? 0,
              views: question.view_count ?? null,
              createdUtc: question.creation_date ?? null,
              meta: { site },
            });
          }
        } catch (err) {
          ctx.log(`stackexchange: ${site} failed (${err instanceof Error ? err.message : err})`, "warn");
        }
      }
    }

    ctx.log(`stackexchange: collected ${items.length} questions`);
    return items;
  },
};
