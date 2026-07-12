import { get, run } from "./db.ts";
import { env } from "./lib/env.ts";
import { z } from "zod";

export type Effort = "none" | "low" | "medium" | "high" | "xhigh";

export interface AppSettings {
  ai: {
    enabled: boolean;
    bin: string;
    model: string;
    efforts: {
      plan: Effort;
      extract: Effort;
      cluster: Effort;
      judge: Effort;
      brief: Effort;
      ask: Effort;
    };
    concurrency: number;
    extractBatchSize: number;
  };
  keys: {
    githubToken: string;
    twitterBearer: string;
    youtubeApiKey: string;
    g2Token: string;
  };
  gate: {
    minAuthors: number;
    minPlatforms: number;
    minEngagement: number;
    minRecencyRatio: number; // 0..1 share of evidence from the last 12 months
    minDatedRatio: number; // 0..1 share whose publication date is known
  };
  tiers: {
    goldAuthors: number;
    goldPlatforms: number;
    silverAuthors: number;
  };
  briefsPerScan: number;
  judgedClustersPerScan: number;
  /** Harvest cutoff in months — GitHub/StackExchange/YouTube/HN ignore anything older. */
  recencyWindowMonths: number;
  /** Trend scout: how many top software-fit trends get AI build-angles automatically. */
  trendAnglesPerScan: number;
}

const EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

function effortEnv(key: string, fallback: Effort): Effort {
  const value = env(key, fallback);
  return EFFORTS.includes(value as Effort) ? (value as Effort) : fallback;
}

function defaults(): AppSettings {
  return {
    ai: {
      enabled: true,
      bin: env("CODEX_BIN", "codex"),
      model: env("CODEX_MODEL", "gpt-5.6-sol"),
      efforts: {
        plan: effortEnv("CODEX_EFFORT_PLAN", "xhigh"),
        extract: effortEnv("CODEX_EFFORT_EXTRACT", "xhigh"),
        cluster: effortEnv("CODEX_EFFORT_CLUSTER", "xhigh"),
        judge: effortEnv("CODEX_EFFORT_JUDGE", "xhigh"),
        brief: effortEnv("CODEX_EFFORT_BRIEF", "xhigh"),
        ask: effortEnv("CODEX_EFFORT_ASK", "xhigh"),
      },
      concurrency: 2,
      extractBatchSize: 60,
    },
    keys: {
      githubToken: env("GITHUB_TOKEN"),
      twitterBearer: env("TWITTER_BEARER_TOKEN"),
      youtubeApiKey: env("YOUTUBE_API_KEY"),
      g2Token: env("G2_TOKEN"),
    },
    gate: {
      minAuthors: 25,
      minPlatforms: 2,
        minEngagement: 800,
        minRecencyRatio: 0.3,
        minDatedRatio: 0.7,
      },
      tiers: {
        goldAuthors: 100,
        goldPlatforms: 3,
        silverAuthors: 50,
    },
    briefsPerScan: 5,
    judgedClustersPerScan: 12,
    recencyWindowMonths: 24,
    trendAnglesPerScan: 4,
  };
}

