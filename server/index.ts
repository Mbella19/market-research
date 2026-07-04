import "./lib/env.ts";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, env } from "./lib/env.ts";
import { all, get, run, jsonOrNull } from "./db.ts";
import { getSettings, updateSettings, publicSettings, type Effort } from "./settings.ts";
import { codexHealth } from "./ai/codex.ts";
import { codexJson } from "./ai/codex.ts";
import { askPrompt, type AskEvidenceInput } from "./ai/prompts.ts";
import { ZAsk, JAsk } from "./ai/schemas.ts";
import { CONNECTORS } from "./connectors/index.ts";
import { startScan, startReanalyze, cancelScan, isRunning } from "./pipeline/orchestrator.ts";
import { generateBrief } from "./pipeline/synthesize.ts";
import { generateTrendAngles } from "./pipeline/trendscout.ts";
import { onScanEvent } from "./lib/events.ts";
import { nowSec, truncate } from "./lib/text.ts";

const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

// ---------------- health & meta ----------------

app.get("/api/health", async () => {
  const s = getSettings();
  return { ok: true, name: "Lodestone", version: "0.1.0", aiEnabled: s.ai.enabled, model: s.ai.model };
});

app.get("/api/sources", async () => {
  const s = getSettings();
  return CONNECTORS.map((c) => ({ id: c.id, label: c.label, weight: c.weight, status: c.status(s) }));
});

app.get("/api/stats", async () => {
  const counts = {
    scans: get<{ n: number }>("SELECT COUNT(*) AS n FROM scans")?.n ?? 0,
    items: get<{ n: number }>("SELECT COUNT(*) AS n FROM items")?.n ?? 0,
    problems: get<{ n: number }>("SELECT COUNT(*) AS n FROM problems")?.n ?? 0,
    validated: get<{ n: number }>("SELECT COUNT(*) AS n FROM clusters WHERE validated=1")?.n ?? 0,
    opportunities: get<{ n: number }>("SELECT COUNT(*) AS n FROM opportunities")?.n ?? 0,
  };
  const recentScans = all(
    `SELECT s.*,
       (SELECT COUNT(*) FROM items WHERE scan_id=s.id) AS item_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id AND validated=1) AS validated_count,
       (SELECT COUNT(*) FROM opportunities WHERE scan_id=s.id) AS brief_count
     FROM scans s ORDER BY s.created_at DESC LIMIT 6`
  );
  const topClusters = all(
    `SELECT c.*, s.topic AS scan_topic FROM clusters c JOIN scans s ON s.id=c.scan_id
     WHERE c.validated=1 ORDER BY c.demand_score DESC LIMIT 6`
  );
  const topOpportunities = all(
    `SELECT o.id, o.title, o.one_liner, o.cluster_id, o.scan_id, o.created_at, c.demand_score, c.tier, c.voices
     FROM opportunities o JOIN clusters c ON c.id=o.cluster_id ORDER BY c.demand_score DESC LIMIT 6`
  );
  return { counts, recentScans, topClusters, topOpportunities };
});

// ---------------- scans ----------------

interface CreateScanBody {
  topic?: string;
  mode?: "topic" | "discovery" | "trends";
  depth?: "quick" | "standard" | "deep";
  sources?: string[];
}

app.post("/api/scans", async (req, reply) => {
  const body = (req.body ?? {}) as CreateScanBody;
  const mode = body.mode === "discovery" ? "discovery" : body.mode === "trends" ? "trends" : "topic";
  // Trend scans take an OPTIONAL focus ("AI", "health") — empty means full sweep.
  const topic = mode === "discovery" ? null : (body.topic ?? "").trim() || null;
  if (mode === "topic" && !topic) {
    return reply.code(400).send({ error: "topic is required (or use discovery mode)" });
  }
  const depth = ["quick", "standard", "deep"].includes(body.depth ?? "") ? body.depth! : "standard";
  const sources = Array.isArray(body.sources) ? body.sources : [];
  const { lastId } = run(
    `INSERT INTO scans (topic, mode, depth, sources_json, status, stage, created_at) VALUES (?, ?, ?, ?, 'running', 'plan', ?)`,
    topic,
    mode,
    depth,
    JSON.stringify(sources),
    nowSec()
  );
  startScan(lastId);
  return get("SELECT * FROM scans WHERE id=?", lastId);
});

app.get("/api/scans", async () => {
  return all(
    `SELECT s.*,
       (SELECT COUNT(*) FROM items WHERE scan_id=s.id) AS item_count,
       (SELECT COUNT(*) FROM problems WHERE scan_id=s.id) AS problem_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id) AS cluster_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id AND validated=1) AS validated_count,
       (SELECT COUNT(*) FROM opportunities WHERE scan_id=s.id) AS brief_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id) AS trend_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id AND status='surging') AS surging_count
     FROM scans s ORDER BY s.created_at DESC`
  );
});

