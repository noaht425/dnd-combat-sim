// The paladin and its nine printed Sacred Oaths, built from the printed text (dnd5e.wikidot.com/paladin and each oath's page): Devotion and Ancients and Vengeance (Player's Handbook), Conquest and
// Redemption (Sword Coast), Glory and Watchers (Tasha's/Van Richten's era... Glory is Theros, Watchers is Ravenloft), Crown (Guildmasters' Guide to Ravnica) and Oathbreaker (Dungeon Master's Guide).
//
// Base class (the Paladin table): a half caster — Charisma casting, spells PREPARED = Charisma modifier + half the paladin level, rounded down (minimum one); proficient in Wisdom and Charisma saves; a
// d10 hit die; all armor and shields. Lay on Hands (1st): a pool of 5 x the paladin level hit points, restored on a long rest, that can't heal undead or constructs. Divine Smite (2nd): hitting with a
// melee weapon attack may spend a spell slot for 2d8 radiant (+1d8 a slot level above 1st, to 5d8; +1d8 more against an undead or a fiend, to 6d8). Sacred Oath (3rd): oath spells (always prepared, not
// counted) and a Channel Divinity option (one use, back on a short or long rest) at 3rd, 7th, 15th and 20th. Extra Attack (5th). Aura of Protection (6th): the Charisma modifier (minimum +1) to the
// saving throws of the paladin and friendly creatures within 10 ft (30 ft from 18th). Aura of Courage (10th): immune to being frightened, same range. Improved Divine Smite (11th): every melee hit adds
// 1d8 radiant. Cleansing Touch (14th): an action, Charisma-modifier times a long rest, ends one spell on the paladin or a willing creature it touches.
//
// Build assumptions the books leave open: Strength 18 (20 from 17th), Constitution 14, Charisma 16 (18 from 17th); half the oaths take a longsword and shield with the Defense fighting style (+1 AC),
// half a greatsword with Great Weapon Fighting (reroll a 1 or 2 on the weapon's damage dice); an oath is only worth a use of its Channel Divinity when there is something for it to do.
//
// Not modeled anywhere: Divine Sense, Divine Health, Harness Divine Power and Martial Versatility (optional rules), the Blessed Warrior / Blind Fighting / Protection fighting styles, tenets and other
// out-of-combat flavor, Emissary of Peace and Peerless Athlete (pure ability checks), Relentless Avenger's and Champion Challenge's and Elder Champion's and Mortal Bulwark's movement clauses, Aura of
// Alacrity's and Aura of the Sentinel's propagation to allies (built self-only), truesight, and Sacred Weapon's magic-weapon/light clauses (every attack in this sim is already magical). Known
// approximations: turning uses the `turned` condition rather than the printed "moves away and takes the Dash action" behaviour; Champion Challenge and Mortal Bulwark's banishing are capped versions of
// the cleric's `banish` node; Rebuke the Violent estimates the triggering attack's damage rather than reading the actual roll; Aura of Hate is self-only (no undead/fiend allies to extend it to).

import type { Action, AutomationNode, Combatant, DamageType } from "../schema";
import { between, pbFor, score } from "../engine/pcBase";
import { makeCaster } from "./caster";
import { SPELLS_BY_ID } from "./catalog";
import { maxSlotLevel } from "./slots";
import { preparedCount } from "./prepare";

const chaMod = (level: number) => (pbFor(level) === 6 ? 5 : 4);
const strMod = (level: number) => (pbFor(level) === 6 ? 5 : 4);
const CON = 2;
const ALL_DAMAGE_TYPES: DamageType[] = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];

export type Oath = "devotion" | "ancients" | "vengeance" | "conquest" | "redemption" | "glory" | "watchers" | "crown" | "oathbreaker";

