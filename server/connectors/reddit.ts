import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchText, fetchJson, HttpError } from "../lib/http.ts";
import { truncate, stripHtml } from "../lib/text.ts";
import { XMLParser } from "fast-xml-parser";

/**
 * Reddit without any API key — a two-layer scraper:
 *   1. Fast path: public .json endpoints (work on some networks).
 *   2. Scraper path (default reality: .json returns 403): merge
 *      - RSS feeds (titles, selftext bodies, authors, dates) with
 *      - old.reddit HTML (data-score / data-comments-count attributes)
 *      keyed by post id, so we keep full engagement numbers.
 */

const JSON_HOSTS = ["https://www.reddit.com", "https://old.reddit.com"];
// www and old are separate anonymous rate buckets — RSS falls back across both.
const RSS_HOSTS = ["https://www.reddit.com", "https://old.reddit.com"];
const HTML_HOST = "https://old.reddit.com";
const PACE = 2400; // ms between requests per host — anonymous Reddit is ~10 req/min
const CACHE = 45 * 60_000;

interface PostDraft {
  id: string; // t3_xxx
  title: string;
  body: string;
  author: string | null;
  url: string;
  createdUtc: number | null;
  score: number;
  comments: number;
  subreddit?: string;
}

// ---------- layer 1: .json fast path ----------

interface RedditChild {
  kind: string;
  data: {
    name?: string;
    title?: string;
    selftext?: string;
    permalink?: string;
    score?: number;
    num_comments?: number;
    created_utc?: number;
    author?: string;
    subreddit?: string;
    over_18?: boolean;
    stickied?: boolean;
  };
}

/** Once .json comes back 403 we stop trying it for the rest of the process. */
let jsonBlocked: boolean | null = null;

async function tryJsonPath(path: string, ctx: HarvestContext): Promise<PostDraft[] | null> {
  if (jsonBlocked) return null;
  for (const host of JSON_HOSTS) {
    try {
      const res = await fetchJson<{ data?: { children?: RedditChild[] } }>(`${host}${path}`, {
        minIntervalMs: PACE,
        cacheTtlMs: CACHE,
        retries: 0,
        signal: ctx.signal,
        headers: { Accept: "application/json" },
      });
      const out: PostDraft[] = [];
      for (const child of res.data?.children ?? []) {
        const d = child.data;
        if (child.kind !== "t3" || !d.title || d.over_18 || d.stickied) continue;
        out.push({
          id: d.name ?? `t3_${Math.random().toString(36).slice(2)}`,
          title: d.title,
          body: truncate(stripHtml(d.selftext ?? ""), 2400),
          author: d.author ?? null,
          url: `https://www.reddit.com${d.permalink ?? ""}`,
          createdUtc: d.created_utc ? Math.floor(d.created_utc) : null,
          score: d.score ?? 0,
          comments: d.num_comments ?? 0,
          subreddit: d.subreddit,
        });
      }
      jsonBlocked = false;
      return out;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (err instanceof HttpError && (err.status === 403 || err.status === 429)) continue;
      return null;
    }
  }
  jsonBlocked = true;
  return null; // all hosts blocked -> caller uses scraper path
}

// ---------- layer 2a: RSS (content) ----------

interface AtomEntry {
  id?: string;
  title?: string;
  author?: { name?: string };
  link?: { "@_href"?: string };
  updated?: string;
  content?: { "#text"?: string } | string;
  category?: { "@_term"?: string } | { "@_term"?: string }[];
}

