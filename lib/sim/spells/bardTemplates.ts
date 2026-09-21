// The bard and its eight colleges, built from the printed text (dnd5e.wikidot.com/bard and each college's page): Lore and Valor (Player's Handbook), Glamour, Swords and Whispers (Xanathar's),
// Creation and Eloquence (Tasha's) and Spirits (Van Richten's).
//
// Base class (the Bard table): a full caster — Charisma casting, spells KNOWN 4 rising to 22 (Magical Secrets' spells are among them), cantrips 2 / 3 / 4, slots per the full-caster table; proficient
// in Dexterity and Charisma saves; a d8 hit die; light armor. Bardic Inspiration (1st): a bonus action gives one creature (not the bard) within 60 feet a die — d6, d8 from 5th, d10 from 10th, d12 from 15th —
// that it can add after seeing the roll to an attack roll or saving throw (ability checks aren't modeled); Charisma-modifier uses, back on a LONG rest until Font of Inspiration (5th) makes it a short
// one. Jack of All Trades (2nd: half the proficiency bonus on initiative), Song of Rest (2nd: an extra die of healing on a short rest, d6 / d8 / d10 / d12 at 2nd / 9th / 13th / 17th), Countercharm
// (6th), Magical Secrets (10th, 14th, 18th: two spells from any class each time) and Superior Inspiration (20th: a use back when initiative is rolled with none left).
//
// Build assumptions the books leave open: Charisma 18 (20 from 17th), Dexterity 14, Constitution 14; studded leather (AC 14), and a rapier; Valor takes scale mail and a shield (AC 18) and Swords scale
// mail (AC 16) from the 3rd level; the Magical Secrets are Counterspell, Fireball, Wall of Force, Cone of Cold, Chain Lightning and Spirit Guardians (and Eldritch Blast as a cantrip); a bard AI keeps
// one use of Bardic Inspiration back for its college feature.
//
// Not modeled anywhere: ability checks (so Expertise, Jack of All Trades on checks, Peerless Skill, Silver Tongue, Mote of Potential's re-roll and Tale of the Clever Animal do nothing), Bonus
// Proficiencies, Performance of Creation and Creative Crescendo (objects), Enthralling Performance and Words of Terror (they need a minute of performance or private talk before the fight), Mantle of
// Whispers, Universal Speech, Spirit Session, Guiding Whispers. The catalog has automation for only one bard cantrip (Vicious Mockery). Known approximations: Defensive Flourish adds the average of the
// die to armor class, not the number rolled; Slashing Flourish reaches one other creature, not every one within 5 feet; Mobile Flourish's follow-up movement isn't taken; Mantle of Inspiration's
// reaction move isn't taken; a tale told to a friend (Avenger, Traveler) goes to the sturdiest ally; Tale of the Renowned Duelist is a ranged spell attack; Mystical Connection is "the better of two
// rolls"; Combat Inspiration keeps the die for armor class while its holder is under half its hit points.

import type { Action, AutomationNode, Combatant, EffectMods } from "../schema";
import { between, pbFor, score } from "../engine/pcBase";
import { dancingItemFor } from "../engine/minions";
import { bardicDieSides } from "../engine/reactions";
import { makeCaster } from "./caster";
import { SPELLS_BY_ID } from "./catalog";
import { cantripsKnown, preparedCount } from "./prepare";
import { maxSlotLevel } from "./slots";
import { mapNodes } from "./spellTransforms";

const chaMod = (level: number) => (pbFor(level) === 6 ? 5 : 4);
const DEX = 2;
const CON = 2;

export type College = "lore" | "valor" | "glamour" | "swords" | "whispers" | "creation" | "eloquence" | "spirits";

