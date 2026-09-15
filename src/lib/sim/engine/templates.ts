// Phase 3 — real per-class PC builds, each a function of level. Not min-maxed,
// but they actually cast Fireball, Spirit Guardians, a control spell, smite,
// Shield, Counterspell, etc. — so the engine's read means something.
//
// `makeTemplate("blaster-wizard", 15)` -> a schema-valid Combatant.

import type { Ability, Combatant } from "../schema";
import { CASTER_BUILDERS } from "../spells/casterTemplates";

const pbFor = (lvl: number) => 2 + Math.floor((lvl - 1) / 4);
const score = (mod: number) => 10 + mod * 2;
/** linear interpolate a stat from its value `a` at level 1 to its value `b` at
 *  level 20. IMPORTANT: `b` is the LEVEL-20 value, a constant — do NOT pass a
 *  level-dependent expression (that was a long-standing HP bug that crushed
 *  low-to-mid-level PCs to ~1/3 of their real hit points). */
const between = (lvl: number, a: number, b: number, atA = 1, atB = 20) =>
  Math.round(a + ((b - a) * (Math.max(atA, Math.min(atB, lvl)) - atA)) / (atB - atA));

function pc(base: {
  id: string; name: string; level: number; ac: number; hp: number;
  abilities: Combatant["abilities"]; proficientSaves: Ability[];
  saveBonusAll?: number;
  resources?: Combatant["resources"]; traits?: Combatant["traits"];
  actions: Combatant["actions"]; reactions?: Combatant["reactions"];
  specialRules?: Combatant["specialRules"];
  keepDistance?: boolean; opener?: string[]; targetPriority?: Combatant["ai"]["targetPriority"];
}): Combatant {
  return {
    id: base.id, name: base.name, kind: "pc", size: "medium", level: base.level,
    templateId: base.id, ac: base.ac, maxHp: base.hp, speeds: { walk: 30 },
    abilities: base.abilities, pb: pbFor(base.level), proficientSaves: base.proficientSaves,
    saveBonusAll: base.saveBonusAll ?? 0,
    resistances: [], resistancesNonmagical: [], immunities: [], vulnerabilities: [],
    conditionImmunities: [], specialRules: base.specialRules ?? [],
    resources: base.resources ?? {}, traits: base.traits ?? [],
    actions: base.actions, reactions: base.reactions ?? [],
    ai: {
      targetPriority: base.targetPriority ?? "lowestHp", aoeMinTargets: 2,
      opener: base.opener ?? [], saveLegendaryResistanceFor: [],
      keepDistance: base.keepDistance ?? false, neverRetreat: true, focusFire: true,
    },
  };
}

// ─────────────────────────────────────────────────────────────── the templates

function gwmFighter(level: number): Combatant {
  const pb = pbFor(level);
  // Extra Attack: 1 swing, 2 at L5, 3 at L11, 4 at L20
  const baseAttacks = level >= 20 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
  // ...plus a GWM bonus-action attack once Extra Attack is online — folded into the main routine
  const attacks = baseAttacks + (level >= 5 ? 1 : 0);
  const str = pb === 6 ? 5 : 4;
  // Great Weapon Master: -5 to hit for +10 damage, roughly offset by a magic weapon
  const toHit = pb + str - 2;
  const dmgPerHit = `2d6+${str + 6}`; // 2d6 + STR + GWF + partial GWM
  const swing = () =>
    ({ type: "attack" as const, bonus: toHit, onHit: [{ type: "damage" as const, amount: dmgPerHit, damageType: "slashing" as const }] });
  return pc({
    id: "gwm-fighter", name: `Fighter ${level}`, level,
    ac: 19, hp: between(level, 13, 9 * 20 + 15),
    abilities: { str: score(pb === 6 ? 5 : 4), dex: score(1), con: score(3), int: score(0), wis: score(1), cha: score(0) },
    proficientSaves: ["str", "con"],
    resources: { action_surge: { max: level >= 17 ? 2 : 1, recharge: "shortRest" }, superiority: { max: 4, recharge: "shortRest" }, second_wind: { max: 1, recharge: "shortRest" } },
    actions: [
      {
        id: "attack", name: "Multiattack (GWM)", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attacks }, swing) }],
      },
      {
        // Action Surge grants ONE extra action = one more Attack action: `baseAttacks`
        // swings (1 at L3, 2 at L5, 3 at L11) — NOT the GWM bonus-action attack
        id: "action-surge", name: "Action Surge", cost: { bonus: 1 }, recharge: "none",
        limitedUse: { resource: "action_surge", amount: 1 },
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: baseAttacks }, swing) }],
      },
    ],
    reactions: [{
      id: "riposte", name: "Riposte", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasMissedByMeleeAttack", limitedUse: { resource: "superiority", amount: 1 },
      automation: [{ type: "useAction", action: "attack", times: 1 }],
    }],
    opener: ["action-surge"], targetPriority: "lowestHp",
  });
}

