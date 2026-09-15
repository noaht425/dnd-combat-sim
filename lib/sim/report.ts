// Convenience: assess every fixture (or an arbitrary list) and render a report.
// Importable for a future vault UI panel; also printed by tests/sim-report.test.ts.

import type { Combatant } from "./schema";
import { assess, formatAssessment, type Assessment } from "./calculator";
import { genericParty, type PartyProfile } from "./party";
import { MONSTER_FIXTURES } from "./fixtures";

export function assessAll(monsters: Combatant[] = MONSTER_FIXTURES, party?: PartyProfile): Assessment[] {
  return monsters.map((m) => assess(m, party));
}

/** one-line-per-monster table, sorted by how far each sits from its label */
export function summaryTable(assessments: Assessment[]): string {
  const rows = assessments
    .slice()
    .sort((a, b) => rank(b.readsAs) - rank(a.readsAs))
    .map((a) => {
      const cr = (a.labelledCr ?? "?").padEnd(3);
      const name = a.monster.padEnd(24);
      const reads = a.readsAs.padEnd(16);
      return `${name} CR ${cr} -> ${reads} eff ${a.effectiveCr.padEnd(8)} party wins ~${a.roundsForPartyToWin}r @ ${a.partyHpPctWhenMonsterDies}% HP  (TPK: ${a.tpkRisk})`;
    });
  return rows.join("\n");
}

function rank(r: Assessment["readsAs"]): number {
  return { "well below tier": -2, "below tier": -1, "on tier": 0, "above tier": 1, "well above tier": 2 }[r];
}

export function fullReport(monsters: Combatant[] = MONSTER_FIXTURES): string {
  const parts = monsters.map((m) => formatAssessment(assess(m)));
  return parts.join("\n\n");
}

/**
 * "Test PCs at level L against monster M" — the scenario shape from the README.
 * (Phase 1 uses the generic party; real per-PC templates arrive with Phase 3.)
 */
export function assessVsParty(monster: Combatant, level: number, size = 4): Assessment {
  return assess(monster, genericParty(level, size));
}