// the spells a bard builds its list around, best first; Magical Secrets' spells (from any class) take the last places
const BARD_CORE = ["healing-word", "faerie-fire", "dissonant-whispers", "cure-wounds", "tashas-hideous-laughter", "heroism", "sleep", "bane", "thunderwave", "hold-person", "shatter", "invisibility",
  "suggestion", "hypnotic-pattern", "fear", "dispel-magic", "bestow-curse", "greater-invisibility", "polymorph", "confusion", "dimension-door", "compulsion", "hold-monster", "animate-objects",
  "mass-cure-wounds", "dominate-person", "mass-suggestion", "eyebite", "heroes-feast", "forcecage", "regenerate", "mordenkainens-sword", "dominate-monster", "power-word-stun", "feeblemind",
  "power-word-kill", "psychic-scream", "foresight", "power-word-heal", "true-polymorph", "calm-emotions", "cloud-of-daggers", "crown-of-madness", "phantasmal-force", "blindness-deafness", "heat-metal",
  "charm-person", "stinking-cloud", "charm-monster"];
const SECRET_CANTRIPS = ["eldritch-blast", "fire-bolt"];
const SECRETS = ["counterspell", "fireball", "wall-of-force", "cone-of-cold", "chain-lightning", "spirit-guardians", "haste", "conjure-elemental"];

const castable = (id: string, maxLevel: number) => {
  const sp = SPELLS_BY_ID[id];
  return !!sp && sp.level > 0 && sp.level <= maxLevel && (!!sp.build || sp.castTime === "reaction");
};

interface Spec {
  college: College;
  level: number;
  ac?: number;
  /** Extra Attack (6th) */
  extraAttack?: boolean;
  weapon?: { name: string; die: string; bonus: number; type: "piercing" | "slashing" };
  /** extra spells from any class that don't count against spells known (Lore, 6th) */
  loreSecrets?: number;
  actions?: Action[];
  reactions?: Combatant["reactions"];
  traits?: Combatant["traits"];
  rules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  /** mods carried on every Bardic Inspiration die the bard gives (Valor, Eloquence, Creation) */
  inspirationMods?: EffectMods;
  /** the uses of Bardic Inspiration the AI keeps back from granting dice, for the college's own features */
  reserve?: number;
  spells?: (a: Action) => Action;
  bonusRoutine?: string[];
  bonusAfterSpell?: string[];
  opener?: string[];
  /** builds the attack action(s) beyond the plain weapon, given the plain swing builder */
  variants?: (swing: (riders?: AutomationNode[], firstRiders?: AutomationNode[]) => AutomationNode[]) => Action[];
  keepDistance?: boolean;
}

const plusDie = (amount: string, die: string) => `${amount}+${die}`;