export function recencyCutoffSec(s: AppSettings): number {
  return Math.floor(Date.now() / 1000) - s.recencyWindowMonths * 30 * 86400;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== "object" || base === null) return patch as T;
  if (typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) continue; // ignore unknown/inherited keys
    const cur = out[k];
    if (typeof cur === "object" && cur !== null && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

const ZEffort = z.enum(EFFORTS);
const ZAppSettings: z.ZodType<AppSettings> = z
  .object({
    ai: z.object({
      enabled: z.boolean(),
      bin: z.string().trim().min(1).max(300),
      model: z.string().trim().min(1).max(120),
      efforts: z.object({
        plan: ZEffort,
        extract: ZEffort,
        cluster: ZEffort,
        judge: ZEffort,
        brief: ZEffort,
        ask: ZEffort,
      }),
      concurrency: z.number().int().min(1).max(8),
      extractBatchSize: z.number().int().min(10).max(100),
    }),
    keys: z.object({
      githubToken: z.string().max(1000),
      twitterBearer: z.string().max(2000),
      youtubeApiKey: z.string().max(1000),
      g2Token: z.string().max(1000),
    }),
    gate: z.object({
      minAuthors: z.number().int().min(1).max(100_000),
      minPlatforms: z.number().int().min(1).max(11),
      minEngagement: z.number().min(0).max(100_000_000),
      minRecencyRatio: z.number().min(0).max(1),
      minDatedRatio: z.number().min(0).max(1),
    }),
    tiers: z.object({
      goldAuthors: z.number().int().min(1).max(100_000),
      goldPlatforms: z.number().int().min(1).max(11),
      silverAuthors: z.number().int().min(1).max(100_000),
    }),
    briefsPerScan: z.number().int().min(0).max(20),
    judgedClustersPerScan: z.number().int().min(1).max(100),
    recencyWindowMonths: z.number().int().min(3).max(60),
    trendAnglesPerScan: z.number().int().min(0).max(20),
  })
  .superRefine((settings, ctx) => {
    if (settings.tiers.goldAuthors < settings.tiers.silverAuthors) {
      ctx.addIssue({ code: "custom", path: ["tiers", "goldAuthors"], message: "must be >= silverAuthors" });
    }
    if (settings.tiers.goldPlatforms < settings.gate.minPlatforms) {
      ctx.addIssue({ code: "custom", path: ["tiers", "goldPlatforms"], message: "must be >= gate.minPlatforms" });
    }
  });

export class SettingsValidationError extends Error {}

function assertPatchShape(base: unknown, patch: unknown, path = "settings"): void {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new SettingsValidationError(`${path}: expected an object`);
  }
  const baseRecord = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(baseRecord, key)) {
      throw new SettingsValidationError(`${path}.${key}: unknown setting`);
    }
    assertPatchShape(baseRecord[key], value, `${path}.${key}`);
  }
}

export function getSettings(): AppSettings {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'");
  let stored: unknown = null;
  try {
    stored = row ? (JSON.parse(row.value) as unknown) : null;
  } catch {
    stored = null;
  }
  const parsed = ZAppSettings.safeParse(deepMerge(defaults(), stored));
  return parsed.success ? parsed.data : defaults();
}

export function updateSettings(patch: unknown): AppSettings {
  const current = getSettings();
  assertPatchShape(current, patch);
  const merged = deepMerge(current, patch);
  const parsed = ZAppSettings.safeParse(merged);
  if (!parsed.success) {
    throw new SettingsValidationError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  run(
    "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(parsed.data)
  );
  return parsed.data;
}

const mask = (s: string) => (s ? `••••••••${s.slice(-4)}` : "");

/** Settings shaped for the UI — secrets masked. */
export function publicSettings(): Omit<AppSettings, "keys"> & {
  keys: { githubToken: string; twitterBearer: string; youtubeApiKey: string; g2Token: string };
  keysConfigured: { github: boolean; twitter: boolean; youtube: boolean; g2: boolean };
} {
  const s = getSettings();
  return {
    ...s,
    keys: {
      githubToken: mask(s.keys.githubToken),
      twitterBearer: mask(s.keys.twitterBearer),
      youtubeApiKey: mask(s.keys.youtubeApiKey),
      g2Token: mask(s.keys.g2Token),
    },
    keysConfigured: {
      github: Boolean(s.keys.githubToken),
      twitter: Boolean(s.keys.twitterBearer),
      youtube: Boolean(s.keys.youtubeApiKey),
      g2: Boolean(s.keys.g2Token),
    },
  };
}

/** Immutable, secret-free configuration recorded with each scan. */
export function pipelineConfigSnapshot(settings = getSettings()): Record<string, unknown> {
  const { keys: _keys, ...safe } = settings;
  return {
    ...safe,
    keysConfigured: {
      github: Boolean(settings.keys.githubToken),
      twitter: Boolean(settings.keys.twitterBearer),
      youtube: Boolean(settings.keys.youtubeApiKey),
      g2: Boolean(settings.keys.g2Token),
    },
    promptVersion: 2,
    metricsVersion: 2,
  };
}
