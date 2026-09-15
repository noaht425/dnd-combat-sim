// Summoned / raised minion stat blocks. A `summon` automation node names one of
// these by id; the interpreter spawns `initCombatant`s from the registry and
// drops them into the initiative order on the summoner's side. They also show
// up in the enemy picker's "Minions" group as standalone options.
//
// Kept deliberately light. Both entries are SRD 5.2.1 (CC-BY-4.0); homebrew
// summons live in the git-ignored local monster JSON, not here.

import type { Combatant } from "../schema";
import { parseCombatant } from "../schema";

const AI = {
  targetPriority: "squishiest" as const,
  aoeMinTargets: 2,
  opener: [] as string[],
  saveLegendaryResistanceFor: [] as string[],
  keepDistance: false,
  neverRetreat: true,
  focusFire: true,
};

function minion(base: Partial<Combatant> & Pick<Combatant, "id" | "name" | "ac" | "maxHp" | "abilities" | "pb">): Combatant {
  return parseCombatant({
    kind: "monster",
    size: "medium",
    proficientSaves: [],
    saveBonusAll: 0,
    resistances: [],
    resistancesNonmagical: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
    specialRules: [],
    resources: {},
    traits: [],
    reactions: [],
    ai: AI,
    ...base,
  });
}

const fireElemental = minion({
  id: "fire-elemental",
  name: "Fire Elemental",
  cr: "5",
  ac: 13,
  maxHp: "12d10+36",
  speeds: { walk: 50 },
  abilities: { str: 10, dex: 17, con: 16, int: 6, wis: 10, cha: 7 },
  pb: 3,
  immunities: ["fire", "poison"],
  conditionImmunities: ["exhaustion", "grappled", "paralyzed", "petrified", "poisoned", "prone", "restrained", "unconscious"],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "touch", times: 2 }],
    },
    {
      id: "touch",
      name: "Fire Touch",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 6,
              onHit: [
                { type: "damage", amount: "2d6", damageType: "fire" },
                { type: "damage", amount: "1d10", damageType: "fire" },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const chainDevil = minion({
  id: "chain-devil",
  name: "Chain Devil",
  cr: "8",
  ac: 16,
  maxHp: "10d8+40",
  speeds: { walk: 30 },
  abilities: { str: 18, dex: 15, con: 18, int: 11, wis: 12, cha: 14 },
  pb: 3,
  immunities: ["fire", "poison"],
  resistances: ["cold"],
  resistancesNonmagical: ["bludgeoning", "piercing", "slashing"],
  conditionImmunities: ["poisoned"],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "chain", times: 2 }],
    },
    {
      id: "chain",
      name: "Animated Chain",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 8,
              onHit: [
                { type: "damage", amount: "2d6+4", damageType: "slashing" },
                {
                  type: "save",
                  ability: "str",
                  dc: 15,
                  onFail: [{ type: "applyCondition", condition: "restrained", durationRounds: 1, saveEnds: { ability: "str", dc: 15, at: "endOfTurn" } }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

// Light SRD stand-ins for the party's summon spells (Animate Dead, Conjure
// Animals, Giant Insect, …) so those spells actually field something.
const zombie = minion({
  id: "zombie",
  name: "Zombie",
  cr: "1/4",
  ac: 8,
  maxHp: "3d8+9",
  speeds: { walk: 20 },
  abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  pb: 2,
  immunities: ["poison"],
  conditionImmunities: ["poisoned"],
  actions: [
    {
      id: "slam",
      name: "Slam",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        { type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 3, onHit: [{ type: "damage", amount: "1d6+1", damageType: "bludgeoning" }] }] },
      ],
    },
  ],
});

const wolf = minion({
  id: "wolf",
  name: "Wolf",
  cr: "1/4",
  ac: 13,
  maxHp: "2d8+2",
  speeds: { walk: 40 },
  abilities: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
  pb: 2,
  actions: [
    {
      id: "bite",
      name: "Bite",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 4,
              onHit: [
                { type: "damage", amount: "2d4+2", damageType: "piercing" },
                { type: "save", ability: "str", dc: 11, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] },
              ],
            },
          ],
        },
      ],
    },
  ],
});

// Generic stand-ins for a PC's summoned ally (Beastmaster Primal Companion,
// Wildfire / Shepherd spirit, Summon-X spells). Fixed mid-tier stats — good for
// a level ~12-16 party, an abstraction otherwise.
const primalCompanion = minion({
  id: "primal-companion",
  name: "Primal Companion",
  cr: "4",
  ac: 14,
  maxHp: "9d10+18",
  speeds: { walk: 40 },
  abilities: { str: 18, dex: 15, con: 15, int: 6, wis: 13, cha: 8 },
  pb: 3,
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "maul", times: 2 }],
    },
    {
      id: "maul",
      name: "Maul",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [{ type: "attack", bonus: 7, onHit: [{ type: "damage", amount: "2d6+4", damageType: "slashing" }] }],
        },
      ],
    },
  ],
});

const primalSpirit = minion({
  id: "primal-spirit",
  name: "Primal Spirit",
  cr: "3",
  ac: 13,
  maxHp: "6d8+12",
  speeds: { walk: 30, fly: 30 },
  abilities: { str: 10, dex: 14, con: 14, int: 13, wis: 15, cha: 11 },
  pb: 3,
  conditionImmunities: ["charmed", "frightened", "grappled", "prone", "restrained"],
  actions: [
    {
      id: "flame-seed",
      name: "Flame Seed",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [{ type: "attack", bonus: 6, onHit: [{ type: "damage", amount: "2d6+3", damageType: "fire" }] }],
        },
      ],
    },
  ],
});

export const MINIONS: Record<string, Combatant> = {
  "fire-elemental": fireElemental,
  "chain-devil": chainDevil,
  zombie,
  wolf,
  "primal-companion": primalCompanion,
  "primal-spirit": primalSpirit,
};

/**
 * Minions of these stat blocks vanish the instant their summoner dies. Empty
 * for the bundled SRD set; homebrew summons that revert are re-registered when
 * a custom monster pack declares them.
 */
export const REVERTS_ON_SUMMONER_DEATH = new Set<string>();
