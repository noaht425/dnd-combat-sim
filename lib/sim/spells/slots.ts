// Spell-slot progressions. Every caster's `resources` gets `slot1`..`slot9`
// (full/half/third) or `pactSlot` + `arcanum6`..`arcanum9` (warlock), populated
// from these tables by class level.

import type { Combatant } from "../schema";

export type CasterKind = "full" | "half" | "third" | "warlock" | "none";

type SlotRow = number[]; // index i => number of (i+1)-th level slots

// ---- full casters: wizard, cleric, druid, sorcerer, bard ----
const FULL: Record<number, SlotRow> = {
  1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1],
  8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1],
  12: [4, 3, 3, 3, 2, 1], 13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1],
  15: [4, 3, 3, 3, 2, 1, 1, 1], 16: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1], 19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};

// ---- half casters: paladin, ranger (no slots at level 1) ----
const HALF: Record<number, SlotRow> = {
  1: [], 2: [2], 3: [3], 4: [3], 5: [4, 2], 6: [4, 2], 7: [4, 3], 8: [4, 3], 9: [4, 3, 2],
  10: [4, 3, 2], 11: [4, 3, 3], 12: [4, 3, 3], 13: [4, 3, 3, 1], 14: [4, 3, 3, 1],
  15: [4, 3, 3, 2], 16: [4, 3, 3, 2], 17: [4, 3, 3, 3, 1], 18: [4, 3, 3, 3, 1],
  19: [4, 3, 3, 3, 2], 20: [4, 3, 3, 3, 2],
};

// ---- third casters: Eldritch Knight, Arcane Trickster (no slots until level 3) ----
const THIRD: Record<number, SlotRow> = {
  1: [], 2: [], 3: [2], 4: [3], 5: [3], 6: [3], 7: [4, 2], 8: [4, 2], 9: [4, 2], 10: [4, 3],
  11: [4, 3], 12: [4, 3], 13: [4, 3, 2], 14: [4, 3, 2], 15: [4, 3, 2], 16: [4, 3, 3],
  17: [4, 3, 3], 18: [4, 3, 3], 19: [4, 3, 3, 1], 20: [4, 3, 3, 1],
};

// ---- warlock pact magic: [slotCount, slotLevel] ----
const PACT: Record<number, [number, number]> = {
  1: [1, 1], 2: [2, 1], 3: [2, 2], 4: [2, 2], 5: [2, 3], 6: [2, 3], 7: [2, 4], 8: [2, 4],
  9: [2, 5], 10: [2, 5], 11: [3, 5], 12: [3, 5], 13: [3, 5], 14: [3, 5], 15: [3, 5], 16: [3, 5],
  17: [4, 5], 18: [4, 5], 19: [4, 5], 20: [4, 5],
};

function clampLevel(lvl: number): number {
  return Math.max(1, Math.min(20, Math.round(lvl)));
}

function rowFor(table: Record<number, SlotRow>, level: number): SlotRow {
  return table[clampLevel(level)] ?? [];
}

/** the number of slots this caster has at each spell level (1-indexed via [0] = 1st) */
export function slotRow(kind: CasterKind, level: number): SlotRow {
  if (kind === "full") return rowFor(FULL, level);
  if (kind === "half") return rowFor(HALF, level);
  if (kind === "third") return rowFor(THIRD, level);
  return [];
}

/** highest spell level this caster can cast from slots (0 = none) */
export function maxSlotLevel(kind: CasterKind, level: number): number {
  if (kind === "warlock") return PACT[clampLevel(level)][1];
  return slotRow(kind, level).length;
}

/** Mystic Arcanum: warlock gains one 6th at L11, 7th at L13, 8th at L15, 9th at L17 (1/long rest each) */
export function mysticArcanumLevels(level: number): number[] {
  const lvl = clampLevel(level);
  const out: number[] = [];
  if (lvl >= 11) out.push(6);
  if (lvl >= 13) out.push(7);
  if (lvl >= 15) out.push(8);
  if (lvl >= 17) out.push(9);
  return out;
}

/**
 * Slot resources for a caster's `resources` map.
 * Full/half/third -> slot1..slotN (longRest). Warlock -> pactSlot (shortRest) + arcanum6..9 (longRest).
 */
export function slotResources(kind: CasterKind, level: number): Combatant["resources"] {
  const res: NonNullable<Combatant["resources"]> = {};
  if (kind === "warlock") {
    const [count] = PACT[clampLevel(level)];
    res.pactSlot = { max: count, recharge: "shortRest" };
    for (const a of mysticArcanumLevels(level)) res[`arcanum${a}`] = { max: 1, recharge: "longRest" };
    return res;
  }
  const row = slotRow(kind, level);
  for (let i = 1; i <= 9; i++) res[`slot${i}`] = { max: row[i - 1] ?? 0, recharge: "longRest" };
  return res;
}

/** warlock's fixed pact-slot level at a given class level */
export function pactSlotLevel(level: number): number {
  return PACT[clampLevel(level)][1];
}
