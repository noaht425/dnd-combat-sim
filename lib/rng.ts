// Shared deterministic hashing/PRNG primitives — originally lived in
// weatherGeneration.ts (still re-exported from there for backward
// compatibility), now shared with the map generation system too.

export function deterministicFraction(seed: number): number {
  let x = seed | 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = (x ^ (x >>> 16)) >>> 0
  return x / 4294967296
}

// Combines several integers (e.g. a parent seed plus a region's bounds)
// into one new deterministic seed — used to derive a child map's generation
// seed from its parent map's seed + the selected bounding box, so the same
// selection always regenerates the same child. Folds each part through
// deterministicFraction's mixing step rather than concatenating digits, so
// nearby inputs (e.g. two adjacent selections) don't produce visibly
// correlated seeds.
export function hashSeed(...parts: number[]): number {
  let acc = 0x9e3779b9
  for (const part of parts) {
    const mixed = Math.floor(deterministicFraction(acc ^ (part | 0)) * 4294967296)
    acc = (acc ^ mixed ^ (mixed << 13) ^ (mixed >>> 7)) | 0
  }
  return acc >>> 0
}
