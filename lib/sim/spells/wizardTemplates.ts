// The wizard and its published arcane traditions, built from the printed text (dnd5e.wikidot.com/wizard and each tradition's page): the eight
// schools of the Player's Handbook (Abjuration, Conjuration, Divination, Enchantment, Evocation, Illusion, Necromancy, Transmutation), War Magic
// (Xanathar's), Bladesinging and the Order of Scribes (Tasha's), and Chronurgy and Graviturgy (Explorer's Guide to Wildemount).
//
// Base class (the Wizard table): a full caster — Intelligence casting, spells prepared = Intelligence modifier + wizard level, cantrips 3 / 4 / 5
// (levels 1 / 4 / 10), slots per the table; proficient in Intelligence and Wisdom saves only; a d6 hit die. Arcane Recovery (1st): on a short rest,
// once a day, slots totalling up to half the wizard level (rounded up), none above 5th, come back. Spell Mastery (18th): a 1st- and a 2nd-level
// spell cast at their lowest level for free — here Shield and Scorching Ray, one legal choice. Signature Spells (20th): two 3rd-level spells, each
// cast once per rest for free — here Fireball and Hypnotic Pattern. Cantrip Formulas and the spellbook are between-fights bookkeeping.
//
// Build assumptions the books leave open: Intelligence 18 (20 from 17th), Dexterity 14, Constitution 14; Mage Armor is up (AC 13 + Dex); a
// dagger for the odd weapon attack; a Bladesinger has Dexterity 16 (18 from 12th) and a rapier.
//
// Not modeled anywhere: the schools' Savant halved-copying rules and other spellbook features, Minor Conjuration, Benign Transposition, Arcane
// Abeyance, Hypnotic Gaze (it needs an adjacent creature and a spent action each turn), Alter Memories, Malleable Illusions and Illusory Reality,
// Minor Alchemy, Shapechanger, Master Transmuter, Command Undead, Adjust Density, Gravity Well, Manifest Mind, The Third Eye, Improved Abjuration
// (ability checks), and Sculpt Spells (an area spell in this sim never catches an ally, so there is nothing to spare). Overchannel is built for its
// free first use only — the necrotic self-damage of later uses is not.

import type { Action, AutomationNode, Combatant, DamageType } from "../schema";
import { between, pbFor, score } from "../engine/pcBase";
import { makeCaster } from "./caster";
import { spellActions, type CasterCtx } from "./cast";
import { SPELLS_BY_ID } from "./catalog";
import { autoPrepare, preparedCount, type CasterFocus } from "./prepare";
import { maxSlotLevel } from "./slots";
import { baseSpellId, injectAfterFirstDamage, injectFirstDamageBonus, mapNodes, maximizeDamage, potentCantrip } from "./spellTransforms";

const intMod = (level: number) => (pbFor(level) === 6 ? 5 : 4);

/** a light weapon fallback so opportunity attacks and `id:"attack"` lookups resolve */
function weapon(dmg: string, bonus: number, type: DamageType = "piercing"): Action[] {
  return [{
    id: "attack", name: "Weapon", cost: { action: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: type }] }] }],
  }];
}

interface Spec {
  id: string;
  level: number;
  focus?: CasterFocus;
  /** spells always prepared (kept if the wizard has a slot for them) */
  always?: string[];
  dex?: number;
  keepDistance?: boolean;
  targetPriority?: Combatant["ai"]["targetPriority"];
  opener?: string[];
  bonusRoutine?: string[];
  weapon?: Action[];
  actions?: Action[];
  reactions?: Combatant["reactions"];
  traits?: Combatant["traits"];
  rules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  resistances?: DamageType[];
  initiativeBonus?: number;
  /** rewrites every spell Action / reaction (the Action itself says its school and slot level) */
  spells?: (a: Action) => Action;
  /** extra spell variants built from the finished spell list (Overchannel, Split Enchantment) */
  variants?: (spellActs: Action[]) => Action[];
  acBonus?: number;
}

