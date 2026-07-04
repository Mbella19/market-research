import { z } from "zod";

/**
 * Each AI task has a zod validator (lenient: coerces/clamps model sloppiness)
 * plus a strict JSON Schema handed to `codex exec --output-schema`.
 */

const strArr = z.array(z.string()).catch([]);
const jsStrArr = { type: "array", items: { type: "string" } };

// ---------- plan ----------

export const ZPlan = z.object({
  keywords: strArr,
  painQueries: strArr,
  subreddits: strArr,
  stackSites: strArr,
  githubQueries: strArr,
  storeTerms: strArr,
  youtubeQueries: strArr,
  wikipediaEntities: strArr,
});
export type QueryPlan = z.infer<typeof ZPlan>;

export const JPlan = {
  type: "object",
  properties: {
    keywords: jsStrArr,
    painQueries: jsStrArr,
    subreddits: jsStrArr,
    stackSites: jsStrArr,
    githubQueries: jsStrArr,
    storeTerms: jsStrArr,
    youtubeQueries: jsStrArr,
    wikipediaEntities: jsStrArr,
  },
  required: [
    "keywords",
    "painQueries",
    "subreddits",
    "stackSites",
    "githubQueries",
    "storeTerms",
    "youtubeQueries",
    "wikipediaEntities",
  ],
  additionalProperties: false,
};

// ---------- extract ----------

export const ZExtractResult = z.object({
  id: z.coerce.number().int(),
  isPain: z.boolean().catch(false),
  statement: z.string().catch(""),
  category: z.string().catch("general"),
  persona: z.string().catch("unknown"),
  severity: z.coerce.number().int().min(1).max(5).catch(3),
  wtp: z.enum(["none", "hinted", "explicit"]).catch("none"),
  quote: z.string().catch(""),
});
export const ZExtract = z.object({ results: z.array(ZExtractResult).catch([]) });
export type ExtractResult = z.infer<typeof ZExtractResult>;

export const JExtract = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          isPain: { type: "boolean" },
          statement: { type: "string" },
          category: { type: "string" },
          persona: { type: "string" },
          severity: { type: "integer" },
          wtp: { type: "string", enum: ["none", "hinted", "explicit"] },
          quote: { type: "string" },
        },
        required: ["id", "isPain", "statement", "category", "persona", "severity", "wtp", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

// ---------- cluster refine ----------

export const ZClusterRefine = z.object({
  clusters: z
    .array(
      z.object({
        memberIds: z.array(z.coerce.number().int()).catch([]),
        name: z.string().catch(""),
        summary: z.string().catch(""),
        category: z.string().catch("general"),
        persona: z.string().catch("unknown"),
        coherent: z.boolean().catch(true),
      })
    )
    .catch([]),
});
export type ClusterRefine = z.infer<typeof ZClusterRefine>;

export const JClusterRefine = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          memberIds: { type: "array", items: { type: "integer" } },
          name: { type: "string" },
          summary: { type: "string" },
          category: { type: "string" },
          persona: { type: "string" },
          coherent: { type: "boolean" },
        },
        required: ["memberIds", "name", "summary", "category", "persona", "coherent"],
        additionalProperties: false,
      },
    },
  },
  required: ["clusters"],
  additionalProperties: false,
};

// ---------- demand judge ----------

export const ZJudge = z.object({
  painIntensity: z.coerce.number().min(0).max(10).catch(5),
  wtpEvidence: z.coerce.number().min(0).max(10).catch(3),
  verdict: z.enum(["validated", "rejected"]).catch("validated"),
  reasons: strArr,
  buyerPersona: z.string().catch(""),
  competition: z.string().catch(""),
  whyNow: z.string().catch(""),
});
export type JudgeVerdict = z.infer<typeof ZJudge>;

