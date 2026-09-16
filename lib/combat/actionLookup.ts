// Rebuilds the real Combatant for a unit id, purely to read its actions'
// full automation for a "what does this do" lookup. BattleOutcome doesn't
// carry the built Combatants (only AwaitAction's id/name/needsMelee/aoe) —
// buildParty/resolveEnemies are cheap pure functions, so re-deriving them
// here is simpler than plumbing more data through the vendored engine.

import { buildParty, resolveEnemies } from "../sim/engine/scenario";
import type { BattleSetup } from "../sim/battle";
import type { Combatant } from "../sim/schema";

export function findCombatant(setup: Pick<BattleSetup, "party" | "enemies" | "extraById">, unitId: string): Combatant | undefined {
  const pcs = buildParty(setup.party);
  const pc = pcs.find((c) => c.id === unitId);
  if (pc) return pc;
  const monsters = resolveEnemies(setup.enemies, setup.extraById);
  return monsters.find((c) => c.id === unitId);
}