// oath spells by paladin level (always prepared, not counted)
const OATH_SPELLS: Record<Oath, [number, string[]][]> = {
  devotion: [[3, ["protection-from-evil-and-good", "sanctuary"]], [5, ["lesser-restoration", "zone-of-truth"]], [9, ["beacon-of-hope", "dispel-magic"]], [13, ["freedom-of-movement", "guardian-of-faith"]], [17, ["commune", "flame-strike"]]],
  ancients: [[3, ["ensnaring-strike", "speak-with-animals"]], [5, ["misty-step", "moonbeam"]], [9, ["plant-growth", "protection-from-energy"]], [13, ["ice-storm", "stoneskin"]], [17, ["commune-with-nature", "tree-stride"]]],
  vengeance: [[3, ["bane", "hunters-mark"]], [5, ["hold-person", "misty-step"]], [9, ["haste", "protection-from-energy"]], [13, ["banishment", "dimension-door"]], [17, ["hold-monster", "scrying"]]],
  conquest: [[3, ["armor-of-agathys", "command"]], [5, ["hold-person", "spiritual-weapon"]], [9, ["bestow-curse", "fear"]], [13, ["dominate-beast", "stoneskin"]], [17, ["cloudkill", "dominate-person"]]],
  redemption: [[3, ["sanctuary", "sleep"]], [5, ["calm-emotions", "hold-person"]], [9, ["counterspell", "hypnotic-pattern"]], [13, ["otilukes-resilient-sphere", "stoneskin"]], [17, ["hold-monster", "wall-of-force"]]],
  glory: [[3, ["guiding-bolt", "heroism"]], [5, ["enhance-ability", "magic-weapon"]], [9, ["haste", "protection-from-energy"]], [13, ["compulsion", "freedom-of-movement"]], [17, ["commune", "flame-strike"]]],
  watchers: [[3, ["alarm", "detect-magic"]], [5, ["moonbeam", "see-invisibility"]], [9, ["counterspell", "nondetection"]], [13, ["aura-of-purity", "banishment"]], [17, ["hold-monster", "scrying"]]],
  crown: [[3, ["command", "compelled-duel"]], [5, ["warding-bond", "zone-of-truth"]], [9, ["aura-of-vitality", "spirit-guardians"]], [13, ["banishment", "guardian-of-faith"]], [17, ["circle-of-power", "geas"]]],
  oathbreaker: [[3, ["hellish-rebuke", "inflict-wounds"]], [5, ["crown-of-madness", "darkness"]], [9, ["animate-dead", "bestow-curse"]], [13, ["blight", "confusion"]], [17, ["contagion", "dominate-person"]]],
};

// the spells a paladin builds its list around, best first: the smite riders (bonus action, one hit) first, then the party buffs and control
const PALADIN_CORE = ["divine-favor", "shield-of-faith", "wrathful-smite", "searing-smite", "thunderous-smite", "bless", "branding-smite", "cure-wounds", "aid",
  "blinding-smite", "crusaders-mantle", "elemental-weapon", "aura-of-vitality", "banishing-smite", "circle-of-power", "aura-of-life", "aura-of-purity", "death-ward",
  "dispel-magic", "command", "heroism", "protection-from-evil-and-good", "destructive-wave"];

const castable = (id: string, maxLevel: number) => {
  const sp = SPELLS_BY_ID[id];
  return !!sp && sp.level > 0 && sp.level <= maxLevel && (!!sp.build || sp.castTime === "reaction");
};

interface Spec {
  oath: Oath;
  level: number;
  /** a greatsword + Great Weapon Fighting rather than a longsword + shield + Defense */
  twoHanded?: boolean;
  actions?: Action[];
  reactions?: Combatant["reactions"];
  traits?: Combatant["traits"];
  rules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  resistances?: DamageType[];
  resistancesNonmagical?: DamageType[];
  auraKind?: "protection" | "immunity" | "spellResistance" | "conquest";
  auraExtra?: NonNullable<Combatant["specialRules"]>;
  bonusRoutine?: string[];
  opener?: string[];
  keepDistance?: boolean;
  /** an always-on rider appended to every weapon hit (not used; kept for a future per-hit extra) */
  weaponRider?: AutomationNode[];
  /** a flat bonus folded into the weapon's own damage roll (Aura of Hate) */
  weaponBonusFlat?: number;
}