function assassinRogue(level: number): Combatant {
  const pb = pbFor(level);
  const sneak = `${Math.ceil(level / 2)}d6`;
  return pc({
    id: "assassin-rogue", name: `Rogue ${level}`, level,
    ac: 18, hp: between(level, 10, 7 * 20 + 12),
    abilities: { str: score(0), dex: score(pb === 6 ? 5 : 4), con: score(2), int: score(2), wis: score(2), cha: score(1) },
    proficientSaves: ["dex", "int"],
    traits: [{ id: "evasion", name: "Evasion", trigger: "always", automation: [], text: "half on a failed Dex save, none on a success (engine hook)" }],
    actions: [{
      id: "attack", name: "Attack + Sneak Attack", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "squishiestEnemy" }, effects: [
        { type: "attack", bonus: pb + 5, adv: "adv", onHit: [
          { type: "damage", amount: `1d8+${pb === 6 ? 5 : 4}`, damageType: "piercing" },
          { type: "damage", amount: sneak, damageType: "piercing" },
        ] },
        { type: "attack", bonus: pb + 5, onHit: [{ type: "damage", amount: `1d8+${pb === 6 ? 5 : 4}`, damageType: "piercing" }] },
      ] }],
    }],
    reactions: [{
      id: "uncanny-dodge", name: "Uncanny Dodge", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasHitByAttack", automation: [{ type: "note", text: "halves the triggering attack's damage (engine hook)" }],
    }],
    keepDistance: true, targetPriority: "squishiest",
  });
}

function totemBarbarian(level: number): Combatant {
  const pb = pbFor(level);
  const str = pb === 6 ? 5 : 4;
  const attacks = level >= 5 ? 2 : 1;
  const dmg = `2d6+${str + 3}`; // greatsword + Rage damage
  return pc({
    id: "totem-barbarian", name: `Barbarian ${level}`, level,
    ac: 16, hp: between(level, 15, 10 * 20 + 20), // d12 + Con + Tough-ish
    abilities: { str: score(str), dex: score(2), con: score(pb === 6 ? 5 : 4), int: score(-1), wis: score(1), cha: score(0) },
    proficientSaves: ["str", "con"],
    // Danger Sense — advantage on Dex saves; Rage soak modelled as a 25% cut to all incoming
    specialRules: [{ rule: "advantageOnSaves", abilities: ["dex"] }],
    resources: { rage: { max: level >= 17 ? 6 : level >= 12 ? 5 : 4, recharge: "longRest" } },
    actions: [
      {
        id: "rage", name: "Rage", cost: { bonus: 1 }, recharge: "none",
        limitedUse: { resource: "rage", amount: 1 },
        automation: [{ type: "target", who: { who: "self" }, effects: [
          { type: "applyEffect", name: "rage", durationRounds: 10, mods: { damageTakenMultiplier: 0.75 } },
        ] }],
      },
      {
        id: "attack", name: "Reckless Multiattack", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attacks + (level >= 5 ? 1 : 0) }, () => (
          { type: "attack" as const, bonus: pb + str, adv: "adv" as const, onHit: [{ type: "damage" as const, amount: dmg, damageType: "slashing" as const }] }
        )) }],
      },
    ],
    opener: ["rage"], targetPriority: "lowestHp",
  });
}

