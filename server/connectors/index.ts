import type { Connector, SourceId } from "./types.ts";
import { reddit } from "./reddit.ts";
import { hn } from "./hn.ts";
import { github } from "./github.ts";
import { stackexchange } from "./stackexchange.ts";
import { lemmy } from "./lemmy.ts";
import { youtube } from "./youtube.ts";
import { playstore } from "./playstore.ts";
import { appstore } from "./appstore.ts";
import { producthunt } from "./producthunt.ts";
import { twitter } from "./twitter.ts";
import { g2 } from "./g2.ts";

export const CONNECTORS: Connector[] = [
  reddit,
  hn,
  github,
  stackexchange,
  lemmy,
  youtube,
  playstore,
  appstore,
  producthunt,
  twitter,
  g2,
];

export const connectorById = new Map<SourceId, Connector>(CONNECTORS.map((c) => [c.id, c]));

export const DEPTH_BUDGETS: Record<string, number> = {
  quick: 500,
  standard: 1500,
  deep: 3500,
};