/** a Channel Divinity option: an action that spends the one use */
const channel = (id: string, name: string, automation: Action["automation"], cost: Action["cost"] = { action: 1 }, extra: Partial<Action> = {}): Action => ({
  id, name, cost, recharge: "none", limitedUse: { resource: "channel_divinity", amount: 1 }, automation, ...extra,
});
/** an id-only reaction: the mechanics live in the engine hook that reads this reaction's id */
const hook = (id: string, name: string, trigger: string, limitedUse?: { resource: string; amount: number }): NonNullable<Combatant["reactions"]>[number] => ({
  id, name, cost: { reaction: 1 }, recharge: "none", trigger, automation: [{ type: "note", text: `${name} (engine hook)` }], ...(limitedUse ? { limitedUse } : {}),
});
const chaUses = (level: number) => Math.max(1, chaMod(level));

function build(spec: Spec): Combatant {
  const { level } = spec;
  const pb = pbFor(level);
  const cha = chaMod(level);
  const str = strMod(level);
  const maxSlot = maxSlotLevel("half", level);
  const oathSpells = (OATH_SPELLS[spec.oath] ?? []).filter(([l]) => level >= l).flatMap(([, ids]) => ids).filter((id) => castable(id, maxSlot));
  const budget = preparedCount("paladin", "half", level, cha);
  const core = PALADIN_CORE.filter((id) => castable(id, maxSlot) && !oathSpells.includes(id));
  const prepared = [...new Set([...oathSpells, ...core.slice(0, budget)])];

  // ---- the weapon: a longsword + shield + Defense (AC +1) or a greatsword + Great Weapon Fighting
  const w = spec.twoHanded ? { name: "Greatsword", die: "2d6", ac: 0 } : { name: "Longsword", die: "1d8", ac: 1 };
  const attackCount = level >= 5 ? 2 : 1;
  const rider = spec.weaponRider ?? [];
  const bonusFlat = str + (spec.weaponBonusFlat ?? 0);
  type Attack = Extract<AutomationNode, { type: "attack" }>;
  const swing = (extra: AutomationNode[] = [], every: AutomationNode[] = []): AutomationNode[] => {
    const one = (): Attack => ({
      type: "attack", bonus: pb + str,
      onHit: [{ type: "damage", amount: `${w.die}+${bonusFlat}`, damageType: "slashing", weaponDice: true }, { type: "divineSmite" }, ...(level >= 11 ? [{ type: "damage" as const, amount: "1d8", damageType: "radiant" as const }] : []), ...rider, ...every],
    });
    const attacks: Attack[] = Array.from({ length: attackCount }, one);
    if (extra.length) attacks[0] = { ...attacks[0], onHit: [...attacks[0].onHit, ...extra] };
    return [{ type: "target", who: { who: "aiChoice" }, effects: attacks }];
  };
  const attack: Action = { id: "attack", name: w.name, cost: { action: 1 }, recharge: "none", automation: swing() };

  // ---- Lay on Hands (1st): worth an action once someone (self included) is missing a real chunk of its maximum
  const layOnHands: Action = {
    id: "lay-on-hands", name: "Lay on Hands", cost: { action: 1 }, recharge: "none", usableWhen: { allyHpBelow: 0.6 },
    automation: [{ type: "target", who: { who: "lowestHpAlly", includeDowned: true }, filter: { notTypes: ["undead", "construct"] }, effects: [{ type: "layOnHands" }] }],
  };

  // ---- Cleansing Touch (14th): only when an ally carries a condition worth ending
  const cleansingTouch: Action | undefined = level >= 14 ? {
    id: "cleansing-touch", name: "Cleansing Touch", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "cleansing_touch", amount: 1 },
    automation: [{ type: "branch", if: "party.ally_afflicted", then: [{ type: "target", who: { who: "afflictedAlly" }, effects: [
      ...(["paralyzed", "stunned", "petrified", "incapacitated", "restrained", "charmed", "frightened", "blinded", "poisoned", "prone"] as const)
        .map((c): AutomationNode => ({ type: "branch", if: `target.has('${c}')`, then: [{ type: "removeEffect", name: c }] })),
    ] }] }],
  } : undefined;

  // no Sacred Oath before the 3rd level: nothing that spends Channel Divinity is on the sheet yet
  const oathActions = level >= 3 ? (spec.actions ?? []) : (spec.actions ?? []).filter((a) => a.limitedUse?.resource !== "channel_divinity");
  const actions: Action[] = [attack, layOnHands, ...(cleansingTouch ? [cleansingTouch] : []), ...oathActions];
  const reactions: Combatant["reactions"] = [...(spec.reactions ?? [])];
  const traits: NonNullable<Combatant["traits"]> = [...(spec.traits ?? [])];
  const bonusRoutine: string[] = [...(spec.bonusRoutine ?? [])];
  const opener: string[] = [...(spec.opener ?? [])];
  const rules: NonNullable<Combatant["specialRules"]> = [...(spec.rules ?? []), ...(spec.twoHanded ? [{ rule: "greatWeaponFighting" as const }] : [])];
  const resources: NonNullable<Combatant["resources"]> = {
    lay_on_hands: { max: level * 5, recharge: "longRest" },
    ...(level >= 3 ? { channel_divinity: { max: 1, recharge: "shortRest" } } : {}),
    ...(level >= 14 ? { cleansing_touch: { max: chaUses(level), recharge: "longRest" } } : {}),
    ...(spec.resources ?? {}),
  };

  // Aura of Protection (6th), Aura of Courage (10th)
  if (level >= 6) rules.push({ rule: "paladinAura", kind: "protection", rangeFt: level >= 18 ? 30 : 10, bonus: Math.max(1, cha) });
  if (level >= 10) rules.push({ rule: "paladinAura", kind: "immunity", rangeFt: level >= 18 ? 30 : 10, conditions: ["frightened"] });
  // the oath's own 7th/18th-level aura
  if (level >= 7 && spec.auraKind) rules.push({ rule: "paladinAura", kind: spec.auraKind, rangeFt: level >= 18 ? 30 : 10, ...(spec.auraKind === "immunity" ? { conditions: ["charmed"] } : spec.auraKind === "conquest" ? { bonus: Math.floor(level / 2) } : {}) });
  if (level >= 7) rules.push(...(spec.auraExtra ?? []));

  const built = makeCaster({
    id: `${spec.oath}-paladin`, name: `Paladin ${level}`, level, spellClass: "paladin", casterKind: "half", spellAbility: "cha",
    ac: 16 + w.ac + (spec.twoHanded ? 0 : 2), hp: between(level, 10 + CON * 1, 10 + 19 * 8),
    abilities: { str: score(str), dex: score(0), con: score(CON), int: score(0), wis: score(1), cha: score(cha) },
    proficientSaves: ["wis", "cha"],
    prepared, cantrips: [],
    extraActions: actions, extraReactions: reactions, extraTraits: traits,
    keepDistance: spec.keepDistance ?? false, targetPriority: "lowestHp", opener,
  });
  return {
    ...built,
    resources: { ...built.resources, ...resources },
    specialRules: [...built.specialRules, ...rules],
    resistances: [...built.resistances, ...(spec.resistances ?? [])],
    resistancesNonmagical: [...built.resistancesNonmagical, ...(spec.resistancesNonmagical ?? [])],
    ai: { ...built.ai, bonusRoutine: [...new Set(bonusRoutine)] },
    initiativeBonus: level >= 7 && spec.oath === "watchers" ? pb : 0, // Aura of the Sentinel (self only, approximated): +proficiency bonus
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------- Devotion
function devotion(level: number): Combatant {
  const dc = 8 + pbFor(level) + chaMod(level);
  return build({
    oath: "devotion", level, auraKind: "immunity",
    resources: level >= 20 ? { holy_nimbus: { max: 1, recharge: "longRest" } } : undefined,
    // Purity of Spirit (15th): "aberrations, celestials, elementals, fey, fiends, and undead have disadvantage on attack rolls against you"
    rules: level >= 15 ? [{ rule: "disadvantageFromTypes" as const, types: ["aberration", "celestial", "elemental", "fey", "fiend", "undead"] as const }] : undefined,
    actions: [
      channel("sacred-weapon", "Sacred Weapon", [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "sacred-weapon", durationRounds: 10, mods: { attackBonusAll: Math.max(1, chaMod(level)) } }] }]),
      channel("turn-the-unholy", "Turn the Unholy", [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, filter: { types: ["fiend", "undead"], strictTypes: true }, effects: [{
        type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "turned", durationRounds: 10, endsOnDamage: true }], onSuccess: [],
      }] }]),
      ...(level >= 20 ? [{
        id: "holy-nimbus", name: "Holy Nimbus", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "holy_nimbus", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hasnt('holy-nimbus')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "holy-nimbus", durationRounds: 10 }] }] }],
      }] : []),
    ],
    bonusRoutine: ["sacred-weapon"],
    opener: ["turn-the-unholy", ...(level >= 20 ? ["holy-nimbus"] : [])],
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------- Ancients
function ancients(level: number): Combatant {
  const dc = 8 + pbFor(level) + chaMod(level);
  return build({
    oath: "ancients", level, auraKind: "spellResistance",
    rules: level >= 15 ? [{ rule: "undyingReturn" as const, returnHp: 1, oncePer: "encounter" as const }] : undefined,
    actions: [
      channel("natures-wrath", "Nature's Wrath", [{ type: "target", who: { who: "aiChoice" }, effects: [{
        type: "save", ability: "str", dc, onFail: [{ type: "applyCondition", condition: "restrained", durationRounds: 10, saveEnds: { ability: "str", dc, at: "endOfTurn" } }], onSuccess: [],
      }] }]),
      channel("turn-the-faithless", "Turn the Faithless", [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, filter: { types: ["fey", "fiend"], strictTypes: true }, effects: [{
        type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "turned", durationRounds: 10, endsOnDamage: true }], onSuccess: [],
      }] }]),
      ...(level >= 20 ? [{
        id: "elder-champion", name: "Elder Champion", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "elder_champion", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hasnt('elder-champion')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [
          { type: "applyEffect" as const, name: "elder-champion", durationRounds: 10, tick: [{ type: "heal" as const, amount: "10" }] },
        ] }] }],
      }] : []),
    ],
    resources: level >= 20 ? { elder_champion: { max: 1, recharge: "longRest" } } : undefined,
    opener: ["natures-wrath", "turn-the-faithless", ...(level >= 20 ? ["elder-champion"] : [])],
  });
}

