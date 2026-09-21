// Creature types (aberration, beast, ... undead). The type of a stat block is its explicit `creatureType`, or — for imported stat blocks that only
// carry the presentation string — the first word of `flavor.type` ("fiend (devil)" -> fiend). A stat block with neither is UNKNOWN, and an unknown
// creature is never excluded by a type restriction (nor selected by one that names the types it may be): the sim behaves as it did before types
// existed for a creature it can't classify, rather than silently changing the odds.

import { creatureTypeSchema, type Combatant, type CreatureType, type TargetFilter } from "../schema";

const TYPES = new Set<string>(creatureTypeSchema.options);

export function creatureTypeOf(c: Combatant): CreatureType | undefined {
  if (c.creatureType) return c.creatureType;
  const word = c.flavor?.type?.toLowerCase().match(/[a-z]+/)?.[0];
  return word && TYPES.has(word) ? (word as CreatureType) : undefined;
}

/** is `c` one of `types`? (an unknown creature is not) */
export const isCreatureType = (c: Combatant, ...types: CreatureType[]): boolean => {
  const t = creatureTypeOf(c);
  return t !== undefined && types.includes(t);
};

/** may `c` be picked by a target node carrying `filter`? An unknown type passes both `types` and `notTypes`; `effects` are the creature's current effects. */
export function matchesFilter(c: Combatant, filter?: TargetFilter, effects?: readonly { name: string }[]): boolean {
  if (!filter) return true;
  if (filter.notEffects && effects?.some((e) => filter.notEffects!.includes(e.name))) return false;
  const t = creatureTypeOf(c);
  if (filter.types && t !== undefined && !filter.types.includes(t)) return false;
  if (filter.types && t === undefined && filter.strictTypes) return false; // Turn Undead never turns a creature it can't tell is undead
  if (filter.notTypes && t !== undefined && filter.notTypes.includes(t)) return false;
  if (filter.notImmune?.some((cond) => c.conditionImmunities.includes(cond))) return false;
  if (filter.minInt !== undefined && c.abilities.int < filter.minInt) return false;
  return true;
}

/** a stat block's challenge rating as a number ("1/2" -> 0.5); a stat block without one is unrated (undefined) */
export function crValue(c: Combatant): number | undefined {
  if (!c.cr) return undefined;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(c.cr.trim());
  const n = m ? Number(m[1]) / Number(m[2]) : Number(c.cr);
  return Number.isFinite(n) ? n : undefined;
}
