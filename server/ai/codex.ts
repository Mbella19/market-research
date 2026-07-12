import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TMP_DIR } from "../lib/env.ts";
import { Semaphore } from "../lib/ratelimit.ts";
import { redactSecrets } from "../lib/secrets.ts";
import { getSettings, type Effort } from "../settings.ts";

/**
 * Lodestone's AI engine: shells out to the user's Codex CLI (GPT-5.6 Sol by default).
 *
 * Calls are isolated from machine-specific config with --ignore-user-config;
 * authentication still comes from the configured Codex home.
 */

export class CodexError extends Error {
  constructor(
    message: string,
    public detail: string = ""
  ) {
    super(redactSecrets(message));
    this.detail = redactSecrets(detail);
  }
}

export interface CodexCallOpts {
  task: string; // label for logs/errors
  prompt: string;
  effort: Effort;
  /** JSON Schema for codex --output-schema (constrains the final message). */
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Smoke tests bypass (and on success reset) the failure circuit breaker. */
  bypassBreaker?: boolean;
}

/**
 * Circuit breaker: quota/auth/launch failures affect EVERY call, so after one
 * such failure we fail fast for a cooldown instead of burning ~40s per stage.
 */
const FATAL_RE = /usage limit|you've hit|hit your|401|authenticat|login|failed to launch|ENOENT/i;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
let breakerUntil = 0;
let breakerReason = "";

export function aiBreakerState(): { open: boolean; reason: string; until: number } {
  return { open: Date.now() < breakerUntil, reason: breakerReason, until: breakerUntil };
}

function tripBreaker(reason: string): void {
  breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
  breakerReason = reason.slice(0, 300);
}

const semaphore = new Semaphore(2);

/** Codex needs its login and executable path, not the source API credentials. */
function codexEnvironment(): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "CODEX_HOME",
  ] as const;
  const out: NodeJS.ProcessEnv = { RUST_LOG: "error", NO_COLOR: "1" };
  for (const key of allow) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

function rand(): string {
  return randomBytes(6).toString("hex");
}

/** Extract the first plausible JSON object from model output. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];
  candidates.push(trimmed);
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  throw new CodexError("Model output was not valid JSON", trimmed.slice(0, 400));
}

async function spawnCodex(opts: CodexCallOpts): Promise<{ text: string; latencyMs: number }> {
  const s = getSettings();
  semaphore.max = Math.max(1, s.ai.concurrency);

  const id = rand();
  const outFile = join(TMP_DIR, `codex-${id}-last.txt`);
  const schemaFile = opts.schema ? join(TMP_DIR, `codex-${id}-schema.json`) : null;
  if (schemaFile && opts.schema) writeFileSync(schemaFile, JSON.stringify(opts.schema), { mode: 0o600 });

  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "-s",
    "read-only",
    "--color",
    "never",
    "-m",
    s.ai.model,
    "-c",
    `model_reasoning_effort="${opts.effort}"`,
    "-c",
    'web_search="disabled"',
    "-C",
    TMP_DIR,
    "-o",
    outFile,
  ];
  if (schemaFile) args.push("--output-schema", schemaFile);
  args.push("-"); // read prompt from stdin

  const timeoutMs = opts.timeoutMs ?? 900_000;
  const started = Date.now();

  return semaphore.run(
    () =>
      new Promise((resolve, reject) => {
        if (opts.signal?.aborted) return reject(new CodexError("aborted"));

        const child = spawn(s.ai.bin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: codexEnvironment(),
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (err: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          if (err) {
            cleanup();
            return reject(err);
          }
          let text = "";
          try {
            if (existsSync(outFile)) text = readFileSync(outFile, "utf8").trim();
          } catch {
            /* fall through to stdout */
          }
          if (!text) text = stdout.trim();
          cleanup();
          if (!text) {
            return reject(
              new CodexError(`codex produced no output for ${opts.task}`, stderr.slice(-500))
            );
          }
          resolve({ text, latencyMs: Date.now() - started });
        };

        const cleanup = () => {
          for (const f of [outFile, schemaFile]) {
            if (f) {
              try {
                rmSync(f, { force: true });
              } catch {
                /* ignore */
              }
            }
          }
        };

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(
            new CodexError(
              `codex timed out after ${Math.round(timeoutMs / 60000)} min on ${opts.task}`
            )
          );
        }, timeoutMs);

        const onAbort = () => {
          child.kill("SIGKILL");
          finish(new CodexError("aborted"));
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
          if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString();
          if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
        });
        child.on("error", (err) =>
          finish(new CodexError(`failed to launch codex (${s.ai.bin}): ${err.message}`))
        );
        child.on("close", (code) => {
          if (code === 0) return finish(null);
          finish(
            new CodexError(
              `codex exited with code ${code} on ${opts.task}`,
              (stderr || stdout).slice(-800)
            )
          );
        });

        child.stdin.write(opts.prompt);
        child.stdin.end();
      })
  );
}

