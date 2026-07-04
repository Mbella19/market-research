import { codexJson } from "../ai/codex.ts";
import { planPrompt } from "../ai/prompts.ts";
import { ZPlan, JPlan, type QueryPlan } from "../ai/schemas.ts";
import type { AppSettings } from "../settings.ts";

/** Curated "pain wells" scanned when no topic is given (Discovery mode). */
export const DISCOVERY_PACK: QueryPlan = {
  keywords: [],
  painQueries: [
    "is there a tool that",
    "why is there no app",
    "I wish there was an app",
    "software that doesn't exist",
    "I'd pay for a tool that",
    "manual process driving me crazy",
    "still doing this in spreadsheets",
    "how do you keep track of",
  ],
  subreddits: [
    "SomebodyMakeThis",
    "AppIdeas",
    "smallbusiness",
    "Entrepreneur",
    "productivity",
    "freelance",
    "sysadmin",
    "msp",
    "ecommerce",
    "marketing",
  ],
  stackSites: ["softwarerecs", "webapps"],
  githubQueries: ["feature request", "missing integration", "no way to export"],
  storeTerms: ["small business tools", "productivity", "field service"],
  youtubeQueries: ["app I wish existed", "small business software problems", "my workflow is broken"],
  wikipediaEntities: [],
};

function heuristicPlan(topic: string): QueryPlan {
  const t = topic.trim();
  const head = t.split(/\s+/).slice(0, 2).join(" ");
  return {
    keywords: [t, `${t} software`, `${t} tool`],
    painQueries: [
      `${t} is there a tool`,
      `${t} frustrating`,
      `I wish ${t}`,
      `${t} manual process`,
      `how do you manage ${t}`,
      `${t} spreadsheet`,
      `${t} problem`,
      `${t} alternative`,
    ],
    subreddits: ["smallbusiness", "Entrepreneur", "productivity", "freelance", "startups"],
    stackSites: ["softwarerecs", "webapps", "superuser"],
    githubQueries: [head, `${head} integration`],
    storeTerms: [head, `${head} app`],
    youtubeQueries: [`${t} workflow`, `${t} problems`],
    wikipediaEntities: [t.charAt(0).toUpperCase() + t.slice(1)],
  };
}

function sanitize(plan: QueryPlan): QueryPlan {
  const clean = (arr: string[], max: number, maxLen = 80) =>
    [...new Set(arr.map((s) => s.trim()).filter((s) => s.length > 1 && s.length <= maxLen))].slice(0, max);
  return {
    keywords: clean(plan.keywords, 6),
    painQueries: clean(plan.painQueries, 12),
    subreddits: clean(plan.subreddits, 10, 21),
    stackSites: clean(plan.stackSites, 4, 30),
    githubQueries: clean(plan.githubQueries, 5),
    storeTerms: clean(plan.storeTerms, 5),
    youtubeQueries: clean(plan.youtubeQueries, 4),
    wikipediaEntities: clean(plan.wikipediaEntities, 3),
  };
}

export async function buildPlan(
  topic: string | null,
  settings: AppSettings,
  signal: AbortSignal | undefined,
  log: (msg: string, type?: "log" | "warn") => void
): Promise<{ plan: QueryPlan; engine: "ai" | "heuristic" | "pack" }> {
  if (!topic) {
    log("discovery mode: scanning curated pain wells");
    return { plan: DISCOVERY_PACK, engine: "pack" };
  }
  if (settings.ai.enabled) {
    try {
      const { data, latencyMs } = await codexJson(
        {
          task: "query-plan",
          prompt: planPrompt(topic),
          effort: settings.ai.efforts.plan,
          schema: JPlan,
          timeoutMs: 12 * 60_000,
          signal,
        },
        ZPlan
      );
      const plan = sanitize(data);
      log(
        `AI query plan ready in ${(latencyMs / 1000).toFixed(0)}s — ${plan.painQueries.length} pain queries, ${plan.subreddits.length} subreddits`
      );
      return { plan, engine: "ai" };
    } catch (err) {
      log(
        `AI planning unavailable (${err instanceof Error ? err.message : err}) — using heuristic template`,
        "warn"
      );
    }
  }
  return { plan: sanitize(heuristicPlan(topic)), engine: "heuristic" };
}
