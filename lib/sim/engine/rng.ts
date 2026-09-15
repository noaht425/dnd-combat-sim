// Seeded, deterministic PRNG for the turn engine. Every random draw in a fight
// goes through one of these so a (fight, seed) pair is perfectly reproducible —
// which is what makes TDD and Monte-Carlo possible.

import { hashSeed } from "../../rng";

export interface Rng {
  next(): number; // [0, 1)
  int(minInclusive: number, maxInclusive: number): number;
  d20(): number;
  /** roll a d20 with advantage / disadvantage / flat; returns the used face + the nat roll */
  d20mode(mode: "adv" | "dis" | "flat"): { used: number; nat: number };
  dice(n: number, sides: number): number;
}

/** mulberry32 — small, fast, good enough for combat dice. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(...seedParts: number[]): Rng {
  const seed = hashSeed(...(seedParts.length ? seedParts : [0x1234abcd]));
  const next = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const d20 = () => int(1, 20);
  return {
    next,
    int,
    d20,
    d20mode(mode) {
      if (mode === "flat") {
        const n = d20();
        return { used: n, nat: n };
      }
      const a = d20();
      const b = d20();
      const used = mode === "adv" ? Math.max(a, b) : Math.min(a, b);
      // the "nat" that matters for crit/fumble is the die actually used
      return { used, nat: used };
    },
    dice(n, sides) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += int(1, sides);
      return sum;
    },
  };
}
