# Lodestone

**Evidence-based market research.** Lodestone hunts for real problems people repeatedly complain about across the public internet, validates whether the demand is real (hundreds/thousands of voices — not three excited comments), and turns only the strongest validated problems into founder-grade software opportunity briefs.

It is deliberately **not** an idea generator. Every claim traces to quoted, linked, real posts. If evidence is thin, it says "insufficient evidence." If a cluster is one viral thread wearing a trenchcoat, the AI demand judge rejects it and shows you why.

---

## Run it

```bash
npm install
npm run dev:server   # API on http://127.0.0.1:5058
```

Production mode:

```bash
npm start            # http://127.0.0.1:5058
```

## The AI core

Lodestone shells out to your **Codex CLI** (`codex exec`, model **gpt-5.5**) as its reasoning engine — no OpenAI API key needed, it rides your ChatGPT login:

- **plan** — expands a niche into pain-hunting queries per source
- **extract** — reads every harvested item: real pain or noise, severity, willingness-to-pay, verbatim quote (quotes are substring-verified against the source; unverifiable quotes are replaced with real excerpts)
- **cluster** — merges TF-IDF candidate groups into named problem clusters
- **judge** (xhigh) — skeptical demand analyst; can reject gate-passing clusters (one-thread wonders, free-product whining, already-solved problems)
- **brief** (xhigh) — opportunity report: concept, ICP, MVP, differentiation, monetization, GTM, risks, competitors, evidence trail
- **ask** — "Ask the evidence" Q&A on any cluster, citations included

Per-stage reasoning effort is configurable in **Settings** (default: high for bulk work, xhigh for judging/briefs). If Codex is unavailable (usage limit, logged out), scans **fall back to a labeled heuristic engine** — never silently — and a **Re-analyze** action re-runs stored items through the AI later.

> **Machine-specific workaround:** your `~/.codex/config.toml` contains `service_tier = "priority"`, which codex-cli 0.130.0 can't parse — plain `codex` commands die on startup. Lodestone always invokes `codex exec --ignore-user-config` with explicit flags, so it is immune. (Fix your terminal codex by removing that line or upgrading the CLI.)

## Sources (11)

| Source | Access | Notes |
|---|---|---|
| Reddit | **no key** — custom scraper | `.json` fast path; when Reddit 403s it merges RSS (content) + old.reddit HTML (`data-score`/`data-comments-count`) |
| Hacker News | no key (Algolia) | stories + comments + Ask HN |
| GitHub Issues | your PAT | feature requests, 👍 reactions = demand |
| Stack Exchange | no key | incl. softwarerecs — people literally asking for software |
| Lemmy | no key | lemmy.world search |
| YouTube | your Data API key | comment mining; falls back to keyless InnerTube |
| Google Play | no key | 1–3★ reviews of category apps |
| Apple App Store | no key | iTunes RSS 1–3★ reviews |
| Product Hunt | no key (RSS) | competitive context for briefs, never counted as pain |
| X / Twitter | your bearer token | up to 8 pain queries × 3 pages each (recent search covers the last 7 days) + 24h cache |
| G2 Landscape | your API token | data.g2.com v2 (Bearer): category search → market leaders (rating, review count, pricing) as competitive context; per-product review text is partner-gated |

Trend signals: Wikipedia Pageviews (interest proxy) + complaint-frequency timelines computed from the harvested evidence itself.

**Recency by construction:** Reddit/Lemmy search last 12 months, X last 7 days (API limit), App Store + Play Store sorted most-recent, Product Hunt current launches, and GitHub / Stack Exchange / YouTube / HN are cut off at the **Evidence window** (Settings, default 24 months). The demand score explicitly rewards clusters whose complaint frequency is growing in the last 6 months.

## Trend scout (separate from pain research)

The third scan mode measures pure GROWTH — no pain, no demand gate:

- **Signals**: GitHub repos < window old gaining stars abnormally fast (star velocity) · Hacker News term momentum (last window vs previous window, full-window slicing) · Product Hunt launch-keyword clusters · Google's daily breakout searches · X trending topics (tier-dependent).
- **Pipeline**: `scout → classify → rank → report`. Signals group across sources; the AI names/describes each candidate and REJECTS anything not rideable with pure software (hardware, physical products, news, celebrities, sports). Its only powers are naming and rejecting — momentum comes from the numbers.
- **Momentum score**: 0.6 × strongest signal + 0.4 × cross-source spread. Single-source trends cap at 60 ("rising"); "surging" requires multi-platform confirmation.
- **Build angles**: top software-fit trends get 2-3 solo-buildable product angles (xhigh), framed honestly as bets on the trend — demand stays a separate question, answered by running a niche scan from the trend card.

## The Demand Gate

A cluster is **validated** only when ALL pass (thresholds editable in Settings):

- distinct complainers ≥ **25**
- platforms ≥ **2**
- **normalized** engagement ≥ **800**
- ≥ **30%** of evidence from the last 12 months

Engagement is *normalized before counting*: platform units are weighted (a GitHub 👍 ≈ 2.5 reddit-upvote equivalents; an X like ≈ 0.4), any single item is winsorized to ≤3× the median (and ≤35% of the cluster), and with 2+ platforms present no single platform may carry >60% of the counted total — one viral thread can no longer validate a cluster by itself. The gate stores the raw total alongside so nothing is hidden.

**Voices** = distinct complainers + normalized engagement. Tiers: 🥇 ≥ 5,000 voices & 3+ platforms · 🥈 ≥ 1,500 · 🥉 passes gate — all labeled "pain validated", deliberately. The AI judge can still reject a gate-passer — and its reasons are shown.

## Paid intent & the validation ladder

Complaints prove pain, not payment. Two mechanisms keep that distinction honest:

- **Paid-intent evidence**: the Reddit connector additionally harvests hiring subreddits (r/forhire, r/slavelabour, …) for `[Hiring]`/`[Task]` posts, parses posted budgets, and matches them to clusters by vocabulary overlap. Matched posts appear as a separate axis (never mixed into engagement), feed 12% of the demand score, and show on the cluster as "paid intent ×N · ~$median".
- **Validation ladder** on every cluster and brief: ☑ online pain validated → ☑/☐ paid intent detected → ☐ customer interviews → ☐ landing-page interest → ☐ pre-orders. Brief pricing is explicitly labeled a hypothesis; the ladder names the rung that would test it.

Scans also report **source coverage** ("9/11 sources delivered" + what failed) so a validation is never read against silently missing sources, and interrupted scans are marked as such on server restart (Re-analyze resumes from stored items).

## Layout

```
server/            Fastify API + pipeline (TypeScript, node:sqlite — zero native deps)
  ai/              codex runner, prompts, JSON schemas
  connectors/      11 sources + trends
  pipeline/        plan → harvest → extract → cluster → validate → synthesize
data/              SQLite DB + tmp (gitignored)
.env               your keys (gitignored)
```

> **Public repo note:** this repository is the backend only — the operator interface (`web/`, local), `.env`, and all data are intentionally excluded and stay private.

Handy scripts: `npx tsx server/scripts/probe-connectors.ts [source…]` (live-test connectors), `npx tsx server/scripts/probe-trends.ts [source…]` (live-test trend sources), `npx tsx server/scripts/smoke-ai.ts [effort]` (real Codex call). `npm test` runs the analytical-core unit suite (budget parsing, engagement normalization/caps, quote verification, dedupe).