function build(spec: Spec): Combatant {
  const { level } = spec;
  const pb = pbFor(level);
  const cha = chaMod(level);
  const dc = 8 + pb + cha;
  const sides = bardicDieSides(level);
  const maxSlot = maxSlotLevel("full", level);
  const college = level >= 3;

  // ---- spells known: the class table's number, with Magical Secrets among them (Lore's extra pair from the 6th on top)
  const budget = preparedCount("bard", "full", level, cha);
  const counted = (level >= 10 ? 2 : 0) + (level >= 14 ? 2 : 0) + (level >= 18 ? 2 : 0);
  const secretPool = SECRETS.filter((id) => castable(id, maxSlot));
  const loreExtra = spec.loreSecrets && level >= 6 ? secretPool.slice(0, spec.loreSecrets) : [];
  const secretCantrip = level >= 10 ? SECRET_CANTRIPS.find((id) => !!SPELLS_BY_ID[id]?.build) : undefined;
  // (the cantrip is one of the first pair; the rest are leveled spells)
  const secrets = secretPool.filter((id) => !loreExtra.includes(id)).slice(0, Math.max(0, counted - (secretCantrip ? 1 : 0)));
  const core = BARD_CORE.filter((id) => castable(id, maxSlot) && !secrets.includes(id) && !loreExtra.includes(id));
  const known = [...new Set([...core.slice(0, Math.max(0, budget - secrets.length - (secretCantrip ? 1 : 0))), ...secrets, ...loreExtra])];
  const cantrips = ["vicious-mockery"].filter((id) => !!SPELLS_BY_ID[id]?.build).slice(0, cantripsKnown("bard", level));
  if (secretCantrip) cantrips.push(secretCantrip);

  // ---- the weapon
  const w = spec.weapon ?? { name: "Rapier", die: "1d8", bonus: 0, type: "piercing" as const };
  const swing = (riders: AutomationNode[] = [], firstRiders: AutomationNode[] = []): AutomationNode[] => {
    const one = (first: boolean): AutomationNode => ({
      type: "attack", bonus: pb + DEX,
      onHit: [{ type: "damage", amount: `${w.die}+${DEX + w.bonus}`, damageType: w.type }, ...riders, ...(first ? firstRiders : [])],
    });
    return [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: spec.extraAttack && level >= 6 ? 2 : 1 }, (_, i) => one(i === 0)) }];
  };
  const attack: Action = { id: "attack", name: w.name, cost: { action: 1 }, recharge: "none", automation: swing() };

  // ---- Bardic Inspiration: a die for the sturdiest ally that hasn't one, keeping `reserve` uses back
  const inspiration: EffectMods = { inspirationDie: `1d${sides}`, inspirationDc: dc, inspirationCha: cha, ...(spec.inspirationMods ?? {}) };
  const reserve = spec.reserve ?? 0;
  const grant: Action = {
    id: "bardic-inspiration", name: "Bardic Inspiration", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "bardic_inspiration", amount: 1 },
    automation: [{ type: "branch", if: `self.can_inspire(${reserve})`, then: [{
      type: "target", who: { who: "eachAlly", limit: 1, excludeSelf: true }, filter: { notEffects: ["bardic-inspiration"] },
      effects: [{ type: "applyEffect", name: "bardic-inspiration", durationRounds: 100, mods: inspiration }],
    }] }],
  };
  const resources: NonNullable<Combatant["resources"]> = { bardic_inspiration: { max: Math.max(1, cha), recharge: level >= 5 ? "shortRest" : "longRest" }, ...(spec.resources ?? {}) };

  const actions: Action[] = [attack, grant];
  const reactions: Combatant["reactions"] = [...(spec.reactions ?? [])];
  const traits: NonNullable<Combatant["traits"]> = [...(spec.traits ?? [])];
  const rules: NonNullable<Combatant["specialRules"]> = [...(spec.rules ?? [])];
  const bonusRoutine: string[] = ["bardic-inspiration", ...(spec.bonusRoutine ?? [])]; // dice for the allies first, then the college's own bonus actions
  const opener = [...(spec.opener ?? [])];

  if (spec.variants && college) actions.push(...spec.variants(swing));
  actions.push(...(spec.actions ?? []));

  // Song of Rest (2nd)
  if (level >= 2) rules.push({ rule: "songOfRest", faces: level >= 17 ? 12 : level >= 13 ? 10 : level >= 9 ? 8 : 6 });

  // Countercharm (6th): "you and any friendly creatures within 30 feet of you have advantage on saving throws against being frightened or charmed" until the end of the next turn — worth an action
  // when a foe has such an effect, and taken on the first round
  if (level >= 6) {
    actions.push({
      id: "countercharm", name: "Countercharm", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "branch", if: "any_enemy.imposes('frightened|charmed')", then: [{
        type: "target", who: { who: "eachAlly", withinFt: 30 }, effects: [{ type: "applyEffect", name: "countercharm", durationRounds: 1, mods: { saveAdvantageAgainst: ["frightened", "charmed"], untilSourceNextTurn: true } }],
      }] }],
    });
    opener.push("countercharm");
  }

  // Superior Inspiration (20th): rolling initiative with none left gives one back
  if (level >= 20) {
    traits.push({ id: "superior-inspiration", name: "Superior Inspiration", trigger: "encounterStart", automation: [{
      type: "branch", if: "self.resource('bardic_inspiration') >= 1", then: [], else: [{ type: "spendResource", resource: "bardic_inspiration", amount: -1 }],
    }] });
  }

  // Spiritual Focus (Spirits, 6th) rides on every damage or healing spell: a d6 on one roll
  const spells = spec.spells;
  const built = makeCaster({
    id: `${spec.college}-bard`, name: `Bard ${level}`, level, spellClass: "bard", casterKind: "full", spellAbility: "cha",
    ac: spec.ac ?? 14, hp: between(level, 10, 10 + 19 * 7),
    abilities: { str: score(0), dex: score(DEX), con: score(CON), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["dex", "cha"],
    prepared: known, cantrips,
    extraActions: actions, extraReactions: reactions, extraTraits: traits,
    keepDistance: spec.keepDistance ?? true, targetPriority: "squishiest", opener,
  });
  const rewrite = (a: Action): Action => (spells && a.isSpell ? spells(a) : a);
  return {
    ...built,
    actions: built.actions.map(rewrite),
    reactions: built.reactions.map(rewrite),
    resources: { ...built.resources, ...resources },
    specialRules: [...built.specialRules, ...rules],
    initiativeBonus: level >= 2 ? DEX + Math.floor(pb / 2) : DEX, // Jack of All Trades: half the proficiency bonus, rounded down, on the initiative check
    ai: { ...built.ai, bonusRoutine: [...new Set(bonusRoutine)], ...(spec.bonusAfterSpell ? { bonusAfterSpell: spec.bonusAfterSpell } : {}) },
  };
}

