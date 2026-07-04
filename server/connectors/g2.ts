import type { Connector, HarvestContext, RawItem } from "./types.ts";
import { fetchJson, HttpError } from "../lib/http.ts";
import { stripHtml, truncate } from "../lib/text.ts";

/**
 * G2.com via data.g2.com JSON:API v2 — behavior verified live (2026-07-03)
 * against the user's Developer Portal token:
 *
 *   ✅ Authorization: Bearer <token>            (only working auth style)
 *   ✅ GET /api/v2/user                         (token self-test)
 *   ✅ GET /api/v2/categories?filter[name_cont] (global category search)
 *   ✅ GET /api/v2/categories/{id}?include=products
 *        → global market leaders per category with name, star_rating,
 *          review_count, pricing_tiers, detail_description, g2_url
 *   ❌ GET /api/v2/products (list/search)       (scoped to owned products)
 *   ❌ per-product reviews/snippets/discussions (403 — partner syndication)
 *
 * So G2 contributes COMPETITIVE LANDSCAPE (meta.kind="market": who dominates
 * the niche, at what rating/price) that feeds opportunity-brief competitor
 * sections. A review-access probe runs each harvest so review mining turns on
 * automatically if G2 ever grants syndication access to this account.
 */

interface JsonApiResource {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
}
interface JsonApiDoc {
  data?: JsonApiResource[] | JsonApiResource;
  included?: JsonApiResource[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

async function g2Json(path: string, params: Record<string, string>, token: string, ctx: HarvestContext): Promise<JsonApiDoc> {
  const qs = new URLSearchParams(params).toString();
  return fetchJson<JsonApiDoc>(`https://data.g2.com/${path}${qs ? `?${qs}` : ""}`, {
    headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${token}` },
    minIntervalMs: 1200,
    cacheTtlMs: 6 * 60 * 60_000,
    cacheKeyExtra: token.slice(-6),
    retries: 1,
    signal: ctx.signal,
  });
}

export const g2: Connector = {
  id: "g2",
  label: "G2 Landscape",
  weight: 0.05,
  status: (s) => (s.keys.g2Token ? "ready" : "needs-key"),

  async harvest(ctx: HarvestContext): Promise<RawItem[]> {
    const token = ctx.settings.keys.g2Token;
    if (!token) {
      ctx.log("g2: no token configured — skipped", "warn");
      return [];
    }
    const items: RawItem[] = [];

    // ---- token self-test ----
    try {
      await g2Json("api/v2/user", {}, token, ctx);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        ctx.log("g2: token rejected (401) — regenerate in the Developer Portal and update Settings; skipped", "warn");
      } else {
        ctx.log(`g2: self-test failed (${err instanceof Error ? err.message : err}) — skipped`, "warn");
      }
      return items;
    }

    // ---- niche categories → market-leading products ----
    const terms = [...ctx.plan.storeTerms, ...ctx.plan.keywords].slice(0, 3);
    const seenCategory = new Set<string>();
    const seenProduct = new Set<string>();
    let firstProductId: string | null = null;

    for (const term of terms) {
      if (items.length >= ctx.limit || ctx.signal?.aborted) break;
      // G2 category names are generic ("Invoice Management") — try the two-word
      // phrase, then the first word, until something matches.
      const words = term.trim().split(/\s+/);
      const fragments = [...new Set([words.slice(0, 2).join(" "), words[0] ?? ""])].filter(
        (f) => f.length >= 4
      );
      let categories: JsonApiResource[] = [];
      for (const fragment of fragments) {
        try {
          const res = await g2Json(
            "api/v2/categories",
            { "filter[name_cont]": fragment, "page[size]": "3" },
            token,
            ctx
          );
          categories = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
          if (categories.length > 0) break;
        } catch (err) {
          ctx.log(`g2: category search "${fragment}" failed (${err instanceof Error ? err.message : err})`, "warn");
          break;
        }
      }

      for (const category of categories) {
        if (items.length >= ctx.limit || seenCategory.has(category.id)) continue;
        seenCategory.add(category.id);
        try {
          const res = await g2Json(`api/v2/categories/${category.id}`, { include: "products" }, token, ctx);
          const categoryName = str((res.data as JsonApiResource | undefined)?.attributes?.["name"]) || "G2 category";
          for (const product of (res.included ?? []).slice(0, 6)) {
            if (items.length >= ctx.limit) break;
            const a = product.attributes ?? {};
            const name = str(a["name"]);
            if (!name || seenProduct.has(product.id)) continue;
            seenProduct.add(product.id);
            firstProductId ??= product.id;
            const rating = num(a["star_rating"]);
            const reviews = num(a["review_count"]);
            const pricing = Array.isArray(a["pricing_tiers"]) ? (a["pricing_tiers"] as unknown[]).map(String).slice(0, 3).join(" · ") : "";
            items.push({
              source: "g2",
              externalId: `product-${product.id}`,
              url: str(a["g2_url"]) || `https://www.g2.com/products/${str(a["slug"]) || product.id}/reviews`,
              title: `G2 ${categoryName}: ${name}${rating !== null ? ` (${rating}★${reviews ? `, ${reviews} reviews` : ""})` : ""}`,
              body: truncate(stripHtml(str(a["detail_description"])) + (pricing ? `\nPricing: ${pricing}` : ""), 700),
              author: null,
              score: 0,
              comments: 0,
              createdUtc: null,
              meta: { kind: "market", appTitle: name, rating, reviewCount: reviews, category: categoryName },
            });
          }
        } catch (err) {
          ctx.log(`g2: category ${category.id.slice(0, 8)} failed (${err instanceof Error ? err.message : err})`, "warn");
        }
      }
    }

    // ---- review-access probe: auto-upgrades if G2 ever grants syndication ----
    if (firstProductId && !ctx.signal?.aborted) {
      try {
        await g2Json(`api/v2/products/${firstProductId}/reviews`, { "page[size]": "1" }, token, ctx);
        ctx.log("g2: review access detected! Tell the developer — review mining can now be enabled for G2");
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) {
          ctx.log("g2: review text is partner-gated for this token — contributing competitive landscape only");
        }
      }
    }

    ctx.log(`g2: collected ${items.length} market-landscape entries`);
    return items;
  },
};