const isSpellAction = (a: Action) => a.isSpell === true;

function chassis(spec: Spec): Combatant {
  const { level } = spec;
  const pb = pbFor(level);
  const int = intMod(level);
  const dex = spec.dex ?? 2;
  const maxSlot = maxSlotLevel("full", level);
  const picked = autoPrepare("wizard", "full", level, int, spec.focus ?? "balanced");
  const budget = preparedCount("wizard", "full", level, int);
  const always = (spec.always ?? []).filter((id) => {
    const sp = SPELLS_BY_ID[id];
    return sp && sp.level <= maxSlot && (sp.build || sp.castTime === "reaction");
  });
  const prepared = [...new Set([...always, ...picked.spells])].slice(0, Math.max(budget, always.length));

  const built = makeCaster({
    id: spec.id, name: `Wizard ${level}`, level, spellClass: "wizard", casterKind: "full", spellAbility: "int",
    ac: 13 + dex + (spec.acBonus ?? 0), hp: between(level, 8, 8 + 19 * 6),
    abilities: { str: score(-1), dex: score(dex), con: score(2), int: score(int), wis: score(1), cha: score(0) },
    proficientSaves: ["int", "wis"],
    prepared, cantrips: picked.cantrips,
    extraActions: [...(spec.weapon ?? weapon(`1d4+${dex}`, pb + dex)), ...(spec.actions ?? [])],
    extraReactions: spec.reactions, extraTraits: spec.traits,
    keepDistance: spec.keepDistance ?? true, targetPriority: spec.targetPriority ?? "lowestHp",
    opener: spec.opener,
  });

  const cc: CasterCtx = { kind: "full", level, pb, spellMod: int };
  const rewrite = spec.spells;
  let actions = rewrite ? built.actions.map((a) => (isSpellAction(a) ? rewrite(a) : a)) : built.actions;
  let reactions = rewrite ? built.reactions.map((a) => (isSpellAction(a) ? rewrite(a) : a)) : built.reactions;
  actions = [...actions, ...(spec.variants ? spec.variants(actions.filter(isSpellAction)) : [])];

  const resources: Combatant["resources"] = { ...built.resources, ...(spec.resources ?? {}) };
  const rules: Combatant["specialRules"] = [...built.specialRules, { rule: "arcaneRecovery" }, ...(spec.rules ?? [])];

  // Spell Mastery (18th): Shield is cast for free; Scorching Ray at 2nd level costs no slot
  if (level >= 18) {
    reactions = reactions.map((r) => (r.id === "shield" ? { ...r, limitedUse: undefined } : r));
    const ray = spellActions(SPELLS_BY_ID["scorching-ray"], cc).find((a) => a.id === "cast-scorching-ray-2");
    if (ray) actions = [...actions, { ...(rewrite ? rewrite(ray) : ray), id: "cast-scorching-ray-mastery", name: "Scorching Ray (Spell Mastery)", limitedUse: undefined }];
  }
  // Signature Spells (20th): two 3rd-level spells, once per short or long rest each, no slot
  if (level >= 20) {
    for (const id of ["fireball", "hypnotic-pattern"]) {
      const a = spellActions(SPELLS_BY_ID[id], cc).find((x) => x.id === `cast-${id}-3`);
      if (!a) continue;
      resources[`signature_${id}`] = { max: 1, recharge: "shortRest" };
      actions = [...actions, { ...(rewrite ? rewrite(a) : a), id: `cast-${id}-signature`, name: `${SPELLS_BY_ID[id].name} (Signature Spell)`, limitedUse: { resource: `signature_${id}`, amount: 1 } }];
    }
  }

  const c: Combatant = {
    ...built, actions, reactions, resources, specialRules: rules,
    resistances: [...built.resistances, ...(spec.resistances ?? [])],
    ...(spec.initiativeBonus !== undefined ? { initiativeBonus: spec.initiativeBonus } : {}),
    ai: { ...built.ai, ...(spec.bonusRoutine ? { bonusRoutine: spec.bonusRoutine } : {}) },
  };
  return c;
}

