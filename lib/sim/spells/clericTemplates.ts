// The cleric and its fourteen published domains, built from the printed text (dnd5e.wikidot.com/cleric and each domain's page): Knowledge, Life, Light, Nature,
// Tempest, Trickery and War (Player's Handbook), Death (Dungeon Master's Guide), Arcana (Sword Coast), Forge and Grave (Xanathar's), Order, Peace and Twilight
// (Tasha's).
//
// Base class (the Cleric table): a full caster — Wisdom casting, spells prepared = Wisdom modifier + cleric level from the whole cleric list plus the domain's spells
// (always prepared, not counted), cantrips 3 / 4 / 5 (levels 1 / 4 / 10), slots per the table; proficient in Wisdom and Charisma saves; a d8 hit die. Healing is real: a
// spell costs a slot, is only worth casting once someone is below half their hit points (or down), and can be cast on a creature at 0 hit points. Channel Divinity (2nd):
// one use, two from 6th, three from 18th, back on a short or long rest — Turn Undead (each undead within 30 ft that sees or hears you makes a Wisdom save or is turned: it
// flees and does nothing else until it takes damage) plus the domain's own. Destroy Undead (5th): an undead that fails is destroyed outright if its challenge rating is at
// most 1/2 (5th level), 1 (8th), 2 (11th), 3 (14th) or 4 (17th).
//
// Build assumptions the books leave open: Wisdom 18 (20 from 17th), Strength 14, Constitution 14; armor class 18 (chain mail and a shield for the heavy-armor domains, scale mail
// and a shield for the rest); a mace, or a longsword where the domain gives martial weapons; Forge's Blessing of the Forge blesses the armor (`forge-cleric`) — `forge-cleric-weapon`
// takes the weapon (+1 to attack and damage) instead, since the printed feature is one or the other, never both.
//
// Not modeled anywhere, each verified rather than assumed: Divine Intervention (the DM decides what the god does), the optional Harness Divine Power and Cantrip Versatility, Artisan's
// Blessing, Eyes of the Grave, Blessings of Knowledge / Knowledge of the Ages / Visions of the Past, Bonus Cantrip: Light, Blessing of the Trickster, Eyes of Night, Implement of Peace
// (all ability checks, proficiencies or pure flavor — ability checks aren't modeled anywhere in this sim); Improved Duplicity's extra images (checked against the source: they only add
// more places to stand for advantage that's already unconditional here, nothing new to build); Order's Demand making a charmed creature drop what it holds (the same gap the Battle
// Master's Disarming Attack already documented: no item/inventory model exists for a monster to be disarmed of or retrieve); Vigilant Blessing (advantage on an ally's next initiative
// roll — there's no pre-initiative action window in this engine at all, and `initiativeAdvantage` is a static per-creature build flag, not a targetable buff); Spell Breaker (Arcana,
// "end one spell on the creature you heal, of a level up to the slot spent" — no effect anywhere in this engine is tagged with the spell level that applied it, and even Dispel Magic
// doesn't reach that precision, so there's nothing to check the level of); Master of Nature (Nature, 17th: command what a charmed beast or plant does on its turn — a Dominate-caliber
// "direct an enemy's actions" mechanic that doesn't exist even for the actual Dominate spells, which are built as plain `charmed`). Known approximations: Blessed Healer also
// fires when the cleric heals itself (the printed feature says another creature); Twilight Sanctuary's temporary hit points come as the creature's turn starts, not ends; Read Thoughts is
// a charm for the fight rather than Suggestion; Invoke Duplicity and Cloak of Shadows are modeled, but the AI's scoring seldom prefers them to a slot spell; Steps of Night (Twilight, 6th)
// and Stormborn (Tempest, 17th) grant their flying speed without checking dim light/darkness or being outdoors, which this sim doesn't track. The sim treats every attack as magical, so
// "resistance to nonmagical bludgeoning, piercing and slashing" (Forge 17th, War 17th) is built as resistance to that damage: nearly every monster attack is nonmagical.

import type { Action, AutomationNode, Combatant, DamageType } from "../schema";
import { between, pbFor, score } from "../engine/pcBase";
import { makeCaster } from "./caster";
import { SPELLS_BY_ID } from "./catalog";
import { autoPrepare, type CasterFocus } from "./prepare";
import { maxSlotLevel } from "./slots";
import { baseSpellId, injectAfterFirstDamage, injectAfterFirstHeal, injectFirstDamageBonus, mapNodes, maximizeDamageOfTypes } from "./spellTransforms";

const wisMod = (level: number) => (pbFor(level) === 6 ? 5 : 4);
const STR = 2;

const isSpellAction = (a: Action) => a.isSpell === true;
const spellOf = (a: Action) => SPELLS_BY_ID[baseSpellId(a.id)];
/** a healing spell cast with a slot */
const isSlotHeal = (a: Action) => a.isSpell === true && !!a.limitedUse && (a.spellLevel ?? 0) >= 1 && spellOf(a)?.role === "heal";

const reaction = (id: string, name: string, trigger: string, automation: Action["automation"] = [{ type: "note", text: `${name} (engine hook)` }], limitedUse?: { resource: string; amount: number }): Action => ({
  id, name, cost: { reaction: 1 }, recharge: "none", trigger, automation, ...(limitedUse ? { limitedUse } : {}),
});

