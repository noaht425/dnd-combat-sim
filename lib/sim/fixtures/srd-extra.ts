// A broader bench of SRD 5.2.1 monsters so common encounters run out of the box
// without importing anything. Same source + licence + fidelity notes as srd.ts
// (SRD 5.2.1, © Wizards of the Coast, CC-BY-4.0 — transcribed at the fidelity the
// sim needs: defences, attacks, multiattack, key riders, breath weapons).

import type { Combatant } from "../schema";
import { srd, strike, type Automation } from "./srd";

import type { DamageType } from "../schema";

/** a save-for-half AoE-ish or single-target save effect */
function saveHit(
  ability: "str" | "dex" | "con" | "int" | "wis" | "cha",
  dc: number,
  dmg: string,
  damageType: DamageType,
  half = true,
  area?: { shape: "cone" | "line" | "sphere"; size: number },
): Automation {
  return [
    {
      type: "target",
      who: area ? { who: "area", shape: area.shape, size: area.size } : { who: "aiChoice" },
      effects: [
        {
          type: "save",
          ability,
          dc,
          onFail: [{ type: "damage", amount: dmg, damageType }],
          onSuccess: half ? [{ type: "damage", amount: dmg, damageType, half: true }] : [],
        },
      ],
    },
  ];
}

const multi = (...calls: Array<[string, number]>): Automation => [
  ...calls.map(([action, times]) => ({ type: "useAction" as const, action, times })),
];

// ------------------------------------------------------------- humanoids / low CR

export const goblin = srd({
  id: "goblin", name: "Goblin", cr: "1/4", ac: 15, maxHp: "2d6", size: "small",
  speeds: { walk: 30 }, abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 }, pb: 2,
  actions: [{ id: "scimitar", name: "Scimitar", cost: { action: 1 }, recharge: "none", automation: strike(4, "1d6+2", "slashing"), text: "Melee/ranged +4. Hit: 5 (1d6+2) slashing." }],
});

export const hobgoblin = srd({
  id: "hobgoblin", name: "Hobgoblin", cr: "1/2", ac: 18, maxHp: "2d8+2",
  abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 9 }, pb: 2,
  actions: [{ id: "longsword", name: "Longsword", cost: { action: 1 }, recharge: "none", automation: strike(3, "1d8+1", "slashing"), text: "Melee +3. Hit: 5 (1d8+1) slashing (+7 with Martial Advantage)." }],
});

export const kobold = srd({
  id: "kobold", name: "Kobold", cr: "1/8", ac: 12, maxHp: "2d6-2", size: "small",
  abilities: { str: 7, dex: 15, con: 9, int: 8, wis: 7, cha: 8 }, pb: 2,
  actions: [{ id: "dagger", name: "Dagger", cost: { action: 1 }, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 4, adv: "adv", onHit: [{ type: "damage", amount: "1d4+2", damageType: "piercing" }] }] }], text: "Melee/ranged +4 (Pack Tactics). Hit: 4 (1d4+2) piercing." }],
});

export const orc = srd({
  id: "orc", name: "Orc", cr: "1/2", ac: 13, maxHp: "2d8+6",
  speeds: { walk: 30 }, abilities: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 }, pb: 2,
  actions: [{ id: "greataxe", name: "Greataxe", cost: { action: 1 }, recharge: "none", automation: strike(5, "1d12+3", "slashing"), text: "Melee +5. Hit: 9 (1d12+3) slashing." }],
});

export const bugbear = srd({
  id: "bugbear", name: "Bugbear", cr: "1", ac: 16, maxHp: "5d8+5", size: "medium",
  abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 11, cha: 9 }, pb: 2,
  actions: [{ id: "morningstar", name: "Morningstar", cost: { action: 1 }, recharge: "none", automation: strike(4, "2d8+2", "piercing"), text: "Melee +4 (Brute). Hit: 11 (2d8+2) piercing." }],
});

export const gnoll = srd({
  id: "gnoll", name: "Gnoll", cr: "1/2", ac: 15, maxHp: "5d8",
  speeds: { walk: 30 }, abilities: { str: 14, dex: 12, con: 11, int: 6, wis: 10, cha: 7 }, pb: 2,
  actions: [{ id: "spear", name: "Spear", cost: { action: 1 }, recharge: "none", automation: strike(4, "1d6+2", "piercing"), text: "Melee/ranged +4. Hit: 5 (1d6+2) piercing." }],
});

