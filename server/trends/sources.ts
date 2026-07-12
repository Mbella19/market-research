import { fetchJson, fetchText, HttpError } from "../lib/http.ts";
import { parseCount, nowSec, stripHtml } from "../lib/text.ts";
import { trendFocusMatches, trendTokens } from "../lib/trendtext.ts";
import type { AppSettings } from "../settings.ts";
import { XMLParser } from "fast-xml-parser";

/**
 * Trend-scout signal sources. DELIBERATELY separate from the pain connectors:
 * these measure GROWTH (velocity, deltas, breakouts), never complaints.
 * No pain phrasing, no demand gate — momentum evidence only.
 */

export type TrendSourceId = "github" | "hn" | "producthunt" | "gtrends" | "twitter";

export const TREND_SOURCES: { id: TrendSourceId; label: string; needsKey: "github" | "twitter" | null }[] = [
  { id: "github", label: "GitHub star velocity", needsKey: "github" },
  { id: "hn", label: "Hacker News momentum", needsKey: null },
  { id: "producthunt", label: "Product Hunt launches", needsKey: null },
  { id: "gtrends", label: "Google breakout searches", needsKey: null },
  { id: "twitter", label: "X trending topics", needsKey: "twitter" },
];

export interface TrendSignal {
  source: TrendSourceId;
  /** Text used for cross-source grouping (name + description + topics). */
  key: string;
  /** Short display label ("owner/repo" or the surging term itself). */
  label: string;
  /** Human-readable momentum evidence ("★ 1,240 in 9d — 138/day"). */
  metric: string;
  url: string;
  /** 0..1 momentum subscore within this source. */
  strength: number;
  /** Extra context handed to the AI classifier (e.g. repo description). */
  detail?: string;
}

export interface ScoutContext {
  /** Lookback window in days (depth: quick 14 / standard 30 / deep 90). */
  windowDays: number;
  /** GitHub search pages (1..3 by depth). */
  ghPages: number;
  /** HN stories fetched per comparison window (paginated in 1000s). */
  hnHits: number;
  settings: AppSettings;
  signal?: AbortSignal;
  log: (msg: string, type?: "log" | "warn") => void;
  /** Optional focus filter ("AI", "health") — keeps only overlapping signals. */
  focus?: string | null;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/** Words too generic to BE a trend on their own (unigram blocklist). */
const GENERIC = new Set(
  (
    "show ask launch launched launches launching open source opensource using building built build make made makes " +
    "best guide tutorial review reviews year years people world company companies startup startups software engineer " +
    "engineers engineering programming programmer developer developers develop code coding computer tech technology " +
    "project projects app apps application applications tool tools free paid million billion first every day days week " +
    "weeks month months time work working works life live news update updates release released version support against " +
    "windows linux macos android iphone google apple microsoft amazon meta facebook story stories post comments website " +
    "web internet online platform platforms product products service services system systems data user users experience " +
    "problem problems idea ideas question everyone anyone available official simple based inside behind future modern " +
    "faster better bigger small large great good real actually finally discussion link links join community share upvote " +
    "shared give gives giving going coming getting looking trying making taking asking showing telling saying turned turns " +
    "today yesterday tomorrow tonight monday tuesday wednesday thursday friday saturday sunday january february march " +
    "april may june july august september october november december " +
    "can't cant won't wont don't dont doesn't doesnt didn't didnt isn't isnt aren't arent you're youre they're theyre " +
    "we've weve you've youve i've it's thats what's whats here's model models machine machines learning language agent agents"
  ).split(" ")
);

/** Terms of a title: distinctive unigrams + adjacent bigrams (generic words ride only in bigrams). */
function trendTerms(title: string): string[] {
  const toks = trendTokens(title);
  const out: string[] = [];
  for (const t of toks) {
    if (t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t)) out.push(t);
  }
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i]!;
    const b = toks[i + 1]!;
    if (GENERIC.has(a) && GENERIC.has(b)) continue; // both-generic pairs are background noise
    out.push(`${a} ${b}`);
  }
  return [...new Set(out)];
}

function focusMatch(ctx: ScoutContext, text: string): boolean {
  return trendFocusMatches(ctx.focus, text);
}

// ---------------- GitHub: new repos with abnormal star velocity ----------------

interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  created_at: string;
  language: string | null;
  topics?: string[];
}

