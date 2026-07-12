import { readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DATA_DIR = join(ROOT, "data");
export const TMP_DIR = join(DATA_DIR, "tmp");

// Runtime data contains API credentials and harvested research. New files must
// never inherit a permissive shell umask.
process.umask(0o077);

for (const dir of [DATA_DIR, TMP_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
}

// Minimal .env loader — no dependency, never overrides real env vars.
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function env(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}
