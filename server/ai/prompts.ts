import { truncate, collapseWs } from "../lib/text.ts";

const PREAMBLE =
  "You are the reasoning engine inside Lodestone, an evidence-based market research tool. " +
  "You are running non-interactively: do NOT run commands, do NOT read or write files, do NOT use tools. " +
  "Think carefully, then reply with a SINGLE JSON object and nothing else — no prose, no markdown fences.\n\n";

export const STACK_SITES = ["softwarerecs", "webapps", "superuser", "stackoverflow", "pm"];

export function planPrompt(topic: string): string {
  return (
    PREAMBLE +
    `TASK: Build a harvesting query plan to find REAL people complaining about REAL problems related to the niche: "${topic}".

We will run your queries against Reddit, Hacker News, GitHub issues, Stack Exchange, YouTube, app stores and X/Twitter. Good queries surface first-person pain ("I waste hours...", "is there a tool that...", "why does X not support...") rather than news or tutorials.

Produce:
- keywords: 4-6 short topic phrasings people actually use (2-4 words each, no boolean operators).
- painQueries: 8-12 search strings combining the niche with pain/demand phrasing, e.g. "<niche> is there a tool", "<niche> so frustrating", "I wish <niche>", "how do you manage <niche>", "<niche> spreadsheet hell", "<niche> alternative". Keep each under 8 words, no quotes/operators.
- subreddits: 5-10 REAL subreddit names (no "r/" prefix) where this audience genuinely hangs out and complains. Only subreddits you are confident exist.
- stackSites: 1-4 Stack Exchange site slugs from this exact list: ${STACK_SITES.join(", ")}.
- githubQueries: 3-5 SHORT phrases (2-3 words each) matching feature requests / tool gaps in this space, e.g. "invoice reminder", "recurring invoices" (no qualifiers).
- storeTerms: 3-5 app-store search terms for existing apps this audience uses (we mine their 1-3 star reviews for complaints).
- youtubeQueries: 3-4 YouTube searches likely to surface videos whose comment sections contain complaints about this workflow.
- wikipediaEntities: 1-3 English Wikipedia article titles (exact, underscored not required) that proxy interest in this niche for trend data.

JSON shape: {"keywords":[],"painQueries":[],"subreddits":[],"stackSites":[],"githubQueries":[],"storeTerms":[],"youtubeQueries":[],"wikipediaEntities":[]}`
  );
}

export interface ExtractItemInput {
  id: number;
  source: string;
  title: string;
  body: string;
}

export function extractPrompt(items: ExtractItemInput[], topic: string | null): string {
  const itemsJson = JSON.stringify(
    items.map((it) => ({
      id: it.id,
      source: it.source,
      title: truncate(collapseWs(it.title), 200),
      body: truncate(collapseWs(it.body), 700),
    }))
  );
  return (
    PREAMBLE +
    `TASK: You are screening raw internet posts for REAL problems that software could solve${topic ? ` (research niche: "${topic}")` : ""}.

For EVERY item below decide isPain: does the author (or the people they describe) genuinely experience a problem, unmet need, or painful workflow?

isPain = true only when there is a concrete problem a product could address. Typical true cases: complaints, "is there a tool for X", feature requests, angry app reviews, descriptions of tedious manual workflows, "I'd pay for X".
isPain = false for: news, launches, self-promotion, praise, memes, philosophical rants with no actionable need, tutorials, questions already fully solved in the post.

For items with isPain = true also produce:
- statement: the underlying problem in ONE clear sentence, generalized ("Freelancers lose hours chasing overdue invoices"), not a copy of the title.
- category: 2-4 word domain label (e.g. "invoicing & payments").
- persona: WHO has the problem (e.g. "freelance designers", "small e-commerce owners").
- severity 1-5: 1 = mild annoyance, 3 = regular friction, 5 = costs serious money/time or blocks work.
- wtp: "explicit" if they mention paying/pricing/subscriptions or "shut up and take my money"; "hinted" if they describe paying for workarounds or heavy time loss; else "none".
- quote: copy the single most evidential sentence VERBATIM from the title or body (max 220 chars). It must be an exact contiguous substring — do not paraphrase, do not stitch fragments.

For isPain = false items: statement/category/persona/quote = "", severity = 1, wtp = "none".

Return every id exactly once.
ITEMS: ${itemsJson}

JSON shape: {"results":[{"id":0,"isPain":true,"statement":"","category":"","persona":"","severity":3,"wtp":"none","quote":""}]}`
  );
}

export interface ClusterCandidateInput {
  id: number;
  size: number;
  samples: string[];
}