export async function scoutGithub(ctx: ScoutContext): Promise<TrendSignal[]> {
  const token = ctx.settings.keys.githubToken;
  if (!token) {
    ctx.log("trend/github: no token configured — skipped", "warn");
    return [];
  }
  const since = new Date(Date.now() - ctx.windowDays * 86400_000).toISOString().slice(0, 10);
  // The "exploding" bar scales with the window: a repo must average ≥6 stars/day
  // to even enter the pool; velocity ranks the survivors.
  const minStars = Math.max(80, ctx.windowDays * 6);
  const signals: TrendSignal[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= ctx.ghPages; page++) {
    if (ctx.signal?.aborted) break;
    try {
      const res = await fetchJson<{ items?: GhRepo[] }>(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(
          `created:>=${since} stars:>${minStars}`
        )}&sort=stars&order=desc&per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          minIntervalMs: 2200,
          cacheTtlMs: 60 * 60_000,
          cacheKeyExtra: token.slice(-6),
          signal: ctx.signal,
        }
      );
      for (const repo of res.items ?? []) {
        if (seen.has(repo.full_name)) continue;
        seen.add(repo.full_name);
        const ageDays = Math.max(1, Math.round((Date.now() - Date.parse(repo.created_at)) / 86400_000));
        const velocity = repo.stargazers_count / ageDays;
        if (velocity < 5) continue;
        const desc = (repo.description ?? "").slice(0, 220);
        const text = `${repo.full_name.split("/")[1] ?? repo.full_name} ${desc} ${(repo.topics ?? []).join(" ")}`;
        if (!focusMatch(ctx, text)) continue;
        signals.push({
          source: "github",
          key: text,
          label: repo.full_name,
          metric: `★ ${fmt(repo.stargazers_count)} in ${ageDays}d — ${Math.round(velocity)}/day${repo.language ? ` · ${repo.language}` : ""}`,
          url: repo.html_url,
          strength: velocity / (velocity + 30),
          detail: desc,
        });
      }
    } catch (err) {
      ctx.log(`trend/github: search failed (${err instanceof Error ? err.message : err})`, "warn");
      break;
    }
  }

  signals.sort((a, b) => b.strength - a.strength);
  const kept = signals.slice(0, 40);
  ctx.log(`trend/github: ${kept.length} fast-rising repos (created ≤${ctx.windowDays}d, ≥${minStars}★)`);
  return kept;
}

// ---------------- Hacker News: term momentum, window vs previous window ----------------

interface HnHit {
  objectID: string;
  title?: string;
  points?: number;
}

async function hnWindow(from: number, to: number, maxHits: number, ctx: ScoutContext): Promise<HnHit[]> {
  // NB: /search rejects multi-value numericFilters (400) — /search_by_date accepts
  // them BUT hard-caps every query at 1,000 results (nbPages=1 regardless of nbHits).
  // So we slice the window into ≤10-day chunks that each fit under the cap; without
  // this, a 30-day window silently truncates to its most recent ~13 days and
  // calendar flukes ("july") masquerade as 25× surges.
  const out: HnHit[] = [];
  const sliceSec = 10 * 86400;
  for (let end = to; end > from && out.length < maxHits; end -= sliceSec) {
    const start = Math.max(from, end - sliceSec);
    const res = await fetchJson<{ hits?: HnHit[] }>(
      `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=1000&numericFilters=${encodeURIComponent(
        `created_at_i>${start},created_at_i<=${end},points>=30`
      )}`,
      { minIntervalMs: 600, cacheTtlMs: 60 * 60_000, signal: ctx.signal }
    );
    out.push(...(res.hits ?? []));
  }
  return out.slice(0, maxHits);
}

