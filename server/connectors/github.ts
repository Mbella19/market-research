import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson, HttpError } from "../lib/http.ts";
import { truncate } from "../lib/text.ts";

/** GitHub issue search — feature requests and tool-gap complaints, 👍 reactions = demand. */

interface GhIssue {
  id: number;
  title: string;
  body?: string | null;
  html_url: string;
  comments?: number;
  reactions?: { total_count?: number; "+1"?: number };
  created_at?: string;
  user?: { login?: string };
  pull_request?: unknown;
}

export const github: Connector = {
  id: "github",
  label: "GitHub Issues",
  weight: 0.12,
  status: (s) => (s.keys.githubToken ? "ready" : "needs-key"),

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const token = ctx.settings.keys.githubToken;
    if (!token) {
      ctx.log("github: no token configured — skipped", "warn");
      return [];
    }

    const items: RawItem[] = [];
    const seen = new Set<number>();
    const queries = [
      ...ctx.plan.githubQueries.slice(0, 6),
      ...(ctx.plan.keywords[0] ? [`${ctx.plan.keywords[0]} feature request`] : []),
    ].slice(0, 8);

    for (const q of queries) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      // Short quoted phrases give on-topic results; loose words return
      // popular-but-unrelated issues (verified against the live API).
      // created:>= keeps ancient famous issues out of the demand signal.
      const since = new Date(Date.now() - ctx.settings.recencyWindowMonths * 30 * 86400_000)
        .toISOString()
        .slice(0, 10);
      // With the recency window, reactions:>2 starves results (fresh issues
      // accumulate reactions slowly) — recency is the quality bar, sort still
      // surfaces the most-reacted first (verified live: >2→2 hits, >0→57).
      const words = q.trim().split(/\s+/).slice(0, 3).join(" ");
      const phrase = words.includes(" ") ? `"${words}"` : words;
      const query = encodeURIComponent(`${phrase} is:issue reactions:>0 created:>=${since}`);
      try {
        const res = await fetchJson<{ items?: GhIssue[] }>(
          `https://api.github.com/search/issues?q=${query}&sort=reactions&order=desc&per_page=100`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            minIntervalMs: 2200, // search API: 30 req/min
            cacheTtlMs: 30 * 60_000,
            cacheKeyExtra: token.slice(-6),
            signal: ctx.signal,
          }
        );
        for (const issue of res.items ?? []) {
          if (items.length >= ctx.limit) break;
          if (issue.pull_request || seen.has(issue.id)) continue;
          seen.add(issue.id);
          items.push({
            source: "github",
            externalId: String(issue.id),
            url: issue.html_url,
            title: issue.title,
            body: truncate(issue.body ?? "", 2400),
            author: issue.user?.login ?? null,
            // GitHub's total_count mixes positive and negative reactions.
            // Only thumbs-up is a defensible positive demand signal.
            score: issue.reactions?.["+1"] ?? 0,
            comments: issue.comments ?? 0,
            createdUtc: issue.created_at ? Math.floor(Date.parse(issue.created_at) / 1000) : null,
          });
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) {
          ctx.log("github: token rejected (401) — check GITHUB_TOKEN", "warn");
          break;
        }
        ctx.log(`github: search failed (${err instanceof Error ? err.message : err})`, "warn");
      }
    }

    ctx.log(`github: collected ${items.length} issues`);
    return items;
  },
};
