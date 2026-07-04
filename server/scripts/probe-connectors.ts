/**
 * Live probe of every connector with a small fixed plan (no AI involved).
 * Usage: npx tsx server/scripts/probe-connectors.ts [sourceId ...]
 */
import { CONNECTORS } from "../connectors/index.ts";
import type { HarvestContext } from "../connectors/types.ts";
import { getSettings } from "../settings.ts";
import type { QueryPlan } from "../ai/schemas.ts";

const plan: QueryPlan = {
  keywords: ["freelance invoicing", "invoice tracking"],
  painQueries: [
    "invoicing is there a tool",
    "chasing invoices frustrating",
    "freelance invoice nightmare",
    "invoice late payment problem",
  ],
  subreddits: ["freelance", "smallbusiness"],
  stackSites: ["softwarerecs", "webapps"],
  githubQueries: ["invoice reminder feature request"],
  storeTerms: ["invoice maker"],
  youtubeQueries: ["freelance invoicing workflow"],
  wikipediaEntities: ["Invoice"],
};

const only = process.argv.slice(2);
const settings = getSettings();

// Per-source limits exactly as a Standard-depth scan (budget 550) allocates them.
const BUDGET = Number(process.env.PROBE_BUDGET ?? 550);
const totalWeight = CONNECTORS.reduce((s, c) => s + c.weight, 0);

for (const connector of CONNECTORS) {
  if (only.length && !only.includes(connector.id)) continue;
  const limit = Math.max(10, Math.ceil((BUDGET * connector.weight) / totalWeight));
  const ctx: HarvestContext = {
    topic: "freelance invoicing",
    plan,
    limit,
    settings,
    log: (msg, type) => console.log(`  [${type ?? "log"}] ${msg}`),
  };
  const started = Date.now();
  try {
    const items = await connector.harvest(ctx);
    const engagement = items.reduce((s, it) => s + it.score + it.comments, 0);
    const authors = new Set(items.map((it) => it.author).filter(Boolean)).size;
    const dated = items.filter((it) => it.createdUtc).length;
    const sample = items[0];
    console.log(
      `✔ ${connector.id.padEnd(13)} ${String(items.length).padStart(3)}/${String(limit).padStart(3)} items · ${String(engagement).padStart(6)} engagement · ${String(authors).padStart(3)} authors · ${dated} dated · ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
    if (sample) console.log(`   e.g. "${sample.title.slice(0, 90)}"`);
  } catch (err) {
    console.log(`✘ ${connector.id.padEnd(13)} FAILED: ${err instanceof Error ? err.message : err}`);
  }
}
