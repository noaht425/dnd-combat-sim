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

function crRank(cr: string | undefined): number {
  if (!cr) return Infinity;
  if (cr.includes("/")) {
    const [n, d] = cr.split("/").map(Number);
    return n / d;
  }
  const n = Number(cr);
  return Number.isFinite(n) ? n : Infinity;
}

/** The picker's monster list — CR-sorted, excluding the `pc-fighter-15` test
 *  fixture (a stray PC stat block bundled for engine tests, not a monster). */
export function listMonsters(): { id: string; name: string; cr: string }[] {
  return Object.values(ALL_MONSTERS)
    .filter((m) => m.kind === "monster")
    .map((m) => ({ id: m.id, name: m.name, cr: m.cr ?? "—" }))
    .sort((a, b) => crRank(a.cr) - crRank(b.cr) || a.name.localeCompare(b.name));
}