app.get("/api/scans/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const scan = get(
    `SELECT s.*,
       (SELECT COUNT(*) FROM items WHERE scan_id=s.id) AS item_count,
       (SELECT COUNT(*) FROM problems WHERE scan_id=s.id) AS problem_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id) AS cluster_count,
       (SELECT COUNT(*) FROM clusters WHERE scan_id=s.id AND validated=1) AS validated_count,
       (SELECT COUNT(*) FROM opportunities WHERE scan_id=s.id) AS brief_count,
       (SELECT COUNT(*) FROM trends WHERE scan_id=s.id) AS trend_count
     FROM scans s WHERE s.id=?`,
    id
  );
  if (!scan) return reply.code(404).send({ error: "scan not found" });
  const events = all("SELECT * FROM events WHERE scan_id=? ORDER BY id DESC LIMIT 80", id).reverse();
  return { ...scan, events, running: isRunning(id) };
});

app.post("/api/scans/:id/cancel", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!cancelScan(id)) return reply.code(409).send({ error: "scan is not running" });
  return { ok: true };
});

app.post("/api/scans/:id/reanalyze", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const scan = get<{ status: string; mode: string }>("SELECT status, mode FROM scans WHERE id=?", id);
  if (!scan) return reply.code(404).send({ error: "scan not found" });
  if (scan.mode === "trends") {
    return reply.code(409).send({ error: "trend scans have no stored raw signals — run a fresh trend scout instead" });
  }
  if (isRunning(id)) return reply.code(409).send({ error: "scan is already running" });
  const items = get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE scan_id=?", id)?.n ?? 0;
  if (items === 0) return reply.code(409).send({ error: "scan has no stored items to re-analyze" });
  startReanalyze(id);
  return { ok: true };
});

app.delete("/api/scans/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (isRunning(id)) return reply.code(409).send({ error: "cancel the scan before deleting it" });
  run("DELETE FROM events WHERE scan_id=?", id);
  const { changes } = run("DELETE FROM scans WHERE id=?", id);
  if (!changes) return reply.code(404).send({ error: "scan not found" });
  return { ok: true };
});

// ---------------- live progress (SSE) ----------------

app.get("/api/scans/:id/stream", (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const scan = get("SELECT * FROM scans WHERE id=?", id);
  const events = all("SELECT * FROM events WHERE scan_id=? ORDER BY id DESC LIMIT 60", id).reverse();
  send("snapshot", { scan, events, running: isRunning(id) });

  const off = onScanEvent(id, (ev) => send(ev.type, ev));
  const ping = setInterval(() => reply.raw.write(":ping\n\n"), 15_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    off();
  });
});

// ---------------- trends (trend-scout scans) ----------------

app.get("/api/scans/:id/trends", async (req) => {
  const id = Number((req.params as { id: string }).id);
  return all("SELECT * FROM trends WHERE scan_id=? ORDER BY momentum_score DESC, id ASC", id);
});

app.post("/api/trends/:id/angles", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const settings = getSettings();
  if (!settings.ai.enabled) return reply.code(503).send({ error: "AI engine is disabled in Settings" });
  try {
    const angles_md = await generateTrendAngles(id);
    return { id, angles_md };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(msg === "trend not found" ? 404 : 503).send({ error: msg });
  }
});

// ---------------- clusters & evidence ----------------