export const berserker = srd({
  id: "berserker", name: "Berserker", cr: "2", ac: 13, maxHp: "9d8+27",
  abilities: { str: 16, dex: 12, con: 17, int: 9, wis: 11, cha: 9 }, pb: 2,
  specialRules: [{ rule: "resistNonAdvantageAttacks" }], // Reckless: attacks against it have advantage
  actions: [{ id: "greataxe", name: "Greataxe", cost: { action: 1 }, recharge: "none", automation: strike(5, "2d12+3", "slashing"), text: "Melee +5 (Reckless). Hit: 17 (2d12+3) slashing." }],
});

export const veteran = srd({
  id: "veteran", name: "Veteran", cr: "3", ac: 17, maxHp: "9d8+18",
  proficientSaves: [], abilities: { str: 16, dex: 13, con: 14, int: 10, wis: 11, cha: 10 }, pb: 2,
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["longsword", 2], ["shortsword", 1]), text: "Two longsword and one shortsword attack." },
    { id: "longsword", name: "Longsword", cost: {}, recharge: "none", automation: strike(5, "1d8+3", "slashing"), text: "Melee +5. Hit: 7 (1d8+3) slashing." },
    { id: "shortsword", name: "Shortsword", cost: {}, recharge: "none", automation: strike(5, "1d6+3", "piercing"), text: "Melee +5. Hit: 6 (1d6+3) piercing." },
  ],
});

export const knight = srd({
  id: "knight", name: "Knight", cr: "3", ac: 18, maxHp: "8d8+16",
  proficientSaves: ["con", "wis"], abilities: { str: 16, dex: 11, con: 14, int: 11, wis: 11, cha: 15 }, pb: 2,
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["greatsword", 2]), text: "Two greatsword attacks." },
    { id: "greatsword", name: "Greatsword", cost: {}, recharge: "none", automation: strike(5, "2d6+3", "slashing"), text: "Melee +5. Hit: 10 (2d6+3) slashing." },
  ],
  reactions: [{ id: "parry", name: "Parry", cost: { reaction: 1 }, recharge: "none", trigger: "self.wasHitByAttack", automation: [{ type: "note", text: "+2 AC vs one melee attack (engine hook)" }] }],
});

// ------------------------------------------------------------- undead

export const ghoul = srd({
  id: "ghoul", name: "Ghoul", cr: "1", ac: 12, maxHp: "5d8",
  abilities: { str: 13, dex: 15, con: 10, int: 7, wis: 10, cha: 6 }, pb: 2,
  immunities: ["poison"], conditionImmunities: ["poisoned", "charmed", "exhaustion"],
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["bite", 1], ["claws", 1]), text: "One bite and one claws attack." },
    { id: "bite", name: "Bite", cost: {}, recharge: "none", automation: strike(2, "2d6+2", "piercing"), text: "Melee +2. Hit: 9 (2d6+2) piercing." },
    { id: "claws", name: "Claws", cost: {}, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 4, onHit: [{ type: "damage", amount: "2d4+2", damageType: "slashing" }, { type: "save", ability: "con", dc: 10, onFail: [{ type: "applyCondition", condition: "paralyzed", durationRounds: 1, saveEnds: { ability: "con", dc: 10, at: "endOfTurn" } }] }] }] }], text: "Melee +4. Hit: 7 (2d4+2) slashing, DC 10 Con or paralyzed 1 min (save ends)." },
  ],
});

export const ghast = srd({
  id: "ghast", name: "Ghast", cr: "2", ac: 13, maxHp: "8d8",
  abilities: { str: 16, dex: 17, con: 10, int: 11, wis: 10, cha: 8 }, pb: 2,
  resistances: ["necrotic"], immunities: ["poison"], conditionImmunities: ["poisoned", "charmed", "exhaustion"],
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["bite", 1], ["claws", 1]), text: "One bite and one claws attack." },
    { id: "bite", name: "Bite", cost: {}, recharge: "none", automation: strike(3, "2d8+3", "piercing"), text: "Melee +3. Hit: 12 (2d8+3) piercing." },
    { id: "claws", name: "Claws", cost: {}, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 5, onHit: [{ type: "damage", amount: "2d6+3", damageType: "slashing" }, { type: "save", ability: "con", dc: 10, onFail: [{ type: "applyCondition", condition: "paralyzed", durationRounds: 1, saveEnds: { ability: "con", dc: 10, at: "endOfTurn" } }] }] }] }], text: "Melee +5. Hit: 10 (2d6+3) slashing, DC 10 Con or paralyzed (save ends)." },
  ],
});

