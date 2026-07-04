/** Per-host polite serial queues: one request at a time per host, spaced by a minimum interval. */

const hosts = new Map<string, { chain: Promise<unknown>; nextAt: number }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function throttled<T>(host: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const entry = hosts.get(host) ?? { chain: Promise.resolve(), nextAt: 0 };
  const run = entry.chain.then(async () => {
    const wait = entry.nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    entry.nextAt = Date.now() + minIntervalMs;
    try {
      return await fn();
    } finally {
      entry.nextAt = Date.now() + minIntervalMs;
    }
  });
  // Keep the chain alive even when a call rejects.
  entry.chain = run.catch(() => {});
  hosts.set(host, entry);
  return run;
}

/** Simple counting semaphore — used to cap concurrent Codex processes. */
export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(public max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Map over items with bounded concurrency, preserving order of results. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
