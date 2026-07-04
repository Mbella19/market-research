import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson, HttpError } from "../lib/http.ts";
import { truncate, parseRelativeDate, parseCount } from "../lib/text.ts";

/**
 * YouTube comment mining. Primary path: official Data API v3 (user's key).
 * Fallback path: youtubei.js (keyless InnerTube) when quota/key fails.
 * Comments under "my workflow is broken / which tool do you use" videos are
 * dense with first-person pain.
 */

interface YtSearchItem {
  id?: { videoId?: string };
  snippet?: { title?: string };
}
interface YtCommentThread {
  id: string;
  snippet?: {
    totalReplyCount?: number;
    topLevelComment?: {
      snippet?: {
        textOriginal?: string;
        likeCount?: number;
        publishedAt?: string;
        authorDisplayName?: string;
      };
    };
  };
}

function cutoffSec(ctx: HarvestContext): number {
  return Math.floor(Date.now() / 1000) - ctx.settings.recencyWindowMonths * 30 * 86400;
}

async function harvestViaDataApi(ctx: HarvestContext, key: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  const queries = ctx.plan.youtubeQueries.slice(0, 4);
  const publishedAfter = new Date(cutoffSec(ctx) * 1000).toISOString();
  for (const q of queries) {
    if (items.length >= ctx.limit || ctx.signal?.aborted) break;
    const search = await fetchJson<{ items?: YtSearchItem[] }>(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&relevanceLanguage=en&publishedAfter=${encodeURIComponent(
        publishedAfter
      )}&q=${encodeURIComponent(q)}&key=${key}`,
      { minIntervalMs: 400, cacheTtlMs: 6 * 60 * 60_000, cacheKeyExtra: key.slice(-6), signal: ctx.signal }
    );
    for (const video of (search.items ?? []).slice(0, 4)) {
      const videoId = video.id?.videoId;
      const videoTitle = video.snippet?.title ?? "YouTube video";
      if (!videoId || items.length >= ctx.limit) break;
      try {
        const threads = await fetchJson<{ items?: YtCommentThread[] }>(
          `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=80&order=relevance&textFormat=plainText&key=${key}`,
          { minIntervalMs: 400, cacheTtlMs: 6 * 60 * 60_000, cacheKeyExtra: key.slice(-6), signal: ctx.signal }
        );
        for (const thread of threads.items ?? []) {
          if (items.length >= ctx.limit) break;
          const cs = thread.snippet?.topLevelComment?.snippet;
          const text = cs?.textOriginal ?? "";
          if (text.length < 70) continue;
          const publishedSec = cs?.publishedAt ? Math.floor(Date.parse(cs.publishedAt) / 1000) : null;
          if (publishedSec && publishedSec < cutoffSec(ctx)) continue; // old comment on a recent video
          items.push({
            source: "youtube",
            externalId: thread.id,
            url: `https://www.youtube.com/watch?v=${videoId}&lc=${thread.id}`,
            title: `Comment on: ${videoTitle}`,
            body: truncate(text, 1500),
            author: cs?.authorDisplayName ?? null,
            score: cs?.likeCount ?? 0,
            comments: thread.snippet?.totalReplyCount ?? 0,
            createdUtc: cs?.publishedAt ? Math.floor(Date.parse(cs.publishedAt) / 1000) : null,
            meta: { videoId },
          });
        }
      } catch (err) {
        // Comments disabled on a video is routine — keep going.
        if (err instanceof HttpError && err.status === 403 && /commentsDisabled/.test(err.bodySnippet)) continue;
        throw err;
      }
    }
  }
  return items;
}

async function harvestViaInnerTube(ctx: HarvestContext): Promise<RawItem[]> {
  const { Innertube } = await import("youtubei.js");
  const yt = await Innertube.create({ retrieve_player: false });
  const items: RawItem[] = [];

  for (const q of ctx.plan.youtubeQueries.slice(0, 4)) {
    if (items.length >= ctx.limit || ctx.signal?.aborted) break;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    // upload_date:"year" keeps the fallback path recent too (best-effort filter).
    let search: any;
    try {
      search = await (yt.search as any)(q, { type: "video", upload_date: "year" });
    } catch {
      search = await yt.search(q, { type: "video" });
    }
    const videos: any[] = (search?.videos ?? []).slice(0, 2);
    for (const video of videos) {
      const videoId: string | undefined = video?.id ?? video?.video_id;
      const videoTitle: string = video?.title?.text ?? video?.title?.toString?.() ?? "YouTube video";
      if (!videoId || items.length >= ctx.limit) break;
      try {
        const comments: any = await yt.getComments(videoId);
        const threads: any[] = comments?.contents ?? [];
        for (const thread of threads.slice(0, 30)) {
          if (items.length >= ctx.limit) break;
          const c: any = thread?.comment;
          const text: string = c?.content?.text ?? c?.content?.toString?.() ?? "";
          if (!text || text.length < 70) continue;
          const created = parseRelativeDate(c?.published_time ?? c?.published?.text);
          if (created && created < cutoffSec(ctx)) continue;
          const commentId: string = c?.comment_id ?? `${videoId}-${items.length}`;
          items.push({
            source: "youtube",
            externalId: commentId,
            url: `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`,
            title: `Comment on: ${videoTitle}`,
            body: truncate(text, 1500),
            author: c?.author?.name ?? null,
            score: parseCount(c?.like_count),
            comments: parseCount(c?.reply_count),
            createdUtc: parseRelativeDate(c?.published_time ?? c?.published?.text),
            meta: { videoId, via: "innertube" },
          });
        }
      } catch {
        continue; // comments disabled / parser hiccup — next video
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  return items;
}

export const youtube: Connector = {
  id: "youtube",
  label: "YouTube",
  weight: 0.08,
  status: () => "ready", // works keyless via InnerTube fallback

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const key = ctx.settings.keys.youtubeApiKey;
    if (key) {
      try {
        const items = await harvestViaDataApi(ctx, key);
        ctx.log(`youtube: collected ${items.length} comments (Data API)`);
        return items;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log(`youtube: Data API failed (${msg}) — falling back to InnerTube`, "warn");
      }
    }
    try {
      const items = await harvestViaInnerTube(ctx);
      ctx.log(`youtube: collected ${items.length} comments (InnerTube)`);
      return items;
    } catch (err) {
      ctx.log(`youtube: failed (${err instanceof Error ? err.message : err}) — skipped`, "warn");
      return [];
    }
  },
};