export const wight = srd({
  id: "wight", name: "Wight", cr: "3", ac: 14, maxHp: "6d8+18",
  abilities: { str: 15, dex: 14, con: 16, int: 10, wis: 13, cha: 15 }, pb: 2,
  resistancesNonmagical: ["bludgeoning", "piercing", "slashing"], resistances: ["necrotic"],
  immunities: ["poison"], conditionImmunities: ["poisoned", "exhaustion"],
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["longsword", 2]), text: "Two longsword or life-drain attacks." },
    { id: "longsword", name: "Longsword", cost: {}, recharge: "none", automation: strike(4, "1d8+2", "slashing"), text: "Melee +4. Hit: 6 (1d8+2) slashing." },
    { id: "life-drain", name: "Life Drain", cost: {}, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 4, onHit: [{ type: "damage", amount: "1d6+2", damageType: "necrotic" }, { type: "applyEffect", name: "life-drained", durationRounds: -1, mods: { maxHpReduction: "1d6+2" } }] }] }], text: "Melee +4. Hit: 5 (1d6+2) necrotic; max HP reduced by the damage." },
  ],
});

export const wraith = srd({
  id: "wraith", name: "Wraith", cr: "5", ac: 13, maxHp: "9d8+27",
  speeds: { walk: 0, fly: 60 }, abilities: { str: 6, dex: 16, con: 16, int: 12, wis: 14, cha: 15 }, pb: 3,
  resistancesNonmagical: ["bludgeoning", "piercing", "slashing"],
  resistances: ["acid", "cold", "fire", "lightning", "thunder", "necrotic"],
  immunities: ["poison"], conditionImmunities: ["poisoned", "charmed", "exhaustion", "grappled", "paralyzed", "petrified", "prone", "restrained"],
  actions: [
    { id: "life-drain", name: "Life Drain", cost: { action: 1 }, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 6, onHit: [{ type: "damage", amount: "4d8+3", damageType: "necrotic" }, { type: "applyEffect", name: "life-drained", durationRounds: -1, mods: { maxHpReduction: "4d8+3" } }] }] }], text: "Melee +6. Hit: 21 (4d8+3) necrotic; max HP reduced by the damage." },
  ],
});

// ------------------------------------------------------------- casters

export const mage = srd({
  id: "mage", name: "Mage", cr: "6", ac: 15, maxHp: "9d8",
  proficientSaves: ["int", "wis"], abilities: { str: 9, dex: 14, con: 11, int: 17, wis: 12, cha: 11 }, pb: 3,
  resources: { fireball: { max: 3, recharge: "longRest" }, shield: { max: 3, recharge: "longRest" } },
  ai: { targetPriority: "highestThreat", aoeMinTargets: 2, opener: ["fireball"], saveLegendaryResistanceFor: [], keepDistance: true, neverRetreat: false, focusFire: true },
  actions: [
    { id: "fireball", name: "Fireball", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "fireball", amount: 1 }, isSpell: true, automation: saveHit("dex", 15, "8d6", "fire", true, { shape: "sphere", size: 20 }), text: "20-ft sphere, DC 15 Dex, 28 (8d6) fire, half on a success. (3/day)" },
    { id: "firebolt", name: "Fire Bolt", cost: { action: 1 }, recharge: "none", isSpell: true, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 6, onHit: [{ type: "damage", amount: "2d10", damageType: "fire" }] }] }], text: "Ranged spell +6. Hit: 11 (2d10) fire." },
  ],
  reactions: [{ id: "shield", name: "Shield", cost: { reaction: 1 }, recharge: "none", trigger: "self.wasHitByAttack", limitedUse: { resource: "shield", amount: 1 }, isSpell: true, automation: [{ type: "note", text: "+5 AC until next turn (engine hook)" }] }],
});

