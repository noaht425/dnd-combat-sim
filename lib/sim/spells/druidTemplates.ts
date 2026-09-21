// The druid and its published circles, built from the printed text (dnd5e.wikidot.com/druid and each circle's page): Land and Moon (Player's Handbook),
// Dreams and Shepherd (Xanathar's), Spores, Stars and Wildfire (Tasha's / Guildmasters' Guide to Ravnica).
//
// Base class (the Druid table): a full caster — Wisdom casting, spells prepared = Wisdom modifier + druid level from the whole druid list, cantrips 2 / 3 / 4
// (levels 1 / 4 / 10), slots per the table; proficient in Intelligence and Wisdom saves; a d8 hit die; medium armor and a shield, none of it metal.
// Wild Shape (2nd): a real transformation — the druid's armor class, hit points, speeds, attacks and Strength / Dexterity / Constitution are the beast's until
// its hit points reach 0 (the excess damage carries over to the druid) or the fight ends; the druid keeps its mental scores, its saving-throw proficiencies and
// its spell slots, and "can't cast spells" in beast shape (Beast Spells, 18th, lifts that). Two uses, back on a short or long rest (Archdruid, 20th: unlimited).
// Only a Moon druid changes shape to fight: a caster who can cast is better off casting, and the other circles spend Wild Shape on their own features.
//
// Build assumptions the books leave open: Wisdom 18 (20 from 17th), Dexterity 14, Constitution 14; hide armor and a wooden shield (AC 12 + Dex up to 2 + 2);
// a Land druid's land is a choice — Forest unless another is named.
//
// Not modeled anywhere: Druidic, Timeless Body, Cantrip Versatility, Wild Companion (Tasha's optional), Thousand Forms (Alter Self at will), Land's Stride,
// speech and dream features, and each circle's out-of-combat features.

import type { Action, Combatant, DamageType } from "../schema";
import { BEAST_FORMS, bestBeast, bestElemental } from "../engine/beastForms";
import { PC_SUMMONS, wildfireSpiritFor } from "../engine/minions";
import { between, pbFor, score } from "../engine/pcBase";
import { makeCaster } from "./caster";
import { SPELLS_BY_ID, spellsForClass } from "./catalog";
import { autoPrepare, type CasterFocus } from "./prepare";
import { maxSlotLevel } from "./slots";
import { baseSpellId, injectAfterFirstHeal, injectFirstDamageBonus } from "./spellTransforms";

const wisMod = (level: number) => (pbFor(level) === 6 ? 5 : 4);

/** a quarterstaff for the odd weapon attack, so `id:"attack"` lookups resolve */
function staff(pb: number): Action[] {
  return [{
    id: "attack", name: "Quarterstaff", cost: { action: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb, onHit: [{ type: "damage", amount: "1d6", damageType: "bludgeoning" }] }] }],
  }];
}

interface Spec {
  id: string;
  level: number;
  focus?: CasterFocus;
  /** spells always prepared, by druid level: kept if the druid has a slot for them */
  always?: [number, string[]][];
  /** cantrips beyond the class's own (Land's bonus cantrip, Spores' Chill Touch) */
  bonusCantrips?: string[];
  keepDistance?: boolean;
  opener?: string[];
  bonusRoutine?: string[];
  bonusAfterAttack?: string[];
  weapon?: Action[];
  actions?: Action[];
  reactions?: Combatant["reactions"];
  traits?: Combatant["traits"];
  rules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  resistances?: DamageType[];
  immunities?: DamageType[];
  conditionImmunities?: Combatant["conditionImmunities"];
  /** rewrites every spell Action / reaction */
  spells?: (a: Action) => Action;
  targetPriority?: Combatant["ai"]["targetPriority"];
}

const isSpellAction = (a: Action) => a.isSpell === true;