const reaction = (id: string, name: string, trigger: string, automation: AutomationNode[] = [{ type: "note", text: `${name} (engine hook)` }], limitedUse?: { resource: string; amount: number }): Action => ({
  id, name, cost: { reaction: 1 }, recharge: "none", trigger, automation, ...(limitedUse ? { limitedUse } : {}),
});

/** the spell an Action was built from, when it is a spell */
const spellOf = (a: Action) => SPELLS_BY_ID[baseSpellId(a.id)];

// ------------------------------------------------------------------------------------------------- Abjuration
// Arcane Ward (2nd): casting an abjuration spell of 1st level or higher raises a ward of twice your wizard level + Int hit points (once until a long
// rest), or restores twice the spell's level to it; Mage Armor was cast in the morning, so it starts the day full. The ward takes damage first.
// Projected Ward (6th): a reaction has the ward absorb damage a creature within 30 ft takes. Spell Resistance (14th): advantage on saves against
// spells, resistance to their damage. Improved Abjuration (10th) is about ability checks and isn't modeled.
function abjuration(level: number): Combatant {
  const int = intMod(level);
  const sub = level >= 2;
  const ward = (a: Action): Action => (a.school === "abjuration" && (a.spellLevel ?? 0) >= 1
    ? { ...a, automation: [{ type: "arcaneWard", maxHp: 2 * level + int, slotLevel: a.spellLevel! }, ...a.automation] } : a);
  return chassis({
    id: "abjuration-wizard", level, focus: "balanced", always: ["shield", "counterspell", "absorb-elements"],
    spells: sub ? ward : undefined,
    resources: sub ? { arcane_ward: { max: 1, recharge: "longRest" } } : undefined,
    traits: sub ? [{
      id: "arcane-ward", name: "Arcane Ward", trigger: "encounterStart",
      automation: [{ type: "branch", if: "self.resource('arcane_ward') >= 1", then: [{ type: "arcaneWard", maxHp: 2 * level + int, slotLevel: 1 }] }],
      text: "the ward raised with the morning's Mage Armor",
    }] : undefined,
    reactions: level >= 6 ? [reaction("projected-ward", "Projected Ward", "an ally within 30 ft takes damage")] : undefined,
    rules: level >= 14 ? [{ rule: "spellResistance" }] : undefined,
  });
}

// ----------------------------------------------------------------------------------------------- Conjuration
// Focused Conjuration (10th): damage can't break your concentration on a conjuration spell. Durable Summons (14th): anything you summon or create
// with a conjuration spell has 30 temporary hit points. (Minor Conjuration and Benign Transposition aren't modeled.)
function conjuration(level: number): Combatant {
  const durable = (a: Action): Action => (a.school === "conjuration" && level >= 14
    ? { ...a, automation: mapNodes(a.automation, (n) => (n.type === "summon" ? { ...n, tempHp: "30" } : n)) } : a);
  return chassis({
    id: "conjuration-wizard", level, focus: "controller", always: ["web", "conjure-minor-elementals", "conjure-elemental"],
    spells: level >= 14 ? durable : undefined,
    rules: level >= 10 ? [{ rule: "concentrationImmune", schools: ["conjuration"] }] : undefined,
  });
}

