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

/** may `c` be picked by a target node carrying `filter`? An unknown type passes both `types` and `notTypes`. */
export function matchesFilter(c: Combatant, filter?: TargetFilter): boolean {
  if (!filter) return true;
  const t = creatureTypeOf(c);
  if (filter.types && t !== undefined && !filter.types.includes(t)) return false;
  if (filter.notTypes && t !== undefined && filter.notTypes.includes(t)) return false;
  if (filter.notImmune?.some((cond) => c.conditionImmunities.includes(cond))) return false;
  if (filter.minInt !== undefined && c.abilities.int < filter.minInt) return false;
  return true;
}
