// Spell-based PC templates. Each is a class + level + focus fed to `makeCaster`,
// which pulls a prepared / known list from the SRD catalog, wires real slot
// resources, and expands every prepared spell into its upcast Action variants.

import type { Combatant } from "../schema";
import { makeCaster } from "./caster";

const score = (mod: number) => 10 + mod * 2;
const between = (lvl: number, a: number, b: number) => Math.round(a + ((b - a) * (Math.max(1, Math.min(20, lvl)) - 1)) / 19);
const pbFor = (lvl: number) => 2 + Math.floor((Math.max(1, Math.min(20, lvl)) - 1) / 4);

/** a light weapon / unarmed fallback so opportunity attacks and `id:"attack"` lookups resolve */
function stub(dmg: string, bonus: number): Combatant["actions"] {
  return [{
    id: "attack", name: "Weapon", cost: { action: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: "bludgeoning" }] }] }],
  }];
}

export function blasterWizard(level: number): Combatant {
  const pb = pbFor(level);
  const int = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "blaster-wizard", name: `Wizard ${level}`, level, spellClass: "wizard", casterKind: "full", spellAbility: "int",
    ac: 15, hp: between(level, 8, 5 * 20 + 10),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(int), wis: score(1), cha: score(0) },
    proficientSaves: ["con", "int", "wis"], focus: "blaster",
    extraActions: stub(`1d4+${1}`, pb + 2), keepDistance: true, targetPriority: "squishiest",
  });
}

export function lifeCleric(level: number): Combatant {
  const pb = pbFor(level);
  const wis = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "life-cleric", name: `Cleric ${level}`, level, spellClass: "cleric", casterKind: "full", spellAbility: "wis",
    ac: 19, hp: between(level, 10, 7 * 20 + 15),
    abilities: { str: score(1), dex: score(0), con: score(2), int: score(0), wis: score(wis), cha: score(1) },
    proficientSaves: ["con", "wis", "cha"], focus: "balanced",
    extraTraits: [{ id: "party-heal", name: "Healer", trigger: "always", automation: [], text: "the engine's healer role tops up the most-hurt ally" }],
    extraActions: [
      { id: "party-heal", name: "Healing Word (bonus)", cost: { bonus: 1 }, recharge: "none", automation: [{ type: "target", who: { who: "lowestHpAlly" }, effects: [] }], text: "AI applies to the most-hurt ally" },
      ...stub(`1d8+${1}`, pb + 1),
    ],
    keepDistance: true, targetPriority: "lowestHp",
  });
}

export function vengeancePaladin(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const attacks = level >= 5 ? 2 : 1;
  const smite = `${Math.min(5, 2 + Math.floor(level / 5))}d8`;
  return makeCaster({
    id: "vengeance-paladin", name: `Paladin ${level}`, level, spellClass: "paladin", casterKind: "half", spellAbility: "cha",
    ac: 20, hp: between(level, 12, 8 * 20 + 18),
    abilities: { str: score(pb === 6 ? 5 : 4), dex: score(0), con: score(3), int: score(0), wis: score(1), cha: score(cha) },
    proficientSaves: ["wis", "cha"],
    saveBonusAll: level >= 6 ? cha : 0, // Aura of Protection (buildParty shares it)
    focus: "balanced",
    extraTraits: [{ id: "aura-of-protection", name: "Aura of Protection", trigger: "always", automation: [], text: "+CHA to saves, self + allies" }],
    extraActions: [{
      id: "attack", name: "Multiattack + Divine Smite", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [
        ...Array.from({ length: attacks }, () => ({ type: "attack" as const, bonus: pb + cha, adv: "adv" as const, onHit: [
          { type: "damage" as const, amount: `1d8+${cha}`, damageType: "slashing" as const },
          { type: "damage" as const, amount: "1d8", damageType: "radiant" as const },
        ] })),
        { type: "branch", if: "self.resource('slot2') > 0", then: [
          { type: "spendResource", resource: "slot2", amount: 1 },
          { type: "damage", amount: smite, damageType: "radiant" },
        ] },
      ] }],
    }],
    keepDistance: false, opener: ["attack"], targetPriority: "lowestHp",
  });
}