/** the challenge rating Destroy Undead (and Arcane Abjuration's banishing) reaches: 1/2 at 5th, 1 at 8th, 2 at 11th, 3 at 14th, 4 at 17th */
const destroyCr = (level: number) => (level >= 17 ? 4 : level >= 14 ? 3 : level >= 11 ? 2 : level >= 8 ? 1 : level >= 5 ? 0.5 : 0);

interface Spec {
  id: string;
  level: number;
  focus?: CasterFocus;
  /** the domain's spells by cleric level (always prepared, not counted) */
  domain?: [number, string[]][];
  bonusCantrips?: string[];
  /** a martial weapon (a longsword) rather than a mace */
  martial?: boolean;
  /** Divine Strike's damage type (8th level: 1d8, 14th: 2d8), when the domain has one */
  strike?: DamageType;
  /** extra riders on Divine Strike (Order's Wrath) */
  strikeRiders?: AutomationNode[];
  /** a flat bonus to the weapon attack's to-hit and damage (Blessing of the Forge's weapon option: +1) */
  weaponBonus?: number;
  ac?: number;
  /** overrides the default { walk: 30 } (Stormborn: a flying speed) */
  speeds?: Combatant["speeds"];
  actions?: Action[];
  reactions?: Combatant["reactions"];
  traits?: Combatant["traits"];
  rules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  resistances?: DamageType[];
  immunities?: DamageType[];
  /** rewrites every spell Action / reaction */
  spells?: (a: Action) => Action;
  /** extra spell variants built from the finished list */
  variants?: (spellActs: Action[]) => Action[];
  keepDistance?: boolean;
  opener?: string[];
  bonusRoutine?: string[];
  bonusAfterAttack?: string[];
  /** extra weapon attack actions (Touch of Death) built from the weapon attack node */
  weaponVariants?: (swing: (riders?: AutomationNode[]) => AutomationNode) => Action[];
}

function chassis(spec: Spec): Combatant {
  const { level } = spec;
  const pb = pbFor(level);
  const wis = wisMod(level);
  const dc = 8 + pb + wis;
  const maxSlot = maxSlotLevel("full", level);
  const picked = autoPrepare("cleric", "full", level, wis, spec.focus ?? "balanced");
  const domain = (spec.domain ?? []).filter(([l]) => level >= l).flatMap(([, ids]) => ids).filter((id) => {
    const sp = SPELLS_BY_ID[id];
    return sp && sp.level <= maxSlot && (sp.build || sp.castTime === "reaction");
  });
  const prepared = [...new Set([...domain, ...picked.spells])];
  const cantrips = [...new Set([...(spec.bonusCantrips ?? []).filter((id) => SPELLS_BY_ID[id]?.build), ...picked.cantrips])];

  // Divine Strike (8th, 14th): once per turn, when a weapon attack hits
  const strikeDice = level >= 14 ? "2d8" : "1d8";
  const divine: AutomationNode[] = spec.strike && level >= 8
    ? [{ type: "damage", amount: strikeDice, damageType: spec.strike, oncePerTurn: "divine-strike" }, ...(spec.strikeRiders ?? [])]
    : [];
  const wb = spec.weaponBonus ?? 0;
  const swing = (riders: AutomationNode[] = []): AutomationNode => ({
    type: "attack", bonus: pb + STR + wb,
    onHit: [{ type: "damage", amount: `${spec.martial ? "1d8" : "1d6"}+${STR + wb}`, damageType: "bludgeoning" }, ...riders, ...divine],
  });
  const weapon: Action[] = [{
    id: "attack", name: spec.martial ? "Longsword" : "Mace", cost: { action: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: [swing()] }],
  }, ...(spec.weaponVariants ? spec.weaponVariants(swing) : [])];

  // Channel Divinity and Turn Undead
  const cdUses = level >= 18 ? 3 : level >= 6 ? 2 : level >= 2 ? 1 : 0;
  const cr = destroyCr(level);
  const turn: Action[] = cdUses ? [{
    id: "turn-undead", name: "Turn Undead", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "channel_divinity", amount: 1 },
    automation: [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, filter: { types: ["undead"], strictTypes: true }, effects: [{
      type: "save", ability: "wis", dc,
      // Destroy Undead: "the creature is instantly destroyed if its challenge rating is at or below a certain threshold"
      onFail: [...(cr > 0 ? [{ type: "destroy" as const, crMax: cr }] : []), { type: "applyCondition", condition: "turned", durationRounds: 10, endsOnDamage: true }],
      onSuccess: [],
    }] }],
  }] : [];

  const built = makeCaster({
    id: spec.id, name: `Cleric ${level}`, level, spellClass: "cleric", casterKind: "full", spellAbility: "wis",
    ac: spec.ac ?? 18, hp: between(level, 10, 10 + 19 * 7),
    abilities: { str: score(STR), dex: score(0), con: score(2), int: score(0), wis: score(wis), cha: score(1) },
    proficientSaves: ["wis", "cha"],
    prepared, cantrips,
    extraActions: [...weapon, ...turn, ...(spec.actions ?? [])],
    extraReactions: spec.reactions, extraTraits: spec.traits,
    keepDistance: spec.keepDistance ?? true, targetPriority: "lowestHp",
    opener: spec.opener,
  });
  const rewrite = spec.spells;
  const actions = rewrite ? built.actions.map((a) => (isSpellAction(a) ? rewrite(a) : a)) : built.actions;
  const reactions = rewrite ? built.reactions.map((a) => (isSpellAction(a) ? rewrite(a) : a)) : built.reactions;
  const withVariants = [...actions, ...(spec.variants ? spec.variants(actions.filter(isSpellAction)) : [])];
  return {
    ...built, actions: withVariants, reactions,
    ...(spec.speeds ? { speeds: spec.speeds } : {}),
    resources: { ...built.resources, ...(cdUses ? { channel_divinity: { max: cdUses, recharge: "shortRest" as const } } : {}), ...(spec.resources ?? {}) },
    specialRules: [...built.specialRules, ...(spec.rules ?? [])],
    resistances: [...built.resistances, ...(spec.resistances ?? [])],
    immunities: [...built.immunities, ...(spec.immunities ?? [])],
    ai: { ...built.ai, ...(spec.bonusRoutine ? { bonusRoutine: spec.bonusRoutine } : {}), ...(spec.bonusAfterAttack ? { bonusAfterAttack: spec.bonusAfterAttack } : {}) },
  };
}