export const priest = srd({
  id: "priest", name: "Priest", cr: "2", ac: 13, maxHp: "5d8+5",
  abilities: { str: 10, dex: 10, con: 12, int: 13, wis: 16, cha: 13 }, pb: 2,
  resources: { heal: { max: 3, recharge: "longRest" } },
  actions: [
    { id: "guiding-bolt", name: "Guiding Bolt", cost: { action: 1 }, recharge: "none", isSpell: true, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 5, onHit: [{ type: "damage", amount: "4d6", damageType: "radiant" }] }] }], text: "Ranged spell +5. Hit: 14 (4d6) radiant." },
    { id: "mace", name: "Mace", cost: { action: 1 }, recharge: "none", automation: strike(2, "1d6-1", "bludgeoning"), text: "Melee +2. Hit: 2 (1d6-1) bludgeoning." },
    { id: "cure", name: "Cure Wounds", cost: { action: 1 }, recharge: "none", isSpell: true, limitedUse: { resource: "heal", amount: 1 }, automation: [{ type: "target", who: { who: "lowestHpAlly" }, effects: [{ type: "heal", amount: "3d8+3" }] }], text: "Heal a wounded ally 16 (3d8+3). (3/day)" },
  ],
});

// ------------------------------------------------------------- beasts

export const owlbear = srd({
  id: "owlbear", name: "Owlbear", cr: "3", ac: 13, maxHp: "7d10+21", size: "large",
  speeds: { walk: 40 }, abilities: { str: 20, dex: 12, con: 17, int: 3, wis: 12, cha: 7 }, pb: 2,
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["beak", 1], ["claws", 1]), text: "One beak and one claws attack." },
    { id: "beak", name: "Beak", cost: {}, recharge: "none", automation: strike(7, "1d10+5", "piercing"), text: "Melee +7. Hit: 10 (1d10+5) piercing." },
    { id: "claws", name: "Claws", cost: {}, recharge: "none", automation: strike(7, "2d8+5", "slashing"), text: "Melee +7. Hit: 14 (2d8+5) slashing." },
  ],
});

export const direWolf = srd({
  id: "dire-wolf", name: "Dire Wolf", cr: "1", ac: 14, maxHp: "5d10+10", size: "large",
  speeds: { walk: 50 }, abilities: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 }, pb: 2,
  actions: [{ id: "bite", name: "Bite", cost: { action: 1 }, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 5, adv: "adv", onHit: [{ type: "damage", amount: "2d6+3", damageType: "piercing" }, { type: "save", ability: "str", dc: 13, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] }] }] }], text: "Melee +5 (Pack Tactics). Hit: 10 (2d6+3) piercing, DC 13 Str or prone." }],
});

export const giantSpider = srd({
  id: "giant-spider", name: "Giant Spider", cr: "1", ac: 14, maxHp: "4d10+4", size: "large",
  speeds: { walk: 30 }, abilities: { str: 14, dex: 16, con: 12, int: 2, wis: 11, cha: 4 }, pb: 2,
  actions: [{ id: "bite", name: "Bite", cost: { action: 1 }, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 5, onHit: [{ type: "damage", amount: "1d8+3", damageType: "piercing" }, { type: "save", ability: "con", dc: 11, onFail: [{ type: "damage", amount: "2d8", damageType: "poison" }, { type: "applyCondition", condition: "poisoned", durationRounds: 1, saveEnds: { ability: "con", dc: 11, at: "endOfTurn" } }], onSuccess: [{ type: "damage", amount: "2d8", damageType: "poison", half: true }] }] }] }], text: "Melee +5. Hit: 7 (1d8+3) piercing + DC 11 Con or 9 (2d8) poison and poisoned (save ends)." }],
});

// ------------------------------------------------------------- big brutes

export const troll = srd({
  id: "troll", name: "Troll", cr: "5", ac: 15, maxHp: "8d10+40", size: "large",
  speeds: { walk: 30 }, abilities: { str: 18, dex: 13, con: 20, int: 7, wis: 9, cha: 7 }, pb: 3,
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["bite", 1], ["claw", 2]), text: "One bite and two claw attacks. (Regenerates 10 HP/turn — not modelled.)" },
    { id: "bite", name: "Bite", cost: {}, recharge: "none", automation: strike(7, "1d6+4", "piercing"), text: "Melee +7. Hit: 7 (1d6+4) piercing." },
    { id: "claw", name: "Claw", cost: {}, recharge: "none", automation: strike(7, "2d6+4", "slashing"), text: "Melee +7. Hit: 11 (2d6+4) slashing." },
  ],
});