/** a bonus-action or reaction cost, spent from Bardic Inspiration */
const spendBI = { resource: "bardic_inspiration", amount: 1 } as const;
/** the AI keeps this many uses of Bardic Inspiration back from a college feature that spends them every turn it can (the rest go to giving allies dice) */
const keep = (over: number) => ({ resourceAbove: { resource: "bardic_inspiration", over } });
const avgDie = (sides: number) => Math.floor((sides + 1) / 2);

// ------------------------------------------------------------------------------------------------------------------------------------- Lore
// Cutting Words (3rd): a reaction, a Bardic Inspiration use — subtract the die from an attack roll or a damage roll of a creature within 60 feet. Additional Magical Secrets (6th): two spells from any
// class, on top of the known total. Peerless Skill (14th) is for ability checks.
function lore(level: number): Combatant {
  return build({
    college: "lore", level, loreSecrets: 2, reserve: 1,
    reactions: level >= 3 ? [{
      id: "cutting-words", name: "Cutting Words", cost: { reaction: 1 }, recharge: "none", trigger: "ally.aboutToBeHitByAttack", limitedUse: spendBI,
      automation: [{ type: "note", text: "subtracts a Bardic Inspiration die from the triggering attack or damage roll (engine hook)" }],
    }] : undefined,
  });
}

// ----------------------------------------------------------------------------------------------------------------------------------- Valor
// Bonus Proficiencies (3rd): medium armor, shields, martial weapons. Combat Inspiration (3rd): a creature with your die can add it to a weapon damage roll it just made, or to its AC against an attack as a
// reaction. Extra Attack (6th). Battle Magic (14th): when you use your action to cast a bard spell, a weapon attack as a bonus action.
function valor(level: number): Combatant {
  const pb = pbFor(level);
  const swing1 = (): AutomationNode[] => [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb + DEX, onHit: [{ type: "damage", amount: `1d8+${DEX}`, damageType: "piercing" }] }] }];
  return build({
    college: "valor", level, ac: level >= 3 ? 18 : 14, extraAttack: true, reserve: 0, keepDistance: level < 3,
    inspirationMods: level >= 3 ? { combatInspiration: true } : undefined,
    actions: level >= 14 ? [{ id: "battle-magic", name: "Battle Magic (weapon attack)", cost: { bonus: 1 }, recharge: "none", automation: swing1() }] : undefined,
    bonusAfterSpell: level >= 14 ? ["battle-magic"] : undefined,
  });
}