/** a Channel Divinity option: an action that spends one of the pool */
const channel = (id: string, name: string, automation: Action["automation"], cost: Action["cost"] = { action: 1 }, extra: Partial<Action> = {}): Action => ({
  id, name, cost, recharge: "none", limitedUse: { resource: "channel_divinity", amount: 1 }, automation, ...extra,
});

/** a resource that recharges on a long rest, sized by the Wisdom modifier (minimum one) */
const wisUses = (level: number) => ({ max: Math.max(1, wisMod(level)), recharge: "longRest" as const });

/** Potent Spellcasting (8th): + Wisdom to the damage of any cleric cantrip */
const potent = (level: number) => (a: Action): Action => {
  if ((a.spellLevel ?? 0) !== 0 || level < 8) return a;
  const { nodes, applied } = injectFirstDamageBonus(a.automation, wisMod(level));
  return applied ? { ...a, automation: nodes } : a;
};
const compose = (...fns: Array<((a: Action) => Action) | undefined>) => (a: Action): Action => fns.reduce((acc, f) => (f ? f(acc) : acc), a);

// --------------------------------------------------------------------------------------------------------------------------- Life
// Bonus Proficiency: heavy armor. Disciple of Life (1st): a healing spell restores 2 + the spell's level more. Preserve Life (2nd Channel Divinity): five times the cleric level in
// hit points divided among creatures within 30 ft, none raised above half its maximum, and not undead or constructs. Blessed Healer (6th): healing another creature with a spell of
// 1st level or higher heals you 2 + the spell's level. Divine Strike (8th, 14th): 1d8 (2d8) radiant. Supreme Healing (17th): healing dice are always at their maximum.
function life(level: number): Combatant {
  const disciple = (a: Action): Action => {
    if (!isSlotHeal(a)) return a;
    const extra: Action["automation"] = [
      { type: "heal", amount: String(2 + a.spellLevel!) },
      ...(level >= 6 ? [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "heal" as const, amount: String(2 + a.spellLevel!) }] }] : []),
    ];
    const { nodes, applied } = injectAfterFirstHeal(a.automation, extra);
    return applied ? { ...a, automation: nodes } : a;
  };
  return chassis({
    id: "life-cleric", level, focus: "support",
    domain: [[1, ["bless", "cure-wounds"]], [3, ["lesser-restoration", "spiritual-weapon"]], [5, ["beacon-of-hope", "revivify"]], [7, ["death-ward", "guardian-of-faith"]], [9, ["mass-cure-wounds", "raise-dead"]]],
    strike: "radiant", spells: disciple,
    actions: level >= 2 ? [channel("preserve-life", "Preserve Life", [{
      type: "branch", if: "party.missing_hp >= 15", then: [{ type: "healPool", total: 5 * level, withinFt: 30, capFraction: 0.5, filter: { notTypes: ["undead", "construct"] } }],
    }])] : undefined,
    rules: level >= 17 ? [{ rule: "maxHealing", always: true }] : undefined,
  });
}

// -------------------------------------------------------------------------------------------------------------------------- Arcana
// Arcane Initiate (1st): two wizard cantrips. Arcane Abjuration (2nd Channel Divinity): each celestial, elemental, fey and fiend within 30 ft makes a Wisdom save or is turned; from 5th
// level one whose challenge rating is at or below the step (1/2, 1 at 8th, 2, 3, 4) is banished instead. Potent Spellcasting (8th). Arcane Mastery (17th): a wizard spell of each level
// from 6th to 9th (Chain Lightning, Finger of Death, Sunburst, Meteor Swarm), always prepared. Spell Breaker (6th) isn't modeled.
function arcana(level: number): Combatant {
  const cr = destroyCr(level);
  return chassis({
    id: "arcana-cleric", level, focus: "controller",
    domain: [[1, ["detect-magic", "magic-missile"]], [3, ["magic-weapon", "nystuls-magic-aura"]], [5, ["dispel-magic", "magic-circle"]], [7, ["arcane-eye", "leomunds-secret-chest"]], [9, ["planar-binding", "teleportation-circle"]],
      [17, ["chain-lightning", "finger-of-death", "sunburst", "meteor-swarm"]]],
    bonusCantrips: ["fire-bolt", "ray-of-frost"], spells: potent(level),
    actions: level >= 2 ? [channel("arcane-abjuration", "Arcane Abjuration", [{
      type: "target", who: { who: "eachEnemy", withinFt: 30 }, filter: { types: ["celestial", "elemental", "fey", "fiend"], strictTypes: true }, effects: [{
        type: "save", ability: "wis", dc: 8 + pbFor(level) + wisMod(level),
        onFail: [...(cr > 0 ? [{ type: "banish" as const, crMax: cr }] : []), { type: "applyCondition", condition: "turned", durationRounds: 10, endsOnDamage: true }], onSuccess: [],
      }],
    }])] : undefined,
  });
}