// ------------------------------------------------------------------------------------------------ Divination
// Portent (2nd): after a long rest roll two d20s (three at 14th, Greater Portent) and replace one d20 — yours or a creature's you can see — with a
// foretelling die, once a turn. It is decided before the roll, so a die is spent only where it settles the roll by itself: a die that fails a foe's
// attack on a hurt ally, a foe's saving throw against a control effect, or an ally's save against one. Expert Divination (6th): casting a
// divination spell of 2nd level or higher with a slot regains a slot of a lower level (5th at most). The Third Eye (10th) isn't modeled.
function divination(level: number): Combatant {
  const expert = (a: Action): Action => (a.school === "divination" && (a.spellLevel ?? 0) >= 2 && a.limitedUse
    ? { ...a, automation: [...a.automation, { type: "regainSlot", below: a.spellLevel! }] } : a);
  return chassis({
    id: "divination-wizard", level, focus: "controller", always: ["mind-spike"],
    spells: level >= 6 ? expert : undefined,
    traits: level >= 2 ? [{
      id: "portent", name: "Portent", trigger: "encounterStart",
      automation: [{ type: "portentRoll", dice: level >= 14 ? 3 : 2 }],
      text: "foretelling d20s rolled after a long rest",
    }] : undefined,
    rules: level >= 2 ? [{ rule: "portent" }] : undefined,
  });
}

// ----------------------------------------------------------------------------------------------- Enchantment
// Instinctive Charm (6th): a reaction when a creature attacks you — a Wisdom save, and on a failure it must attack the creature closest to it
// instead (not you); once per attacker until a long rest. Split Enchantment (10th): an enchantment spell of 1st level or higher that targets only one
// creature can target a second. Hypnotic Gaze (2nd) and Alter Memories (14th) aren't modeled.
function enchantment(level: number): Combatant {
  return chassis({
    id: "enchantment-wizard", level, focus: "controller", always: ["hold-person", "hold-monster"],
    reactions: level >= 6 ? [reaction("instinctive-charm", "Instinctive Charm", "a creature attacks you")] : undefined,
    variants: level >= 10 ? (spells) => spells.flatMap((a): Action[] => {
      const top = a.automation[0];
      if (a.school !== "enchantment" || !a.limitedUse || (a.spellLevel ?? 0) < 1 || top?.type !== "target") return [];
      // "targets only one creature": a single-target pick, or a multi-target spell at the level where it still has just one (Hold Person cast at 2nd)
      const single = top.who.who === "aiChoice" || (top.who.who === "chosenEnemies" && top.who.upTo === 1);
      if (!single) return [];
      return [{ ...a, id: `${a.id}-split`, name: `${a.name} (Split Enchantment)`, automation: [{ ...top, who: { who: "chosenEnemies", upTo: 2 } }, ...a.automation.slice(1)] }];
    }) : undefined,
  });
}

// ------------------------------------------------------------------------------------------------- Evocation
// Sculpt Spells (2nd) would spare allies — an area spell never catches one here. Potent Cantrip (6th): a creature that succeeds on its save against
// your cantrip still takes half its damage. Empowered Evocation (10th): + Int to one damage roll of a wizard evocation spell. Overchannel (14th):
// a wizard spell of 1st-5th level that deals damage can deal maximum damage — built for the free first use (once until a long rest).
function evocation(level: number): Combatant {
  const int = intMod(level);
  const spells = (a: Action): Action => {
    let out = a;
    if (level >= 6 && (a.spellLevel ?? 0) === 0) out = { ...out, automation: potentCantrip(out.automation) };
    if (level >= 10 && a.school === "evocation" && spellOf(a)?.role === "damage") {
      const { nodes, applied } = injectFirstDamageBonus(out.automation, int);
      if (applied) out = { ...out, automation: nodes };
    }
    return out;
  };
  return chassis({
    id: "blaster-wizard", level, focus: "blaster", targetPriority: "squishiest",
    spells: level >= 6 ? spells : undefined,
    resources: level >= 14 ? { overchannel: { max: 1, recharge: "longRest" } } : undefined,
    variants: level >= 14 ? (spellActs) => spellActs.flatMap((a): Action[] => {
      const lvl = a.spellLevel ?? 0;
      if (lvl < 1 || lvl > 5 || !a.limitedUse || spellOf(a)?.role !== "damage") return [];
      return [{
        ...a, id: `${a.id}-overchannel`, name: `${a.name} (Overchannel)`,
        automation: [{ type: "branch", if: "self.resource('overchannel') >= 1", then: [{ type: "spendResource", resource: "overchannel", amount: 1 }, ...maximizeDamage(a.automation)] }],
      }];
    }) : undefined,
  });
}