export function clusterRefinePrompt(candidates: ClusterCandidateInput[], topic: string | null): string {
  return (
    PREAMBLE +
    `TASK: We grouped extracted problem statements${topic ? ` about "${topic}"` : ""} into rough candidate clusters with TF-IDF. Refine them into final, coherent problem clusters.

Rules:
- Merge candidates that describe the SAME underlying problem (memberIds = the candidate ids you merged; every candidate id must appear in exactly one output cluster).
- Split nothing; if a candidate is a grab-bag, mark coherent=false.
- name: a crisp 3-7 word problem name, phrased as the pain (e.g. "Invoice chasing eats freelancer hours"), never a product name.
- summary: 2-3 sentences describing the shared problem and who suffers from it, grounded ONLY in the samples shown.
- category: 2-4 word domain label. persona: who has it.
- coherent: false ONLY if the member statements have no common problem.

CANDIDATE CLUSTERS: ${JSON.stringify(candidates)}

JSON shape: {"clusters":[{"memberIds":[1,2],"name":"","summary":"","category":"","persona":"","coherent":true}]}`
  );
}

export interface JudgeEvidenceInput {
  source: string;
  date: string;
  engagement: number;
  title: string;
  quote: string;
}

export function judgePrompt(
  name: string,
  summary: string,
  metrics: {
    distinctAuthors: number;
    platforms: string[];
    engagement: number;
    voices: number;
    recencyRatio: number;
    topThreadShare?: number;
    paidIntentPosts?: number;
    paidMedianBudgetUsd?: number;
  },
  evidence: JudgeEvidenceInput[]
): string {
  return (
    PREAMBLE +
    `TASK: You are a deeply skeptical demand analyst. Assess whether this problem cluster represents REAL, monetizable market demand — or an artifact (one viral thread, vocal minority, already well-solved, or people who complain but would never pay).

CLUSTER: "${name}"
SUMMARY: ${summary}
HARD METRICS: ${JSON.stringify(metrics)} (voices = distinct complainers + normalized viral-capped engagement; topThreadShare = fraction of engagement carried by the single biggest thread; paidIntentPosts = hiring posts with real budgets matched to this problem — the strongest willingness-to-pay evidence available)

EVIDENCE (verbatim quotes from real posts): ${JSON.stringify(evidence)}

Judge:
- painIntensity 0-10: how much time/money/stress this problem actually costs the people affected.
- wtpEvidence 0-10: strength of willingness-to-pay signals in the evidence (mentions of paying, pricing complaints about incumbents, expensive workarounds).
- verdict: "rejected" if the demand is illusory — e.g. >70% of engagement from ONE thread, complaints about a free product being free, problems already solved by dominant free tools, or pure venting with zero desire for a solution. Otherwise "validated".
- reasons: 2-4 short bullets defending your verdict, referencing the evidence patterns (not invented facts).
- buyerPersona: one sentence: who would pay.
- competition: one-two sentences: what people currently use (only if visible in evidence; else say what the evidence implies).
- whyNow: one sentence: why this pain is growing or newly addressable (or "" if no signal).

JSON shape: {"painIntensity":0,"wtpEvidence":0,"verdict":"validated","reasons":[],"buyerPersona":"","competition":"","whyNow":""}`
  );
}

export interface BriefEvidenceInput {
  source: string;
  title: string;
  quote: string;
  engagement: number;
  url: string;
}

export function briefPrompt(
  name: string,
  summary: string,
  judge: { buyerPersona: string; competition: string; whyNow: string },
  metrics: { voices: number; distinctAuthors: number; platforms: string[] },
  evidence: BriefEvidenceInput[],
  marketContext: string[],
  steer?: string
): string {
  return (
    PREAMBLE +
    `TASK: Write a founder-grade opportunity brief for a software product that solves this validated problem. Be specific and buildable by a solo developer or tiny team — no "platform" fantasies. Ground every claim in the evidence; do not invent statistics.

VALIDATED PROBLEM: "${name}"
SUMMARY: ${summary}
DEMAND METRICS: ${JSON.stringify(metrics)}
ANALYST NOTES: ${JSON.stringify(judge)}
EVIDENCE SAMPLE: ${JSON.stringify(evidence)}
MARKET CONTEXT (existing products/launches seen during harvesting): ${JSON.stringify(marketContext.slice(0, 12))}
${steer ? `USER STEERING (must follow): ${steer}\n` : ""}
Produce:
- title: product concept name + 3-6 word descriptor (e.g. "DunningPilot — invoice chasing on autopilot").
- oneLiner: one sentence a stranger instantly understands.
- problem: 2-3 sentences, quantified only by what the evidence shows.
- targetUser: precise ICP, where they hang out (from the evidence sources).
- mvpFeatures: 4-6 features for a 4-6 week MVP, each one line, ordered by importance. No auth/billing boilerplate.
- differentiation: 2-3 sentences vs the market context above (or vs manual workarounds if no products exist).
- monetization: pricing model + realistic price point, phrased explicitly as a HYPOTHESIS to test (harvested complaints cannot verify prices) with one-line justification.
- gtm: 3-5 concrete first-100-customers moves tied to WHERE the evidence came from (specific subreddits, HN, app-store keywords...).
- risks: 2-4 honest risks (platform dependence, incumbent response, thin wallet...).
- competitors: 2-5 real alternatives from market context/evidence with a one-line note each (empty array if genuinely none visible).
- whyNow: one sentence.
- successMetrics: 2-3 measurable 90-day validation targets.

JSON shape: {"title":"","oneLiner":"","problem":"","targetUser":"","mvpFeatures":[],"differentiation":"","monetization":"","gtm":[],"risks":[],"competitors":[{"name":"","note":""}],"whyNow":"","successMetrics":[]}`
  );
}