// --------------------------------------------------------------------------------------------------------------------------- Death
// Bonus Proficiency: martial weapons. Reaper (1st): Chill Touch, and a necromancy cantrip that targets one creature can target two. Touch of Death (2nd Channel Divinity): a melee hit
// adds 5 + twice the cleric level necrotic damage. Inescapable Destruction (6th): necrotic damage from cleric spells and Channel Divinity ignores resistance. Divine Strike (8th, 14th):
// necrotic. Improved Reaper (17th): a necromancy spell of 1st to 5th level that targets one creature can target two.
function death(level: number): Combatant {
  const inescapable = (nodes: AutomationNode[]): AutomationNode[] => level < 6 ? nodes
    : mapNodes(nodes, (n) => (n.type === "damage" && n.damageType === "necrotic" ? { ...n, ignoreResistances: true } : n));
  const two = (a: Action): Action => {
    const top = a.automation[0];
    if (top?.type !== "target" || a.school !== "necromancy") return a;
    const cantrip = (a.spellLevel ?? 0) === 0;
    if (!cantrip && (level < 17 || (a.spellLevel ?? 0) > 5)) return a;
    const single = top.who.who === "aiChoice" || (top.who.who === "chosenEnemies" && top.who.upTo === 1);
    return single ? { ...a, automation: [{ ...top, who: { who: "chosenEnemies", upTo: 2 } }, ...a.automation.slice(1)] } : a;
  };
  return chassis({
    id: "death-cleric", level, focus: "blaster", martial: true, strike: "necrotic",
    domain: [[1, ["false-life", "ray-of-sickness"]], [3, ["blindness-deafness", "ray-of-enfeeblement"]], [5, ["animate-dead", "vampiric-touch"]], [7, ["blight", "death-ward"]], [9, ["antilife-shell", "cloudkill"]]],
    bonusCantrips: ["chill-touch"],
    spells: compose((a) => ({ ...a, automation: inescapable(a.automation) }), two),
    weaponVariants: level >= 2 ? (swing) => [{
      id: "attack-touch-of-death", name: "Touch of Death", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "channel_divinity", amount: 1 },
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [swing(inescapable([{ type: "damage", amount: String(5 + 2 * level), damageType: "necrotic" }]))] }],
    }] : undefined,
  });
}

// --------------------------------------------------------------------------------------------------------------------------- Forge
// Bonus Proficiencies: heavy armor. Blessing of the Forge (1st, end of a long rest): bless one nonmagical suit of armor OR weapon — +1 AC, or
// +1 to that weapon's attack and damage rolls (built as two templates: `forge-cleric` takes the armor, `forge-cleric-weapon` the weapon). Soul
// of the Forge (6th): resistance to fire, and +1 AC in heavy armor (on top of either Blessing choice). Divine Strike (8th, 14th): fire. Saint
// of Forge and Fire (17th): immunity to fire, and resistance to bludgeoning, piercing and slashing (from nonmagical attacks: see the header).
function forge(level: number, weapon = false): Combatant {
  return chassis({
    id: weapon ? "forge-cleric-weapon" : "forge-cleric", level, focus: "balanced", strike: "fire",
    ac: 18 + (weapon ? 0 : 1) + (level >= 6 ? 1 : 0),
    weaponBonus: weapon ? 1 : undefined,
    domain: [[1, ["identify", "searing-smite"]], [3, ["heat-metal", "magic-weapon"]], [5, ["elemental-weapon", "protection-from-energy"]], [7, ["fabricate", "wall-of-fire"]], [9, ["animate-objects", "creation"]]],
    resistances: [...(level >= 6 ? ["fire" as const] : []), ...(level >= 17 ? ["bludgeoning" as const, "piercing" as const, "slashing" as const] : [])],
    immunities: level >= 17 ? ["fire"] : [],
  });
}