// --------------------------------------------------------------------------------------------------------------------------------- Vengeance
function vengeance(level: number): Combatant {
  const dc = 8 + pbFor(level) + chaMod(level);
  return build({
    oath: "vengeance", level, twoHanded: true,
    actions: [
      channel("abjure-enemy", "Abjure Enemy", [{ type: "target", who: { who: "aiChoice" }, effects: [{
        type: "save", ability: "wis", dc,
        // "the target's speed is 0" while frightened this way isn't separately tracked; the frightened condition (endsOnDamage, as printed) is
        onFail: [{ type: "applyCondition", condition: "frightened", durationRounds: 10, endsOnDamage: true }],
        onSuccess: [{ type: "applyEffect", name: "abjured-half", durationRounds: 2, mods: { speedBonusFt: -15 } }],
      }] }]),
      {
        id: "vow-of-enmity", name: "Vow of Enmity", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "channel_divinity", amount: 1 },
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "applyEffect", name: "vow-of-enmity", durationRounds: 10, mods: { attacksAgainstItAdvantage: "adv", advantageFromSourceOnly: true } }] }],
      },
      ...(level >= 20 ? [{
        id: "avenging-angel", name: "Avenging Angel", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "avenging_angel", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hasnt('avenging-angel')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "avenging-angel", durationRounds: 10, mods: { inspirationDc: dc } }] }] }],
      }] : []),
    ],
    reactions: [hook("soul-of-vengeance", "Soul of Vengeance", "the vowed enemy makes an attack")],
    resources: level >= 20 ? { avenging_angel: { max: 1, recharge: "longRest" } } : undefined,
    bonusRoutine: ["vow-of-enmity"],
    opener: [...(level >= 20 ? ["avenging-angel"] : [])],
  });
}