function chassis(spec: Spec): Combatant {
  const { level } = spec;
  const pb = pbFor(level);
  const wis = wisMod(level);
  const maxSlot = maxSlotLevel("full", level);
  const picked = autoPrepare("druid", "full", level, wis, spec.focus ?? "balanced");
  const always = (spec.always ?? []).filter(([l]) => level >= l).flatMap(([, ids]) => ids).filter((id) => {
    const sp = SPELLS_BY_ID[id];
    return sp && sp.level <= maxSlot && (sp.build || sp.castTime === "reaction");
  });
  // circle spells "don't count against the number of spells you prepare"
  const prepared = [...new Set([...always, ...picked.spells])];
  const cantrips = [...new Set([...(spec.bonusCantrips ?? []).filter((id) => SPELLS_BY_ID[id]?.build), ...picked.cantrips])];
  const built = makeCaster({
    id: spec.id, name: `Druid ${level}`, level, spellClass: "druid", casterKind: "full", spellAbility: "wis",
    ac: 12 + 2 + 2, hp: between(level, 10, 10 + 19 * 7),
    abilities: { str: score(0), dex: score(2), con: score(2), int: score(0), wis: score(wis), cha: score(0) },
    proficientSaves: ["int", "wis"],
    prepared, cantrips,
    extraActions: [...(spec.weapon ?? staff(pb)), ...(spec.actions ?? [])],
    extraReactions: spec.reactions, extraTraits: spec.traits,
    keepDistance: spec.keepDistance ?? true, targetPriority: spec.targetPriority ?? "lowestHp",
    opener: spec.opener,
  });
  const rewrite = spec.spells;
  const actions = rewrite ? built.actions.map((a) => (isSpellAction(a) ? rewrite(a) : a)) : built.actions;
  const reactions = rewrite ? built.reactions.map((a) => (isSpellAction(a) ? rewrite(a) : a)) : built.reactions;
  return {
    ...built, actions, reactions,
    resources: { ...built.resources, ...(spec.resources ?? {}) },
    specialRules: [...built.specialRules, ...(spec.rules ?? [])],
    resistances: [...built.resistances, ...(spec.resistances ?? [])],
    immunities: [...built.immunities, ...(spec.immunities ?? [])],
    conditionImmunities: [...built.conditionImmunities, ...(spec.conditionImmunities ?? [])],
    ai: { ...built.ai, ...(spec.bonusRoutine ? { bonusRoutine: spec.bonusRoutine } : {}), ...(spec.bonusAfterAttack ? { bonusAfterAttack: spec.bonusAfterAttack } : {}) },
  };
}

/** Wild Shape's use pool: two, back on a short or long rest (Archdruid, 20th: unlimited) */
const wildShapePool = (level: number): Combatant["resources"] => (level >= 2 ? { wild_shape: level >= 20 ? { max: "unbounded" as const, recharge: "none" as const } : { max: 2, recharge: "shortRest" as const } } : {});
const wildShapeUse = (level: number, amount = 1): Action["limitedUse"] => (level >= 20 ? undefined : { resource: "wild_shape", amount });

/** the spell an Action was built from, when it is a spell */
export const spellIdOf = (a: Action) => a.id.replace(/^cast-/, "").replace(/-\d+$/, "");

