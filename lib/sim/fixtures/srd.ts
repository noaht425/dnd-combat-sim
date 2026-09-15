import type { Combatant, DamageType } from "../schema";

export type Automation = Combatant["actions"][number]["automation"];

// ---------------------------------------------------------------------------
// A small set of SRD 5.2.1 monsters, bundled as the simulator's built-in
// enemies and as the fixtures the sim tests run against.
//
// Source: System Reference Document 5.2.1, © Wizards of the Coast, released
// under Creative Commons Attribution 4.0 International (CC-BY-4.0). Stats are
// transcribed at the fidelity the sim needs (defenses, attacks, multiattack,
// breath weapons, legendary actions) — not every trait is modelled.
//
// The homebrew campaign stat blocks are NOT here. They load at runtime from a
// local JSON file via the simulator's "Load custom monsters" picker; see
// fixtures/local/ (git-ignored).
// ---------------------------------------------------------------------------

export type SrdBase = Pick<
  Combatant,
  "id" | "name" | "cr" | "ac" | "maxHp" | "abilities" | "pb" | "actions"
> &
  Partial<Combatant>;

/** Fill in the fields every combatant needs but most SRD blocks leave at defaults. */
export function srd(base: SrdBase): Combatant {
  return {
    kind: "monster",
    size: "medium",
    speeds: { walk: 30 },
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
    ai: {
      targetPriority: "highestThreat",
      aoeMinTargets: 2,
      opener: [],
      saveLegendaryResistanceFor: ["stunned", "paralyzed", "banished", "controlled"],
      keepDistance: false,
      neverRetreat: false,
      focusFire: true,
    },
    ...base,
  };
}

/** one to-hit weapon attack against an AI-chosen target, optionally with a rider damage die */
export function strike(
  bonus: number,
  amount: string,
  damageType: DamageType,
  extra?: { amount: string; damageType: DamageType },
): Automation {
  const onHit: Automation = [{ type: "damage", amount, damageType }];
  if (extra) onHit.push({ type: "damage", amount: extra.amount, damageType: extra.damageType });
  return [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus, onHit }] }];
}

// --------------------------------------------------------------------- Ogre

export const ogre = srd({
  id: "ogre",
  name: "Ogre",
  cr: "2",
  ac: 11,
  maxHp: "8d10+24",
  size: "large",
  speeds: { walk: 40 },
  abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
  pb: 2,
  actions: [
    {
      id: "greatclub",
      name: "Greatclub",
      cost: { action: 1 },
      recharge: "none",
      automation: strike(6, "2d8+4", "bludgeoning"),
      text: "Melee +6, reach 5 ft. Hit: 13 (2d8 + 4) bludgeoning.",
    },
  ],
});

// -------------------------------------------------------------- Bandit Captain

export const banditCaptain = srd({
  id: "bandit-captain",
  name: "Bandit Captain",
  cr: "2",
  ac: 15,
  maxHp: "10d8+20",
  abilities: { str: 15, dex: 16, con: 14, int: 14, wis: 11, cha: 14 },
  pb: 2,
  proficientSaves: ["str", "dex", "wis"],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "scimitar", times: 2 }],
      text: "Two scimitar attacks (and a dagger, not modelled).",
    },
    {
      id: "scimitar",
      name: "Scimitar",
      cost: {},
      recharge: "none",
      automation: strike(5, "1d6+3", "slashing"),
      text: "Melee +5, reach 5 ft. Hit: 6 (1d6 + 3) slashing.",
    },
  ],
  reactions: [
    {
      id: "parry",
      name: "Parry",
      cost: { reaction: 1 },
      recharge: "none",
      trigger: "self.wasHitByAttack",
      automation: [
        { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "Parry", durationRounds: 1, mods: { acBonus: 2 } }] },
      ],
      text: "+2 AC against one attack that would hit it.",
    },
  ],
});

// ------------------------------------------------------------------ Gladiator

export const gladiator = srd({
  id: "gladiator",
  name: "Gladiator",
  cr: "5",
  ac: 16,
  maxHp: "15d8+45",
  abilities: { str: 18, dex: 15, con: 16, int: 10, wis: 12, cha: 15 },
  pb: 3,
  proficientSaves: ["str", "dex", "con"],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "spear", times: 3 }],
      text: "Three spear attacks.",
    },
    {
      id: "spear",
      name: "Spear",
      cost: {},
      recharge: "none",
      automation: strike(7, "2d6+4", "piercing"),
      text: "Melee/ranged +7. Hit: 11 (2d6 + 4) piercing.",
    },
    {
      id: "shield-bash",
      name: "Shield Bash",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 7,
              onHit: [
                { type: "damage", amount: "2d4+4", damageType: "bludgeoning" },
                { type: "save", ability: "str", dc: 15, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] },
              ],
            },
          ],
        },
      ],
      text: "Melee +7. Hit: 9 (2d4 + 4) bludgeoning, DC 15 Str save or knocked prone.",
    },
  ],
  reactions: [
    {
      id: "parry",
      name: "Parry",
      cost: { reaction: 1 },
      recharge: "none",
      trigger: "self.wasHitByAttack",
      automation: [
        { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "Parry", durationRounds: 1, mods: { acBonus: 3 } }] },
      ],
      text: "+3 AC against one attack that would hit it.",
    },
  ],
});

