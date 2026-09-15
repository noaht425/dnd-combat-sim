// Estimate how much punishment a monster actually soaks before dying, and how
// well it resists the party's save-or-lose spells.

import type { Combatant } from "./schema";
import type { PartyProfile } from "./party";
import {
  DEFAULT_MIX,
  avgDice,
  damageThroughput,
  flatDamageReduction,
  hasRule,
  hitChance,
  legendaryResistancePerDay,
  saveFailChance,
  undyingReturnHp,
} from "./math";

export interface DefenseEstimate {
  baseHp: number;
  effectiveHp: number;
  /** rounds the party needs to grind through effectiveHp, given their DPR vs this AC */
  roundsToKill: number;
  /** how many of the party's save-or-lose attempts fizzle before one sticks */
  controlResilience: number;
  notes: string[];
}

export function estimateDefense(monster: Combatant, party: PartyProfile): DefenseEstimate {
  const notes: string[] = [];
  const baseHp = typeof monster.maxHp === "number" ? monster.maxHp : avgDice(monster.maxHp) ?? 0;

  // 1 — resistance / immunity / vulnerability / "resist non-advantage" multiplier
  const throughput = damageThroughput(monster, DEFAULT_MIX); // fraction of raw party damage that lands
  let effectiveHp = baseHp / Math.max(0.15, throughput);
  if (throughput < 0.92) notes.push(`resistances cut incoming damage to ~${Math.round(throughput * 100)}% of raw (effective HP up)`);
  if (hasRule(monster, "resistNonAdvantageAttacks")) notes.push("resists any attack made without advantage — a big, build-dependent swing");

  // 2 — flat per-hit reduction (Zaros "Deathless Scales -3"): ~8 hits/round over ~4 rounds
  const flat = flatDamageReduction(monster);
  if (flat > 0) {
    const hitsOverFight = 8 * 4;
    effectiveHp += flat * hitsOverFight;
    notes.push(`flat -${flat}/hit adds ~${flat * hitsOverFight} effective HP over the fight`);
  }

  // 3 — undying return (Undying Grudge / Unrelenting Storm)
  const ret = undyingReturnHp(monster);
  if (ret > 0) {
    effectiveHp += ret + 40; // the returned HP, plus ~a round of resist-all / condition clear
    notes.push(`undying return adds ~${ret + 40} effective HP (a second life)`);
  }

  // 4 — the party's real DPR vs this monster's AC, times what fraction gets through
  const rawPartyDpr = party.dprVsAC(monster.ac);
  // save-spell damage (disintegrate etc.) bypasses AC and the "no-advantage" rule but not resistances
  const roundsToKill = effectiveHp / Math.max(1, rawPartyDpr);

  // 5 — control resilience: Legendary Resistance + Magic Resistance + Unbroken Will
  let controlResilience = legendaryResistancePerDay(monster);
  const advSaves = monster.specialRules.find((r) => r.rule === "advantageOnSaves");
  if (advSaves && advSaves.rule === "advantageOnSaves") {
    // advantage on the mental saves that save-or-lose spells target
    const covered = advSaves.abilities.filter((a) => a === "int" || a === "wis" || a === "cha").length;
    controlResilience += covered * 0.75;
  }
  if (hasRule(monster, "magicResistance")) {
    // MR turns each save-or-lose into two rolls; estimate how many attempts it eats
    const sb = 8; // a rough "the save that matters is one of its better ones"
    const pFailOnce = saveFailChance(party.saveSpellDC, sb, "flat");
    const pFailWithMr = saveFailChance(party.saveSpellDC, sb, "adv");
    // extra attempts absorbed ~ (1/pFailWithMr - 1/pFailOnce), capped
    controlResilience += Math.min(4, Math.max(0, 1 / Math.max(0.05, pFailWithMr) - 1 / Math.max(0.05, pFailOnce)));
  }
  if (hasRule(monster, "uncontainable")) {
    controlResilience += 1.5;
    notes.push("uncontainable: forcecage / banishment / maze don't stick");
  }
  if (hasRule(monster, "denyAdvantageToAttackers")) notes.push("attacks against it never gain advantage");

  return { baseHp, effectiveHp: Math.round(effectiveHp), roundsToKill, controlResilience, notes };
}

/** party's expected attack hit rate vs this monster — used for reporting */
export function partyHitRate(monster: Combatant, party: PartyProfile): number {
  return hitChance(party.attackBonus, monster.ac);
}
