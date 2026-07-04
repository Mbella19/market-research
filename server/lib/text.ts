import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashAuthor(source: string, author: string | null | undefined): string | null {
  if (!author || author === "[deleted]" || author === "AutoModerator") return null;
  return sha256(`${source}:${author.toLowerCase()}`).slice(0, 16);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/** Case/whitespace-tolerant substring check used to verify AI quotes are verbatim. */
export function containsVerbatim(haystack: string, needle: string): boolean {
  if (!needle || needle.length < 8) return false;
  const h = collapseWs(haystack).toLowerCase();
  const n = collapseWs(needle).toLowerCase().replace(/…$/, "").replace(/\.{3}$/, "");
  return h.includes(n);
}

export const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have i if in into is it its me my no not of on or our so " +
    "that the their them they this to was we what when which who why will with you your can could should would " +
    "do does did done just like get got really very much many some any all been being were im ive dont cant wont " +
    "how more most other than then there these those too use used using want wants need needs one two also even " +
    "us out up down over under again still now new way make makes made lot bit thing things something anything"
  ).split(" ")
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t.length > 2 && t.length < 24 && !STOPWORDS.has(t));
}

/** Tokens + adjacent bigrams — the vocabulary used for TF-IDF clustering. */
export function termsOf(s: string): string[] {
  const toks = tokenize(s);
  const out = [...toks];
  for (let i = 0; i < toks.length - 1; i++) out.push(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Parse "3 weeks ago" / "2 years ago" style relative dates (YouTube) to epoch seconds. */
export function parseRelativeDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.toLowerCase().match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2629800,
    year: 31557600,
  };
  return nowSec() - n * (unit[m[2]!] ?? 86400);
}

/** Parse "1.2K" / "3M" style counts to numbers. */
export function parseCount(s: string | number | null | undefined): number {
  if (s === null || s === undefined) return 0;
  if (typeof s === "number") return Math.max(0, Math.round(s));
  const m = String(s)
    .trim()
    .replace(/,/g, "")
    .match(/^([\d.]+)\s*([kmb])?/i);
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Math.round(parseFloat(m[1]!) * mult) || 0;
}