// --------------------------------------------------------------------------------------------------------------------------------- Glamour
// Mantle of Inspiration (3rd): a bonus action and a use of Bardic Inspiration — up to Charisma-modifier creatures within 60 feet gain temporary hit points (5, 8 at 5th, 11 at 10th, 14 at 15th). Mantle of
// Majesty (6th): a bonus action, once a long rest — for a minute (concentration) Command as a bonus action each turn without a slot. Unbreakable Majesty (14th): a bonus action, once a short rest —
// for a minute, the first attack against you each turn needs a Charisma save. Enthralling Performance (3rd) needs a minute of performance first: not modeled.
function glamour(level: number): Combatant {
  const cha = chaMod(level);
  const temp = level >= 15 ? 14 : level >= 10 ? 11 : level >= 5 ? 8 : 5;
  const dc = 8 + pbFor(level) + cha;
  const command = SPELLS_BY_ID["command"];
  const commandNodes = command?.build ? command.build({ casterLevel: level, spellMod: cha, pb: pbFor(level), dc, toHit: pbFor(level) + cha, slotLevel: 1 }) : [];
  const actions: Action[] = [];
  const routine: string[] = [];
  const resources: NonNullable<Combatant["resources"]> = {};
  if (level >= 3) {
    actions.push({
      id: "mantle-of-inspiration", name: "Mantle of Inspiration", cost: { bonus: 1 }, recharge: "none", limitedUse: spendBI, usableWhen: keep(1),
      automation: [{ type: "branch", if: "self.hasnt('mantle-of-inspiration')", then: [
        { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "mantle-of-inspiration", durationRounds: 100 }] },
        { type: "target", who: { who: "eachAlly", limit: Math.max(1, cha) }, effects: [{ type: "tempHp", amount: String(temp) }] },
      ] }],
    });
    routine.push("mantle-of-inspiration");
  }
  if (level >= 6) {
    resources.mantle_of_majesty = { max: 1, recharge: "longRest" };
    actions.push({
      id: "mantle-of-majesty", name: "Mantle of Majesty", cost: { bonus: 1 }, recharge: "none", concentration: true, limitedUse: { resource: "mantle_of_majesty", amount: 1 },
      automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "mantle-of-majesty", durationRounds: 10 }] }],
    }, {
      id: "command-majesty", name: "Command (Mantle of Majesty)", cost: { bonus: 1 }, recharge: "none", isSpell: true, school: "enchantment", spellLevel: 1,
      automation: [{ type: "branch", if: "self.has('mantle-of-majesty')", then: commandNodes }],
    });
    routine.unshift("command-majesty");
    routine.push("mantle-of-majesty");
  }
  if (level >= 14) {
    resources.unbreakable_majesty = { max: 1, recharge: "shortRest" };
    actions.push({
      id: "unbreakable-majesty", name: "Unbreakable Majesty", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "unbreakable_majesty", amount: 1 },
      automation: [{ type: "branch", if: "self.hasnt('unbreakable-majesty')", then: [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "unbreakable-majesty", durationRounds: 10, mods: { inspirationDc: dc } }] }] }],
    });
    routine.push("unbreakable-majesty");
  }
  return build({ college: "glamour", level, reserve: 1, actions, resources, bonusRoutine: routine });
}