// --------------------------------------------------------------------------------------------------------------------------------- Conquest
function conquest(level: number): Combatant {
  const dc = 8 + pbFor(level) + chaMod(level);
  return build({
    oath: "conquest", level, twoHanded: true, auraKind: "conquest",
    rules: level >= 3 ? [{ rule: "guidedStrike" as const, resource: "channel_divinity" }] : undefined,
    actions: [
      channel("conquering-presence", "Conquering Presence", [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [{
        type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "frightened", durationRounds: 10, saveEnds: { ability: "wis", dc, at: "endOfTurn" } }], onSuccess: [],
      }] }]),
      ...(level >= 20 ? [
        { id: "invincible-conqueror", name: "Invincible Conqueror", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "invincible_conqueror", amount: 1 },
          automation: [{ type: "branch" as const, if: "self.hasnt('invincible-conqueror')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [
            { type: "applyEffect" as const, name: "invincible-conqueror", durationRounds: 10, mods: { critRange: 19, resistTypes: ALL_DAMAGE_TYPES } },
          ] }] }] },
        // "you can make one additional weapon attack as part of the Attack action" while transformed
        { id: "attack-conqueror-strike", name: "Conqueror's Strike", cost: { bonus: 1 }, recharge: "none" as const,
          automation: [{ type: "branch" as const, if: "self.has('invincible-conqueror')", then: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [{
            type: "attack" as const, bonus: pbFor(level) + strMod(level), onHit: [{ type: "damage" as const, amount: `2d6+${strMod(level)}`, damageType: "slashing" as const }],
          }] }] }] },
      ] : []),
    ],
    traits: level >= 15 ? [{
      id: "scornful-rebuke", name: "Scornful Rebuke", trigger: "whenHitByAttack",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: String(Math.max(1, chaMod(level))), damageType: "psychic" }] }],
    }] : undefined,
    resources: level >= 20 ? { invincible_conqueror: { max: 1, recharge: "longRest" } } : undefined,
    opener: ["conquering-presence", ...(level >= 20 ? ["invincible-conqueror"] : [])],
  });
}