// ------------------------------------------------------------------------------------------------ Circle of the Moon
// Combat Wild Shape (2nd): Wild Shape as a bonus action, and "expend one spell slot to regain 1d8 hit points per level of the spell slot expended" — used
// on the beast's hit points once they are below half, from the highest slot down (the slots are useless in beast shape). Circle Forms (2nd): a beast of
// challenge rating up to 1 ("ignoring the Max. CR column"), from 6th level a challenge rating of the druid level divided by 3 (rounded down); the fly / swim
// limits of the class table still apply (no flying or swimming at 2nd, no flying at 4th, neither restriction from 8th). Primal Strike (6th): every attack in this sim
// already counts as magical. Elemental Wild Shape (10th): two uses at once for an air, earth, fire or water elemental — the best of them is taken (Earth).
// Thousand Forms (14th) has no combat form. Beast Spells (18th) keeps the druid's spells in a form.
function moon(level: number): Combatant {
  const sub = level >= 2;
  const cr = level >= 6 ? Math.max(1, Math.floor(level / 3)) : 1;
  const beast = sub ? bestBeast(cr, { fly: level >= 8, swim: level >= 4 }) : undefined;
  const shape = (formId: string): Action["automation"] => [{
    type: "branch", if: "self.unshaped", then: [{ type: "wildShape", form: formId, ...(level >= 18 ? { beastSpells: true } : {}) }],
  }];
  const lvlMax = Math.min(5, maxSlotLevel("full", level));
  const heals: Action[] = sub ? Array.from({ length: lvlMax }, (_, i) => i + 1).map((slot) => ({
    id: `shape-heal-${slot}`, name: `Combat Wild Shape (heal, ${slot}${slot === 1 ? "st" : slot === 2 ? "nd" : slot === 3 ? "rd" : "th"}-level slot)`,
    cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: `slot${slot}`, amount: 1 }, keepInForm: true,
    automation: [{ type: "branch" as const, if: "self.shape_hurt", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "heal" as const, amount: `${slot}d8` }] }] }],
  })) : [];
  const elemental = level >= 10 ? bestElemental() : undefined;
  const actions: Action[] = [
    ...(beast ? [{
      id: "wild-shape", name: `Wild Shape (${beast.name})`, cost: { bonus: 1 }, recharge: "none" as const, limitedUse: wildShapeUse(level),
      automation: shape(beast.id),
    }] : []),
    ...(elemental ? [{
      id: "elemental-wild-shape", name: `Elemental Wild Shape (${elemental.name})`, cost: { bonus: 1 }, recharge: "none" as const, limitedUse: wildShapeUse(level, 2),
      automation: shape(elemental.id),
    }] : []),
    ...heals,
  ];
  const routine = [...(elemental ? ["elemental-wild-shape"] : []), ...(beast ? ["wild-shape"] : []), ...heals.map((h) => h.id).reverse()];
  const c = chassis({
    id: "moon-druid", level, focus: "controller", keepDistance: !sub, actions, resources: wildShapePool(level),
    opener: routine.slice(0, 2), bonusRoutine: routine,
  });
  return c;
}

// ------------------------------------------------------------------------------------------------ Circle of the Land
// Bonus Cantrip (2nd). Natural Recovery (2nd): on a short rest, slots totalling up to half the druid level (rounded up), none 6th or higher, once until a long
// rest — the same numbers as Arcane Recovery. Circle Spells (3rd, 5th, 7th, 9th): the land's two spells at each step, always prepared. Nature's Ward (10th): you
// can't be charmed or frightened by elementals or fey, and are immune to poison (and disease). Nature's Sanctuary (14th): a beast or plant that attacks you makes
// a Wisdom save against your spell save DC, or must attack something else — or the attack misses; a creature that succeeds is immune for 24 hours.
// Land's Stride (6th) has no combat form.
type Land = "arctic" | "coast" | "desert" | "forest" | "grassland" | "mountain" | "swamp" | "underdark";
const LAND_SPELLS: Record<Land, [number, string[]][]> = {
  arctic: [[3, ["hold-person", "spike-growth"]], [5, ["sleet-storm", "slow"]], [7, ["freedom-of-movement", "ice-storm"]], [9, ["commune-with-nature", "cone-of-cold"]]],
  coast: [[3, ["mirror-image", "misty-step"]], [5, ["water-breathing", "water-walk"]], [7, ["control-water", "freedom-of-movement"]], [9, ["conjure-elemental", "scrying"]]],
  desert: [[3, ["blur", "silence"]], [5, ["create-food-and-water", "protection-from-energy"]], [7, ["blight", "hallucinatory-terrain"]], [9, ["insect-plague", "wall-of-stone"]]],
  forest: [[3, ["barkskin", "spider-climb"]], [5, ["call-lightning", "plant-growth"]], [7, ["divination", "freedom-of-movement"]], [9, ["commune-with-nature", "tree-stride"]]],
  grassland: [[3, ["invisibility", "pass-without-trace"]], [5, ["daylight", "haste"]], [7, ["divination", "freedom-of-movement"]], [9, ["dream", "insect-plague"]]],
  mountain: [[3, ["spider-climb", "spike-growth"]], [5, ["lightning-bolt", "meld-into-stone"]], [7, ["stone-shape", "stoneskin"]], [9, ["passwall", "wall-of-stone"]]],
  swamp: [[3, ["darkness", "melfs-acid-arrow"]], [5, ["water-walk", "stinking-cloud"]], [7, ["freedom-of-movement", "locate-creature"]], [9, ["insect-plague", "scrying"]]],
  underdark: [[3, ["spider-climb", "web"]], [5, ["gaseous-form", "stinking-cloud"]], [7, ["greater-invisibility", "stone-shape"]], [9, ["cloudkill", "insect-plague"]]],
};