// ---------------------------------------------------------------------------------------------------------------------------------- Swords
// Bonus Proficiencies (3rd): medium armor and the scimitar, a melee weapon as a spellcasting focus. Fighting Style (3rd): Dueling (+2 to damage with one melee weapon). Blade Flourish (3rd): when you take
// the Attack action your walking speed is 10 feet more, and if a weapon attack hits you may use ONE flourish that turn, each spending a Bardic Inspiration use: Defensive (the die as extra damage, and its
// number added to your AC until the start of your next turn), Slashing (the die as extra damage to the target and to another creature near you) and Mobile (the die as extra damage, and the target pushed
// 5 feet plus the number rolled). Extra Attack (6th). Master's Flourish (14th): a d6 may be used in place of the Bardic Inspiration die.
function swords(level: number): Combatant {
  const sides = bardicDieSides(level);
  const speed: AutomationNode = { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "blade-flourish", durationRounds: 1, mods: { speedBonusFt: 10, untilSourceNextTurn: true } }] };
  const flourishes = (die: number, free: boolean, swing: (riders?: AutomationNode[], first?: AutomationNode[]) => AutomationNode[]): Action[] => {
    const d = `1d${die}`;
    const mk = (id: string, name: string, first: AutomationNode[]): Action => ({
      id: `attack-${id}${free ? "-master" : ""}`, name: `${name}${free ? " (Master's Flourish)" : ""}`, cost: { action: 1 }, recharge: "none", ...(free ? {} : { limitedUse: spendBI }),
      automation: [speed, ...swing([], first)],
    });
    return [
      mk("defensive-flourish", "Defensive Flourish", [{ type: "damage", amount: d, damageType: "slashing" }, { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "defensive-flourish", durationRounds: 1, mods: { acBonus: avgDie(die), untilSourceNextTurn: true } }] }]),
      mk("slashing-flourish", "Slashing Flourish", [{ type: "damage", amount: d, damageType: "slashing" }, { type: "target", who: { who: "anotherEnemy" }, effects: [{ type: "damage", amount: d, damageType: "slashing" }] }]),
      mk("mobile-flourish", "Mobile Flourish", [{ type: "damage", amount: d, damageType: "slashing" }, { type: "move", kind: "push", distance: 5 + avgDie(die) }]),
    ];
  };
  return build({
    college: "swords", level, ac: level >= 3 ? 16 : 14, extraAttack: true, reserve: 1, keepDistance: level < 3,
    weapon: level >= 3 ? { name: "Scimitar", die: "1d6", bonus: 2, type: "slashing" } : undefined, // Dueling: +2 to damage
    variants: (swing) => [...flourishes(sides, false, swing), ...(level >= 14 ? flourishes(6, true, swing) : [])],
  });
}

// -------------------------------------------------------------------------------------------------------------------------------- Whispers
// Psychic Blades (3rd): when you hit with a weapon attack, spend a Bardic Inspiration use for extra psychic damage — 2d6, 3d6 at 5th, 5d6 at 10th, 8d6 at 15th — once a round on your turn. Shadow Lore (14th):
// an action, once a long rest — a creature within 30 feet makes a Wisdom save or is charmed until it or its allies attack or hurt it. Words of Terror and Mantle of Whispers aren't modeled.
function whispers(level: number): Combatant {
  const dice = level >= 15 ? 8 : level >= 10 ? 5 : level >= 5 ? 3 : 2;
  const dc = 8 + pbFor(level) + chaMod(level);
  const actions: Action[] = [];
  const resources: NonNullable<Combatant["resources"]> = {};
  if (level >= 14) {
    resources.shadow_lore = { max: 1, recharge: "longRest" };
    actions.push({
      id: "shadow-lore", name: "Shadow Lore", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "shadow_lore", amount: 1 },
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "charmed", durationRounds: 600, endsOnDamage: true }], onSuccess: [] }] }],
    });
  }
  return build({
    college: "whispers", level, reserve: 1, actions, resources,
    variants: (swing) => [{
      id: "attack-psychic-blades", name: "Psychic Blades", cost: { action: 1 }, recharge: "none", limitedUse: spendBI,
      automation: swing([], [{ type: "damage", amount: `${dice}d6`, damageType: "psychic" }]),
    }],
  });
}

