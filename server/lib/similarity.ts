import { tokenize } from "./text.ts";

/**
 * Cross-scan duplicate detection for opportunities. Clustering is per-scan, so
 * two scans can independently rediscover the same problem and each write a
 * brief ("HassMedic" and "BridgeSentry" were the same product). Before a brief
 * is written, its cluster is compared against every existing opportunity's
 * cluster; near-duplicates are skipped (auto) or require force (manual).
 */

/** Light stem so "integrations breaking" matches "integration breakage". */
function stem(t: string): string {
  let s = t;
  if (s.length > 5 && (s.endsWith("ing") || s.endsWith("age"))) s = s.slice(0, -3);
  else if (s.length > 4 && (s.endsWith("ed") || s.endsWith("es"))) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s")) s = s.slice(0, -1);
  return s;
}

export type Fingerprint = Map<string, number>;

/** Term-frequency fingerprint of a cluster's descriptive text. */
export function fingerprint(texts: string[]): Fingerprint {
  const tf: Fingerprint = new Map();
  for (const text of texts) {
    for (const tok of tokenize(text)) {
      const t = stem(tok);
      if (t.length < 3) continue;
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
  }
  return tf;
}

/** Cosine similarity between two fingerprints (0..1). */
export function cosine(a: Fingerprint, b: Fingerprint): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, v] of small) {
    const w = big.get(t);
    if (w) dot += v * w;
  }
  if (dot === 0) return 0;
  let na = 0;
  for (const v of a.values()) na += v * v;
  let nb = 0;
  for (const v of b.values()) nb += v * v;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Above this, two clusters describe the same buildable problem. Calibrated on
 * real briefed clusters (2026-07-04): the HassMedic/BridgeSentry duplicate
 * pair scores 0.883; two invoicing clusters with genuinely different angles
 * (payment leverage vs chasing automation) score 0.459; unrelated pairs ~0.06.
 * 0.55 splits "same product" from "same niche, different angle" with margin.
 */
export const DUPLICATE_THRESHOLD = 0.55;