export const hillGiant = srd({
  id: "hill-giant", name: "Hill Giant", cr: "5", ac: 13, maxHp: "10d12+40", size: "huge",
  speeds: { walk: 40 }, abilities: { str: 21, dex: 8, con: 19, int: 5, wis: 9, cha: 6 }, pb: 3,
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["greatclub", 2]), text: "Two greatclub attacks." },
    { id: "greatclub", name: "Greatclub", cost: {}, recharge: "none", automation: strike(8, "3d8+5", "bludgeoning"), text: "Melee +8, reach 10 ft. Hit: 18 (3d8+5) bludgeoning." },
    { id: "rock", name: "Rock", cost: { action: 1 }, recharge: "none", automation: strike(8, "3d10+5", "bludgeoning"), text: "Ranged +8, range 60/240. Hit: 21 (3d10+5) bludgeoning." },
  ],
});

export const frostGiant = srd({
  id: "frost-giant", name: "Frost Giant", cr: "8", ac: 15, maxHp: "12d12+60", size: "huge",
  speeds: { walk: 40 }, proficientSaves: ["con", "wis", "cha"], abilities: { str: 23, dex: 9, con: 21, int: 9, wis: 10, cha: 12 }, pb: 3,
  immunities: ["cold"],
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["greataxe", 2]), text: "Two greataxe attacks." },
    { id: "greataxe", name: "Greataxe", cost: {}, recharge: "none", automation: strike(9, "3d12+6", "slashing"), text: "Melee +9, reach 10 ft. Hit: 25 (3d12+6) slashing." },
    { id: "rock", name: "Rock", cost: { action: 1 }, recharge: "none", automation: strike(9, "4d10+6", "bludgeoning"), text: "Ranged +9, range 60/240. Hit: 28 (4d10+6) bludgeoning." },
  ],
});

export const fireGiant = srd({
  id: "fire-giant", name: "Fire Giant", cr: "9", ac: 18, maxHp: "13d12+78", size: "huge",
  speeds: { walk: 30 }, proficientSaves: ["dex", "con", "cha"], abilities: { str: 25, dex: 9, con: 23, int: 10, wis: 14, cha: 13 }, pb: 4,
  immunities: ["fire"],
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["greatsword", 2]), text: "Two greatsword attacks." },
    { id: "greatsword", name: "Greatsword", cost: {}, recharge: "none", automation: strike(11, "6d6+7", "slashing"), text: "Melee +11, reach 10 ft. Hit: 28 (6d6+7) slashing." },
    { id: "rock", name: "Rock", cost: { action: 1 }, recharge: "none", automation: strike(11, "4d10+7", "bludgeoning"), text: "Ranged +11, range 60/240. Hit: 29 (4d10+7) bludgeoning." },
  ],
});

export const wyvern = srd({
  id: "wyvern", name: "Wyvern", cr: "6", ac: 13, maxHp: "13d10+39", size: "large",
  speeds: { walk: 20, fly: 80 }, abilities: { str: 19, dex: 10, con: 16, int: 5, wis: 12, cha: 6 }, pb: 3,
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["bite", 1], ["stinger", 1]), text: "One bite and one stinger attack." },
    { id: "bite", name: "Bite", cost: {}, recharge: "none", automation: strike(7, "2d6+4", "piercing"), text: "Melee +7, reach 10 ft. Hit: 11 (2d6+4) piercing." },
    { id: "stinger", name: "Stinger", cost: {}, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 7, onHit: [{ type: "damage", amount: "2d6+4", damageType: "piercing" }, { type: "save", ability: "con", dc: 15, onFail: [{ type: "damage", amount: "7d6", damageType: "poison" }], onSuccess: [{ type: "damage", amount: "7d6", damageType: "poison", half: true }] }] }] }], text: "Melee +7, reach 10 ft. Hit: 11 piercing + DC 15 Con or 24 (7d6) poison, half on a success." },
  ],
});

// ------------------------------------------------------------- young dragons (no legendary actions)