// -------------------------------------------------------------------------------------------------------------------------------- Redemption
function redemption(level: number): Combatant {
  return build({
    oath: "redemption", level, keepDistance: false,
    rules: level >= 15 ? [{ rule: "protectiveSpirit" as const }] : undefined,
    reactions: [
      hook("aura-of-the-guardian", "Aura of the Guardian", "an ally near you takes damage"),
      ...(level >= 3 ? [hook("rebuke-the-violent", "Rebuke the Violent", "a creature near you damages another with an attack")] : []),
    ],
    actions: level >= 20 ? [{
      id: "emissary-of-redemption", name: "Emissary of Redemption", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "emissary_of_redemption", amount: 1 },
      // approximated: resistance to everything, and half of what lands (after resistance) reflects as radiant — the printed exclusion for a creature "you've attacked, cast a spell on, or dealt damage to" isn't tracked
      automation: [{ type: "branch", if: "self.hasnt('emissary-of-redemption')", then: [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "emissary-of-redemption", durationRounds: 600, mods: {
        resistTypes: ALL_DAMAGE_TYPES,
      } }] }] }],
    }] : undefined,
    resources: level >= 20 ? { emissary_of_redemption: { max: 1, recharge: "longRest" } } : undefined,
    bonusRoutine: level >= 20 ? ["emissary-of-redemption"] : undefined,
  });
}

