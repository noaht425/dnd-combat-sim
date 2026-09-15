// Resolves a target phrase ("the dragon", "cultist 3", "nearest enemy",
// "the one with the least health") against the live board — spec §4.1.
// Ambiguous bare names (two dragons, no qualifier) are refused, not guessed.

import type { AwaitUnit } from "../sim/battle";
import type { UnitSnap } from "../sim/battle/state";
import { normalize, similarity } from "./fuzzy";

export interface LiveUnit {
  id: string;
  name: string;
  side: "party" | "monster";
  glyph: string;
  box: { x0: number; y0: number; x1: number; y1: number };
  hp?: number;
  maxHp?: number;
  conditions?: string[];
}

/** Merge the awaiting-turn roster (positions) with the latest frame's HP
 *  snapshot (not present on AwaitUnit) into one lookup for the resolver. */
export function liveUnits(units: AwaitUnit[], lastSnap?: UnitSnap[]): LiveUnit[] {
  const snapById = new Map((lastSnap ?? []).map((s) => [s.id, s]));
  return units.map((u) => {
    const s = snapById.get(u.id);
    return { ...u, hp: s?.hp, maxHp: s?.maxHp, conditions: s?.conditions };
  });
}

function boxCenter(b: LiveUnit["box"]): { x: number; y: number } {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}
function dist(a: LiveUnit["box"], b: LiveUnit["box"]): number {
  const ca = boxCenter(a);
  const cb = boxCenter(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

export type ResolveResult =
  | { kind: "found"; unit: LiveUnit }
  | { kind: "ambiguous"; candidates: LiveUnit[] }
  | { kind: "none"; suggestions: LiveUnit[] };

/** `self` is the acting unit (for "nearest", "closest to me", relative qualifiers).
 *  `side` restricts the pool (enemies for an attack, allies for a heal). */
export function resolveTarget(
  phrase: string,
  units: LiveUnit[],
  self: LiveUnit,
  side: "party" | "monster",
): ResolveResult {
  const pool = units.filter((u) => u.side === side && u.id !== self.id);
  if (!pool.length) return { kind: "none", suggestions: [] };
  const p = normalize(phrase);

  // --- relational / superlative qualifiers (resolve deterministically, no ask) ---
  const named = (frag: string): LiveUnit | undefined => {
    const scored = units
      .map((u) => ({ u, s: Math.max(similarity(frag, u.name), similarity(frag, u.glyph)) }))
      .sort((a, b) => b.s - a.s);
    return scored[0]?.s >= 0.6 ? scored[0].u : undefined;
  };

  if (/\bnearest\b|\bclosest\b/.test(p) && !/closest to\b/.test(p)) {
    return { kind: "found", unit: [...pool].sort((a, b) => dist(self.box, a.box) - dist(self.box, b.box))[0] };
  }
  if (/\bfurthest\b|\bfarthest\b/.test(p) && !/\bfrom\b/.test(p)) {
    return { kind: "found", unit: [...pool].sort((a, b) => dist(self.box, b.box) - dist(self.box, a.box))[0] };
  }
  let m = p.match(/closest to (?:the )?(.+)/) ?? p.match(/nearest (?:the )?(.+?) to\b/);
  if (m) {
    const anchor = named(m[1]);
    if (anchor) return { kind: "found", unit: [...pool].sort((a, b) => dist(anchor.box, a.box) - dist(anchor.box, b.box))[0] };
  }
  m = p.match(/furthest from (?:the )?(.+)/) ?? p.match(/farthest from (?:the )?(.+)/);
  if (m) {
    const anchor = named(m[1]);
    if (anchor) return { kind: "found", unit: [...pool].sort((a, b) => dist(anchor.box, b.box) - dist(anchor.box, a.box))[0] };
  }
  if (/\b(most|highest|full|max)\s*(health|hp)\b/.test(p)) {
    const withHp = pool.filter((u) => u.hp !== undefined);
    if (withHp.length) return { kind: "found", unit: [...withHp].sort((a, b) => (b.hp! - a.hp!))[0] };
  }
  if (/\b(least|lowest|low)\s*(health|hp)\b/.test(p) || /\bweakest\b/.test(p)) {
    const withHp = pool.filter((u) => u.hp !== undefined);
    if (withHp.length) return { kind: "found", unit: [...withHp].sort((a, b) => (a.hp! - b.hp!))[0] };
  }
  if (/\bbloodied\b/.test(p)) {
    const bloodied = pool.filter((u) => u.hp !== undefined && u.maxHp !== undefined && u.hp <= u.maxHp / 2 && u.hp > 0);
    if (bloodied.length === 1) return { kind: "found", unit: bloodied[0] };
    if (bloodied.length > 1) return { kind: "ambiguous", candidates: bloodied };
  }

  // --- bare name / glyph match ---
  const scored = pool
    .map((u) => ({ u, s: Math.max(similarity(p, u.name), similarity(p, u.glyph)) }))
    .sort((a, b) => b.s - a.s);
  const top = scored[0];
  if (!top || top.s < 0.55) return { kind: "none", suggestions: pool.slice(0, 3) };

  const tied = scored.filter((x) => x.s >= top.s - 0.08);
  if (tied.length > 1) return { kind: "ambiguous", candidates: tied.map((x) => x.u) };
  return { kind: "found", unit: top.u };
}
