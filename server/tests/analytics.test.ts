import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBudget, isHiringPost, matchScore, buildVocab } from "../lib/paidintent.ts";
import { normalizeEngagement, paidIntentScore, SOURCE_ENGAGEMENT_WEIGHT } from "../lib/demand.ts";
import { containsVerbatim, tokenize, hashAuthor } from "../lib/text.ts";
import { nearDuplicateIndexes } from "../lib/dedupe.ts";

describe("parseBudget", () => {
  test("fixed budget", () => {
    assert.equal(parseBudget("Budget: $250 for the whole project")?.amountUsd, 250);
    assert.equal(parseBudget("willing to pay $1,500 total")?.amountUsd, 1500);
  });
  test("k suffix", () => {
    assert.equal(parseBudget("budget is $2k")?.amountUsd, 2000);
  });
  test("hourly and monthly kinds", () => {
    const hourly = parseBudget("paying $45/hr for a few weeks");
    assert.equal(hourly?.amountUsd, 45);
    assert.equal(hourly?.kind, "hourly");
    const monthly = parseBudget("retainer of $800 per month");
    assert.equal(monthly?.amountUsd, 800);
    assert.equal(monthly?.kind, "monthly");
  });
  test("takes the largest plausible amount", () => {
    assert.equal(parseBudget("$50 for a logo or $500 for full branding")?.amountUsd, 500);
  });
  test("rejects noise", () => {
    assert.equal(parseBudget("I have $1 to my name lol"), null);
    assert.equal(parseBudget("no money mentioned here"), null);
    assert.equal(parseBudget("$5,000,000,000 valuation"), null); // > 1M cap
  });
});

describe("isHiringPost", () => {
  test("hiring and task pass", () => {
    assert.equal(isHiringPost("[Hiring] Need a Shopify inventory script"), true);
    assert.equal(isHiringPost("[TASK] scrape a product list ($30)"), true);
  });
  test("for-hire ads rejected", () => {
    assert.equal(isHiringPost("[For Hire] Full-stack dev, $30/hr"), false);
    assert.equal(isHiringPost("[FOR-HIRE] designer"), false);
    assert.equal(isHiringPost("Anyone else hate invoicing?"), false);
  });
});

describe("cluster ↔ paid-intent matching", () => {
  const vocab = buildVocab([
    "Invoice chasing eats freelancer hours",
    "Freelancers lose hours chasing overdue invoices",
    "invoicing & payments",
  ]);
  test("related hiring post matches (≥2 tokens)", () => {
    const score = matchScore(vocab, "[Hiring] build me a tool that chases overdue invoices automatically");
    assert.ok(score >= 2, `expected ≥2, got ${score}`);
  });
  test("unrelated hiring post does not match", () => {
    const score = matchScore(vocab, "[Hiring] Minecraft server admin needed");
    assert.ok(score < 2, `expected <2, got ${score}`);
  });
});

describe("normalizeEngagement", () => {
  test("source weights apply (twitter discounted, github boosted)", () => {
    const twitter = normalizeEngagement([{ source: "twitter", engagement: 100 }]);
    assert.equal(twitter.normalized, 100 * SOURCE_ENGAGEMENT_WEIGHT.twitter!);
    const github = normalizeEngagement([{ source: "github", engagement: 100 }]);
    assert.equal(github.normalized, 100 * SOURCE_ENGAGEMENT_WEIGHT.github!);
    assert.ok(github.normalized > twitter.normalized);
  });
  test("g2 market context counts zero", () => {
    assert.equal(normalizeEngagement([{ source: "g2", engagement: 5000 }]).counted, 0);
  });
  test("viral thread is capped", () => {
    const items = [
      { source: "reddit", engagement: 5000 }, // the viral thread
      ...Array.from({ length: 10 }, () => ({ source: "reddit", engagement: 20 })),
    ];
    const res = normalizeEngagement(items);
    assert.equal(res.raw, 5200);
    assert.ok(res.viralCapApplied, "viral cap should trigger");
    assert.ok(res.counted < 1000, `counted ${res.counted} should be far below raw 5200`);
  });
  test("uniform engagement is not capped", () => {
    const res = normalizeEngagement(Array.from({ length: 20 }, () => ({ source: "reddit", engagement: 50 })));
    assert.equal(res.viralCapApplied, false);
    assert.equal(res.counted, 1000);
  });
  test("single platform cannot exceed 60% when 2+ platforms present", () => {
    const res = normalizeEngagement([
      ...Array.from({ length: 30 }, () => ({ source: "reddit", engagement: 100 })),
      { source: "hn", engagement: 50 },
    ]);
    assert.ok(res.platformCapApplied, "platform cap should trigger");
    const hn = 50 * SOURCE_ENGAGEMENT_WEIGHT.hn!;
    assert.ok(res.counted <= hn + 1.5 * hn + 1, `reddit share should be ≤1.5× rest (counted=${res.counted})`);
  });
  test("empty input", () => {
    const res = normalizeEngagement([]);
    assert.equal(res.counted, 0);
    assert.equal(res.topItemShare, 0);
  });
});

