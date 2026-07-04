import type { QueryPlan } from "../ai/schemas.ts";
import type { AppSettings } from "../settings.ts";

export type SourceId =
  | "reddit"
  | "hn"
  | "github"
  | "stackexchange"
  | "lemmy"
  | "youtube"
  | "playstore"
  | "appstore"
  | "producthunt"
  | "twitter"
  | "g2";

export interface RawItem {
  source: SourceId;
  externalId: string;
  url: string;
  title: string;
  body: string;
  author: string | null;
  /** Upvotes / points / likes / reactions / review helpful-votes. */
  score: number;
  /** Comment / reply / answer count. */
  comments: number;
  views?: number | null;
  createdUtc: number | null;
  /** kind: "pain" (default, goes through extraction) or "market" (competitive context only). */
  meta?: Record<string, unknown>;
}

export interface HarvestContext {
  topic: string | null;
  plan: QueryPlan;
  /** Item budget for this source. */
  limit: number;
  settings: AppSettings;
  signal?: AbortSignal;
  log: (msg: string, type?: "log" | "warn") => void;
}

export interface Connector {
  id: SourceId;
  label: string;
  /** Share of the scan's item budget. */
  weight: number;
  /** "ready" | "needs-key" — used by the UI source grid. */
  status(settings: AppSettings): "ready" | "needs-key";
  harvest(ctx: HarvestContext): Promise<RawItem[]>;
}