export function hunterRanger(level: number): Combatant {
  const pb = pbFor(level);
  const dex = pb === 6 ? 5 : 4;
  const attacks = (level >= 5 ? 2 : 1) + (level >= 11 ? 1 : 0);
  return makeCaster({
    id: "hunter-ranger", name: `Ranger ${level}`, level, spellClass: "ranger", casterKind: "half", spellAbility: "wis",
    ac: 18, hp: between(level, 11, 7 * 20 + 12),
    abilities: { str: score(0), dex: score(dex), con: score(2), int: score(0), wis: score(3), cha: score(0) },
    proficientSaves: ["str", "dex"], focus: "balanced",
    extraActions: [{
      id: "attack", name: "Multiattack (Longbow + Sharpshooter)", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attacks }, () => (
        { type: "attack" as const, bonus: pb + dex - 2, onHit: [{ type: "damage" as const, amount: `1d8+${dex + 10}`, damageType: "piercing" as const }] }
      )) }],
    }],
    keepDistance: true, opener: ["attack"], targetPriority: "lowestHp",
  });
}

export function draconicSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "draconic-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 14, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: stub(`1d10`, pb + cha), keepDistance: true, targetPriority: "lowestHp",
  });
}

export function moonDruid(level: number): Combatant {
  const pb = pbFor(level);
  const wis = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "moon-druid", name: `Druid ${level}`, level, spellClass: "druid", casterKind: "full", spellAbility: "wis",
    ac: 15, hp: between(level, 10, 8 * 20 + 16), // Wild Shape HP buffer folded in
    abilities: { str: score(1), dex: score(1), con: score(3), int: score(0), wis: score(wis), cha: score(0) },
    proficientSaves: ["con", "int", "wis"], focus: "controller",
    extraActions: stub(`2d6+3`, pb + 4), keepDistance: false, targetPriority: "lowestHp",
  });
}

export function loreBard(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "lore-bard", name: `Bard ${level}`, level, spellClass: "bard", casterKind: "full", spellAbility: "cha",
    ac: 16, hp: between(level, 9, 6 * 20 + 12),
    abilities: { str: score(0), dex: score(2), con: score(2), int: score(1), wis: score(1), cha: score(cha) },
    proficientSaves: ["con", "dex", "cha"], focus: "balanced",
    extraActions: stub(`1d8+${2}`, pb + 2), keepDistance: true, targetPriority: "squishiest",
  });
}

export function warlock(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "warlock", name: `Warlock ${level}`, level, spellClass: "warlock", casterKind: "warlock", spellAbility: "cha",
    ac: 16, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(1), wis: score(1), cha: score(cha) },
    proficientSaves: ["con", "wis", "cha"], focus: "blaster",
    // Eldritch Blast is the workhorse — make it the fallback `attack` too
    extraActions: [{
      id: "attack", name: "Eldritch Blast (Agonizing)", cost: { action: 1 }, recharge: "none", isSpell: true,
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from(
        { length: level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1 },
        () => ({ type: "attack" as const, bonus: pb + cha, onHit: [{ type: "damage" as const, amount: `1d10+${cha}`, damageType: "force" as const }] }),
      ) }],
    }],
    keepDistance: true, opener: [], targetPriority: "lowestHp",
  });
}

export const CASTER_BUILDERS: Record<string, (level: number) => Combatant> = {
  "blaster-wizard": blasterWizard,
  "life-cleric": lifeCleric,
  "vengeance-paladin": vengeancePaladin,
  "hunter-ranger": hunterRanger,
  "draconic-sorcerer": draconicSorcerer,
  "moon-druid": moonDruid,
  "lore-bard": loreBard,
  "warlock": warlock,
};