async function fetchRss(path: string, ctx: HarvestContext, kinds: ("t3" | "t1")[] = ["t3"]): Promise<PostDraft[]> {
  let xml = "";
  let lastErr: unknown;
  for (const host of RSS_HOSTS) {
    try {
      xml = await fetchText(`${host}${path}`, {
        minIntervalMs: PACE,
        cacheTtlMs: CACHE,
        retries: 1,
        signal: ctx.signal,
        headers: { Accept: "application/atom+xml,application/xml" },
      });
      break;
    } catch (err) {
      lastErr = err;
      if (ctx.signal?.aborted) throw err;
      if (err instanceof HttpError && (err.status === 429 || err.status === 403)) continue;
      throw err;
    }
  }
  if (!xml) throw lastErr;
  const parser = new XMLParser({ ignoreAttributes: false });
  const feed = parser.parse(xml) as { feed?: { entry?: AtomEntry | AtomEntry[] } };
  const raw = feed.feed?.entry;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: PostDraft[] = [];
  for (const entry of entries) {
    const id = entry.id ?? "";
    if (!kinds.some((k) => id.startsWith(`${k}_`))) continue;
    const rawContent = typeof entry.content === "string" ? entry.content : (entry.content?.["#text"] ?? "");
    let body = stripHtml(String(rawContent));
    // RSS bodies end with "submitted by /u/... [link] [comments]" boilerplate.
    body = body.replace(/submitted by\s+\/u\/[\s\S]*$/i, "").trim();
    const cat = Array.isArray(entry.category) ? entry.category[0] : entry.category;
    out.push({
      id,
      title: stripHtml(String(entry.title ?? "")),
      body: truncate(body, 2400),
      author: entry.author?.name?.replace(/^\/u\//, "") ?? null,
      url: entry.link?.["@_href"] ?? "",
      createdUtc: entry.updated ? Math.floor(Date.parse(entry.updated) / 1000) : null,
      score: 0,
      comments: 0,
      subreddit: cat?.["@_term"],
    });
  }
  return out;
}

// ---------- layer 2b: old.reddit HTML (engagement) ----------

interface EngagementInfo {
  score: number;
  comments: number;
  nsfw: boolean;
  promoted: boolean;
}

function parseListingHtml(html: string): Map<string, EngagementInfo> {
  const map = new Map<string, EngagementInfo>();
  // Listing pages: <div class=" thing ..." data-fullname="t3_x" data-score="999" data-comments-count="96" ...>
  const attrRe =
    /data-fullname="(t3_[a-z0-9]+)"[^>]*?data-comments-count="(\d+)"[^>]*?data-score="(-?\d+)"[^>]*?data-promoted="(true|false)"[^>]*?data-nsfw="(true|false)"/g;
  for (const m of html.matchAll(attrRe)) {
    map.set(m[1]!, {
      comments: Number(m[2]),
      score: Math.max(0, Number(m[3])),
      promoted: m[4] === "true",
      nsfw: m[5] === "true",
    });
  }
  // Search pages: each result chunk starts at data-fullname and contains
  // `search-score">6,102 points` and `search-comments ...>729 comments`.
  for (const chunk of html.split(/data-fullname="/g).slice(1)) {
    const id = chunk.match(/^(t3_[a-z0-9]+)"/)?.[1];
    if (!id || map.has(id)) continue;
    const score = chunk.match(/search-score">([\d,]+)\s+point/)?.[1];
    const comments = chunk.match(/search-comments[^>]*>([\d,]+)\s+comment/)?.[1];
    if (score === undefined && comments === undefined) continue;
    map.set(id, {
      score: Number(score?.replace(/,/g, "") ?? 0),
      comments: Number(comments?.replace(/,/g, "") ?? 0),
      nsfw: false,
      promoted: false,
    });
  }
  return map;
}

async function fetchEngagement(path: string, ctx: HarvestContext): Promise<Map<string, EngagementInfo>> {
  try {
    const html = await fetchText(`${HTML_HOST}${path}`, {
      minIntervalMs: PACE,
      cacheTtlMs: CACHE,
      signal: ctx.signal,
      headers: { Accept: "text/html" },
    });
    return parseListingHtml(html);
  } catch {
    return new Map();
  }
}

// ---------- combined queries ----------

async function scrapeQuery(
  kind: "siteSearch" | "subSearch" | "subTop",
  ctx: HarvestContext,
  q: string,
  sub?: string
): Promise<PostDraft[]> {
  let rssPath: string;
  let htmlPath: string;
  const enc = encodeURIComponent(q);
  if (kind === "siteSearch") {
    rssPath = `/search.rss?q=${enc}&sort=relevance&t=year&limit=100`;
    htmlPath = `/search?q=${enc}&sort=relevance&t=year`;
  } else if (kind === "subSearch") {
    rssPath = `/r/${sub}/search.rss?q=${enc}&restrict_sr=on&sort=top&t=year&limit=100`;
    htmlPath = `/r/${sub}/search?q=${enc}&restrict_sr=on&sort=top&t=year`;
  } else {
    rssPath = `/r/${sub}/top.rss?t=year&limit=100`;
    htmlPath = `/r/${sub}/top/?t=year&limit=100`;
  }

  // Fast path first.
  const jsonPath =
    kind === "siteSearch"
      ? `/search.json?q=${enc}&sort=relevance&t=year&limit=100`
      : kind === "subSearch"
        ? `/r/${sub}/search.json?q=${enc}&restrict_sr=on&sort=top&t=year&limit=100`
        : `/r/${sub}/top.json?t=year&limit=100`;
  const viaJson = await tryJsonPath(jsonPath, ctx);
  if (viaJson) return viaJson;

  // Scraper path: RSS content + HTML engagement.
  try {
    const [drafts, engagement] = await Promise.all([
      fetchRss(rssPath, ctx),
      fetchEngagement(htmlPath, ctx),
    ]);
    for (const draft of drafts) {
      const eng = engagement.get(draft.id);
      if (eng) {
        draft.score = eng.score;
        draft.comments = eng.comments;
      }
    }
    // Posts the HTML saw but RSS didn't: engagement without body — still useful signal.
    return drafts;
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.log(`reddit: ${kind} "${q || sub}" failed (${err instanceof Error ? err.message : err})`, "warn");
    return [];
  }
}

export const reddit: Connector = {
  id: "reddit",
  label: "Reddit",
  weight: 0.24,
  status: () => "ready",

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const items: RawItem[] = [];
    const seen = new Set<string>();
    let scraperMode = false;

    const push = (drafts: PostDraft[]) => {
      for (const d of drafts) {
        if (items.length >= ctx.limit) return;
        if (!d.title || seen.has(d.id)) continue;
        seen.add(d.id);
        items.push({
          source: "reddit",
          externalId: d.id,
          url: d.url,
          title: d.title,
          body: d.body,
          author: d.author,
          score: d.score,
          comments: d.comments,
          createdUtc: d.createdUtc,
          meta: { subreddit: d.subreddit },
        });
      }
    };

    // Probe once to know which mode we're in (for the log line).
    const probe = await tryJsonPath("/r/programming/top.json?t=week&limit=1", ctx);
    scraperMode = probe === null;
    if (scraperMode) ctx.log("reddit: .json blocked on this network — using RSS+HTML scraper");

    for (const q of ctx.plan.painQueries.slice(0, 8)) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      push(await scrapeQuery("siteSearch", ctx, q));
    }

    const kw = ctx.plan.keywords[0] ?? ctx.topic ?? "";
    const kw2 = ctx.plan.keywords[1] ?? "";
    for (const subRaw of ctx.plan.subreddits.slice(0, 10)) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      const sub = subRaw.replace(/^\/?r\//i, "").trim();
      if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) continue;
      if (kw) {
        push(await scrapeQuery("subSearch", ctx, kw, sub));
        if (kw2 && items.length < ctx.limit) push(await scrapeQuery("subSearch", ctx, kw2, sub));
      } else {
        push(await scrapeQuery("subTop", ctx, "", sub));
      }
    }

    // ---- comment mining: hot threads carry dozens more distinct voices ----
    const hotThreads = items
      .filter((it) => it.comments >= 15)
      .sort((a, b) => b.score + b.comments - (a.score + a.comments))
      .slice(0, 12);
    let commentCount = 0;
    for (const thread of hotThreads) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      try {
        const path = new URL(thread.url).pathname.replace(/\/$/, "");
        const comments = await fetchRss(`${path}.rss?limit=50`, ctx, ["t1"]);
        for (const c of comments) {
          if (items.length >= ctx.limit) break;
          if (seen.has(c.id) || c.body.length < 60) continue;
          seen.add(c.id);
          commentCount++;
          items.push({
            source: "reddit",
            externalId: c.id,
            url: c.url || thread.url,
            title: `Comment on: ${thread.title}`,
            body: c.body,
            author: c.author,
            score: 0, // RSS carries no comment score; the author is the value
            comments: 0,
            createdUtc: c.createdUtc,
            meta: { subreddit: thread.meta?.subreddit, kind: "comment" },
          });
        }
      } catch {
        continue; // thread RSS blocked/deleted — next
      }
    }

    ctx.log(
      `reddit: collected ${items.length} items (${items.length - commentCount} posts + ${commentCount} comments)${scraperMode ? " (scraper mode)" : ""}`
    );
    return items;
  },
};
