// Phase 2 uses real per-PC combatants (so a stunned PC actually loses its turn),
// but not yet real class builds — those are Phase 3 "templates". Here we spin up
// N generic adventurers whose totals match the Phase 1 `genericParty` model:
// one striker, one controller, one healer, the rest strikers.

import type { Ability, Combatant } from "../schema";
import { genericParty, SOLO_BOSS_DISRUPTION } from "../party";
import { hitChance } from "../math";

function pcAttack(id: string, dprPerAttack: string, bonus: number): Combatant["actions"][number] {
  return {
    id,
    name: "Attack",
    cost: { action: 1 },
    recharge: "none",
    automation: [
      {
        type: "target",
        who: { who: "aiChoice" },
        effects: [
          { type: "attack", bonus, onHit: [{ type: "damage", amount: dprPerAttack, damageType: "slashing" }] },
          { type: "attack", bonus, onHit: [{ type: "damage", amount: dprPerAttack, damageType: "slashing" }] },
        ],
      },
    ],
  };
}

export function makeGenericParty(level: number, size = 4): Combatant[] {
  const p = genericParty(level, size);
  const pb = Math.floor((level - 1) / 4) + 2;
  const perPcHp = Math.round(p.totalHp / size);
  // per-PC damage. The Phase 1 `dprVsAC` bakes in a hit-rate factor AND the
  // SOLO_BOSS_DISRUPTION haircut — but the turn engine PLAYS OUT disruption
  // (charm locks, stuns, misses), so we divide both back out here and let the
  // loop apply the real haircut. 2 * hitRate * perAttack then lands near the
  // white-room per-PC number.
  const perPcDpr = p.dprVsAC(19) / size / SOLO_BOSS_DISRUPTION;
  const expHit = Math.max(0.3, hitChance(pb + 4, 19));
  const perAttack = Math.max(1, Math.round(perPcDpr / 2 / expHit));

  const abilityScore = (mod: number) => 10 + mod * 2;
  // party-wide "Bless / Paladin aura / Resistance / items" cushion, plus a
  // half-proficiency-ish floor on the saves a PC isn't proficient in — a real
  // level-20 party is not helpless against a DC 22 Wis save.
  const partySaveCushion = level >= 17 ? 3 : level >= 11 ? 2 : level >= 5 ? 1 : 0;
  const weakSaveMod = Math.max(1, Math.floor(pb / 2));

  const out: Combatant[] = [];
  for (let i = 0; i < size; i++) {
    const role = i === 0 ? "healer" : i === 1 ? "controller" : "striker";
    // saves: give each PC two "good" saves so the party average roughly matches p.saveBonus
    const goodA: Ability = role === "controller" ? "wis" : "con";
    const goodB: Ability = role === "healer" ? "wis" : "dex";

    const actions: Combatant["actions"] = [pcAttack("attack", `${perAttack}`, pb + 4)];
    if (role === "healer") {
      actions.push({
        id: "party-heal",
        name: "Healing Word-ish",
        cost: { bonus: 1 },
        recharge: "none",
        automation: [{ type: "target", who: { who: "lowestHpEnemy" }, effects: [] }], // placeholder; healing handled by AI
        text: "the AI applies this to the most-hurt ally",
      });
    }
    if (role === "controller") {
      actions.push({
        id: "save-or-lose",
        name: "Save-or-Lose (banish / hold / feeblemind)",
        cost: { action: 1 },
        recharge: "none",
        isSpell: true,
        concentration: true,
        limitedUse: { resource: "control_spell", amount: 1 },
        automation: [
          {
            type: "target",
            who: { who: "nearestEnemy" },
            effects: [
              {
                type: "save",
                ability: "wis",
                dc: 8 + pb + 5,
                onFail: [{ type: "applyCondition", condition: "incapacitated", durationRounds: 2, saveEnds: { ability: "wis", dc: 8 + pb + 5, at: "endOfTurn" } }],
              },
            ],
          },
        ],
      });
    }

    out.push({
      id: `pc-${i + 1}`,
      name: `${role === "healer" ? "Cleric" : role === "controller" ? "Wizard" : "Striker"} ${i + 1}`,
      kind: "pc",
      size: "medium",
      level,
      ac: 18,
      maxHp: perPcHp,
      speeds: { walk: 30 },
      abilities: {
        str: abilityScore((goodA as string) === "str" || (goodB as string) === "str" ? pb : weakSaveMod),
        dex: abilityScore((goodA as string) === "dex" || (goodB as string) === "dex" ? pb : weakSaveMod),
        con: abilityScore((goodA as string) === "con" || (goodB as string) === "con" ? pb + 1 : weakSaveMod),
        int: abilityScore(role === "controller" ? pb : weakSaveMod),
        wis: abilityScore((goodA as string) === "wis" || (goodB as string) === "wis" ? pb : weakSaveMod),
        cha: abilityScore(weakSaveMod),
      },
      pb,
      proficientSaves: [goodA, goodB],
      saveBonusAll: partySaveCushion,
      resistances: [],
      resistancesNonmagical: [],
      immunities: [],
      vulnerabilities: [],
      conditionImmunities: [],
      specialRules: [],
      resources: role === "controller" ? { control_spell: { max: 1, recharge: "longRest" } } : {},
      traits: [],
      actions,
      // a real level-11+ party has reactions too — Shield, Absorb Elements,
      // Uncanny Dodge, a Cleric's Warding Flare. Model the lot as one "halve a
      // hit, 1/round" so the party isn't the only side without reactions.
      reactions: level >= 9
        ? [{
            id: "uncanny-dodge",
            name: "Defensive Reaction",
            cost: { reaction: 1 },
            recharge: "none",
            trigger: "self.wasHitByAttack",
            automation: [{ type: "note", text: "halves the triggering attack's damage" }],
          }]
        : [],
      ai: {
        targetPriority: "lowestHp",
        aoeMinTargets: 2,
        opener: role === "controller" ? ["save-or-lose"] : [],
        saveLegendaryResistanceFor: [],
        keepDistance: role !== "striker",
        neverRetreat: true,
        focusFire: true,
      },
    });
  }
  return out;
}

/** healing-per-round the healer applies, from the Phase 1 model */
export function partyHealingPerRound(level: number): number {
  return Math.round(level * 1.6);
}

