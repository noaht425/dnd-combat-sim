// How many spells a caster has access to, and an opinionated auto-pick from the
// class list when the caller doesn't hand one in.

import type { Spell, SpellClass } from "./types";
import { spellsForClass, SPELLS_BY_ID } from "./catalog";
import { maxSlotLevel, type CasterKind } from "./slots";

const clamp = (lvl: number) => Math.max(1, Math.min(20, Math.round(lvl)));

// spells-known tables for the "known" casters
const SORCERER_KNOWN = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 15];
const BARD_KNOWN = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 16, 18, 19, 19, 20, 22, 22, 22];
const RANGER_KNOWN = [0, 0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11];
const WARLOCK_KNOWN = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15];

const CANTRIPS: Partial<Record<SpellClass, number[]>> = {
  wizard: [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  sorcerer: [0, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
  cleric: [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  druid: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  bard: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  warlock: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
};

export type CasterFocus = "blaster" | "controller" | "support" | "balanced";

/** cantrips known at this level */
export function cantripsKnown(cls: SpellClass, level: number): number {
  return CANTRIPS[cls]?.[clamp(level)] ?? 0;
}

/**
 * How many leveled spells the caster has ready this fight.
 * Prepared casters: mod + (full: level, half: floor(level/2), third: floor(level/3)).
 * Known casters: the class table. Wizard: int mod + level (spellbook assumed deep).
 */
export function preparedCount(cls: SpellClass, kind: CasterKind, level: number, abilityMod: number): number {
  const lvl = clamp(level);
  if (cls === "sorcerer") return SORCERER_KNOWN[lvl];
  if (cls === "bard") return BARD_KNOWN[lvl];
  if (cls === "ranger") return RANGER_KNOWN[lvl];
  if (cls === "warlock") return WARLOCK_KNOWN[lvl];
  // prepared casters + wizard
  const casterLevels = kind === "full" ? lvl : kind === "half" ? Math.floor(lvl / 2) : Math.floor(lvl / 3);
  return Math.max(1, abilityMod + casterLevels);
}

// ---------------------------------------------------- auto spell selection

const roleWeight: Record<CasterFocus, Partial<Record<Spell["role"], number>>> = {
  blaster: { damage: 10, control: 6, defense: 5, buff: 3, heal: 2, summon: 4 },
  controller: { control: 10, damage: 5, defense: 6, buff: 5, summon: 6, heal: 3 },
  support: { heal: 9, buff: 8, defense: 7, control: 7, damage: 5, summon: 4 },
  balanced: { damage: 7, control: 7, buff: 6, heal: 6, defense: 6, summon: 5 },
};

// spells worth having regardless of focus, if the class list has them
const STAPLES = new Set(["shield", "counterspell", "misty-step", "absorb-elements", "healing-word", "revivify", "bless"]);

// how many prepared spells a real caster keeps at each level (fraction of budget),
// roughly: lots of low/mid, a couple of top-tier. Indexed by spell level 1..9.
const LEVEL_MIX = [0, 0.16, 0.15, 0.16, 0.13, 0.12, 0.1, 0.08, 0.06, 0.04];

function scoreSpell(sp: Spell, focus: CasterFocus, casterMaxSlot: number): number {
  if (!sp.build) return -100; // utility: never auto-prepare
  if (sp.level > casterMaxSlot) return -100;
  let s = roleWeight[focus][sp.role] ?? 1;
  // prefer a spell that is strong *for its own level* — not just the highest level
  if (sp.concentration) s -= 1.5;
  if (STAPLES.has(sp.id)) s += 10;
  if (sp.castTime === "reaction") s += 4;
  if (sp.castTime === "bonus") s += 1; // action-economy friendly
  return s;
}

export interface PreparedSet {
  cantrips: string[]; // spell ids
  spells: string[];   // leveled spell ids
}

/** Pick a prepared / known list from the class list for a given focus. */
export function autoPrepare(
  cls: SpellClass, kind: CasterKind, level: number, abilityMod: number, focus: CasterFocus = "balanced",
): PreparedSet {
  const list = spellsForClass(cls);
  const casterMaxSlot = maxSlotLevel(kind, level) || Math.ceil(clamp(level) / 2);

  const cantrips = list
    .filter((s) => s.level === 0)
    .sort((a, b) => (b.build ? 1 : 0) - (a.build ? 1 : 0) || (b.role === "damage" ? 1 : 0) - (a.role === "damage" ? 1 : 0))
    .slice(0, cantripsKnown(cls, level))
    .map((s) => s.id);

  const budget = preparedCount(cls, kind, level, abilityMod);

  // reaction staples always earn a slot if the class has them
  const forced = list
    .filter((s) => s.level > 0 && s.level <= casterMaxSlot &&
      (s.castTime === "reaction" || (STAPLES.has(s.id) && s.build !== undefined)))
    .map((s) => s.id);

  // fill the remaining budget with a realistic spread across spell levels, not
  // just the highest-level nukes — a per-level quota from LEVEL_MIX
  const pickable = list.filter((s) => s.level > 0 && !forced.includes(s.id) && scoreSpell(s, focus, casterMaxSlot) > -50);
  const remaining = Math.max(0, budget - forced.length);
  const chosen: string[] = [];
  for (let lvl = 1; lvl <= casterMaxSlot; lvl++) {
    const quota = Math.max(lvl >= casterMaxSlot - 1 ? 1 : 2, Math.round(remaining * LEVEL_MIX[lvl]));
    const atLevel = pickable
      .filter((s) => s.level === lvl)
      .sort((a, b) => scoreSpell(b, focus, casterMaxSlot) - scoreSpell(a, focus, casterMaxSlot))
      .slice(0, quota)
      .map((s) => s.id);
    chosen.push(...atLevel);
  }
  // trim / pad to budget
  const spells = [...forced, ...chosen].slice(0, budget);
  if (spells.length < budget) {
    const extra = pickable
      .filter((s) => !spells.includes(s.id))
      .sort((a, b) => scoreSpell(b, focus, casterMaxSlot) - scoreSpell(a, focus, casterMaxSlot))
      .slice(0, budget - spells.length)
      .map((s) => s.id);
    spells.push(...extra);
  }

  return { cantrips, spells };
}

/** Resolve ids -> Spell, dropping anything unknown. */
export function resolveSpells(ids: string[]): Spell[] {
  return ids.map((id) => SPELLS_BY_ID[id]).filter(Boolean);
}
