import { tokenize } from "./text.ts";

/**
 * Paid-intent evidence: people posting "I will PAY someone to solve X".
 * Harvested from hiring subreddits ([Hiring]/[Task] posts), stored as
 * meta.kind = "paid-intent", and matched to problem clusters at validation —
 * a fundamentally stronger signal than complaints or upvotes.
 */

export interface ParsedBudget {
  amount: number;
  currency: "USD" | "GBP" | "EUR";
  /** Only populated when the source amount is actually denominated in USD. */
  amountUsd: number | null;
  kind: "fixed" | "hourly" | "monthly" | "weekly" | "unknown";
  raw: string;
}

const BUDGET_RE =
  /(?:budget[:\s]*)?([$£€])\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d{1,2})?)\s*(k\b)?\s*(?:(?:\/|per[\s-])(hr|hour|h\b|mo|month|wk|week)|(hourly|monthly|weekly))?/gi;

/** Extract the largest plausible budget mentioned in a hiring post. */
export function parseBudget(text: string): ParsedBudget | null {
  let best: ParsedBudget | null = null;
  for (const m of text.matchAll(BUDGET_RE)) {
    const num = parseFloat((m[2] ?? "0").replace(/,/g, ""));
    if (!isFinite(num) || num <= 0) continue;
    const amount = m[3] ? num * 1000 : num;
    if (amount < 5 || amount > 1_000_000) continue; // "$1" noise / typo territory
    const unit = (m[4] ?? m[5] ?? "").toLowerCase();
    const kind: ParsedBudget["kind"] = /^h/.test(unit)
      ? "hourly"
      : /^mo/.test(unit)
        ? "monthly"
        : /^w/.test(unit)
          ? "weekly"
          : "fixed";
    const currency = m[1] === "£" ? "GBP" : m[1] === "€" ? "EUR" : "USD";
    if (!best || amount > best.amount) {
      const rounded = Math.round(amount);
      best = {
        amount: rounded,
        currency,
        amountUsd: currency === "USD" ? rounded : null,
        kind,
        raw: m[0].trim(),
      };
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

const PAID_GENERIC = new Set(
  (
    "assistant assistants available budget business client clients company contract daily developer developers flexible " +
    "freelance freelancer freelancers full hiring hour hours job jobs looking month monthly needed online paid part payment " +
    "pay project projects remote role service services simple software task tasks team tool tools weekly work worker workers"
  ).split(" ")
);

function matchTerm(token: string): string {
  if (/^\d+$/.test(token) || PAID_GENERIC.has(token)) return "";
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function matchTerms(text: string): Set<string> {
  return new Set(tokenize(text).map(matchTerm).filter((term) => term.length >= 3));
}

export interface PaidMatchDocument {
  id: number;
  text: string;
}

export interface PaidMatchPost {
  id: number;
  text: string;
  /** Unbudgeted hiring posts are retained as leads but do not become scored paid intent. */
  budgetAmount: number | null;
}

export interface PaidMatch<TPost extends PaidMatchPost> {
  clusterId: number;
  post: TPost;
  score: number;
  sharedTerms: string[];
}

/**
 * High-precision, exclusive paid-intent assignment.
 *
 * A post must contain a real parsed budget, share at least two meaningful terms
 * (including one rare across clusters), and clearly beat the next-best cluster.
 * One buyer post can therefore strengthen at most one problem cluster.
 */
export function assignPaidIntentMatches<TPost extends PaidMatchPost>(
  documents: PaidMatchDocument[],
  posts: TPost[]
): PaidMatch<TPost>[] {
  if (documents.length === 0 || posts.length === 0) return [];
  const termsByCluster = new Map(documents.map((doc) => [doc.id, matchTerms(doc.text)]));
  const df = new Map<string, number>();
  for (const terms of termsByCluster.values()) {
    for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = documents.length;
  const idf = (term: string) => Math.log(1 + n / (df.get(term) ?? 1));
  const rareLimit = Math.max(2, Math.ceil(n * 0.2));
  const matches: PaidMatch<TPost>[] = [];

  for (const post of posts) {
    if (post.budgetAmount === null || post.budgetAmount <= 0) continue;
    const postTerms = matchTerms(post.text);
    if (postTerms.size < 2) continue;
    const postWeight = [...postTerms].reduce((sum, term) => sum + idf(term), 0) || 1;
    const ranked = documents
      .map((doc) => {
        const clusterTerms = termsByCluster.get(doc.id)!;
        const sharedTerms = [...postTerms].filter((term) => clusterTerms.has(term));
        const sharedWeight = sharedTerms.reduce((sum, term) => sum + idf(term), 0);
        const coverage = sharedWeight / postWeight;
        const breadth = Math.min(1, sharedTerms.length / 4);
        return { clusterId: doc.id, score: 0.8 * coverage + 0.2 * breadth, sharedTerms };
      })
      .filter(
        (candidate) =>
          candidate.sharedTerms.length >= 2 &&
          candidate.sharedTerms.some((term) => (df.get(term) ?? n) <= rareLimit)
      )
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < 0.42) continue;
    const runnerUp = ranked[1]?.score ?? 0;
    if (best.score < 0.72 && best.score - runnerUp < 0.08) continue;
    matches.push({ ...best, post });
  }
  return matches;
}