// ----------------------------------------------------------- Young Gold Dragon

export const youngGoldDragon = srd({
  id: "young-gold-dragon",
  name: "Young Gold Dragon",
  cr: "10",
  ac: 18,
  maxHp: "17d10+85",
  size: "large",
  speeds: { walk: 40, fly: 80, swim: 40 },
  abilities: { str: 23, dex: 14, con: 21, int: 16, wis: 13, cha: 20 },
  pb: 4,
  proficientSaves: ["dex", "con", "wis", "cha"],
  immunities: ["fire"],
  resources: { breath: { max: 1, recharge: "roll:5-6" } },
  ai: {
    targetPriority: "highestThreat",
    aoeMinTargets: 2,
    opener: ["breath"],
    saveLegendaryResistanceFor: ["stunned", "paralyzed", "banished", "controlled"],
    keepDistance: false,
    neverRetreat: false,
    focusFire: true,
  },
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        { type: "useAction", action: "bite", times: 1 },
        { type: "useAction", action: "claw", times: 2 },
      ],
      text: "One Bite and two Claw attacks.",
    },
    {
      id: "bite",
      name: "Bite",
      cost: {},
      recharge: "none",
      automation: strike(10, "2d10+6", "piercing"),
      text: "Melee +10, reach 10 ft. Hit: 17 (2d10 + 6) piercing.",
    },
    {
      id: "claw",
      name: "Claw",
      cost: {},
      recharge: "none",
      automation: strike(10, "2d6+6", "slashing"),
      text: "Melee +10, reach 5 ft. Hit: 13 (2d6 + 6) slashing.",
    },
    {
      id: "breath",
      name: "Fire Breath",
      cost: { action: 1 },
      recharge: "roll:5-6",
      limitedUse: { resource: "breath", amount: 1 },
      automation: [
        {
          type: "target",
          who: { who: "area", shape: "cone", size: 30 },
          effects: [
            {
              type: "save",
              ability: "dex",
              dc: 17,
              onFail: [{ type: "damage", amount: "10d10", damageType: "fire" }],
              onSuccess: [{ type: "damage", amount: "10d10", damageType: "fire", half: true }],
            },
          ],
        },
      ],
      text: "30-ft cone, DC 17 Dex save, 55 (10d10) fire, half on a success. (Recharge 5–6.)",
    },
  ],
});

// ---------------------------------------------------------- Adult Red Dragon

export const adultRedDragon = srd({
  id: "adult-red-dragon",
  name: "Adult Red Dragon",
  cr: "17",
  ac: 19,
  maxHp: "19d12+133",
  size: "huge",
  speeds: { walk: 40, climb: 40, fly: 80 },
  abilities: { str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 23 },
  pb: 6,
  proficientSaves: ["dex", "con", "wis", "cha"],
  immunities: ["fire"],
  specialRules: [{ rule: "legendaryResistance", perDay: 3 }],
  resources: { breath: { max: 1, recharge: "roll:5-6" } },
  ai: {
    targetPriority: "highestThreat",
    aoeMinTargets: 2,
    opener: ["breath"],
    saveLegendaryResistanceFor: ["stunned", "paralyzed", "banished", "controlled"],
    keepDistance: false,
    neverRetreat: false,
    focusFire: true,
  },
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        { type: "useAction", action: "bite", times: 1 },
        { type: "useAction", action: "claw", times: 2 },
      ],
      text: "One Bite and two Claw attacks.",
    },
    {
      id: "bite",
      name: "Bite",
      cost: {},
      recharge: "none",
      automation: strike(14, "2d10+8", "piercing", { amount: "1d6", damageType: "fire" }),
      text: "Melee +14, reach 10 ft. Hit: 19 (2d10 + 8) piercing plus 3 (1d6) fire.",
    },
    {
      id: "claw",
      name: "Claw",
      cost: {},
      recharge: "none",
      automation: strike(14, "2d6+8", "slashing"),
      text: "Melee +14, reach 5 ft. Hit: 15 (2d6 + 8) slashing.",
    },
    {
      id: "tail",
      name: "Tail",
      cost: {},
      recharge: "none",
      automation: strike(14, "2d8+8", "bludgeoning"),
      text: "Melee +14, reach 15 ft. Hit: 17 (2d8 + 8) bludgeoning.",
    },
    {
      id: "breath",
      name: "Fire Breath",
      cost: { action: 1 },
      recharge: "roll:5-6",
      limitedUse: { resource: "breath", amount: 1 },
      automation: [
        {
          type: "target",
          who: { who: "area", shape: "cone", size: 60 },
          effects: [
            {
              type: "save",
              ability: "dex",
              dc: 21,
              onFail: [{ type: "damage", amount: "17d6", damageType: "fire" }],
              onSuccess: [{ type: "damage", amount: "17d6", damageType: "fire", half: true }],
            },
          ],
        },
      ],
      text: "60-ft cone, DC 21 Dex save, 59 (17d6) fire, half on a success. (Recharge 5–6.)",
    },
    {
      id: "wing-attack",
      name: "Wing Attack",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "area", shape: "emanation", size: 15 },
          effects: [
            {
              type: "save",
              ability: "dex",
              dc: 22,
              onFail: [
                { type: "damage", amount: "2d6+8", damageType: "bludgeoning" },
                { type: "applyCondition", condition: "prone", durationRounds: 1 },
              ],
            },
          ],
        },
      ],
      text: "Each creature within 15 ft: DC 22 Dex save or 15 (2d6 + 8) bludgeoning and knocked prone.",
    },
  ],
  legendaryActions: {
    budget: 3,
    options: [
      { action: "tail", cost: 1 },
      { action: "wing-attack", cost: 2 },
    ],
  },
});

