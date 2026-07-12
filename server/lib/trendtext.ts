import { STOPWORDS } from "./text.ts";

const KEEP_SHORT = new Set(["ai", "ar", "vr", "ml", "3d", "5g"]);

export function trendTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
    .filter((token) => KEEP_SHORT.has(token) || (token.length > 2 && token.length < 24 && !STOPWORDS.has(token)));
}

export function trendFocusMatches(focus: string | null | undefined, text: string): boolean {
  if (!focus) return true;
  const focusTokens = new Set(trendTokens(focus));
  if (focusTokens.size === 0) return false;
  const textTokens = new Set(trendTokens(text));
  return [...focusTokens].some((token) => textTokens.has(token));
}