// --------------------------------------------------------------------------------------------------------------------------- Grave
// Circle of Mortality (1st): a healing spell cast on a creature at 0 hit points rolls its highest number on each die. Path to the Grave (2nd Channel Divinity): an action to curse a
// creature within 30 ft until the end of your next turn — the next hit by you or an ally against it has vulnerability to all of that damage. Sentinel at Death's Door (6th): a reaction turns a
// critical hit against you or an ally within 30 ft into a normal hit (Wisdom-modifier uses). Potent Spellcasting (8th). Keeper of Souls (17th): an enemy dying within 30 ft heals you or an
// ally by its Hit Dice, once until the start of your next turn. Eyes of the Grave (1st) has no combat form.
function grave(level: number): Combatant {
  return chassis({
    id: "grave-cleric", level, focus: "balanced", spells: potent(level),
    domain: [[1, ["bane", "false-life"]], [3, ["gentle-repose", "ray-of-enfeeblement"]], [5, ["revivify", "vampiric-touch"]], [7, ["blight", "death-ward"]], [9, ["antilife-shell", "raise-dead"]]],
    rules: [{ rule: "maxHealing", always: false }, ...(level >= 17 ? [{ rule: "keeperOfSouls" as const }] : [])],
    actions: level >= 2 ? [channel("path-to-the-grave", "Path to the Grave", [{
      type: "target", who: { who: "aiChoice" }, effects: [{ type: "applyEffect", name: "path-to-the-grave", durationRounds: 2, mods: { doubleNextHit: true } }],
    }])] : undefined,
    reactions: level >= 6 ? [reaction("sentinel-at-deaths-door", "Sentinel at Death's Door", "an ally within 30 ft suffers a critical hit", undefined, { resource: "sentinel", amount: 1 })] : undefined,
    resources: level >= 6 ? { sentinel: wisUses(level) } : undefined,
  });
}

// ----------------------------------------------------------------------------------------------------------------------- Knowledge
// Read Thoughts (6th Channel Divinity): a creature within 60 ft makes a Wisdom save or you read its thoughts — and, with an action, cast Suggestion on it without a slot, its save failed
// automatically; built as the one step, a charm for the fight. Potent Spellcasting (8th). Blessings of Knowledge (1st), Knowledge of the Ages (2nd) and Visions of the Past (17th) are out of combat.
function knowledge(level: number): Combatant {
  return chassis({
    id: "knowledge-cleric", level, focus: "controller", spells: potent(level),
    domain: [[1, ["command", "identify"]], [3, ["augury", "suggestion"]], [5, ["nondetection", "speak-with-dead"]], [7, ["arcane-eye", "confusion"]], [9, ["legend-lore", "scrying"]]],
    actions: level >= 6 ? [channel("read-thoughts", "Read Thoughts", [{
      type: "target", who: { who: "aiChoice" }, effects: [{ type: "save", ability: "wis", dc: 8 + pbFor(level) + wisMod(level), onFail: [{ type: "applyCondition", condition: "charmed", durationRounds: 10 }], onSuccess: [] }],
    }])] : undefined,
  });
}