app.get("/api/scans/:id/clusters", async (req) => {
  const id = Number((req.params as { id: string }).id);
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM cluster_problems WHERE cluster_id=c.id) AS problem_count,
       (SELECT COUNT(*) FROM opportunities WHERE cluster_id=c.id) AS brief_count
     FROM clusters c WHERE c.scan_id=? ORDER BY c.demand_score DESC`,
    id
  );
});

app.get("/api/clusters/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const cluster = get("SELECT * FROM clusters WHERE id=?", id);
  if (!cluster) return reply.code(404).send({ error: "cluster not found" });
  const evidence = all(
    `SELECT p.id AS problem_id, p.statement, p.severity, p.wtp, p.quote, p.quote_verified, p.engine,
            i.id AS item_id, i.source, i.url, i.title, i.score, i.comments, i.created_utc
     FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id JOIN items i ON i.id=p.item_id
     WHERE cp.cluster_id=? ORDER BY (i.score+i.comments) DESC LIMIT 200`,
    id
  );
  const brief = get("SELECT id, title, one_liner, created_at FROM opportunities WHERE cluster_id=?", id);
  return { ...cluster, evidence, brief: brief ?? null };
});

app.post("/api/clusters/:id/ask", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { question } = (req.body ?? {}) as { question?: string };
  if (!question?.trim()) return reply.code(400).send({ error: "question is required" });
  const cluster = get<{ name: string }>("SELECT name FROM clusters WHERE id=?", id);
  if (!cluster) return reply.code(404).send({ error: "cluster not found" });
  const settings = getSettings();
  if (!settings.ai.enabled) return reply.code(503).send({ error: "AI engine is disabled in Settings" });

  const evidence: AskEvidenceInput[] = all<{
    item_id: number;
    source: string;
    created_utc: number | null;
    score: number;
    comments: number;
    title: string;
    quote: string | null;
    statement: string;
  }>(
    `SELECT i.id AS item_id, i.source, i.created_utc, i.score, i.comments, i.title, p.quote, p.statement
     FROM cluster_problems cp JOIN problems p ON p.id=cp.problem_id JOIN items i ON i.id=p.item_id
     WHERE cp.cluster_id=? ORDER BY (i.score+i.comments) DESC LIMIT 25`,
    id
  ).map((r) => ({
    itemId: r.item_id,
    source: r.source,
    date: r.created_utc ? new Date(r.created_utc * 1000).toISOString().slice(0, 10) : "undated",
    engagement: r.score + r.comments,
    title: truncate(r.title, 120),
    quote: truncate(r.quote ?? "", 220),
    statement: truncate(r.statement, 200),
  }));

  try {
    const { data } = await codexJson(
      {
        task: "ask-evidence",
        prompt: askPrompt(question.trim().slice(0, 500), cluster.name, evidence),
        effort: settings.ai.efforts.ask,
        schema: JAsk,
        timeoutMs: 10 * 60_000,
      },
      ZAsk
    );
    const cited = data.citedItemIds
      .map((itemId) => get<{ id: number; url: string; title: string; source: string }>(
        "SELECT id, url, title, source FROM items WHERE id=?", itemId))
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
    return { answer: data.answer, citations: cited };
  } catch (err) {
    return reply.code(503).send({ error: `AI unavailable: ${err instanceof Error ? err.message : err}` });
  }
});

app.post("/api/clusters/:id/brief", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { steer } = (req.body ?? {}) as { steer?: string };
  try {
    const result = await generateBrief(id, getSettings(), undefined, steer?.trim() || undefined);
    return result;
  } catch (err) {
    return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------- opportunities ----------------

app.get("/api/opportunities", async (req) => {
  const scanId = Number((req.query as { scanId?: string }).scanId ?? 0);
  const where = scanId ? "WHERE o.scan_id=?" : "";
  const params = scanId ? [scanId] : [];
  return all(
    `SELECT o.id, o.scan_id, o.cluster_id, o.title, o.one_liner, o.created_at,
            c.demand_score, c.tier, c.voices, c.name AS cluster_name
     FROM opportunities o JOIN clusters c ON c.id=o.cluster_id ${where} ORDER BY c.demand_score DESC`,
    ...params
  );
});

app.get("/api/opportunities/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const opp = get(
    `SELECT o.*, c.name AS cluster_name, c.demand_score, c.tier, c.voices, c.distinct_authors,
            c.platform_list_json, c.gate_json, c.judge_json, s.topic AS scan_topic
     FROM opportunities o JOIN clusters c ON c.id=o.cluster_id JOIN scans s ON s.id=o.scan_id
     WHERE o.id=?`,
    id
  );
  if (!opp) return reply.code(404).send({ error: "opportunity not found" });
  return opp;
});

// ---------------- settings & AI ----------------

app.get("/api/settings", async () => publicSettings());

app.put("/api/settings", async (req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Masked key values ("••••…") must never overwrite the real ones.
  const keys = body.keys as Record<string, string> | undefined;
  if (keys) {
    for (const k of Object.keys(keys)) {
      if (typeof keys[k] !== "string" || keys[k]!.includes("•")) delete keys[k];
    }
  }
  updateSettings(body);
  return publicSettings();
});

app.post("/api/ai/smoketest", async (req) => {
  const { effort } = (req.body ?? {}) as { effort?: Effort };
  return codexHealth(effort ?? "low");
});

// ---------------- static frontend (production) ----------------

const dist = join(ROOT, "web", "dist");
if (existsSync(dist)) {
  // wildcard route (default) serves files dynamically — survives rebuilds while running
  const fastifyStatic = (await import("@fastify/static")).default;
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

const port = Number(env("PORT", "5058"));
app
  .listen({ port, host: "127.0.0.1" })
  .then(() => console.log(`Lodestone API listening on http://127.0.0.1:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