function land(level: number, which: Land): Combatant {
  const sub = level >= 2;
  const cantrip = spellsForClass("druid").find((s) => s.level === 0 && s.role === "damage" && s.build)?.id;
  return chassis({
    id: `${which}-land-druid`, level, focus: "balanced", always: LAND_SPELLS[which],
    bonusCantrips: sub && cantrip ? [cantrip] : [],
    resources: wildShapePool(level),
    rules: [
      ...(sub ? [{ rule: "arcaneRecovery" as const }] : []),
      ...(level >= 14 ? [{ rule: "natureSanctuary" as const }] : []),
    ],
    immunities: level >= 10 ? ["poison"] : [],
    conditionImmunities: level >= 10 ? ["poisoned"] : [],
    traits: level >= 10 ? [{
      id: "natures-ward", name: "Nature's Ward", trigger: "encounterStart",
      automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "natures-ward", mods: { noCharmFrightFromTypes: ["elemental", "fey"] } }] }],
      text: "can't be charmed or frightened by elementals or fey",
    }] : undefined,
  });
}

const reaction = (id: string, name: string, trigger: string, automation: Action["automation"], limitedUse?: { resource: string; amount: number }): Action => ({
  id, name, cost: { reaction: 1 }, recharge: "none", trigger, automation, ...(limitedUse ? { limitedUse } : {}),
});
/** a healing spell cast with a slot (Cure Wounds, Healing Word, Mass Cure Wounds...) */
const isSlotHeal = (a: Action) => a.isSpell === true && !!a.limitedUse && (a.spellLevel ?? 0) >= 1 && SPELLS_BY_ID[baseSpellId(a.id)]?.role === "heal";

// ---------------------------------------------------------------------------------------------- Circle of Dreams
// Balm of the Summer Court (2nd): a pool of d6s equal to the druid level; as a bonus action, up to half the druid level of them heal one creature within 120 ft
// for the dice rolled, and it gains 1 temporary hit point per die spent; the dice come back after a long rest. Used once the party has lost a fair number of
// hit points. Hearth of Moonlight and Shadow (6th), Hidden Paths (10th) and Walker in Dreams (14th) have no combat form here.
function dreams(level: number): Combatant {
  const sub = level >= 2;
  const n = Math.max(1, Math.floor(level / 2));
  return chassis({
    id: "dreams-druid", level, focus: "support", resources: { ...wildShapePool(level), ...(sub ? { balm: { max: level, recharge: "longRest" as const } } : {}) },
    actions: sub ? [{
      id: "balm-of-the-summer-court", name: "Balm of the Summer Court", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "balm", amount: n },
      automation: [{ type: "branch", if: "party.missing_hp >= 12", then: [{ type: "target", who: { who: "lowestHpAlly" }, effects: [
        { type: "heal", amount: `${n}d6` }, { type: "tempHp", amount: String(n) },
      ] }] }],
    }] : undefined,
    bonusRoutine: sub ? ["balm-of-the-summer-court"] : undefined,
  });
}