// ----------------------------------------------------------------------------------------------------------------------------- Light
// Warding Flare (1st): a reaction to impose disadvantage on an attack against you by a creature within 30 ft (not one that can't be blinded); Wisdom-modifier uses. Improved Flare (6th): the
// same for an attack on someone else. Radiance of the Dawn (2nd Channel Divinity): each hostile creature within 30 ft makes a Constitution save, taking 2d10 + the cleric level radiant damage
// (half on a save). Potent Spellcasting (8th). Corona of Light (17th): an action for a minute of sunlight — enemies near you have disadvantage on saves against your fire and radiant spells.
function light(level: number): Combatant {
  return chassis({
    id: "light-cleric", level, focus: "blaster", spells: potent(level),
    domain: [[1, ["burning-hands", "faerie-fire"]], [3, ["flaming-sphere", "scorching-ray"]], [5, ["daylight", "fireball"]], [7, ["guardian-of-faith", "wall-of-fire"]], [9, ["flame-strike", "scrying"]]],
    reactions: [level >= 6
      ? reaction("improved-flare", "Warding Flare (Improved Flare)", "a creature attacks you or an ally within 30 ft", undefined, { resource: "warding_flare", amount: 1 })
      : reaction("warding-flare", "Warding Flare", "a creature attacks you", undefined, { resource: "warding_flare", amount: 1 })],
    resources: { warding_flare: wisUses(level) },
    actions: [
      ...(level >= 2 ? [channel("radiance-of-the-dawn", "Radiance of the Dawn", [{
        type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [{
          type: "save", ability: "con", dc: 8 + pbFor(level) + wisMod(level),
          onFail: [{ type: "damage", amount: `2d10+${level}`, damageType: "radiant" }], onSuccess: [{ type: "damage", amount: `2d10+${level}`, damageType: "radiant", half: true }],
        }],
      }])] : []),
      ...(level >= 17 ? [{
        id: "corona-of-light", name: "Corona of Light", cost: { action: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "self.hasnt('corona-of-light')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "corona-of-light", durationRounds: 10 }] }] }],
      }] : []),
    ],
    opener: level >= 17 ? ["corona-of-light"] : undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------- Nature
// Bonus Proficiency: heavy armor. Acolyte of Nature (1st): a druid cantrip (Produce Flame). Charm Animals and Plants (2nd Channel Divinity): each beast or plant within 30 ft that can see you
// makes a Wisdom save or is charmed for a minute or until it takes damage. Dampen Elements (6th): a reaction for resistance to one instance of acid, cold, fire, lightning or thunder damage
// to a creature within 30 ft. Divine Strike (8th, 14th): fire (the choice of cold, fire or lightning). Master of Nature (17th) isn't modeled.
function nature(level: number): Combatant {
  return chassis({
    id: "nature-cleric", level, focus: "balanced", strike: "fire",
    domain: [[1, ["animal-friendship", "speak-with-animals"]], [3, ["barkskin", "spike-growth"]], [5, ["plant-growth", "wind-wall"]], [7, ["dominate-beast", "grasping-vine"]], [9, ["insect-plague", "tree-stride"]]],
    bonusCantrips: ["produce-flame"],
    reactions: level >= 6 ? [reaction("dampen-elements", "Dampen Elements", "a creature within 30 ft takes acid, cold, fire, lightning or thunder damage")] : undefined,
    actions: level >= 2 ? [channel("charm-animals-and-plants", "Charm Animals and Plants", [{
      type: "target", who: { who: "eachEnemy", withinFt: 30 }, filter: { types: ["beast", "plant"], strictTypes: true }, effects: [{
        type: "save", ability: "wis", dc: 8 + pbFor(level) + wisMod(level), onFail: [{ type: "applyCondition", condition: "charmed", durationRounds: 10, endsOnDamage: true }], onSuccess: [],
      }],
    }])] : undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------- Order
// Bonus Proficiencies: heavy armor. Voice of Authority (1st): when you cast a spell of 1st level or higher that targets an ally, that ally uses its reaction to make one weapon attack against
// a creature of your choice. Order's Demand (2nd Channel Divinity): each creature of your choice within 30 ft that sees or hears you makes a Wisdom save or is charmed until the end of your next
// turn or until it takes damage. Embodiment of the Law (6th): a spell of the enchantment school cast as a bonus action (Wisdom-modifier uses). Divine Strike (8th, 14th): psychic. Order's Wrath
// (17th): Divine Strike curses the creature — the next ally to hit it adds 2d8 psychic damage.
function order(level: number): Combatant {
  const voice = (a: Action): Action => {
    if (!a.limitedUse || (a.spellLevel ?? 0) < 1) return a;
    let hit = false;
    const automation = mapNodes(a.automation, (n) => {
      if (n.type === "target" && (n.who.who === "lowestHpAlly" || n.who.who === "eachAlly") && !n.effects.some((e) => e.type === "allyStrike")) { hit = true; return { ...n, effects: [...n.effects, { type: "allyStrike" }] }; }
      return n;
    });
    return hit ? { ...a, automation } : a;
  };
  return chassis({
    id: "order-cleric", level, focus: "support", strike: "psychic", spells: voice,
    domain: [[1, ["command", "heroism"]], [3, ["hold-person", "zone-of-truth"]], [5, ["mass-healing-word", "slow"]], [7, ["compulsion", "locate-creature"]], [9, ["commune", "dominate-person"]]],
    strikeRiders: level >= 17 ? [{ type: "applyEffect", name: "orders-wrath", durationRounds: 2, mods: { extraDamageOnNextAllyHit: { amount: "2d8", damageType: "psychic" } } }] : undefined,
    resources: level >= 6 ? { embodiment: wisUses(level) } : undefined,
    actions: level >= 2 ? [channel("orders-demand", "Order's Demand", [{
      type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [{ type: "save", ability: "wis", dc: 8 + pbFor(level) + wisMod(level), onFail: [{ type: "applyCondition", condition: "charmed", durationRounds: 1, endsOnDamage: true }], onSuccess: [] }],
    }])] : undefined,
    variants: level >= 6 ? (spells) => spells.flatMap((a): Action[] => {
      if (a.school !== "enchantment" || !a.limitedUse || (a.cost.action ?? 0) < 1 || (a.spellLevel ?? 0) < 1) return [];
      return [{
        ...a, id: `${a.id}-embodied`, name: `${a.name} (Embodiment of the Law)`, cost: { bonus: 1 },
        automation: [{ type: "branch", if: "self.resource('embodiment') >= 1", then: [{ type: "spendResource", resource: "embodiment", amount: 1 }, ...a.automation] }],
      }];
    }) : undefined,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------- Peace
// Emboldening Bond (1st): an action — a number of willing creatures equal to the proficiency bonus (the sturdiest here) within 30 ft add a d4 to an attack roll, ability check or saving throw for
// 10 minutes (here on every attack and save), proficiency-bonus times per long rest. Balm of Peace (2nd Channel Divinity): 2d6 + Wisdom to creatures within 5 ft (two here). Protective Bond
// (6th): a bonded creature within 30 ft uses its reaction to take all the damage another is about to take. Potent Spellcasting (8th). Expansive Bond (17th): 60 ft, and the protector has resistance
// to that damage.
function peace(level: number): Combatant {
  const pb = pbFor(level);
  const wis = wisMod(level);
  return chassis({
    id: "peace-cleric", level, focus: "support", spells: potent(level),
    domain: [[1, ["heroism", "sanctuary"]], [3, ["aid", "warding-bond"]], [5, ["beacon-of-hope", "sending"]], [7, ["aura-of-purity", "otilukes-resilient-sphere"]], [9, ["greater-restoration", "rarys-telepathic-bond"]]],
    resources: { emboldening_bond: { max: pb, recharge: "longRest" } },
    actions: [
      { id: "emboldening-bond", name: "Emboldening Bond", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "emboldening_bond", amount: 1 },
        automation: [{ type: "target", who: { who: "eachAlly", limit: pb }, effects: [{
          type: "applyEffect", name: "emboldening-bond", durationRounds: 100,
          // "Each creature can add the d4 no more than once per turn"
          mods: { attackBonusDice: "1d4", saveBonusDice: "1d4", bonusDiceOncePerTurn: true, ...(level >= 6 ? { protectiveBondFt: level >= 17 ? 60 : 30, ...(level >= 17 ? { protectiveBondResists: true } : {}) } : {}) },
        }] }] },
      ...(level >= 2 ? [channel("balm-of-peace", "Balm of Peace", [{ type: "branch", if: "party.missing_hp >= 10", then: [{
        type: "target", who: { who: "eachAlly", withinFt: 5, limit: 2 }, effects: [{ type: "heal", amount: `2d6+${wis}` }],
      }] }])] : []),
    ],
    opener: ["emboldening-bond"],
  });
}

// -------------------------------------------------------------------------------------------------------------------------- Tempest
// Bonus Proficiencies: martial weapons and heavy armor. Wrath of the Storm (1st): a reaction when a creature within 5 ft hits you — a Dexterity save or 2d8 lightning damage (half on a save);
// Wisdom-modifier uses. Destructive Wrath (2nd Channel Divinity): lightning or thunder damage you roll is maximum instead. Thunderous Strike (6th): dealing lightning damage to a Large or
// smaller creature can also push it 10 feet. Divine Strike (8th, 14th): thunder. Stormborn (17th): a flying speed equal to the walking speed (the "not underground or indoors" clause isn't
// tracked, so it's built as always on).
const thunderousStrike = (level: number) => (a: Action): Action => {
  if (level < 6) return a;
  const push: AutomationNode[] = [{ type: "branch", if: "target.size<=large", then: [{ type: "move", kind: "push", distance: 10 }] }];
  const { nodes, applied } = injectAfterFirstDamage(a.automation, push, "lightning");
  return applied ? { ...a, automation: nodes } : a;
};
function tempest(level: number): Combatant {
  const push: AutomationNode[] = level >= 6 ? [{ type: "branch", if: "target.size<=large", then: [{ type: "move", kind: "push", distance: 10 }] }] : [];
  return chassis({
    id: "tempest-cleric", level, focus: "blaster", martial: true, strike: "thunder", spells: thunderousStrike(level),
    speeds: level >= 17 ? { walk: 30, fly: 30 } : undefined,
    domain: [[1, ["fog-cloud", "thunderwave"]], [3, ["gust-of-wind", "shatter"]], [5, ["call-lightning", "sleet-storm"]], [7, ["control-water", "ice-storm"]], [9, ["destructive-wave", "insect-plague"]]],
    resources: { wrath_of_the_storm: wisUses(level) },
    reactions: [reaction("wrath-of-the-storm", "Wrath of the Storm", "a creature within 5 ft hits you", [{
      type: "target", who: { who: "aiChoice" }, effects: [
        { type: "save", ability: "dex", dc: 8 + pbFor(level) + wisMod(level), onFail: [{ type: "damage", amount: "2d8", damageType: "lightning" }, ...push], onSuccess: [{ type: "damage", amount: "2d8", damageType: "lightning", half: true }, ...push] },
      ],
    }], { resource: "wrath_of_the_storm", amount: 1 })],
    variants: level >= 2 ? (spells) => spells.flatMap((a): Action[] => {
      const maxed = maximizeDamageOfTypes(a.automation, ["lightning", "thunder"]);
      if (!a.limitedUse || JSON.stringify(maxed) === JSON.stringify(a.automation)) return [];
      return [{
        ...a, id: `${a.id}-destructive`, name: `${a.name} (Destructive Wrath)`,
        automation: [{ type: "branch", if: "self.resource('channel_divinity') >= 1", then: [{ type: "spendResource", resource: "channel_divinity", amount: 1 }, ...maxed] }],
      }];
    }) : undefined,
  });
}

// ------------------------------------------------------------------------------------------------------------------------- Trickery
// Blessing of the Trickster (1st) is out of combat. Invoke Duplicity (2nd Channel Divinity): a perfect illusion of yourself for a minute (concentration) — with it within 5 ft of a creature you
// have advantage on attack rolls against it; taken as advantage on your attacks. Cloak of Shadows (6th Channel Divinity): invisible until the end of your next turn, or until you attack.
// Divine Strike (8th, 14th): poison. Improved Duplicity (17th) adds images with nothing more to give.
function trickery(level: number): Combatant {
  return chassis({
    id: "trickery-cleric", level, focus: "controller", strike: "poison",
    domain: [[1, ["charm-person", "disguise-self"]], [3, ["mirror-image", "pass-without-trace"]], [5, ["blink", "dispel-magic"]], [7, ["dimension-door", "polymorph"]], [9, ["dominate-person", "modify-memory"]]],
    actions: [
      ...(level >= 2 ? [channel("invoke-duplicity", "Invoke Duplicity", [{ type: "branch", if: "self.hasnt('duplicity')", then: [{
        type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "duplicity", durationRounds: 10, mods: { attackAdvantage: "adv" } }],
      }] }], { action: 1 }, { concentration: true })] : []),
      ...(level >= 6 ? [channel("cloak-of-shadows", "Cloak of Shadows", [{ type: "target", who: { who: "self" }, effects: [
        { type: "applyCondition", condition: "invisible", durationRounds: 2 },
        { type: "applyEffect", name: "cloak-of-shadows", durationRounds: 2, mods: { endsOnAttacking: true } },
      ] }])] : []),
    ],
  });
}

// ------------------------------------------------------------------------------------------------------------------------- Twilight
// Bonus Proficiencies: martial weapons and heavy armor. Twilight Sanctuary (2nd Channel Divinity): a 30-ft sphere for a minute in which each creature, as its turn ends, gains 1d6 + the cleric's level
// temporary hit points or is freed of a charm or fear (here as its turn comes round); Twilight Shroud (17th) gives allies in it half cover. Steps of Night (6th): a bonus action for a flying speed
// equal to the walking speed for a minute, proficiency-bonus times a long rest (the "in dim light or darkness" clause isn't tracked, so it's built as always available, the same simplification as
// Tempest's Stormborn). Divine Strike (8th, 14th): radiant. Eyes of Night (1st) and Vigilant Blessing (1st) aren't modeled.
function twilight(level: number): Combatant {
  return chassis({
    id: "twilight-cleric", level, focus: "support", martial: true, strike: "radiant",
    domain: [[1, ["faerie-fire", "sleep"]], [3, ["moonbeam", "see-invisibility"]], [5, ["aura-of-vitality", "leomunds-tiny-hut"]], [7, ["aura-of-life", "greater-invisibility"]], [9, ["circle-of-power", "mislead"]]],
    resources: level >= 6 ? { steps_of_night: { max: pbFor(level), recharge: "longRest" as const } } : undefined,
    actions: [
      ...(level >= 2 ? [channel("twilight-sanctuary", "Twilight Sanctuary", [{ type: "branch", if: "self.hasnt('twilight-sanctuary')", then: [{
        type: "target", who: { who: "eachAlly" }, effects: [{
          type: "applyEffect", name: "twilight-sanctuary", durationRounds: 10, mods: level >= 17 ? { acBonus: 2 } : {},
          // each creature chooses one: end a charm or fright effect on itself, or take the temporary hit points
          tick: [{ type: "branch", if: "target.has('frightened')", then: [{ type: "removeEffect", name: "frightened" }], else: [
            { type: "branch", if: "target.has('charmed')", then: [{ type: "removeEffect", name: "charmed" }], else: [{ type: "tempHp", amount: `1d6+${level}` }] },
          ] }],
        }],
      }] }])] : []),
      ...(level >= 6 ? [{
        id: "steps-of-night", name: "Steps of Night", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "steps_of_night", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hasnt('steps-of-night')", then: [
          { type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "steps-of-night", durationRounds: 10, mods: { grantsFly: true } }] },
        ] }],
      }] : []),
    ],
    opener: level >= 2 ? ["twilight-sanctuary"] : undefined,
  });
}

// ------------------------------------------------------------------------------------------------------------------------------ War
// Bonus Proficiencies: martial weapons and heavy armor. War Priest (1st): after the Attack action, one weapon attack as a bonus action — Wisdom-modifier uses per long rest. Guided Strike (2nd
// Channel Divinity): after seeing an attack roll, +10 to it, if that makes it hit. War God's Blessing (6th Channel Divinity): a reaction to give a creature within 30 ft +10 to an attack roll.
// Divine Strike (8th, 14th): 1d8 (2d8) of the weapon's damage type. Avatar of Battle (17th): resistance to bludgeoning, piercing and slashing (nonmagical: see the header).
function war(level: number): Combatant {
  const pb = pbFor(level);
  return chassis({
    id: "war-cleric", level, focus: "balanced", martial: true, strike: "bludgeoning", keepDistance: false,
    domain: [[1, ["divine-favor", "shield-of-faith"]], [3, ["magic-weapon", "spiritual-weapon"]], [5, ["crusaders-mantle", "spirit-guardians"]], [7, ["freedom-of-movement", "stoneskin"]], [9, ["flame-strike", "hold-monster"]]],
    resources: { war_priest: wisUses(level) },
    actions: [{
      id: "war-priest", name: "War Priest (bonus attack)", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "war_priest", amount: 1 },
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb + STR, onHit: [{ type: "damage", amount: `1d8+${STR}`, damageType: "bludgeoning" }] }] }],
    }],
    bonusAfterAttack: ["war-priest"],
    rules: level >= 2 ? [{ rule: "guidedStrike", resource: "channel_divinity" }] : undefined,
    reactions: level >= 6 ? [reaction("war-gods-blessing", "War God's Blessing", "a creature within 30 ft makes an attack roll", undefined, { resource: "channel_divinity", amount: 1 })] : undefined,
    resistances: level >= 17 ? ["bludgeoning", "piercing", "slashing"] : undefined,
  });
}

export const CLERIC_BUILDERS: Record<string, (level: number) => Combatant> = {
  "life-cleric": life,
  "arcana-cleric": arcana,
  "death-cleric": death,
  "forge-cleric": forge,
  "forge-cleric-weapon": (l) => forge(l, true),
  "grave-cleric": grave,
  "knowledge-cleric": knowledge,
  "light-cleric": light,
  "nature-cleric": nature,
  "order-cleric": order,
  "peace-cleric": peace,
  "tempest-cleric": tempest,
  "trickery-cleric": trickery,
  "twilight-cleric": twilight,
  "war-cleric": war,
};

