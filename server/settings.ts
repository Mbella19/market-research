import { get, run } from "./db.ts";
import { env } from "./lib/env.ts";

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";

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
  };
  tiers: {
    goldVoices: number;
    goldPlatforms: number;
    silverVoices: number;
  };
  briefsPerScan: number;
  judgedClustersPerScan: number;
  /** Harvest cutoff in months — GitHub/StackExchange/YouTube/HN ignore anything older. */
  recencyWindowMonths: number;
  /** Trend scout: how many top software-fit trends get AI build-angles automatically. */
  trendAnglesPerScan: number;
}

function defaults(): AppSettings {
  return {
    ai: {
      enabled: true,
      bin: env("CODEX_BIN", "codex"),
      model: env("CODEX_MODEL", "gpt-5.5"),
      efforts: {
        plan: env("CODEX_EFFORT_PLAN", "high") as Effort,
        extract: env("CODEX_EFFORT_EXTRACT", "high") as Effort,
        cluster: env("CODEX_EFFORT_CLUSTER", "high") as Effort,
        judge: env("CODEX_EFFORT_JUDGE", "xhigh") as Effort,
        brief: env("CODEX_EFFORT_BRIEF", "xhigh") as Effort,
        ask: env("CODEX_EFFORT_ASK", "high") as Effort,
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
    },
    tiers: {
      goldVoices: 5000,
      goldPlatforms: 3,
      silverVoices: 1500,
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
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue; // ignore unknown keys
    const cur = out[k];
    if (typeof cur === "object" && cur !== null && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function getSettings(): AppSettings {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'");
  const stored = row ? (JSON.parse(row.value) as unknown) : null;
  return deepMerge(defaults(), stored);
}

export function updateSettings(patch: unknown): AppSettings {
  const merged = deepMerge(getSettings(), patch);
  run(
    "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(merged)
  );
  return merged;
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