export interface TrendCandidateInput {
  id: number;
  label: string;
  signals: string[];
}

export function trendClassifyPrompt(candidates: TrendCandidateInput[]): string {
  return (
    PREAMBLE +
    `TASK: You are the classification layer of a TREND SCOUT. Below are candidate trends detected purely from growth signals across the public internet (new GitHub repos gaining stars unusually fast, topics surging on Hacker News front pages vs the previous period, clusters of Product Hunt launches, breakout Google searches, X trending topics).

IMPORTANT — this is NOT demand research: do NOT judge pain, demand, market size, or whether anyone would pay. Momentum was already measured; your only jobs are to identify, describe, and filter.

For EVERY candidate:
- name: a clean human-readable trend name, 2-6 words (e.g. "Local-first sync engines", "AI meeting note-takers"). Never a bare repo slug.
- category: 2-3 word domain label (e.g. "AI · dev tools", "consumer social", "e-commerce ops").
- summary: 2 sentences max — WHAT this is and WHAT the signals say is happening (reference the signal types, not invented facts).
- softwareFit: can a solo developer or tiny team ride this trend by building PURE SOFTWARE (web app, API, CLI, plugin, mobile app)?
  - "strong": the trend itself is software or creates an obvious software surface (new protocol, new platform, new workflow, new model/API people are adopting).
  - "possible": software-adjacent — tooling, analytics, marketplaces or content products around it could work.
  - "rejected": NOT rideable with software alone — physical/hardware products, biotech/medical devices, energy/materials, logistics fleets, retail chains — OR pure noise: celebrities, sports, elections, weather, movies/TV, memes, one-off news events, price movements of assets.
- fitReason: one sentence — for strong/possible, what kind of software the trend opens; for rejected, why it fails the software test.

CANDIDATES: ${JSON.stringify(candidates)}

Return every id exactly once.
JSON shape: {"trends":[{"id":0,"name":"","category":"","summary":"","softwareFit":"possible","fitReason":""}]}`
  );
}

export function trendAnglesPrompt(
  name: string,
  category: string,
  summary: string,
  signals: string[]
): string {
  return (
    PREAMBLE +
    `TASK: A trend scout confirmed this trend is rising and rideable with pure software. Propose 2-3 concrete BUILD ANGLES: software products a solo developer could start building this month (with an AI coding agent) to ride the trend while it is still early. Do not fabricate demand claims — momentum is the only validated fact; frame angles as bets on the trend, not proven needs.

TREND: "${name}" (${category})
WHAT IS HAPPENING: ${summary}
GROWTH SIGNALS: ${JSON.stringify(signals.slice(0, 8))}

Each angle:
- title: product concept name + 3-5 word descriptor.
- oneLiner: one sentence a stranger instantly understands.
- mvp: 1-2 sentences: the buildable 2-4 week core (pure software, no hardware, no auth/billing boilerplate talk).
- trendFit: one sentence: why THIS rides THIS trend's growth curve (distribution, timing, or gap logic).

Rules: pure software only; solo-buildable (no "platforms", no marketplaces needing both sides day one); distinct angles, not three flavors of one idea.

JSON shape: {"angles":[{"title":"","oneLiner":"","mvp":"","trendFit":""}]}`
  );
}

export interface AskEvidenceInput {
  itemId: number;
  source: string;
  date: string;
  engagement: number;
  title: string;
  quote: string;
  statement: string;
}

export function askPrompt(question: string, clusterName: string, evidence: AskEvidenceInput[]): string {
  return (
    PREAMBLE +
    `TASK: Answer the researcher's question about the problem cluster "${clusterName}" using ONLY the evidence below. If the evidence cannot answer it, say exactly what is missing — never invent facts, numbers, or sources. Reference evidence inline as [#itemId] right after each claim.

QUESTION: ${question}

EVIDENCE: ${JSON.stringify(evidence)}

JSON shape: {"answer":"... [#123] ...","citedItemIds":[123]}
- answer: 2-6 sentences, plain text with [#id] citations.
- citedItemIds: every itemId you cited.`
  );
}