// -------------------------------------------------------------------------------------------- Circle of the Shepherd
// Spirit Totem (2nd): a bonus action, once until a short or long rest — a spirit for a minute with a 30-ft aura. Bear: each creature of your choice in it gains
// 5 + your druid level temporary hit points and advantage on Strength checks and saves. Hawk: your reaction gives an attack roll against a creature in the aura
// advantage. Unicorn: a healing spell cast with a slot also heals every creature of your choice in the aura for your druid level. (The spirit is taken to stand
// with the druid.) The AI opens with the Bear. Mighty Summoner (6th): beasts and fey you summon have 2 extra hit points per Hit Die. Guardian Spirit (10th):
// beasts and fey you summoned regain half your level in hit points at the end of their turns while a spirit stands. Faithful Summons (14th): reduced to 0 hit points,
// four beasts of challenge rating 2 or lower (polar bears here) appear, once per long rest. Speech of the Woods (2nd) has no combat form.
function shepherd(level: number): Combatant {
  const sub = level >= 2;
  const totem = (kind: "bear" | "hawk" | "unicorn", nodes: Action["automation"]): Action => ({
    id: `spirit-totem-${kind}`, name: `Spirit Totem (${kind[0].toUpperCase()}${kind.slice(1)})`, cost: { bonus: 1 }, recharge: "none",
    limitedUse: { resource: "spirit_totem", amount: 1 }, automation: nodes,
  });
  const unicorn = (a: Action): Action => {
    if (!isSlotHeal(a) || level < 2) return a;
    const extra: Action["automation"] = [{ type: "branch", if: "self.has('spirit-unicorn')", then: [{ type: "target", who: { who: "eachAlly" }, effects: [{ type: "heal", amount: String(level) }] }] }];
    const { nodes, applied } = injectAfterFirstHeal(a.automation, extra);
    return applied ? { ...a, automation: nodes } : a;
  };
  if (level >= 14) PC_SUMMONS["faithful-polar-bear"] = { ...BEAST_FORMS["polar-bear"].ref, id: "faithful-polar-bear", name: "Polar Bear" };
  return chassis({
    id: "shepherd-druid", level, focus: "balanced", spells: sub ? unicorn : undefined,
    resources: { ...wildShapePool(level), ...(sub ? { spirit_totem: { max: 1, recharge: "shortRest" as const } } : {}), ...(level >= 14 ? { faithful_summons: { max: 1, recharge: "longRest" as const } } : {}) },
    actions: sub ? [
      totem("bear", [{ type: "target", who: { who: "eachAlly" }, effects: [
        { type: "tempHp", amount: String(5 + level) },
        { type: "applyEffect", name: "spirit-bear", durationRounds: 10, mods: { saveAdvantageOn: ["str"] } },
      ] }]),
      totem("hawk", [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "spirit-hawk", durationRounds: 10 }] }]),
      totem("unicorn", [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "spirit-unicorn", durationRounds: 10 }] }]),
    ] : undefined,
    opener: sub ? ["spirit-totem-bear"] : undefined,
    rules: [...(level >= 6 ? [{ rule: "mightySummoner" as const }] : []), ...(level >= 10 ? [{ rule: "guardianSpirit" as const }] : [])],
    traits: level >= 14 ? [{
      id: "faithful-summons", name: "Faithful Summons", trigger: "whenReducedToZero",
      automation: [{ type: "branch", if: "self.resource('faithful_summons') >= 1", then: [
        { type: "spendResource", resource: "faithful_summons", amount: 1 },
        { type: "summon", statBlock: "faithful-polar-bear", count: "4" },
      ] }],
      text: "four beasts of challenge rating 2 or lower appear",
    }] : undefined,
  });
}

