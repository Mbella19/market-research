import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchText } from "../lib/http.ts";
import { stripHtml, truncate, tokenize } from "../lib/text.ts";
import { XMLParser } from "fast-xml-parser";

/**
 * Product Hunt Atom feed (keyless). These are LAUNCHES, not complaints —
 * stored as meta.kind = "market" and used as competitive context for briefs,
 * never counted as pain evidence.
 */

interface AtomEntry {
  id?: string;
  title?: string;
  link?: { "@_href"?: string } | { "@_href"?: string }[];
  content?: { "#text"?: string } | string;
  published?: string;
  author?: { name?: string };
}

export const producthunt: Connector = {
  id: "producthunt",
  label: "Product Hunt",
  weight: 0.04,
  status: () => "ready",

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const items: RawItem[] = [];
    try {
      const xml = await fetchText("https://www.producthunt.com/feed", {
        minIntervalMs: 1500,
        cacheTtlMs: 6 * 60 * 60_000,
        signal: ctx.signal,
        headers: { Accept: "application/atom+xml,application/xml" },
      });
      const parser = new XMLParser({ ignoreAttributes: false });
      const feed = parser.parse(xml) as { feed?: { entry?: AtomEntry | AtomEntry[] } };
      const raw = feed.feed?.entry;
      const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];

      // In topic mode keep only launches overlapping the niche vocabulary.
      const topicTerms = new Set(
        [...ctx.plan.keywords, ctx.topic ?? ""].flatMap((k) => tokenize(k ?? ""))
      );

      for (const entry of entries) {
        if (items.length >= Math.min(ctx.limit, 25)) break;
        const title = typeof entry.title === "string" ? entry.title : "";
        const rawContent =
          typeof entry.content === "string" ? entry.content : (entry.content?.["#text"] ?? "");
        const content = stripHtml(String(rawContent));
        const linkObj = Array.isArray(entry.link) ? entry.link[0] : entry.link;
        const url = linkObj?.["@_href"] ?? "https://www.producthunt.com";
        if (!title) continue;

        if (ctx.topic && topicTerms.size > 0) {
          const entryTerms = new Set(tokenize(`${title} ${content}`));
          let overlap = 0;
          for (const t of topicTerms) if (entryTerms.has(t)) overlap++;
          if (overlap === 0) continue;
        }

        items.push({
          source: "producthunt",
          externalId: entry.id ?? url,
          url,
          title,
          body: truncate(content, 800),
          author: entry.author?.name ?? null,
          score: 0,
          comments: 0,
          createdUtc: entry.published ? Math.floor(Date.parse(entry.published) / 1000) : null,
          meta: { kind: "market" },
        });
      }
    } catch (err) {
      ctx.log(`producthunt: feed failed (${err instanceof Error ? err.message : err}) — skipped`, "warn");
    }

    ctx.log(`producthunt: collected ${items.length} launches (market context)`);
    return items;
  },
};