/**
 * Run a codex call that must return schema-valid JSON. One repair retry on
 * validation failure; one retry without --output-schema if codex itself errors
 * (e.g. schema rejected by the API).
 */
export async function codexJson<T>(
  opts: CodexCallOpts,
  zodSchema: { parse: (v: unknown) => T }
): Promise<{ data: T; latencyMs: number }> {
  if (!opts.bypassBreaker && Date.now() < breakerUntil) {
    throw new CodexError(
      `AI engine cooling down after a fatal error (retry in ${Math.ceil((breakerUntil - Date.now()) / 60000)} min)`,
      breakerReason
    );
  }
  let lastDetail = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    let latencyMs: number;
    try {
      const res = await spawnCodex(
        attempt === 0 ? opts : { ...opts, schema: undefined } // drop schema on retry
      );
      text = res.text;
      latencyMs = res.latencyMs;
      if (opts.bypassBreaker) breakerUntil = 0; // successful smoke test resets the breaker
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastDetail = err instanceof CodexError ? `${err.message} ${err.detail}` : String(err);
      if (FATAL_RE.test(lastDetail)) {
        if (!opts.bypassBreaker) tripBreaker(lastDetail);
        throw err; // retrying a quota/auth failure is pointless
      }
      if (attempt === 0) continue;
      throw err;
    }

    try {
      const parsed = extractJson(text);
      const data = zodSchema.parse(parsed);
      return { data, latencyMs };
    } catch (err) {
      lastDetail = String(err).slice(0, 500);
      if (attempt === 0) {
        opts = {
          ...opts,
          prompt:
            opts.prompt +
            `\n\nIMPORTANT: Your previous reply failed JSON validation (${lastDetail.slice(0, 200)}). ` +
            `Respond again with ONLY the corrected JSON object — no prose, no code fences.`,
        };
        continue;
      }
    }
  }
  throw new CodexError(`AI output invalid for ${opts.task}`, lastDetail);
}

export interface AiHealth {
  ok: boolean;
  latencyMs: number;
  model: string;
  effort: string;
  error?: string;
}

/** Real end-to-end model call used by Settings → smoke test and scan preflight. */
export async function codexHealth(effort: Effort = "low"): Promise<AiHealth> {
  const s = getSettings();
  const started = Date.now();
  try {
    const { data } = await codexJson(
      {
        task: "smoke-test",
        prompt:
          'This is a connectivity test. Do not run any commands. Reply with ONLY this JSON: {"ok": true}',
        effort,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        timeoutMs: 300_000,
        bypassBreaker: true,
      },
      {
        parse: (v: unknown) => {
          if (typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === true) {
            return v as { ok: true };
          }
          throw new Error("expected {ok:true}");
        },
      }
    );
    void data;
    return { ok: true, latencyMs: Date.now() - started, model: s.ai.model, effort };
  } catch (err) {
    const e = err instanceof CodexError ? `${err.message}${err.detail ? ` — ${err.detail}` : ""}` : String(err);
    return { ok: false, latencyMs: Date.now() - started, model: s.ai.model, effort, error: e };
  }
}