// ---------------------------------------------------------------------------------------------- Circle of Spores
// Circle Spells: Chill Touch, and at 3rd / 5th / 7th / 9th the spells listed (always prepared). Halo of Spores (2nd): a reaction when a creature you can see moves within
// 10 ft or starts its turn there — a Constitution save or 1d4 necrotic (1d6 at 6th, 1d8 at 10th, 1d10 at 14th); taken as a hostile creature's turn begins beside you.
// Symbiotic Entity (2nd): an action and a use of Wild Shape — 4 temporary hit points per druid level, Halo damage dice rolled twice, and melee weapon attacks deal an extra
// 1d6 necrotic; it ends when the temporary hit points are gone. Fungal Infestation (6th): a beast or humanoid, Small or Medium, dying within 10 ft rises as a zombie with
// 1 hit point (Wisdom-modifier uses). Spreading Spores (10th): a bonus action while the Symbiotic Entity lasts — spores in a 10-ft cube for a minute (a Constitution save now
// and Halo damage each turn, taken as half). Fungal Body (14th): can't be blinded, deafened, frightened or poisoned; a critical hit against you is a normal hit.
function spores(level: number): Combatant {
  const sub = level >= 2;
  const pb = pbFor(level);
  const wis = wisMod(level);
  const dc = 8 + pb + wis;
  const die = level >= 14 ? 10 : level >= 10 ? 8 : level >= 6 ? 6 : 4;
  const halo = (dice: number): Action["automation"] => [{ type: "save", ability: "con", dc, onFail: [{ type: "damage", amount: `${dice}d${die}`, damageType: "necrotic" }], onSuccess: [] }];
  return chassis({
    id: "spores-druid", level, focus: "balanced", bonusCantrips: sub ? ["chill-touch"] : [],
    always: [[3, ["blindness-deafness"]], [5, ["animate-dead"]], [7, ["blight", "confusion"]], [9, ["cloudkill", "contagion"]]],
    resources: { ...wildShapePool(level), ...(level >= 6 ? { fungal_infestation: { max: Math.max(1, wis), recharge: "longRest" as const } } : {}) },
    actions: sub ? [
      {
        id: "symbiotic-entity", name: "Symbiotic Entity", cost: { action: 1 }, recharge: "none", limitedUse: wildShapeUse(level),
        automation: [{ type: "branch", if: "self.hasnt('symbiotic-entity')", then: [{ type: "target", who: { who: "self" }, effects: [
          { type: "tempHp", amount: String(4 * level) },
          { type: "applyEffect", name: "symbiotic-entity", durationRounds: 100, mods: { extraDamageOnHit: { amount: "1d6", damageType: "necrotic", weaponOnly: true } } },
        ] }] }],
      },
      ...(level >= 10 ? [{
        id: "spreading-spores", name: "Spreading Spores", cost: { bonus: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "self.has('symbiotic-entity')", then: [{ type: "target" as const, who: { who: "eachEnemy" as const }, effects: [
          ...halo(2),
          { type: "applyEffect" as const, name: "spreading-spores", durationRounds: 10, tick: [{ type: "damage" as const, amount: `2d${die}`, damageType: "necrotic" as const, half: true }] },
        ] }] }],
      }] : []),
    ] : undefined,
    reactions: sub ? [
      reaction("halo-of-spores", "Halo of Spores", "a creature moves within 10 ft or starts its turn there", [{ type: "target", who: { who: "aiChoice" }, effects: [
        { type: "branch", if: "self.has('symbiotic-entity')", then: halo(2), else: halo(1) },
      ] }]),
      ...(level >= 6 ? [reaction("fungal-infestation", "Fungal Infestation", "a Small or Medium beast or humanoid dies within 10 ft", [{ type: "summon", statBlock: "zombie", count: "1", hp: 1 }], { resource: "fungal_infestation", amount: 1 })] : []),
    ] : undefined,
    opener: sub ? ["symbiotic-entity"] : undefined,
    bonusRoutine: level >= 10 ? ["spreading-spores"] : undefined,
    conditionImmunities: level >= 14 ? ["blinded", "deafened", "frightened", "poisoned"] : [],
    rules: level >= 14 ? [{ rule: "critImmune" }] : [],
  });
}