// ------------------------------------------------------------------------------------------------- Illusion
// Illusory Self (10th): a reaction — an attack against you automatically misses; once per short or long rest. Improved Minor Illusion (2nd),
// Malleable Illusions (6th) and Illusory Reality (14th) have no combat form here.
function illusion(level: number): Combatant {
  return chassis({
    id: "illusion-wizard", level, focus: "controller", always: ["mirror-image", "hypnotic-pattern", "greater-invisibility"],
    reactions: level >= 10 ? [reaction("illusory-self", "Illusory Self", "a creature attacks you", undefined, { resource: "illusory_self", amount: 1 })] : undefined,
    resources: level >= 10 ? { illusory_self: { max: 1, recharge: "shortRest" } } : undefined,
  });
}

// ----------------------------------------------------------------------------------------------- Necromancy
// Grim Harvest (2nd): killing a creature with a spell of 1st level or higher heals twice the spell's level (three times for a necromancy spell),
// not for constructs or undead. Undead Thralls (6th): Animate Dead is in the spellbook and raises one more corpse; anything a necromancy spell
// raises has extra hit points equal to your wizard level and adds your proficiency bonus to weapon damage. Inured to Undeath (10th): resistance to
// necrotic damage (the hit point maximum can't be reduced isn't modeled). Command Undead (14th) isn't modeled.
function necromancy(level: number): Combatant {
  const pb = pbFor(level);
  const thralls = (a: Action): Action => (a.school === "necromancy" && level >= 6
    ? { ...a, automation: mapNodes(a.automation, (n) => (n.type === "summon"
      ? { ...n, hpBonus: level, damageBonus: pb, ...(baseSpellId(a.id) === "animate-dead" ? { count: String(Number(n.count) + 1) } : {}) } : n)) } : a);
  return chassis({
    id: "necromancy-wizard", level, focus: "balanced", always: level >= 6 ? ["animate-dead", "vampiric-touch"] : ["vampiric-touch"],
    spells: level >= 6 ? thralls : undefined,
    rules: level >= 2 ? [{ rule: "grimHarvest" }] : undefined,
    resistances: level >= 10 ? ["necrotic"] : undefined,
  });
}

// -------------------------------------------------------------------------------------------- Transmutation
// Transmuter's Stone (6th): built as the Constitution saving throw proficiency (the choice that keeps a concentration spell up). Minor Alchemy (2nd),
// Shapechanger (10th) and Master Transmuter (14th) have no combat form here.
function transmutation(level: number): Combatant {
  const c = chassis({ id: "transmutation-wizard", level, focus: "balanced", always: ["slow"] });
  return level >= 6 ? { ...c, proficientSaves: [...c.proficientSaves, "con"] } : c;
}

