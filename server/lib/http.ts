import { get, run } from "../db.ts";
import { sha256 } from "./text.ts";
import { throttled } from "./ratelimit.ts";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface FetchOpts {
  headers?: Record<string, string>;
  /** Minimum ms between requests to this host (default 350). */
  minIntervalMs?: number;
  timeoutMs?: number;
  retries?: number;
  /** Cache successful GET bodies for this many ms (0 = no cache). */
  cacheTtlMs?: number;
  /** Extra string mixed into the cache key (e.g. auth identity). */
  cacheKeyExtra?: string;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public bodySnippet: string
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cacheGet(key: string, ttlMs: number): string | null {
  const row = get<{ body: string; ts: number }>(
    "SELECT body, ts FROM http_cache WHERE key = ?",
    key
  );
  if (!row) return null;
  if (Date.now() - row.ts > ttlMs) return null;
  return row.body;
}

function cachePut(key: string, url: string, status: number, body: string): void {
  run(
    "INSERT INTO http_cache (key, url, status, body, ts) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET body = excluded.body, status = excluded.status, ts = excluded.ts",
    key,
    url,
    status,
    body,
    Date.now()
  );
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const {
    headers = {},
    minIntervalMs = 350,
    timeoutMs = 25_000,
    retries = 2,
    cacheTtlMs = 0,
    cacheKeyExtra = "",
    signal,
  } = opts;

  const cacheKey = sha256(`${url}|${cacheKeyExtra}`);
  if (cacheTtlMs > 0) {
    const hit = cacheGet(cacheKey, cacheTtlMs);
    if (hit !== null) return hit;
  }

  const host = new URL(url).host;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const body = await throttled(host, minIntervalMs, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onOuterAbort = () => controller.abort();
        signal?.addEventListener("abort", onOuterAbort, { once: true });
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": BROWSER_UA, ...headers },
            signal: controller.signal,
            redirect: "follow",
          });
          const text = await res.text();
          if (!res.ok) {
            if (res.status === 429 || res.status >= 500) {
              const retryAfter = Number(res.headers.get("retry-after")) || 0;
              throw Object.assign(new HttpError(res.status, url, text.slice(0, 300)), {
                retryAfterMs: retryAfter * 1000,
              });
            }
            throw new HttpError(res.status, url, text.slice(0, 300));
          }
          return text;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onOuterAbort);
        }
      });
      if (cacheTtlMs > 0) cachePut(cacheKey, url, 200, body);
      return body;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      // Only retry transient failures: 429, 5xx, network/timeouts.
      const status = err instanceof HttpError ? err.status : 0;
      const transient = status === 0 || status === 429 || status >= 500;
      if (!transient || attempt === retries) throw err;
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 0;
      await sleep(Math.max(retryAfterMs, 900 * 2 ** attempt + Math.random() * 400));
    }
  }
  throw lastErr;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const text = await fetchText(url, opts);
  return JSON.parse(text) as T;
}
