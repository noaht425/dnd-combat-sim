// The set of monsters the setup parser can resolve a name against: the SRD
// fixtures plus the minion registry (both already keyed by id in the engine).

import { FIXTURES_BY_ID } from "../sim/fixtures";
import { MINIONS } from "../sim/engine/minions";
import type { Combatant } from "../sim/schema";
import { bestMatch, type Candidate } from "./fuzzy";

export const ALL_MONSTERS: Record<string, Combatant> = { ...FIXTURES_BY_ID, ...MINIONS };

const CANDIDATES: Candidate<Combatant>[] = Object.values(ALL_MONSTERS).map((m) => ({
  key: m.id,
  label: m.name,
  value: m,
}));

export interface MonsterMatch {
  monster?: Combatant;
  suggestions: Combatant[];
}

/** Fuzzy-resolve a free-text monster name ("red dragon", "gobbo") to a fixture. */
export function findMonster(name: string): MonsterMatch {
  const r = bestMatch(name, CANDIDATES);
  if (r.best && r.bestScore >= 0.72) return { monster: r.best.value, suggestions: [] };
  return { monster: undefined, suggestions: r.runnersUp.map((c) => c.value) };
}