// ------------------------------------------------------------------------------------------------ War Magic
// Arcane Deflection (2nd): a reaction when hit by an attack or failing a save — +2 AC against that attack, or +4 to that save — and nothing but
// cantrips until the end of your next turn; used here when it turns a near-miss into a miss while hurt, or rescues a control save. Tactical Wit (2nd):
// Int to initiative. Power Surge (6th): surges up to your Int modifier (one after each long rest; one for each Counterspell you succeed with, and one
// if you end a short rest with none) — once a turn, a surge adds force damage equal to half your wizard level to damage from a wizard spell (here:
// the damage that lands on a failed save or a hit). Durable Magic (10th): +2 AC and saves while concentrating. Deflecting Shroud (14th): with
// Arcane Deflection, up to three creatures within 60 ft take force damage equal to half your level.
function warMagic(level: number): Combatant {
  const int = intMod(level);
  const half = Math.floor(level / 2);
  const surge = (a: Action): Action => {
    const extra: AutomationNode[] = [{
      type: "branch", if: "self.hasnt('surged')", then: [{
        type: "branch", if: "self.resource('power_surge') >= 1", then: [
          { type: "spendResource", resource: "power_surge", amount: 1 },
          { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "surged", mods: { untilSourceNextTurn: true } }] }, // once a turn: the mark is on the wizard
          { type: "damage", amount: String(half), damageType: "force" },
        ],
      }],
    }];
    const { nodes, applied } = injectAfterFirstDamage(a.automation, extra);
    return applied ? { ...a, automation: nodes } : a;
  };
  return chassis({
    id: "war-magic-wizard", level, focus: "blaster", targetPriority: "squishiest", always: ["counterspell", "shield"],
    initiativeBonus: level >= 2 ? 2 + int : undefined,
    spells: level >= 6 ? surge : undefined,
    reactions: level >= 2 ? [reaction("arcane-deflection", "Arcane Deflection", "you are hit by an attack or fail a saving throw", [
      { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "deflection-lockout", durationRounds: 2, mods: { cantripsOnly: true } }] },
      ...(level >= 14 ? [{ type: "target" as const, who: { who: "chosenEnemies" as const, upTo: 3, withinFt: 60 }, effects: [{ type: "damage" as const, amount: String(half), damageType: "force" as const }] }] : []),
    ])] : undefined,
    resources: level >= 6 ? { power_surge: { max: Math.max(1, int), recharge: "longRest", start: 1 } } : undefined,
    rules: [
      ...(level >= 6 ? [{ rule: "surgeOnCounter" as const, resource: "power_surge" }] : []),
      ...(level >= 10 ? [{ rule: "durableMagic" as const, bonus: 2 }] : []),
    ],
  });
}

// ---------------------------------------------------------------------------------------------- Bladesinging
// Bladesong (2nd): a bonus action for a minute — AC + Int, +10 ft speed, + Int to concentration saves — proficiency-bonus times per long rest. Extra Attack
// (6th): two attacks, or one attack and a cantrip (Shocking Grasp here) in place of the other. Song of Defense (10th): a reaction and a spell slot
// cut damage by five times the slot's level while the Bladesong is up. Song of Victory (14th): + Int to melee weapon damage while it is up.
function bladesinging(level: number): Combatant {
  const pb = pbFor(level);
  const int = intMod(level);
  const dex = level >= 12 ? 4 : 3;
  const dc = 8 + pb + int;
  const sub = level >= 2;
  const rapier = (): AutomationNode => {
    const hit = (bonus: number): AutomationNode => ({ type: "attack", bonus: pb + dex, onHit: [{ type: "damage", amount: `1d8+${dex + bonus}`, damageType: "piercing", weaponDice: true }] });
    return level >= 14 ? { type: "branch", if: "self.has('bladesong')", then: [hit(int)], else: [hit(0)] } : hit(0);
  };
  const cantrip = (): AutomationNode[] => {
    const nodes = SPELLS_BY_ID["shocking-grasp"].build!({ slotLevel: 0, casterLevel: level, spellMod: int, dc, toHit: pb + int, pb });
    const top = nodes[0];
    return top.type === "target" ? top.effects : nodes;
  };
  const swings = level >= 6 ? 2 : 1;
  const attackActs: Action[] = [
    { id: "attack", name: "Rapier", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: swings }, rapier) }] },
    ...(level >= 6 ? [{
      id: "attack-cantrip", name: "Rapier + Shocking Grasp", cost: { action: 1 }, recharge: "none" as const,
      automation: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [rapier(), ...cantrip()] }],
    }] : []),
  ];
  const c = chassis({
    id: "bladesinging-wizard", level, focus: "balanced", dex, keepDistance: false, targetPriority: "lowestHp",
    weapon: attackActs,
    opener: sub ? ["bladesong"] : undefined, bonusRoutine: sub ? ["bladesong"] : undefined,
    actions: sub ? [{
      id: "bladesong", name: "Bladesong", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "bladesong", amount: 1 },
      automation: [{ type: "branch", if: "self.hasnt('bladesong')", then: [{ type: "target", who: { who: "self" }, effects: [
        { type: "applyEffect", name: "bladesong", durationRounds: 10, mods: { acBonus: int, speedBonusFt: 10, concentrationSaveBonus: int } },
      ] }] }],
    }] : undefined,
    resources: sub ? { bladesong: { max: pb, recharge: "longRest" } } : undefined,
    reactions: level >= 10 ? [reaction("song-of-defense", "Song of Defense", "you take damage while your Bladesong is up")] : undefined,
  });
  return c;
}