// ------------------------------------------------------------------------------------------------------------------------------- Creation
// Mote of Potential (3rd): the die a creature is given carries a mote — on an attack roll it makes the target and its neighbors save (Constitution, the bard's DC) or take thunder damage equal to the die;
// on a saving throw it gives temporary hit points equal to the die plus Charisma. Animating Performance (6th): an action — once a long rest, or a 3rd-level slot again — a Dancing Item that the bard
// commands with a bonus action. Performance of Creation and Creative Crescendo (objects) aren't modeled.
function creation(level: number): Combatant {
  const pb = pbFor(level);
  const cha = chaMod(level);
  const actions: Action[] = [];
  const resources: NonNullable<Combatant["resources"]> = {};
  const routine: string[] = [];
  const opener: string[] = [];
  if (level >= 6) {
    const item = dancingItemFor(level, pb, pb + cha);
    const raise: AutomationNode[] = [{ type: "branch", if: "self.no_companion", then: [{ type: "summon", statBlock: item, count: "1", max: 1 }] }];
    resources.animating_performance = { max: 1, recharge: "longRest" };
    actions.push(
      { id: "animating-performance", name: "Animating Performance", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "animating_performance", amount: 1 }, automation: raise },
      { id: "animating-performance-slot", name: "Animating Performance (3rd-level slot)", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "slot3", amount: 1 }, automation: raise },
      { id: "command-dancing-item", name: "Command the Dancing Item", cost: { bonus: 1 }, recharge: "none", automation: [{ type: "branch", if: "self.has_companion", then: [{ type: "commandSummon", action: "slam", limit: 1 }] }] },
    );
    routine.push("command-dancing-item");
    opener.push("animating-performance");
  }
  return build({ college: "creation", level, reserve: 0, inspirationMods: level >= 3 ? { moteOfPotential: true } : undefined, actions, resources, bonusRoutine: routine, opener });
}

// ------------------------------------------------------------------------------------------------------------------------------ Eloquence
// Unsettling Words (3rd): a bonus action and a use of Bardic Inspiration — a creature within 60 feet subtracts the die from the next saving throw it makes before your next turn. Unfailing Inspiration
// (6th): a die spent on a roll that still fails isn't lost. Infectious Inspiration (14th): when a creature within 60 feet adds your die to a roll that succeeds, a reaction gives another creature a die
// for free — Charisma-modifier times a long rest. Silver Tongue and Universal Speech aren't modeled.
function eloquence(level: number): Combatant {
  const cha = chaMod(level);
  const sides = bardicDieSides(level);
  const actions: Action[] = [];
  const reactions: Combatant["reactions"] = [];
  const resources: NonNullable<Combatant["resources"]> = {};
  const routine: string[] = [];
  if (level >= 3) {
    actions.push({
      id: "unsettling-words", name: "Unsettling Words", cost: { bonus: 1 }, recharge: "none", limitedUse: spendBI, usableWhen: keep(1),
      automation: [{ type: "branch", if: "no_enemy.has('unsettling-words')", then: [{ type: "target", who: { who: "aiChoice" }, effects: [
        { type: "applyEffect", name: "unsettling-words", durationRounds: 1, mods: { saveMalusDie: `1d${sides}`, untilSourceNextTurn: true } },
      ] }] }],
    });
    routine.push("unsettling-words");
  }
  if (level >= 14) {
    resources.infectious_inspiration = { max: Math.max(1, cha), recharge: "longRest" };
    reactions.push({ id: "infectious-inspiration", name: "Infectious Inspiration", cost: { reaction: 1 }, recharge: "none", trigger: "a creature's Bardic Inspiration die makes a roll succeed", limitedUse: { resource: "infectious_inspiration", amount: 1 }, automation: [{ type: "note", text: "Infectious Inspiration (engine hook)" }] });
  }
  return build({ college: "eloquence", level, reserve: 1, inspirationMods: level >= 6 ? { unfailingInspiration: true } : undefined, actions, reactions, resources, bonusRoutine: routine });
}