export const JJudge = {
  type: "object",
  properties: {
    painIntensity: { type: "number" },
    wtpEvidence: { type: "number" },
    verdict: { type: "string", enum: ["validated", "rejected"] },
    reasons: jsStrArr,
    buyerPersona: { type: "string" },
    competition: { type: "string" },
    whyNow: { type: "string" },
  },
  required: [
    "painIntensity",
    "wtpEvidence",
    "verdict",
    "reasons",
    "buyerPersona",
    "competition",
    "whyNow",
  ],
  additionalProperties: false,
};

// ---------- opportunity brief ----------

export const ZBrief = z.object({
  title: z.string(),
  oneLiner: z.string().catch(""),
  problem: z.string().catch(""),
  targetUser: z.string().catch(""),
  mvpFeatures: strArr,
  differentiation: z.string().catch(""),
  monetization: z.string().catch(""),
  gtm: strArr,
  risks: strArr,
  competitors: z
    .array(z.object({ name: z.string().catch(""), note: z.string().catch("") }))
    .catch([]),
  whyNow: z.string().catch(""),
  successMetrics: strArr,
});
export type Brief = z.infer<typeof ZBrief>;

export const JBrief = {
  type: "object",
  properties: {
    title: { type: "string" },
    oneLiner: { type: "string" },
    problem: { type: "string" },
    targetUser: { type: "string" },
    mvpFeatures: jsStrArr,
    differentiation: { type: "string" },
    monetization: { type: "string" },
    gtm: jsStrArr,
    risks: jsStrArr,
    competitors: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, note: { type: "string" } },
        required: ["name", "note"],
        additionalProperties: false,
      },
    },
    whyNow: { type: "string" },
    successMetrics: jsStrArr,
  },
  required: [
    "title",
    "oneLiner",
    "problem",
    "targetUser",
    "mvpFeatures",
    "differentiation",
    "monetization",
    "gtm",
    "risks",
    "competitors",
    "whyNow",
    "successMetrics",
  ],
  additionalProperties: false,
};

// ---------- trend classify ----------

export const ZTrendClassify = z.object({
  trends: z
    .array(
      z.object({
        id: z.coerce.number().int(),
        name: z.string().catch(""),
        category: z.string().catch("general"),
        summary: z.string().catch(""),
        softwareFit: z.enum(["strong", "possible", "rejected"]).catch("possible"),
        fitReason: z.string().catch(""),
      })
    )
    .catch([]),
});
export type TrendClassify = z.infer<typeof ZTrendClassify>;

export const JTrendClassify = {
  type: "object",
  properties: {
    trends: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          category: { type: "string" },
          summary: { type: "string" },
          softwareFit: { type: "string", enum: ["strong", "possible", "rejected"] },
          fitReason: { type: "string" },
        },
        required: ["id", "name", "category", "summary", "softwareFit", "fitReason"],
        additionalProperties: false,
      },
    },
  },
  required: ["trends"],
  additionalProperties: false,
};

// ---------- trend build angles ----------

export const ZTrendAngles = z.object({
  angles: z
    .array(
      z.object({
        title: z.string().catch(""),
        oneLiner: z.string().catch(""),
        mvp: z.string().catch(""),
        trendFit: z.string().catch(""),
      })
    )
    .catch([]),
});
export type TrendAngles = z.infer<typeof ZTrendAngles>;

export const JTrendAngles = {
  type: "object",
  properties: {
    angles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          oneLiner: { type: "string" },
          mvp: { type: "string" },
          trendFit: { type: "string" },
        },
        required: ["title", "oneLiner", "mvp", "trendFit"],
        additionalProperties: false,
      },
    },
  },
  required: ["angles"],
  additionalProperties: false,
};

// ---------- ask the evidence ----------

export const ZAsk = z.object({
  answer: z.string(),
  citedItemIds: z.array(z.coerce.number().int()).catch([]),
});
export type AskAnswer = z.infer<typeof ZAsk>;

export const JAsk = {
  type: "object",
  properties: {
    answer: { type: "string" },
    citedItemIds: { type: "array", items: { type: "integer" } },
  },
  required: ["answer", "citedItemIds"],
  additionalProperties: false,
};