export async function scoutHn(ctx: ScoutContext): Promise<TrendSignal[]> {
  const now = nowSec();
  const w = ctx.windowDays * 86400;
  let cur: HnHit[];
  let prev: HnHit[];
  try {
    cur = await hnWindow(now - w, now, ctx.hnHits, ctx);
    prev = await hnWindow(now - 2 * w, now - w, ctx.hnHits, ctx);
  } catch (err) {
    ctx.log(`trend/hn: Algolia failed (${err instanceof Error ? err.message : err}) — skipped`, "warn");
    return [];
  }

  const count = (hitList: HnHit[]): Map<string, { n: number; points: number }> => {
    const m = new Map<string, { n: number; points: number }>();
    for (const h of hitList) {
      const title = (h.title ?? "").replace(/^(Show|Ask|Tell) HN:?\s*/i, "");
      for (const term of trendTerms(title)) {
        const e = m.get(term) ?? { n: 0, points: 0 };
        e.n += 1;
        e.points += h.points ?? 0;
        m.set(term, e);
      }
    }
    return m;
  };

  const curMap = count(cur);
  const prevMap = count(prev);
  const minStories = Math.max(3, Math.round(cur.length / 250));
  const candidates: { term: string; n: number; points: number; prevN: number; ratio: number }[] = [];

  for (const [term, e] of curMap) {
    if (e.n < minStories) continue;
    const prevN = prevMap.get(term)?.n ?? 0;
    const ratio = (e.n + 0.5) / (prevN + 0.5);
    if (ratio < 2 && !(prevN === 0 && e.n >= 4)) continue;
    if (!focusMatch(ctx, term)) continue;
    candidates.push({ term, n: e.n, points: e.points, prevN, ratio });
  }

  // Prefer bigrams; drop a unigram when a kept bigram already contains it.
  candidates.sort((a, b) => b.n * b.ratio - a.n * a.ratio);
  const keptTerms: string[] = [];
  const signals: TrendSignal[] = [];
  for (const c of candidates) {
    if (signals.length >= 30) break;
    if (!c.term.includes(" ")) {
      const covered = keptTerms.some((t) => t.includes(" ") && t.split(" ").includes(c.term));
      if (covered) continue;
    }
    keptTerms.push(c.term);
    signals.push({
      source: "hn",
      key: c.term,
      label: c.term,
      metric: `${c.n} high-signal stories vs ${c.prevN} in prior ${ctx.windowDays}d (${c.ratio.toFixed(1)}×) · ${fmt(c.points)} pts`,
      url: `https://hn.algolia.com/?q=${encodeURIComponent(c.term)}&type=story&dateRange=pastMonth`,
      strength: 1 - Math.exp(-((c.n / 12) * 0.55 + (c.ratio / 8) * 0.45)),
    });
  }

  ctx.log(`trend/hn: ${signals.length} surging terms (${cur.length} vs ${prev.length} stories compared)`);
  return signals;
}

// ---------------- Product Hunt: launch-keyword clusters ----------------

interface AtomEntry {
  title?: string;
  link?: { "@_href"?: string } | { "@_href"?: string }[];
  content?: { "#text"?: string } | string;
}

export async function scoutProducthunt(ctx: ScoutContext): Promise<TrendSignal[]> {
  let entries: AtomEntry[] = [];
  try {
    const xml = await fetchText("https://www.producthunt.com/feed", {
      minIntervalMs: 1500,
      cacheTtlMs: 6 * 60 * 60_000,
      signal: ctx.signal,
      headers: { Accept: "application/atom+xml,application/xml" },
    });
    const feed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
      feed?: { entry?: AtomEntry | AtomEntry[] };
    };
    const raw = feed.feed?.entry;
    entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch (err) {
    ctx.log(`trend/producthunt: feed failed (${err instanceof Error ? err.message : err}) — skipped`, "warn");
    return [];
  }

  const perTerm = new Map<string, { n: number; sample: string }>();
  for (const entry of entries) {
    const title = typeof entry.title === "string" ? entry.title : "";
    const rawContent = typeof entry.content === "string" ? entry.content : (entry.content?.["#text"] ?? "");
    const text = `${title} ${stripHtml(String(rawContent)).slice(0, 300)}`;
    for (const term of trendTerms(text)) {
      const e = perTerm.get(term) ?? { n: 0, sample: title };
      e.n += 1;
      perTerm.set(term, e);
    }
  }

  const signals: TrendSignal[] = [];
  // Terms in >50% of launches are feed boilerplate ("Discussion | Link"), not trends.
  const dfCap = Math.max(3, Math.ceil(entries.length * 0.5));
  const sorted = [...perTerm.entries()].filter(([, e]) => e.n >= 2 && e.n <= dfCap).sort((a, b) => b[1].n - a[1].n);
  for (const [term, e] of sorted) {
    if (signals.length >= 15) break;
    if (!focusMatch(ctx, term)) continue;
    signals.push({
      source: "producthunt",
      key: term,
      label: term,
      metric: `${e.n} of ${entries.length} current launches mention "${term}" (e.g. ${e.sample.slice(0, 60)})`,
      url: `https://www.producthunt.com/search?q=${encodeURIComponent(term)}`,
      strength: e.n / (e.n + 3),
    });
  }

  ctx.log(`trend/producthunt: ${signals.length} launch-keyword clusters from ${entries.length} launches`);
  return signals;
}

// ---------------- Google Trends: today's breakout searches ----------------

interface GtItem {
  title?: string;
  "ht:approx_traffic"?: string;
  link?: string;
  description?: string;
}