// --------------------------------------------------------------------------------------------------------------------------------- Spirits
// Tales from Beyond (3rd): a bonus action and a use of Bardic Inspiration roll on the Spirit Tales table, and the bard keeps the tale until it tells it, with an action, to a creature within 30 feet (itself
// included): 1 Clever Animal (checks: nothing here), 2 Renowned Duelist (a melee spell attack: two dice + Charisma force), 3 Beloved Friends (the target and another creature: a die + Charisma temporary
// hit points), 4 Runaway (teleport up to 30 feet), 5 Avenger (a minute: whoever hits the target in melee takes a die of force), 6 Traveler (a die + the bard level temporary hit points, +10 feet of speed and
// +1 AC). Spiritual Focus (6th): a d6 added to one damage or healing roll of a bard spell. Mystical Connection (14th): roll twice and choose.
function spirits(level: number): Combatant {
  const cha = chaMod(level);
  const pb = pbFor(level);
  const sides = bardicDieSides(level);
  const die = `1d${sides}`;
  const tale = (n: number): AutomationNode => ({ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: `tale-${n}`, durationRounds: 999 }, { type: "applyEffect", name: "tale-held", durationRounds: 999 }] });
  // the six tales, in the order a bard values them (best first) — Mystical Connection's best-of-two weights favor the front
  const rank = [2, 6, 3, 5, 4, 1];
  const weights = level >= 14 ? [11, 9, 7, 5, 3, 1] : [1, 1, 1, 1, 1, 1];
  const roll: Action = {
    id: "spirit-tale-roll", name: "Tales from Beyond (roll)", cost: { bonus: 1 }, recharge: "none", limitedUse: spendBI, usableWhen: keep(1),
    automation: [{ type: "branch", if: "self.hasnt('tale-held')", then: [{ type: "randomEffect", options: rank.map((n, i) => ({ weight: weights[i], then: [tale(n)], note: `the tale of ${["the Clever Animal", "the Renowned Duelist", "the Beloved Friends", "the Runaway", "the Avenger", "the Traveler"][n - 1]}` })) }] }],
  };
  const over = (n: number, nodes: AutomationNode[]): AutomationNode => ({ type: "branch", if: `self.has('tale-${n}')`, then: [...nodes, { type: "removeEffect", name: `tale-${n}` }, { type: "removeEffect", name: "tale-held" }] });
  const tell: Action = {
    id: "tell-tale", name: "Tell the tale", cost: { action: 1 }, recharge: "none", ranged: true,
    automation: [{ type: "branch", if: "self.has('tale-held')", then: [
      over(1, []),
      over(2, [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb + cha, onHit: [{ type: "damage", amount: `2d${sides}+${cha}`, damageType: "force" }] }] }]),
      over(3, [{ type: "target", who: { who: "eachAlly", limit: 2 }, effects: [{ type: "tempHp", amount: `${die}+${cha}` }] }]),
      over(4, [{ type: "move", kind: "teleportSelf", distance: 30 }]),
      over(5, [{ type: "target", who: { who: "eachAlly", limit: 1 }, effects: [{ type: "applyEffect", name: "tale-of-the-avenger", durationRounds: 10, mods: { hitBackDamage: { amount: die, damageType: "force", meleeOnly: true } } }] }]),
      over(6, [{ type: "target", who: { who: "eachAlly", limit: 1 }, effects: [{ type: "tempHp", amount: `${die}+${level}` }, { type: "applyEffect", name: "tale-of-the-traveler", durationRounds: 10, mods: { speedBonusFt: 10, acBonus: 1 } }] }]),
    ] }],
  };
  // Spiritual Focus (6th): a d6 on one damage or healing roll of a bard spell
  const focus = (a: Action): Action => {
    if (level < 6 || !a.isSpell || (a.spellLevel ?? 0) < 0) return a;
    let done = false;
    return { ...a, automation: mapNodes(a.automation, (n) => {
      if (done || (n.type !== "damage" && n.type !== "heal")) return n;
      done = true;
      return { ...n, amount: plusDie(n.amount, "1d6") };
    }) };
  };
  return build({ college: "spirits", level, reserve: 1, actions: level >= 3 ? [roll, tell] : undefined, bonusRoutine: level >= 3 ? ["tell-tale", "spirit-tale-roll"] : undefined, spells: focus });
}

export const BARD_BUILDERS: Record<string, (level: number) => Combatant> = {
  "lore-bard": lore,
  "valor-bard": valor,
  "glamour-bard": glamour,
  "swords-bard": swords,
  "whispers-bard": whispers,
  "creation-bard": creation,
  "eloquence-bard": eloquence,
  "spirits-bard": spirits,
};