export const youngWhiteDragon = srd({
  id: "young-white-dragon", name: "Young White Dragon", cr: "6", ac: 17, maxHp: "14d10+56", size: "large",
  speeds: { walk: 40, fly: 80, swim: 40 }, proficientSaves: ["dex", "con", "wis", "cha"],
  abilities: { str: 18, dex: 10, con: 18, int: 6, wis: 11, cha: 12 }, pb: 3, immunities: ["cold"],
  resources: { breath: { max: 1, recharge: "roll:5-6" } },
  ai: { targetPriority: "highestThreat", aoeMinTargets: 2, opener: ["breath"], saveLegendaryResistanceFor: ["stunned", "paralyzed", "controlled"], keepDistance: false, neverRetreat: false, focusFire: true },
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["bite", 1], ["claw", 2]), text: "One bite and two claw attacks." },
    { id: "bite", name: "Bite", cost: {}, recharge: "none", automation: strike(7, "2d10+4", "piercing", { amount: "1d8", damageType: "cold" }), text: "Melee +7, reach 10 ft. Hit: 15 (2d10+4) piercing + 4 (1d8) cold." },
    { id: "claw", name: "Claw", cost: {}, recharge: "none", automation: strike(7, "2d6+4", "slashing"), text: "Melee +7. Hit: 11 (2d6+4) slashing." },
    { id: "breath", name: "Cold Breath", cost: { action: 1 }, recharge: "roll:5-6", limitedUse: { resource: "breath", amount: 1 }, automation: saveHit("con", 15, "10d8", "cold", true, { shape: "cone", size: 30 }), text: "30-ft cone, DC 15 Con, 45 (10d8) cold, half on a success. (Recharge 5–6.)" },
  ],
});

export const youngBlueDragon = srd({
  id: "young-blue-dragon", name: "Young Blue Dragon", cr: "9", ac: 18, maxHp: "16d10+64", size: "large",
  speeds: { walk: 40, fly: 80, burrow: 20 }, proficientSaves: ["dex", "con", "wis", "cha"],
  abilities: { str: 21, dex: 10, con: 19, int: 14, wis: 13, cha: 17 }, pb: 4, immunities: ["lightning"],
  resources: { breath: { max: 1, recharge: "roll:5-6" } },
  ai: { targetPriority: "highestThreat", aoeMinTargets: 2, opener: ["breath"], saveLegendaryResistanceFor: ["stunned", "paralyzed", "controlled"], keepDistance: false, neverRetreat: false, focusFire: true },
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["bite", 1], ["claw", 2]), text: "One bite and two claw attacks." },
    { id: "bite", name: "Bite", cost: {}, recharge: "none", automation: strike(9, "2d10+5", "piercing", { amount: "1d10", damageType: "lightning" }), text: "Melee +9, reach 10 ft. Hit: 16 (2d10+5) piercing + 5 (1d10) lightning." },
    { id: "claw", name: "Claw", cost: {}, recharge: "none", automation: strike(9, "2d6+5", "slashing"), text: "Melee +9. Hit: 12 (2d6+5) slashing." },
    { id: "breath", name: "Lightning Breath", cost: { action: 1 }, recharge: "roll:5-6", limitedUse: { resource: "breath", amount: 1 }, automation: saveHit("dex", 16, "10d10", "lightning", true, { shape: "line", size: 60 }), text: "60-ft line, DC 16 Dex, 55 (10d10) lightning, half on a success. (Recharge 5–6.)" },
  ],
});

export const orcWarChief = srd({
  id: "orc-war-chief", name: "Orc War Chief", cr: "4", ac: 16, maxHp: "11d8+44",
  proficientSaves: ["str", "con", "wis"], abilities: { str: 18, dex: 12, con: 18, int: 11, wis: 11, cha: 16 }, pb: 2,
  actions: [
    { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: multi(["greataxe", 2]), text: "Two greataxe attacks." },
    { id: "greataxe", name: "Greataxe", cost: {}, recharge: "none", automation: strike(6, "1d12+4", "slashing", { amount: "1d8", damageType: "slashing" }), text: "Melee +6. Hit: 10 (1d12+4) + 4 (1d8) slashing." },
  ],
});

export const SRD_EXTRA: Combatant[] = [
  goblin, hobgoblin, kobold, orc, bugbear, gnoll, berserker, veteran, knight,
  ghoul, ghast, wight, wraith,
  mage, priest,
  owlbear, direWolf, giantSpider,
  troll, hillGiant, frostGiant, fireGiant, wyvern,
  youngWhiteDragon, youngBlueDragon, orcWarChief,
];