// --------------------------------------------------------------------------------------- Order of Scribes
// Awakened Spellbook (2nd): a spell cast with a slot can swap its damage type for another the wizard knows — used against a resistance or
// immunity (the same-level condition is relaxed to the common types). Master Scrivener (10th): a scroll of a 1st- or 2nd-level spell, one level
// higher than normal, once per long rest (Scorching Ray, cast as 3rd level). One with the Word (14th): once a day, damage that would drop you to 0
// is negated, and you lose 3d6 levels of spells for it (taken from the highest slots). Manifest Mind (6th) is positioning and isn't modeled.
function scribes(level: number): Combatant {
  const pb = pbFor(level);
  const int = intMod(level);
  const ray = SPELLS_BY_ID["scorching-ray"];
  return chassis({
    id: "scribes-wizard", level, focus: "blaster", targetPriority: "squishiest",
    actions: level >= 10 ? [{
      id: "cast-scorching-ray-scroll", name: "Scorching Ray (3rd-level scroll)", cost: { action: 1 }, recharge: "none", isSpell: true, ranged: true,
      school: "evocation", spellLevel: 3, limitedUse: { resource: "master_scrivener", amount: 1 },
      automation: ray.build!({ slotLevel: 3, casterLevel: level, spellMod: int, dc: 8 + pb + int, toHit: pb + int, pb }),
    }] : undefined,
    resources: { ...(level >= 10 ? { master_scrivener: { max: 1, recharge: "longRest" as const } } : {}), ...(level >= 14 ? { one_with_the_word: { max: 1, recharge: "longRest" as const } } : {}) },
    rules: [
      ...(level >= 2 ? [{ rule: "spellbookSwap" as const, types: ["fire", "cold", "lightning", "acid", "thunder", "force", "necrotic", "poison", "psychic", "radiant"] as DamageType[] }] : []),
      ...(level >= 14 ? [{ rule: "negateLethalDamage" as const, resource: "one_with_the_word" }] : []),
    ],
  });
}

// ------------------------------------------------------------------------------------------------- Chronurgy
// Chronal Shift (2nd): twice per long rest, a reaction makes a creature within 30 ft reroll an attack roll or saving throw. Temporal Awareness (2nd):
// Int to initiative. Momentary Stasis (6th): an action — a Large or smaller creature makes a Constitution save or is incapacitated with 0 speed until
// the end of your next turn; Int modifier uses per long rest. Convergent Future (14th): a reaction to ignore a roll (treated as the least that would
// succeed, or one below), at a level of exhaustion — kept for a hit that could finish an ally or a save that would take a creature out of the fight,
// and never past the second level. Arcane Abeyance (10th) isn't modeled.
function chronurgy(level: number): Combatant {
  const pb = pbFor(level);
  const int = intMod(level);
  const dc = 8 + pb + int;
  return chassis({
    id: "chronurgy-wizard", level, focus: "controller", always: ["counterspell", "shield"],
    initiativeBonus: level >= 2 ? 2 + int : undefined,
    reactions: [
      ...(level >= 2 ? [reaction("chronal-shift", "Chronal Shift", "a creature within 30 ft makes an attack roll or saving throw", undefined, { resource: "chronal_shift", amount: 1 })] : []),
      ...(level >= 14 ? [reaction("convergent-future", "Convergent Future", "a creature within 60 ft makes an attack roll or saving throw")] : []),
    ],
    actions: level >= 6 ? [{
      id: "momentary-stasis", name: "Momentary Stasis", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "momentary_stasis", amount: 1 },
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "branch", if: "target.size<=large", then: [{
        type: "save", ability: "con", dc,
        onFail: [{ type: "applyCondition", condition: "incapacitated", durationRounds: 1 }, { type: "applyEffect", name: "stasis", durationRounds: 1, mods: { speedZero: true } }],
      }] }] }],
    }] : undefined,
    resources: {
      ...(level >= 2 ? { chronal_shift: { max: 2, recharge: "longRest" as const } } : {}),
      ...(level >= 6 ? { momentary_stasis: { max: Math.max(1, int), recharge: "longRest" as const } } : {}),
    },
  });
}