// ------------------------------------------------------------------------------------------------------------------------------------ Glory
function glory(level: number): Combatant {
  return build({
    oath: "glory", level,
    actions: [
      ...(level >= 3 ? [{
        id: "inspiring-smite", name: "Inspiring Smite", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "channel_divinity", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.smote_this_turn", then: [{ type: "target" as const, who: { who: "eachAlly" as const, withinFt: 30 }, effects: [{ type: "tempHp" as const, amount: `2d8+${level}` }] }] }],
      }] : []),
      ...(level >= 20 ? [{
        id: "living-legend", name: "Living Legend", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "living_legend", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hasnt('living-legend')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "living-legend", durationRounds: 10, mods: { livingLegend: true } }] }] }],
      }] : []),
    ],
    reactions: level >= 15 ? [hook("glorious-defense", "Glorious Defense", "a creature near you is hit", { resource: "glorious_defense", amount: 1 })] : undefined,
    resources: {
      ...(level >= 15 ? { glorious_defense: { max: chaUses(level), recharge: "longRest" } } : {}),
      ...(level >= 20 ? { living_legend: { max: 1, recharge: "longRest" } } : {}),
    },
    bonusRoutine: [...(level >= 3 ? ["inspiring-smite"] : []), ...(level >= 20 ? ["living-legend"] : [])],
    traits: level >= 7 ? [{ id: "aura-of-alacrity", name: "Aura of Alacrity", trigger: "encounterStart", automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "aura-of-alacrity", durationRounds: 999, mods: { speedBonusFt: 10 } }] }] }] : undefined,
  });
}

// -------------------------------------------------------------------------------------------------------------------------------- Watchers
function watchers(level: number): Combatant {
  const dc = 8 + pbFor(level) + chaMod(level);
  return build({
    oath: "watchers", level, // Aura of the Sentinel has no direct combat number; the initiative bump (self only) is handled separately below
    actions: [
      channel("watchers-will", "Watcher's Will", [{ type: "target", who: { who: "eachAlly", limit: Math.max(1, chaMod(level)) }, effects: [{
        type: "applyEffect", name: "watchers-will", durationRounds: 10, mods: { saveAdvantageOn: ["int" as const, "wis" as const, "cha" as const] },
      }] }]),
      channel("abjure-the-extraplanar", "Abjure the Extraplanar", [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, filter: { types: ["aberration", "celestial", "elemental", "fey", "fiend"], strictTypes: true }, effects: [{
        type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "turned", durationRounds: 10, endsOnDamage: true }], onSuccess: [],
      }] }]),
      ...(level >= 20 ? [{
        id: "mortal-bulwark", name: "Mortal Bulwark", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "mortal_bulwark", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hasnt('mortal-bulwark')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "mortal-bulwark", durationRounds: 10 }] }] }],
      }] : []),
    ],
    reactions: level >= 15 ? [hook("vigilant-rebuke", "Vigilant Rebuke", "you or an ally succeeds on an Intelligence, Wisdom or Charisma saving throw")] : undefined,
    resources: level >= 20 ? { mortal_bulwark: { max: 1, recharge: "longRest" } } : undefined,
    opener: ["watchers-will", "abjure-the-extraplanar", ...(level >= 20 ? ["mortal-bulwark"] : [])],
  });
}

