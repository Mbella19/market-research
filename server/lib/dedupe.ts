import { tokenize } from "./text.ts";

/**
 * 64-bit simhash (as two 32-bit halves — avoids BigInt in the O(n²) compare loop)
 * over 4-token shingles. Near-duplicates (crossposts, mirrored complaints) hash close.
 */
export function simhash(text: string): [number, number] {
  const toks = tokenize(text);
  const shingles: string[] = [];
  if (toks.length < 4) shingles.push(toks.join(" "));
  else for (let i = 0; i <= toks.length - 4; i++) shingles.push(toks.slice(i, i + 4).join(" "));

  const weights = new Int32Array(64);
  for (const sh of shingles) {
    // FNV-1a, run twice with different seeds for 64 bits total.
    let h1 = 0x811c9dc5;
    let h2 = 0xcbf29ce4;
    for (let i = 0; i < sh.length; i++) {
      const c = sh.charCodeAt(i);
      h1 = ((h1 ^ c) * 0x01000193) >>> 0;
      h2 = ((h2 ^ ((c * 31) & 0xff)) * 0x01000193) >>> 0;
    }
    for (let b = 0; b < 32; b++) {
      weights[b] = weights[b]! + ((h1 >>> b) & 1 ? 1 : -1);
      weights[32 + b] = weights[32 + b]! + ((h2 >>> b) & 1 ? 1 : -1);
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (weights[b]! > 0) lo |= 1 << b;
    if (weights[32 + b]! > 0) hi |= 1 << b;
  }
  return [hi >>> 0, lo >>> 0];
}

function popcount32(x: number): number {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

export function hammingDistance(a: [number, number], b: [number, number]): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

/**
 * Returns the indexes of texts considered near-duplicates of an earlier text.
 * Earlier entries win, so pass items sorted by preference (e.g. engagement desc).
 */
export function nearDuplicateIndexes(texts: string[], maxDistance = 6): Set<number> {
  const hashes = texts.map((t) => simhash(t));
  const dupes = new Set<number>();
  for (let i = 0; i < hashes.length; i++) {
    if (dupes.has(i)) continue;
    for (let j = i + 1; j < hashes.length; j++) {
      if (dupes.has(j)) continue;
      if (hammingDistance(hashes[i]!, hashes[j]!) <= maxDistance) dupes.add(j);
    }
  }
  return dupes;
}
