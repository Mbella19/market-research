import "../lib/env.ts";
import { getSettings } from "../settings.ts";
import { SCOUTS, TREND_SOURCES, type ScoutContext, type TrendSourceId } from "../trends/sources.ts";

/**
 * Live-probe the trend-scout sources (no AI): prints signals per source.
 *   npx tsx server/scripts/probe-trends.ts [source…]
 *   FOCUS="ai" WINDOW=30 npx tsx server/scripts/probe-trends.ts
 */

const args = process.argv.slice(2) as TrendSourceId[];
const only = args.length ? args : TREND_SOURCES.map((s) => s.id);
const settings = getSettings();

const ctx: ScoutContext = {
  windowDays: Number(process.env.WINDOW ?? 30),
  ghPages: 2,
  hnHits: 3000,
  settings,
  log: (msg, type) => console.log(`${type === "warn" ? "⚠" : "·"} ${msg}`),
  focus: process.env.FOCUS ?? null,
};

for (const id of only) {
  const scout = SCOUTS[id];
  if (!scout) {
    console.log(`✘ unknown source "${id}"`);
    continue;
  }
  const started = Date.now();
  try {
    const signals = await scout(ctx);
    console.log(`\n✔ ${id.padEnd(12)} ${signals.length} signals · ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const s of signals.slice(0, 5)) {
      console.log(`   ${s.strength.toFixed(2)}  ${s.label} — ${s.metric}`);
    }
  } catch (err) {
    console.log(`\n✘ ${id.padEnd(12)} failed: ${err instanceof Error ? err.message : err}`);
  }
}