// ----------------------------------------------------------------------------------------------- Circle of Stars
// Star Map (2nd): Guiding Bolt prepared and castable without a slot proficiency-bonus times per long rest (Guidance has no combat form). Starry Form (2nd): a bonus action and
// a use of Wild Shape, ten minutes — the Archer (a ranged spell attack, 1d8 + Wisdom radiant, then again as a bonus action each turn; 2d8 from 10th), the Chalice (a healing
// spell cast with a slot also heals you or a creature within 30 ft for 1d8 + Wisdom; 2d8 from 10th) or the Dragon (a roll of 9 or lower on a concentration save counts as 10) —
// the AI takes the Archer. Cosmic Omen (6th): after a long rest a roll for Weal (even) or Woe (odd), and a reaction, proficiency-bonus times per long rest, to add (Weal) or take
// away (Woe) a d6 on a d20 roll by a creature within 30 ft. Full of Stars (14th): resistance to bludgeoning, piercing and slashing in Starry Form. (Twinkling Constellations'
// flying speed and switching of constellations aren't modeled.)
function stars(level: number): Combatant {
  const sub = level >= 2;
  const pb = pbFor(level);
  const wis = wisMod(level);
  const dice = level >= 10 ? 2 : 1;
  const starry = (kind: "archer" | "chalice" | "dragon", extra: Action["automation"], mods: Record<string, unknown> = {}): Action => ({
    id: `starry-form-${kind}`, name: `Starry Form (${kind[0].toUpperCase()}${kind.slice(1)})`, cost: { bonus: 1 }, recharge: "none", limitedUse: wildShapeUse(level),
    automation: [{ type: "branch", if: "self.hasnt('starry-form')", then: [
      { type: "target", who: { who: "self" }, effects: [
        { type: "applyEffect", name: "starry-form", durationRounds: 100, mods: level >= 14 ? { resistTypes: ["bludgeoning", "piercing", "slashing"] } : {} },
        { type: "applyEffect", name: `starry-form-${kind}`, durationRounds: 100, mods },
      ] },
      ...extra,
    ] }],
  });
  const arrow: Action["automation"][number] = { type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb + wis, onHit: [{ type: "damage", amount: `${dice}d8+${wis}`, damageType: "radiant" }] }] };
  const chalice = (a: Action): Action => {
    if (!isSlotHeal(a)) return a;
    const extra: Action["automation"] = [{ type: "branch", if: "self.has('starry-form-chalice')", then: [{ type: "target", who: { who: "lowestHpAlly" }, effects: [{ type: "heal", amount: `${dice}d8+${wis}` }] }] }];
    const { nodes, applied } = injectAfterFirstHeal(a.automation, extra);
    return applied ? { ...a, automation: nodes } : a;
  };
  const c = chassis({
    id: "stars-druid", level, focus: "balanced", always: sub ? [[2, ["guiding-bolt"]]] : undefined, spells: sub ? chalice : undefined,
    resources: { ...wildShapePool(level), ...(sub ? { star_map: { max: pb, recharge: "longRest" as const } } : {}), ...(level >= 6 ? { cosmic_omen: { max: pb, recharge: "longRest" as const } } : {}) },
    actions: sub ? [
      starry("archer", [{ ...arrow }]),
      starry("chalice", []),
      starry("dragon", [], { concentrationD20Floor: 10 }),
      { id: "starry-archer", name: "Starry Archer", cost: { bonus: 1 }, recharge: "none" as const, ranged: true,
        automation: [{ type: "branch" as const, if: "self.has('starry-form-archer')", then: [arrow] }] },
    ] : undefined,
    reactions: level >= 6 ? [reaction("cosmic-omen", "Cosmic Omen", "a creature within 30 ft makes a d20 roll", [{ type: "note", text: "add (Weal) or subtract (Woe) a d6 (engine hook)" }], { resource: "cosmic_omen", amount: 1 })] : undefined,
    traits: level >= 6 ? [{ id: "cosmic-omen-roll", name: "Cosmic Omen", trigger: "encounterStart", automation: [{ type: "omenRoll" }], text: "Weal or Woe, rolled after a long rest" }] : undefined,
    opener: sub ? ["starry-form-archer"] : undefined,
    bonusRoutine: sub ? ["starry-archer"] : undefined,
  });
  // Star Map: Guiding Bolt without a slot
  const bolt = c.actions.find((a) => a.id === "cast-guiding-bolt-1");
  return sub && bolt ? { ...c, actions: [...c.actions, { ...bolt, id: "cast-guiding-bolt-star-map", name: "Guiding Bolt (Star Map)", limitedUse: { resource: "star_map", amount: 1 } }] } : c;
}

