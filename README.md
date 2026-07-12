# Lodestone

Lodestone is an evidence-based market-research receiver. It harvests public complaints, extracts concrete software problems, groups them, and certifies only clusters that pass measurable coverage thresholds and an explicit skeptical AI-judge verdict.

It does not treat engagement as people, infer a market size from posts, or claim that complaints prove pricing. Every brief keeps payment and customer validation as later rungs.

## Requirements and startup

- Node.js 22.5 or newer; npm 10 or newer
- A logged-in Codex CLI for AI analysis (no OpenAI API key is required)
- Optional source credentials listed in [.env.example](.env.example)

```bash
npm install
npm run dev          # API + local operator UI
npm run dev:server   # API only, http://127.0.0.1:5058
npm test
npm run build
```

Production mode:

```bash
npm start
```

Runtime data is local in `data/`. Lodestone forces private directory/file permissions on POSIX systems, redacts credentials from stored URLs/events, bounds its HTTP cache, and listens only on `127.0.0.1` by default. Rotate any credential that was exposed outside Lodestone; local redaction cannot rotate a provider key.

## AI pipeline

Lodestone invokes `codex exec --ignore-user-config` with GPT-5.6 Sol (`gpt-5.6-sol`) at `xhigh` reasoning effort for every AI stage by default. It uses a minimal environment, read-only sandbox, ephemeral session, and disables shell/browser/computer/plugin/app/web-search tools. Internet content is explicitly delimited as untrusted data and all task outputs must pass strict schemas.

- `plan` — source-specific pain queries
- `extract` — one exact result per item, severity, willingness-to-pay class, and substring-verified quote
- `cluster` — local TF-IDF grouping plus AI coherence/refinement
- `judge` — skeptical demand verdict for gate-passers
- `brief` — evidence-grounded, solo-buildable opportunity report
- `ask` — cluster-bounded answers whose citations must come from the supplied evidence set

Long posts use a structured excerpt (head, pain-bearing sentences, and tail), not a fixed first-700-character cut. Missing AI item IDs receive a labeled heuristic fallback. Incoherent AI clusters are quarantined instead of persisted. A gate-passer is `unjudged`, never validated, if its judge call is absent or invalid.

If AI is unavailable, deterministic work remains explicitly labeled `heuristic` or `mixed`; no heuristic-only run can mint a validated brief. Re-analysis clones stored raw items into a versioned child scan, so a failure cannot erase the prior analysis.

Each scan stores a secret-free configuration snapshot plus pipeline, prompt, and metric versions.

## Pain sources

| Source | Access | Role |
|---|---|---|
| Reddit | no key | posts plus budget-bearing hiring/task posts |
| Hacker News | no key | stories, comments, Ask HN |
| GitHub Issues | PAT | feature requests; only 👍 reactions count positively |
| Stack Exchange | no key | includes Software Recommendations and discovery defaults |
| Lemmy | no key | public community search |
| YouTube | optional Data API key | comment mining with keyless fallback |
| Google Play | no key | recent 1–3★ reviews |
| Apple App Store | no key | recent 1–3★ reviews |
| X / Twitter | bearer token | recent public search |
| Product Hunt | no key | competitive context only |
| G2 | API token | competitive context only |

An omitted source list uses mode defaults; an explicit empty, duplicate, or invalid list is rejected. Product Hunt and G2 never count as pain-source coverage. Connector warnings that were handled internally still surface as failed coverage when no evidence was delivered.

The configurable harvest window defaults to 24 months. Validation separately measures the share from the last 12 months and the share with a known date. Timelines always contain all 24 calendar months, including zeros. Growth compares smoothed, like-for-like six-month windows only for sources with comparable history.

## Demand gate and scoring

A cluster is validated only when every configured gate passes and the AI judge returns `validated`:

- at least 25 distinct observed author hashes
- at least 2 pain-evidence platforms
- at least 800 normalized engagement units
- at least 30% of all evidence from the last 12 months
- at least 70% of all evidence with a known publication date

“Observed authors” is not an estimate of people or customers. Engagement is a separate unit. Platform-specific weights are applied, a single item is capped at three times the median and 35% of the normalized cluster total, and one platform cannot carry over 60% when multiple platforms are present. The stored audit data includes raw, normalized, final, by-source, and final top-item-share values.

Validated tiers use observed authors: Gold defaults to 100 authors on 3+ platforms, Silver to 50, and Bronze to other validated clusters. `Insufficient`, `unjudged`, `rejected`, and `legacy` are visibly distinct states.

Only a bounded number of top gate-passers are judged per scan. The remainder stay explicitly `unjudged`; there is no fail-open path.

## Paid intent

Reddit `[Hiring]` and `[Task]` posts are retained separately from complaint evidence. A scored match must:

- contain an actual parsed budget
- share multiple meaningful terms, including a cluster-rare term
- clear a weighted confidence threshold
- clearly beat the runner-up cluster

Each post can strengthen at most one cluster. Currency and time basis are retained. Only comparable fixed USD budgets contribute to USD total/median summaries; hourly, weekly, monthly, GBP, and EUR amounts are never added as if equivalent.

Paid intent is one scoring axis, not proof of product pricing. Briefs label pricing as a hypothesis and show the remaining customer-interview, landing-page, and paid-pilot rungs.

## Trend scout

Trend scans are separate from pain validation. They measure GitHub star velocity, Hacker News window-over-window terms, Product Hunt launch clusters, Google breakout searches, and X trends.

Signals are grouped with complete-link similarity to prevent transitive mega-clusters. The two-character focus `AI` is supported. Raw per-signal strength and detail, source count, and aggregate strength are persisted.

Momentum combines strongest signal (50%), mean signal strength (20%), and cross-source confirmation (30%). A single-source candidate can be rising but never surging. AI names and filters candidates; it does not create the momentum score. If AI is disabled, evidence is stored with heuristic labels and automatic build-angle calls are skipped.

Build angles remain trend bets, not validated demand. Use “Validate demand with a niche scan” before treating one as an opportunity.

## Data integrity and historical results

Pipeline v2 uses fail-closed schemas and corrected metric semantics. Pre-v2 clusters/trends are marked `legacy`; legacy clusters are not certifications and should be re-analyzed. Brief IDs are stable across regeneration.

SQLite migrations are explicit and fail on unexpected errors. Cluster persistence and brief upserts are transactional, opportunities are unique per cluster, scan deletion cleans its events, startup bounds stale cache rows, and SIGINT/SIGTERM abort background scans before closing the database.

## Repository layout

```text
server/
  ai/          Codex runner, prompts, schemas
  connectors/  pain and market-context receivers
  lib/         scoring, matching, security, selection helpers
  pipeline/    plan → harvest → extract → cluster → validate → synthesize
  tests/       analytical and security invariants
web/           local operator interface (intentionally gitignored here)
data/          local SQLite/cache/temp data (gitignored)
```

This public repository intentionally tracks the backend only. If the operator UI needs collaboration or history, put `web/` in a separate private repository; do not remove it from this public repo’s ignore policy.

Useful probes:

```bash
npx tsx server/scripts/probe-connectors.ts [source...]
FOCUS=AI npx tsx server/scripts/probe-trends.ts [source...]
npx tsx server/scripts/smoke-ai.ts [effort]
```

The connector probe uses the same 1,500-item Standard-depth budget as the application unless `PROBE_BUDGET` is set.