export async function scoutGtrends(ctx: ScoutContext): Promise<TrendSignal[]> {
  let items: GtItem[] = [];
  try {
    const xml = await fetchText("https://trends.google.com/trending/rss?geo=US", {
      minIntervalMs: 1500,
      cacheTtlMs: 3 * 60 * 60_000,
      signal: ctx.signal,
      headers: { Accept: "application/rss+xml,application/xml" },
    });
    const feed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
      rss?: { channel?: { item?: GtItem | GtItem[] } };
    };
    const raw = feed.rss?.channel?.item;
    items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch (err) {
    ctx.log(`trend/gtrends: RSS failed (${err instanceof Error ? err.message : err}) — skipped`, "warn");
    return [];
  }

  const signals: TrendSignal[] = [];
  for (const item of items) {
    if (signals.length >= 20) break;
    const title = (item.title ?? "").trim();
    if (!title) continue;
    if (!focusMatch(ctx, `${title} ${item.description ?? ""}`)) continue;
    const traffic = parseCount(item["ht:approx_traffic"] ?? "");
    signals.push({
      source: "gtrends",
      key: `${title} ${(item.description ?? "").slice(0, 120)}`,
      label: title,
      metric: `Breakout US search today${traffic ? ` · ~${fmt(traffic)}+ searches` : ""}`,
      url: item.link || `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}`,
      strength: Math.min(1, 0.6 + (traffic >= 1_000_000 ? 0.4 : traffic >= 200_000 ? 0.25 : traffic >= 50_000 ? 0.1 : 0)),
      detail: (item.description ?? "").slice(0, 160),
    });
  }

  ctx.log(`trend/gtrends: ${signals.length} breakout searches (most will be filtered as non-software)`);
  return signals;
}

// ---------------- X: trending topics (best-effort; tier-dependent) ----------------

interface XTrendV1 {
  name?: string;
  url?: string;
  tweet_volume?: number | null;
}

export async function scoutTwitter(ctx: ScoutContext): Promise<TrendSignal[]> {
  const bearer = ctx.settings.keys.twitterBearer;
  if (!bearer) {
    ctx.log("trend/twitter: no bearer token — skipped", "warn");
    return [];
  }
  const opts = {
    headers: { Authorization: `Bearer ${bearer}` },
    minIntervalMs: 1500,
    retries: 0,
    cacheTtlMs: 3 * 60 * 60_000,
    cacheKeyExtra: bearer.slice(-6),
    signal: ctx.signal,
  };

  let trends: XTrendV1[] = [];
  try {
    // v1.1 first (works on legacy Elevated), then v2 shape.
    const res = await fetchJson<{ trends?: XTrendV1[] }[]>(
      "https://api.twitter.com/1.1/trends/place.json?id=23424977",
      opts
    );
    trends = res[0]?.trends ?? [];
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
      try {
        const res = await fetchJson<{ data?: { trend_name?: string; tweet_count?: number }[] }>(
          "https://api.twitter.com/2/trends/by/woeid/23424977",
          opts
        );
        trends = (res.data ?? []).map((t) => ({ name: t.trend_name, tweet_volume: t.tweet_count ?? null }));
      } catch (err2) {
        ctx.log(
          `trend/twitter: trends endpoint not available on this tier (${err2 instanceof HttpError ? err2.status : err2}) — skipped, scout continues`,
          "warn"
        );
        return [];
      }
    } else {
      ctx.log(`trend/twitter: failed (${err instanceof Error ? err.message : err}) — skipped`, "warn");
      return [];
    }
  }

  const signals: TrendSignal[] = [];
  const seenTrend = new Set<string>();
  for (const [rank, t] of trends.entries()) {
    if (signals.length >= 15) break;
    const name = (t.name ?? "").replace(/^#/, "").trim();
    const norm = name.toLowerCase().replace(/\s+/g, "");
    if (seenTrend.has(norm)) continue;
    seenTrend.add(norm);
    const volume = t.tweet_volume ?? 0;
    // X often omits volume — keep top-10 ranks anyway (rank IS the evidence),
    // require real volume below that.
    if (!name || (volume < 20_000 && rank >= 10)) continue;
    if (!focusMatch(ctx, name)) continue;
    signals.push({
      source: "twitter",
      key: name,
      label: t.name ?? name,
      metric: volume ? `${fmt(volume)} tweets today (US trending)` : `US trending #${rank + 1} today`,
      url: t.url ?? `https://x.com/search?q=${encodeURIComponent(name)}`,
      strength: volume ? Math.min(1, Math.log10(Math.max(10, volume)) / 6) : Math.max(0.25, 0.55 - rank * 0.03),
    });
  }

  ctx.log(`trend/twitter: ${signals.length} trending topics with volume`);
  return signals;
}

// ---------------- registry ----------------

export const SCOUTS: Record<TrendSourceId, (ctx: ScoutContext) => Promise<TrendSignal[]>> = {
  github: scoutGithub,
  hn: scoutHn,
  producthunt: scoutProducthunt,
  gtrends: scoutGtrends,
  twitter: scoutTwitter,
};
