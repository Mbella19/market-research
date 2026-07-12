import { z } from "zod";

/**
 * Each AI task has a strict zod validator plus a JSON Schema for the model.
 * Invalid or incomplete output is repaired/retried rather than silently defaulted.
 */

const strArr = z.array(z.string().trim().min(1).max(500)).max(50);
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
}).strict();
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

export const ZExtractResult = z
  .object({
    id: z.number().int(),
    isPain: z.boolean(),
    statement: z.string().max(500),
    category: z.string().max(100),
    persona: z.string().max(200),
    severity: z.number().int().min(1).max(5),
    wtp: z.enum(["none", "hinted", "explicit"]),
    quote: z.string().max(300),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.isPain && (!result.statement.trim() || !result.category.trim() || !result.persona.trim())) {
      ctx.addIssue({ code: "custom", message: "pain results require statement, category, and persona" });
    }
    if (
      !result.isPain &&
      (result.statement !== "" || result.category !== "" || result.persona !== "" || result.quote !== "" ||
        result.severity !== 1 || result.wtp !== "none")
    ) {
      ctx.addIssue({ code: "custom", message: "non-pain results must use the documented empty defaults" });
    }
  });
export const ZExtract = z.object({ results: z.array(ZExtractResult).max(100) }).strict();
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
        memberIds: z.array(z.number().int()).min(1).max(40),
        name: z.string().trim().min(1).max(160),
        summary: z.string().max(1200),
        category: z.string().trim().min(1).max(100),
        persona: z.string().trim().min(1).max(200),
        coherent: z.boolean(),
      }).strict()
    )
    .max(40),
}).strict();
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
  painIntensity: z.number().min(0).max(10),
  wtpEvidence: z.number().min(0).max(10),
  verdict: z.enum(["validated", "rejected"]),
  reasons: strArr.min(1).max(6),
  buyerPersona: z.string().max(500),
  competition: z.string().max(800),
  whyNow: z.string().max(500),
}).strict();
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
  title: z.string().trim().min(3).max(200),
  oneLiner: z.string().trim().min(10).max(500),
  problem: z.string().trim().min(20).max(2000),
  targetUser: z.string().trim().min(5).max(1000),
  mvpFeatures: strArr.min(3).max(8),
  differentiation: z.string().trim().min(10).max(1500),
  monetization: z.string().trim().min(10).max(1000),
  gtm: strArr.min(2).max(8),
  risks: strArr.min(1).max(8),
  competitors: z
    .array(z.object({ name: z.string().trim().min(1).max(200), note: z.string().max(600) }).strict())
    .max(8),
  whyNow: z.string().max(500),
  successMetrics: strArr.min(2).max(6),
}).strict();
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
        id: z.number().int(),
        name: z.string().trim().min(1).max(160),
        category: z.string().trim().min(1).max(100),
        summary: z.string().max(1000),
        softwareFit: z.enum(["strong", "possible", "rejected"]),
        fitReason: z.string().max(600),
      }).strict()
    )
    .max(50),
}).strict();
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
        title: z.string().trim().min(3).max(200),
        oneLiner: z.string().trim().min(10).max(500),
        mvp: z.string().trim().min(10).max(1000),
        trendFit: z.string().trim().min(10).max(600),
      }).strict()
    )
    .min(2)
    .max(3),
}).strict();
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
  answer: z.string().trim().min(1).max(4000),
  citedItemIds: z.array(z.number().int()).max(25),
}).strict();
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