// ------------------------------------------------------------------------------------------------------------------------------------ Crown
function crown(level: number): Combatant {
  const cha = chaMod(level);
  return build({
    oath: "crown", level, // Divine Allegiance reuses the same engine hook as Redemption's Aura of the Guardian
    rules: level >= 15 ? [{ rule: "advantageOnSavesAgainst", conditions: ["paralyzed", "stunned"] }] : undefined,
    actions: [
      channel("champion-challenge", "Champion Challenge", [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [{
        type: "save", ability: "wis", dc: 8 + pbFor(level) + cha, onFail: [{ type: "applyCondition", condition: "marked-for-reckoning", durationRounds: 10 }], onSuccess: [],
      }] }]),
      channel("turn-the-tide", "Turn the Tide", [{ type: "branch", if: "party.missing_hp >= 6", then: [{
        type: "target", who: { who: "eachAlly", withinFt: 30 }, effects: [{ type: "heal", amount: `1d6+${Math.max(1, cha)}` }],
      }] }]),
      ...(level >= 20 ? [{
        id: "exalted-champion", name: "Exalted Champion", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "exalted_champion", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hasnt('exalted-champion')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "exalted-champion", durationRounds: 600, mods: { saveAdvantageOn: ["wis" as const] } }] }] }],
      }] : []),
    ],
    reactions: [hook("divine-allegiance", "Divine Allegiance", "an ally near you takes damage")],
    resistancesNonmagical: level >= 20 ? ["bludgeoning", "piercing", "slashing"] : undefined,
    resources: level >= 20 ? { exalted_champion: { max: 1, recharge: "longRest" } } : undefined,
    opener: ["champion-challenge", ...(level >= 20 ? ["exalted-champion"] : [])],
    bonusRoutine: ["turn-the-tide"],
  });
}

// ------------------------------------------------------------------------------------------------------------------------------ Oathbreaker
function oathbreaker(level: number): Combatant {
  const dc = 8 + pbFor(level) + chaMod(level);
  return build({
    oath: "oathbreaker", level, twoHanded: true, weaponBonusFlat: level >= 7 ? Math.max(1, chaMod(level)) : 0, // Aura of Hate, self-only (no undead/fiend allies to extend it to)
    resistancesNonmagical: level >= 15 ? ["bludgeoning", "piercing", "slashing"] : undefined,
    actions: [
      channel("control-undead", "Control Undead", [{ type: "target", who: { who: "aiChoice" }, filter: { types: ["undead"], strictTypes: true }, effects: [{
        type: "branch", if: `target.cr_below(${level})`, then: [{ type: "save", ability: "wis", dc, onFail: [{ type: "takeControl" }], onSuccess: [] }],
      }] }]),
      channel("dreadful-aspect", "Dreadful Aspect", [{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [{
        type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "frightened", durationRounds: 10, saveEnds: { ability: "wis", dc, at: "endOfTurn" } }], onSuccess: [],
      }] }]),
      ...(level >= 20 ? [
        { id: "dread-lord", name: "Dread Lord", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "dread_lord", amount: 1 },
          automation: [{ type: "branch" as const, if: "self.hasnt('dread-lord')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "dread-lord", durationRounds: 10 }] }] }] },
        { id: "attack-dread-lord-strike", name: "Dread Lord's Touch", cost: { bonus: 1 }, recharge: "none" as const,
          automation: [{ type: "branch" as const, if: "self.has('dread-lord')", then: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [{ type: "attack" as const, bonus: pbFor(level) + chaMod(level), onHit: [{ type: "damage" as const, amount: "3d10", damageType: "necrotic" as const }] }] }] }] },
      ] : []),
    ],

    resources: level >= 20 ? { dread_lord: { max: 1, recharge: "longRest" } } : undefined,
    opener: ["dreadful-aspect", ...(level >= 20 ? ["dread-lord"] : [])],
    bonusRoutine: level >= 20 ? ["attack-dread-lord-strike"] : undefined,
  });
}

export const PALADIN_BUILDERS: Record<string, (level: number) => Combatant> = {
  "devotion-paladin": devotion,
  "ancients-paladin": ancients,
  "vengeance-paladin": vengeance,
  "conquest-paladin": conquest,
  "redemption-paladin": redemption,
  "glory-paladin": glory,
  "watchers-paladin": watchers,
  "crown-paladin": crown,
  "oathbreaker-paladin": oathbreaker,
};