// ------------------------------------------------------------------------------------------------ Graviturgy
// Violent Attraction (10th): a reaction adds 1d10 (of the weapon's type) to a weapon hit by a creature within 60 ft; Int modifier uses per long rest.
// Event Horizon (14th): an action, concentration — hostile creatures within 30 ft make a Strength save or take 2d10 force damage and are slowed to
// a stop, and again as their turns come round (half here); once per long rest, or by spending a 3rd-level slot. Adjust Density (2nd) and Gravity Well
// (6th) aren't modeled.
function graviturgy(level: number): Combatant {
  const pb = pbFor(level);
  const int = intMod(level);
  const dc = 8 + pb + int;
  const horizon = (id: string, name: string, limitedUse: { resource: string; amount: number }): Action => ({
    id, name, cost: { action: 1 }, recharge: "none", concentration: true, limitedUse,
    automation: [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [
      { type: "save", ability: "str", dc,
        onFail: [{ type: "damage", amount: "2d10", damageType: "force" }, { type: "applyEffect", name: "event-horizon-slow", durationRounds: 1, mods: { speedZero: true } }],
        onSuccess: [{ type: "damage", amount: "2d10", damageType: "force", half: true }] },
      { type: "applyEffect", name: "event-horizon", durationRounds: 10, tick: [{ type: "damage", amount: "2d10", damageType: "force", half: true }] },
    ] }],
  });
  return chassis({
    id: "graviturgy-wizard", level, focus: "blaster", targetPriority: "squishiest",
    reactions: level >= 10 ? [reaction("violent-attraction", "Violent Attraction", "a creature within 60 ft hits with a weapon attack", undefined, { resource: "violent_attraction", amount: 1 })] : undefined,
    actions: level >= 14 ? [horizon("event-horizon", "Event Horizon", { resource: "event_horizon", amount: 1 }), horizon("event-horizon-slot", "Event Horizon (3rd-level slot)", { resource: "slot3", amount: 1 })] : undefined,
    resources: {
      ...(level >= 10 ? { violent_attraction: { max: Math.max(1, int), recharge: "longRest" as const } } : {}),
      ...(level >= 14 ? { event_horizon: { max: 1, recharge: "longRest" as const } } : {}),
    },
  });
}

export const WIZARD_BUILDERS: Record<string, (level: number) => Combatant> = {
  "abjuration-wizard": abjuration,
  "conjuration-wizard": conjuration,
  "divination-wizard": divination,
  "enchantment-wizard": enchantment,
  "blaster-wizard": evocation,
  "illusion-wizard": illusion,
  "necromancy-wizard": necromancy,
  "transmutation-wizard": transmutation,
  "war-magic-wizard": warMagic,
  "bladesinging-wizard": bladesinging,
  "scribes-wizard": scribes,
  "chronurgy-wizard": chronurgy,
  "graviturgy-wizard": graviturgy,
};
