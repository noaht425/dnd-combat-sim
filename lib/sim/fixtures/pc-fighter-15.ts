import type { Combatant } from "../schema";

// A hand-authored PC — proves a player character uses the identical shape as a
// monster. Later this would be produced by a "battlemaster-fighter" template
// with level as a dial; here it's written out at level 15.
export const pcFighter15: Combatant = {
  id: "pc-fighter-15",
  name: "Bront (Fighter 15)",
  kind: "pc",
  size: "medium",
  level: 15,
  templateId: "battlemaster-fighter",
  ac: 20,
  maxHp: 144,
  speeds: { walk: 30 },
  abilities: { str: 20, dex: 14, con: 16, int: 10, wis: 12, cha: 8 },
  pb: 5,
  proficientSaves: ["str", "con"],
  saveBonusAll: 0,
  resistances: [],
  resistancesNonmagical: [],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: [],
  specialRules: [],
  resources: {
    superiority_dice: { max: 6, recharge: "shortRest" }, // d10s at level 15
    action_surge: { max: 1, recharge: "shortRest" },
    second_wind: { max: 1, recharge: "shortRest" },
    indomitable: { max: 2, recharge: "longRest" },
  },
  traits: [
    {
      id: "indomitable",
      name: "Indomitable",
      trigger: "always",
      automation: [],
      text: "Reroll a failed save, twice per long rest (resource indomitable). Engine hook on save resolution.",
    },
  ],
  actions: [
    {
      id: "attack-action",
      name: "Attack (Extra Attack 3)",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "greatsword", times: 3 }],
      text: "Three greatsword attacks.",
    },
    {
      id: "greatsword",
      name: "Greatsword +2",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 12, // Str +5, PB +5, +2 weapon
              onHit: [{ type: "damage", amount: "2d6+7", damageType: "slashing" }],
            },
          ],
        },
      ],
      text: "+12 to hit, 2d6+7 slashing (GWF reroll 1s/2s handled by the engine).",
    },
    {
      id: "action-surge",
      name: "Action Surge",
      cost: { bonus: 1 }, // modelled as a free extra Attack action this turn
      recharge: "none",
      limitedUse: { resource: "action_surge", amount: 1 },
      automation: [{ type: "useAction", action: "attack-action", times: 1 }],
      text: "Once per short rest: take an extra Attack action.",
    },
    {
      id: "second-wind",
      name: "Second Wind",
      cost: { bonus: 1 },
      recharge: "none",
      limitedUse: { resource: "second_wind", amount: 1 },
      automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: "1d10+15" }] }],
      text: "Bonus action, once per short rest: regain 1d10 + level HP.",
    },
    {
      id: "menacing-strike",
      name: "Menacing Attack (Superiority)",
      cost: {},
      recharge: "none",
      limitedUse: { resource: "superiority_dice", amount: 1 },
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            { type: "damage", amount: "1d10", damageType: "slashing" },
            { type: "save", ability: "wis", dc: 17, onFail: [{ type: "applyCondition", condition: "frightened", durationRounds: 1 }] },
          ],
        },
      ],
      text: "On a hit, spend a superiority die: +1d10 damage, DC 17 Wis or frightened until the end of Bront's next turn.",
    },
  ],
  reactions: [
    {
      id: "riposte",
      name: "Riposte (Superiority)",
      cost: { reaction: 1 },
      recharge: "none",
      trigger: "self.wasMissedByMeleeAttack",
      limitedUse: { resource: "superiority_dice", amount: 1 },
      automation: [{ type: "useAction", action: "greatsword", times: 1 }],
      text: "When a creature misses him with a melee attack, spend a die to make one greatsword attack (+1d10 on hit).",
    },
  ],
  ai: {
    targetPriority: "lowestHp",
    aoeMinTargets: 2,
    opener: [],
    saveLegendaryResistanceFor: [],
    keepDistance: false,
    neverRetreat: true,
    focusFire: true,
  },
};