// ------------------------------------------------------------------------------------------- Circle of Wildfire
// Circle Spells (2nd, 3rd, 5th, 7th, 9th): Burning Hands and Cure Wounds; Flaming Sphere and Scorching Ray; Plant Growth and Revivify; Aura of Life and Fire Shield; Flame Strike and Mass Cure
// Wounds (always prepared; those the sim can cast). Summon Wildfire Spirit (2nd): an action and a use of Wild Shape — the spirit (5 + 5 × level hit points, Flame Seed for 1d6 + PB fire
// at range) appears and each creature near it makes a Dexterity save or takes 2d6 fire; it only Dodges unless the druid uses a bonus action to command it. Enhanced Bond (6th): while
// the spirit stands, a spell that deals fire damage or restores hit points adds a d8 to one roll. Cauterizing Flames (10th): when a creature dies within 30 ft, a proficiency-bonus
// number of times, the flames heal for 2d10 + Wisdom (taken here as the most hurt ally healed at once). Blazing Revival (14th): reduced to 0 with the spirit within 120 ft, the spirit
// falls, and you rise with half your hit points, once per long rest. (Fiery Teleportation isn't modeled.)
function wildfire(level: number): Combatant {
  const sub = level >= 2;
  const pb = pbFor(level);
  const wis = wisMod(level);
  const dc = 8 + pb + wis;
  const bond = (a: Action): Action => {
    if (level < 6) return a;
    const { nodes, applied } = injectFirstDamageBonus(a.automation, "1d8", "fire", true);
    return applied ? { ...a, automation: [{ type: "branch", if: "self.has_companion", then: nodes, else: a.automation }] } : a;
  };
  const spirit = sub ? wildfireSpiritFor(level, pb, wis) : undefined;
  return chassis({
    id: "wildfire-druid", level, focus: "balanced", spells: bond,
    always: [[2, ["burning-hands", "cure-wounds"]], [3, ["flaming-sphere", "scorching-ray"]], [5, ["plant-growth", "revivify"]], [7, ["aura-of-life", "fire-shield"]], [9, ["flame-strike", "mass-cure-wounds"]]],
    resources: {
      ...wildShapePool(level),
      ...(level >= 10 ? { cauterizing_flames: { max: pb, recharge: "longRest" as const } } : {}),
      ...(level >= 14 ? { blazing_revival: { max: 1, recharge: "longRest" as const } } : {}),
    },
    actions: sub ? [{
      id: "summon-wildfire-spirit", name: "Summon Wildfire Spirit", cost: { action: 1 }, recharge: "none", limitedUse: wildShapeUse(level),
      automation: [
        { type: "summon", statBlock: spirit!, count: "1", max: 1 },
        { type: "target", who: { who: "area", shape: "sphere", size: 10 }, effects: [{ type: "save", ability: "dex", dc, onFail: [{ type: "damage", amount: "2d6", damageType: "fire" }], onSuccess: [] }] },
      ],
    }, {
      id: "command-spirit", name: "Command the wildfire spirit", cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "branch", if: "self.has_companion", then: [{ type: "commandSummon", action: "flame-seed", limit: 1 }] }],
    }] : undefined,
    reactions: level >= 10 ? [reaction("cauterizing-flames", "Cauterizing Flames", "a creature dies within 30 ft", [{ type: "target", who: { who: "lowestHpAlly" }, effects: [{ type: "heal", amount: `2d10+${wis}` }] }], { resource: "cauterizing_flames", amount: 1 })] : undefined,
    opener: sub ? ["summon-wildfire-spirit"] : undefined,
    bonusRoutine: sub ? ["command-spirit"] : undefined,
    rules: level >= 14 ? [{ rule: "blazingRevival", resource: "blazing_revival" }] : undefined,
  });
}

const LANDS: Land[] = ["arctic", "coast", "desert", "forest", "grassland", "mountain", "swamp", "underdark"];

export const DRUID_BUILDERS: Record<string, (level: number) => Combatant> = {
  "moon-druid": moon,
  "dreams-druid": dreams,
  "shepherd-druid": shepherd,
  "spores-druid": spores,
  "stars-druid": stars,
  "wildfire-druid": wildfire,
  ...Object.fromEntries(LANDS.map((l) => [`${l}-land-druid`, (level: number) => land(level, l)])),
};