function openHandMonk(level: number): Combatant {
  const pb = pbFor(level);
  const dex = pb === 6 ? 5 : 4;
  const dc = 8 + pb + (pb === 6 ? 3 : 3); // Wis
  const die = level >= 17 ? 10 : level >= 11 ? 8 : level >= 5 ? 6 : 4;
  const strikes = (level >= 5 ? 2 : 1) + 2; // attack(s) + Martial Arts + Flurry
  return pc({
    id: "open-hand-monk", name: `Monk ${level}`, level,
    ac: 18, hp: between(level, 9, 6 * 20 + 12),
    abilities: { str: score(1), dex: score(dex), con: score(2), int: score(0), wis: score(pb === 6 ? 4 : 3), cha: score(0) },
    // Diamond Soul (14+): proficient in every save
    proficientSaves: level >= 14 ? ["str", "dex", "con", "int", "wis", "cha"] : ["str", "dex"],
    resources: { ki: { max: Math.max(2, level), recharge: "shortRest" } },
    actions: [{
      id: "attack", name: "Flurry of Blows + Stunning Strike", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: strikes }, (_, i) => (
        {
          type: "attack" as const, bonus: pb + dex, onHit: [
            { type: "damage" as const, amount: `1d${die}+${dex}`, damageType: "bludgeoning" as const },
            // first two hits each spend ki to try a Stunning Strike
            ...(i < 2
              ? [{
                  type: "branch" as const, if: "self.resource('ki') > 0",
                  then: [
                    { type: "spendResource" as const, resource: "ki", amount: 1 },
                    { type: "save" as const, ability: "con" as const, dc, onFail: [{ type: "applyCondition" as const, condition: "stunned" as const, durationRounds: 1, saveEnds: { ability: "con" as const, dc, at: "endOfTurn" as const } }] },
                  ],
                }]
              : []),
          ],
        }
      )) }],
    }],
    targetPriority: "lowestHp",
  });
}

// ------------------------------------------------------ feats & magic items

export interface Loadout {
  weaponBonus?: 1 | 2 | 3;   // +X magic weapon / focus: +X to hit and damage on every attack
  saveItem?: 1 | 2 | 3;      // Cloak of Protection, Ioun Stone, etc. -> +X to every save
  acItem?: 1 | 2 | 3;        // Ring of Protection, +X armour
  resilientCon?: boolean;    // Resilient (Con) — proficiency on Con saves
  toughHp?: boolean;         // Tough — +2 HP per level
}

function bumpAttacks(nodes: import("../schema").AutomationNode[], toHit: number, dmg: number): import("../schema").AutomationNode[] {
  return nodes.map((n) => {
    if (n.type === "attack") {
      const onHit = n.onHit.map((h, i) =>
        h.type === "damage" && i === n.onHit.findIndex((x) => x.type === "damage")
          ? { ...h, amount: `${h.amount}+${dmg}` }
          : h,
      );
      return { ...n, bonus: typeof n.bonus === "number" ? n.bonus + toHit : n.bonus, onHit: bumpAttacks(onHit, toHit, dmg) };
    }
    if (n.type === "target") return { ...n, effects: bumpAttacks(n.effects, toHit, dmg) };
    if (n.type === "save") return { ...n, onFail: bumpAttacks(n.onFail, toHit, dmg), onSuccess: n.onSuccess && bumpAttacks(n.onSuccess, toHit, dmg) };
    if (n.type === "branch") return { ...n, then: bumpAttacks(n.then, toHit, dmg), else: n.else && bumpAttacks(n.else, toHit, dmg) };
    return n;
  });
}

/** Apply feats / magic items to a built template. */
export function applyLoadout(c: Combatant, l: Loadout): Combatant {
  let out: Combatant = { ...c };
  if (l.weaponBonus) {
    out = { ...out, actions: out.actions.map((a) => ({ ...a, automation: bumpAttacks(a.automation, l.weaponBonus!, l.weaponBonus!) })) };
  }
  if (l.saveItem) out = { ...out, saveBonusAll: out.saveBonusAll + l.saveItem };
  if (l.acItem) out = { ...out, ac: out.ac + l.acItem };
  if (l.resilientCon && !out.proficientSaves.includes("con")) out = { ...out, proficientSaves: [...out.proficientSaves, "con"] };
  if (l.toughHp && typeof out.maxHp === "number" && out.level) out = { ...out, maxHp: out.maxHp + 2 * out.level };
  return out;
}

const BUILDERS: Record<string, (level: number) => Combatant> = {
  "gwm-fighter": gwmFighter,
  "assassin-rogue": assassinRogue,
  "totem-barbarian": totemBarbarian,
  "open-hand-monk": openHandMonk,
  ...CASTER_BUILDERS,
};

export const TEMPLATE_IDS = Object.keys(BUILDERS);

export function makeTemplate(id: string, level: number, name?: string): Combatant {
  const build = BUILDERS[id];
  if (!build) throw new Error(`unknown PC template "${id}". known: ${TEMPLATE_IDS.join(", ")}`);
  const c = build(Math.max(1, Math.min(20, Math.round(level))));
  if (name) return { ...c, name };
  return c;
}