describe("paidIntentScore", () => {
  test("null → 0", () => {
    assert.equal(paidIntentScore(null), 0);
  });
  test("count scales to 1.0 at 5 posts", () => {
    assert.equal(paidIntentScore({ count: 5, totalBudgetUsd: 0, medianBudgetUsd: 0 }), 1);
    assert.ok(paidIntentScore({ count: 1, totalBudgetUsd: 0, medianBudgetUsd: 0 }) < 0.3);
  });
  test("real budgets boost the axis", () => {
    const noBudget = paidIntentScore({ count: 2, totalBudgetUsd: 0, medianBudgetUsd: 0 });
    const budget = paidIntentScore({ count: 2, totalBudgetUsd: 900, medianBudgetUsd: 450 });
    assert.ok(budget > noBudget);
  });
});

describe("containsVerbatim (quote verification)", () => {
  const source = "I waste HOURS every week chasing clients for overdue invoices.\nIt's driving me crazy.";
  test("verbatim substring passes despite case/whitespace", () => {
    assert.equal(containsVerbatim(source, "i waste hours every week chasing clients"), true);
  });
  test("paraphrase fails", () => {
    assert.equal(containsVerbatim(source, "Freelancers spend many hours on invoice chasing"), false);
  });
  test("too-short quotes fail", () => {
    assert.equal(containsVerbatim(source, "hours"), false);
  });
});

describe("tokenize", () => {
  test("drops stopwords and short tokens", () => {
    const toks = tokenize("Is there a tool that syncs invoices to QuickBooks?");
    assert.ok(toks.includes("tool"));
    assert.ok(toks.includes("invoices"));
    assert.ok(!toks.includes("is"));
    assert.ok(!toks.includes("a"));
  });
});

describe("hashAuthor", () => {
  test("stable, source-scoped, drops deleted", () => {
    assert.equal(hashAuthor("reddit", "SomeUser"), hashAuthor("reddit", "someuser"));
    assert.notEqual(hashAuthor("reddit", "SomeUser"), hashAuthor("hn", "SomeUser"));
    assert.equal(hashAuthor("reddit", "[deleted]"), null);
    assert.equal(hashAuthor("reddit", "AutoModerator"), null);
  });
});

describe("nearDuplicateIndexes", () => {
  test("flags the crosspost, keeps the original order winner", () => {
    const texts = [
      "I waste hours every week chasing clients for overdue invoices and it is destroying my freelance business margins",
      "I waste hours every week chasing clients for overdue invoices and it is destroying my freelance business margins!!",
      "Completely different: my restaurant scheduling spreadsheet falls apart every single holiday season without fail",
    ];
    const dupes = nearDuplicateIndexes(texts);
    assert.ok(dupes.has(1), "near-identical later copy should be flagged");
    assert.ok(!dupes.has(0), "first (highest-engagement) copy survives");
    assert.ok(!dupes.has(2), "unrelated text survives");
  });
});
