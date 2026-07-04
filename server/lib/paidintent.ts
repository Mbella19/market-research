import { tokenize } from "./text.ts";

/**
 * Paid-intent evidence: people posting "I will PAY someone to solve X".
 * Harvested from hiring subreddits ([Hiring]/[Task] posts), stored as
 * meta.kind = "paid-intent", and matched to problem clusters at validation —
 * a fundamentally stronger signal than complaints or upvotes.
 */

export interface ParsedBudget {
  amountUsd: number;
  kind: "fixed" | "hourly" | "monthly" | "weekly" | "unknown";
  raw: string;
}

const BUDGET_RE =
  /(?:budget[:\s]*)?[$£€]\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s*(k\b)?\s*(?:(?:\/|per[\s-])(hr|hour|h\b|mo|month|wk|week)|(hourly|monthly|weekly))?/gi;

/** Extract the largest plausible budget mentioned in a hiring post. */
export function parseBudget(text: string): ParsedBudget | null {
  let best: ParsedBudget | null = null;
  for (const m of text.matchAll(BUDGET_RE)) {
    const num = parseFloat((m[1] ?? "0").replace(/,/g, ""));
    if (!isFinite(num) || num <= 0) continue;
    const amount = m[2] ? num * 1000 : num;
    if (amount < 5 || amount > 1_000_000) continue; // "$1" noise / typo territory
    const unit = (m[3] ?? m[4] ?? "").toLowerCase();
    const kind: ParsedBudget["kind"] = /^h/.test(unit)
      ? "hourly"
      : /^mo/.test(unit)
        ? "monthly"
        : /^w/.test(unit)
          ? "weekly"
          : "fixed";
    if (!best || amount > best.amountUsd) {
      best = { amountUsd: Math.round(amount), kind, raw: m[0].trim() };
    }
  }
  return best;
}

/** Is this a demand-side hiring post (not a freelancer advertising themselves)? */
export function isHiringPost(title: string): boolean {
  if (/\[(for[\s-]?hire|offer)\]/i.test(title)) return false;
  return /\[(hiring|task)\]/i.test(title);
}

/**
 * Vocabulary overlap between a cluster and a hiring post: number of distinct
 * meaningful tokens shared. ≥2 is the match bar used at validation.
 */
export function matchScore(clusterVocab: Set<string>, postText: string): number {
  let overlap = 0;
  for (const t of new Set(tokenize(postText))) {
    if (clusterVocab.has(t)) overlap++;
  }
  return overlap;
}

export function buildVocab(texts: string[]): Set<string> {
  const vocab = new Set<string>();
  for (const t of texts) for (const tok of tokenize(t)) vocab.add(tok);
  return vocab;
}