// --------------------------------------------------------------- Tarrasque

export const tarrasque = srd({
  id: "tarrasque",
  name: "Tarrasque",
  cr: "30",
  ac: 25,
  maxHp: "34d20+340",
  size: "gargantuan",
  speeds: { walk: 40 },
  abilities: { str: 30, dex: 11, con: 30, int: 3, wis: 11, cha: 11 },
  pb: 9,
  proficientSaves: ["int", "wis", "cha"],
  immunities: ["fire", "poison"],
  resistancesNonmagical: ["bludgeoning", "piercing", "slashing"],
  conditionImmunities: ["charmed", "frightened", "paralyzed", "poisoned"],
  specialRules: [{ rule: "legendaryResistance", perDay: 3 }, { rule: "magicResistance" }],
  ai: {
    targetPriority: "highestThreat",
    aoeMinTargets: 2,
    opener: ["frightful-presence"],
    saveLegendaryResistanceFor: ["stunned", "paralyzed", "banished", "controlled"],
    keepDistance: false,
    neverRetreat: true,
    focusFire: true,
  },
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        { type: "useAction", action: "bite", times: 1 },
        { type: "useAction", action: "claw", times: 2 },
        { type: "useAction", action: "horns", times: 1 },
        { type: "useAction", action: "tail", times: 1 },
      ],
      text: "One Bite, two Claws, one Horns, and one Tail attack.",
    },
    {
      id: "bite",
      name: "Bite",
      cost: {},
      recharge: "none",
      automation: strike(19, "4d12+10", "piercing"),
      text: "Melee +19, reach 15 ft. Hit: 36 (4d12 + 10) piercing.",
    },
    {
      id: "claw",
      name: "Claw",
      cost: {},
      recharge: "none",
      automation: strike(19, "4d8+10", "slashing"),
      text: "Melee +19, reach 15 ft. Hit: 28 (4d8 + 10) slashing.",
    },
    {
      id: "horns",
      name: "Horns",
      cost: {},
      recharge: "none",
      automation: strike(19, "4d10+10", "piercing"),
      text: "Melee +19, reach 15 ft. Hit: 32 (4d10 + 10) piercing.",
    },
    {
      id: "tail",
      name: "Tail",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 19,
              onHit: [
                { type: "damage", amount: "4d6+10", damageType: "bludgeoning" },
                { type: "save", ability: "str", dc: 20, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] },
              ],
            },
          ],
        },
      ],
      text: "Melee +19, reach 30 ft. Hit: 24 (4d6 + 10) bludgeoning, DC 20 Str save or knocked prone.",
    },
    {
      id: "frightful-presence",
      name: "Frightful Presence",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "eachEnemy" },
          effects: [
            { type: "save", ability: "wis", dc: 17, onFail: [{ type: "applyCondition", condition: "frightened", durationRounds: 1, saveEnds: { ability: "wis", dc: 17, at: "endOfTurn" } }] },
          ],
        },
      ],
      text: "Each enemy within 120 ft: DC 17 Wis save or frightened for 1 minute (save ends).",
    },
  ],
  legendaryActions: {
    budget: 3,
    options: [
      { action: "claw", cost: 1 },
      { action: "bite", cost: 2 },
    ],
  },
});

export const SRD_MONSTERS: Combatant[] = [
  ogre,
  banditCaptain,
  gladiator,
  youngGoldDragon,
  adultRedDragon,
  tarrasque,
];
