// The warlock and its patrons, built from the printed text (dnd5e.wikidot.com/warlock and each patron's page): Archfey, Fiend and Great Old One (Player's Handbook), Undying (Sword Coast),
// Celestial and Hexblade (Xanathar's), Genie and Fathomless (Tasha's), Undead (Van Richten's). The Genie is four templates, one for each kind (Dao, Djinni, Efreeti, Marid).
//
// Base class (the Warlock table): Pact Magic — Charisma casting, slots that are all one level (1st at 1st level up to 5th at 9th), two of them (three from 11th, four from 17th) and
// back on a SHORT or long rest; spells known 2 rising to 15, cantrips 2 / 3 / 4 (levels 1 / 4 / 10); proficient in Wisdom and Charisma saves; a d8 hit die; light armor and simple weapons.
// Eldritch Invocations (2nd): two, rising to eight. Pact Boon (3rd). Mystic Arcanum (11th, 13th, 15th, 17th): one spell of 6th / 7th / 8th / 9th level, once each per long rest.
// A patron's Expanded Spell List only widens what the warlock may choose from — those spells are learned like any other and count against spells known.
//
// Build assumptions the books leave open: Charisma 18 (20 from 17th), Dexterity 14, Constitution 14; studded leather (AC 14), or Mage Armor at will from the Armor of Shadows invocation
// (AC 15), which a Tome or Chain build takes early and a Blade build once its first five are chosen; the Hexblade wears scale mail and a shield (AC 18). Every build takes Agonizing Blast.
// The pact boon is a choice made at the 3rd level (before it every warlock is the same Eldritch Blast caster), and four are built: Tome (three extra cantrips), Blade (a pact weapon — a longsword for the
// Hexblade, a rapier for the rest — with Improved Pact Weapon, Thirsting Blade, Eldritch Smite, Lifedrinker, Grasp of Hadar), Chain (an imp familiar that Helps, and stings on the warlock's command with
// Investment of the Chain Master) and Talisman (an amulet on the sturdiest ally, with Rebuke and Protection of the Talisman). A patron's plain id is the Tome build (the Hexblade's is the Blade), and
// `-blade` / `-tome` / `-chain` / `-talisman` name the others. The imp is the only familiar offered (pseudodragon, quasit and sprite are the other special forms); the Tome build's Repelling Blast and
// Lance of Lethargy, and the Blade build's Grasp of Hadar, are why those are the ones picked.
//
// Not modeled anywhere: Eldritch Master (20th: a minute to regain every slot), Eldritch Spear, Devil's Sight and the other utility invocations, Tomb of Levistus, Cloak of Flies, Beguiling Defenses'
// reflection, Fathomless Plunge, Gift of the Sea, Limited Wish, Genie's Vessel and Sanctuary Vessel, Elemental Gift's flight, Spirit Projection, Grave Touched's change of damage type, Among the Dead
// against spells, Awakened Mind, Create Thrall's permanence past the fight, Undying Nature, the Chain familiar's forgone-attack reaction (it needs the Attack action, and Eldritch Blast is a spell),
// Voice of the Chain Master, Celestial's bonus cantrip Light (it has no automation) and Spare the Dying. The catalog has automation for only three warlock cantrips (Eldritch Blast, Chill Touch,
// Poison Spray), so the fourth cantrip at 10th level isn't filled. Known approximations: the AI never chooses Bond of the Talisman; forced movement is one square (5 feet) at a time along the nearest of
// eight directions; Necrotic Husk and the "1d4 long rests" features come back every long rest; Necrotic Husk's exhaustion and immunity are dropped; Dark Delirium and Fey Presence's charm-or-fear are built
// as the charm (a turned creature for Dark Delirium); Maddening Hex hits only the cursed creature; Hurl Through Hell's 10d10 lands the moment the creature is sent away, not when it returns.

import type { Action, AutomationNode, Combatant, DamageType } from "../schema";
import { between, pbFor, score } from "../engine/pcBase";
import { accursedSpecterFor, impFamiliarFor } from "../engine/minions";
import { makeCaster } from "./caster";
import { SPELLS_BY_ID } from "./catalog";
import { spellActions, type CasterCtx } from "./cast";
import { cantripsKnown, preparedCount } from "./prepare";
import { pactSlotLevel } from "./slots";
import { addFlatBonus, mapNodes } from "./spellTransforms";

const chaMod = (level: number) => (pbFor(level) === 6 ? 5 : 4);
const DEX = 2;
const CON = 2;

export type Patron = "archfey" | "celestial" | "fathomless" | "fiend" | "great-old-one" | "hexblade" | "undead" | "undying" | "dao" | "djinni" | "efreeti" | "marid";
export type Boon = "tome" | "blade" | "chain" | "talisman";

// ------------------------------------------------------------------------------------------------------------------------------- expanded spell lists
const EXPANDED: Record<Patron, [number, string[]][]> = {
  archfey: [[1, ["faerie-fire", "sleep"]], [2, ["calm-emotions", "phantasmal-force"]], [3, ["blink", "plant-growth"]], [4, ["dominate-beast", "greater-invisibility"]], [5, ["dominate-person", "seeming"]]],
  celestial: [[1, ["cure-wounds", "guiding-bolt"]], [2, ["flaming-sphere", "lesser-restoration"]], [3, ["daylight", "revivify"]], [4, ["guardian-of-faith", "wall-of-fire"]], [5, ["flame-strike", "greater-restoration"]]],
  fathomless: [[1, ["create-or-destroy-water", "thunderwave"]], [2, ["gust-of-wind", "silence"]], [3, ["lightning-bolt", "sleet-storm"]], [4, ["control-water", "summon-elemental"]], [5, ["bigbys-hand", "cone-of-cold"]]],
  fiend: [[1, ["burning-hands", "command"]], [2, ["blindness-deafness", "scorching-ray"]], [3, ["fireball", "stinking-cloud"]], [4, ["fire-shield", "wall-of-fire"]], [5, ["flame-strike", "hallow"]]],
  "great-old-one": [[1, ["dissonant-whispers", "tashas-hideous-laughter"]], [2, ["detect-thoughts", "phantasmal-force"]], [3, ["clairvoyance", "sending"]], [4, ["dominate-beast", "evards-black-tentacles"]], [5, ["dominate-person", "telekinesis"]]],
  hexblade: [[1, ["shield", "wrathful-smite"]], [2, ["blur", "branding-smite"]], [3, ["blink", "elemental-weapon"]], [4, ["phantasmal-killer", "staggering-smite"]], [5, ["banishing-smite", "cone-of-cold"]]],
  undead: [[1, ["bane", "false-life"]], [2, ["blindness-deafness", "phantasmal-force"]], [3, ["phantom-steed", "speak-with-dead"]], [4, ["death-ward", "greater-invisibility"]], [5, ["antilife-shell", "cloudkill"]]],
  undying: [[1, ["false-life", "ray-of-sickness"]], [2, ["blindness-deafness", "silence"]], [3, ["feign-death", "speak-with-dead"]], [4, ["aura-of-life", "death-ward"]], [5, ["contagion", "legend-lore"]]],
  // the Genie: a list all four kinds share, and one for each kind
  dao: [[1, ["detect-evil-and-good", "sanctuary"]], [2, ["phantasmal-force", "spike-growth"]], [3, ["create-food-and-water", "meld-into-stone"]], [4, ["phantasmal-killer", "stone-shape"]], [5, ["creation", "wall-of-stone"]]],
  djinni: [[1, ["detect-evil-and-good", "thunderwave"]], [2, ["phantasmal-force", "gust-of-wind"]], [3, ["create-food-and-water", "wind-wall"]], [4, ["phantasmal-killer", "greater-invisibility"]], [5, ["creation", "seeming"]]],
  efreeti: [[1, ["detect-evil-and-good", "burning-hands"]], [2, ["phantasmal-force", "scorching-ray"]], [3, ["create-food-and-water", "fireball"]], [4, ["phantasmal-killer", "fire-shield"]], [5, ["creation", "flame-strike"]]],
  marid: [[1, ["detect-evil-and-good", "fog-cloud"]], [2, ["phantasmal-force", "blur"]], [3, ["create-food-and-water", "sleet-storm"]], [4, ["phantasmal-killer", "control-water"]], [5, ["creation", "cone-of-cold"]]],
};

// the spells a warlock builds its list around, best first (Hex, Hellish Rebuke and Armor of Agathys are the class's signatures); the patron's own expanded spells take the last places
const CORE_SPELLS = ["hex", "hellish-rebuke", "armor-of-agathys", "misty-step", "hold-person", "counterspell", "hunger-of-hadar", "fear", "hypnotic-pattern", "vampiric-touch", "banishment", "blight",
  "hold-monster", "dimension-door", "shatter", "invisibility", "mirror-image", "dispel-magic", "charm-monster", "fly", "arms-of-hadar", "witch-bolt", "suggestion", "crown-of-madness"];
const ARCANUM: Record<number, string[]> = {
  6: ["circle-of-death", "eyebite", "mass-suggestion", "flesh-to-stone", "conjure-fey", "create-undead"],
  7: ["finger-of-death", "forcecage"],
  8: ["dominate-monster", "power-word-stun", "feeblemind"],
  9: ["power-word-kill", "psychic-scream", "foresight", "imprisonment", "true-polymorph"],
};
const TOME_CANTRIPS = ["fire-bolt", "sacred-flame", "vicious-mockery", "shocking-grasp", "produce-flame", "toll-the-dead", "thorn-whip"];

const castable = (id: string, maxLevel: number) => {
  const sp = SPELLS_BY_ID[id];
  return !!sp && sp.level > 0 && sp.level <= maxLevel && (!!sp.build || sp.castTime === "reaction");
};

// ---------------------------------------------------------------------------------------------------------------------------------- invocations
/** how many eldritch invocations the Warlock table gives */
const invocationsKnown = (level: number) => [0, 0, 2, 2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8][Math.max(1, Math.min(20, level))] ?? 0;

// invocations that cast a spell "once using a warlock spell slot" (or for free) and can't be used again until a long rest: [key, spell, level required, casts without a slot?]
const SPELL_INVOCATIONS: Record<string, { spell: string; name: string; minLevel: number; free?: boolean }> = {
  "mire-the-mind": { spell: "slow", name: "Mire the Mind", minLevel: 5 },
  "dreadful-word": { spell: "confusion", name: "Dreadful Word", minLevel: 7 },
  "sign-of-ill-omen": { spell: "bestow-curse", name: "Sign of Ill Omen", minLevel: 5 },
  "bewitching-whispers": { spell: "compulsion", name: "Bewitching Whispers", minLevel: 7 },
  "thief-of-five-fates": { spell: "bane", name: "Thief of Five Fates", minLevel: 2 },
  "sculptor-of-flesh": { spell: "polymorph", name: "Sculptor of Flesh", minLevel: 7 },
  "minions-of-chaos": { spell: "conjure-elemental", name: "Minions of Chaos", minLevel: 9 },
  "undying-servitude": { spell: "animate-dead", name: "Undying Servitude", minLevel: 5, free: true },
  "tricksters-escape": { spell: "freedom-of-movement", name: "Trickster's Escape", minLevel: 7, free: true },
};

type Pick = { id: string; minLevel: number };
// (an invocation that needs a pact boon is only available from the 3rd level, when the boon is chosen)
const TOME_PICKS: Pick[] = [
  { id: "agonizing-blast", minLevel: 2 }, { id: "armor-of-shadows", minLevel: 2 }, { id: "repelling-blast", minLevel: 2 }, { id: "maddening-hex", minLevel: 5 }, { id: "eldritch-mind", minLevel: 2 },
  { id: "lance-of-lethargy", minLevel: 2 }, { id: "fiendish-vigor", minLevel: 2 }, { id: "mire-the-mind", minLevel: 5 }, { id: "dreadful-word", minLevel: 7 }, { id: "sign-of-ill-omen", minLevel: 5 },
  { id: "bewitching-whispers", minLevel: 7 }, { id: "thief-of-five-fates", minLevel: 2 }, { id: "minions-of-chaos", minLevel: 9 },
];
const BLADE_PICKS: Pick[] = [
  { id: "improved-pact-weapon", minLevel: 3 }, { id: "agonizing-blast", minLevel: 2 }, { id: "thirsting-blade", minLevel: 5 }, { id: "eldritch-smite", minLevel: 5 }, { id: "armor-of-shadows", minLevel: 2 },
  { id: "grasp-of-hadar", minLevel: 2 }, { id: "relentless-hex", minLevel: 7 }, { id: "lifedrinker", minLevel: 12 }, { id: "maddening-hex", minLevel: 5 }, { id: "eldritch-mind", minLevel: 2 },
  { id: "fiendish-vigor", minLevel: 2 }, { id: "mire-the-mind", minLevel: 5 },
];
const CHAIN_PICKS: Pick[] = [
  { id: "agonizing-blast", minLevel: 2 }, { id: "investment-of-the-chain-master", minLevel: 3 }, { id: "armor-of-shadows", minLevel: 2 }, { id: "repelling-blast", minLevel: 2 }, { id: "maddening-hex", minLevel: 5 },
  { id: "eldritch-mind", minLevel: 2 }, { id: "gift-of-the-ever-living-ones", minLevel: 3 }, { id: "chains-of-carceri", minLevel: 15 }, { id: "lance-of-lethargy", minLevel: 2 }, { id: "fiendish-vigor", minLevel: 2 },
];
const TALISMAN_PICKS: Pick[] = [
  { id: "agonizing-blast", minLevel: 2 }, { id: "rebuke-of-the-talisman", minLevel: 3 }, { id: "armor-of-shadows", minLevel: 2 }, { id: "repelling-blast", minLevel: 2 }, { id: "protection-of-the-talisman", minLevel: 7 },
  { id: "bond-of-the-talisman", minLevel: 12 }, { id: "maddening-hex", minLevel: 5 }, { id: "eldritch-mind", minLevel: 2 }, { id: "lance-of-lethargy", minLevel: 2 }, { id: "fiendish-vigor", minLevel: 2 },
];
const PICKS: Record<Boon, Pick[]> = { tome: TOME_PICKS, blade: BLADE_PICKS, chain: CHAIN_PICKS, talisman: TALISMAN_PICKS };

function chooseInvocations(level: number, boon: Boon, hexblade: boolean): Set<string> {
  const picks = PICKS[boon].filter((p) => !(hexblade && p.id === "armor-of-shadows")); // the Hexblade wears real armor
  const out: string[] = [];
  for (const p of picks) {
    if (out.length >= invocationsKnown(level)) break;
    if (level >= p.minLevel) out.push(p.id);
  }
  return new Set(out);
}

// ------------------------------------------------------------------------------------------------------------------------------------ the chassis
interface Spec {
  patron: Patron;
  boon: Boon;
  level: number;
  idOverride?: string;
}

const isHexblade = (p: Patron) => p === "hexblade";
const GENIE_TYPE: Partial<Record<Patron, DamageType>> = { dao: "bludgeoning", djinni: "thunder", efreeti: "fire", marid: "cold" };

function build(spec: Spec): Combatant {
  const { patron, boon, level } = spec;
  const pb = pbFor(level);
  const cha = chaMod(level);
  const dc = 8 + pb + cha;
  const hexblade = isHexblade(patron);
  // "Pact Boon (3rd)": before it, every warlock is the same Eldritch Blast caster. The Hexblade's Hex Warrior gives a martial weapon and Charisma from the 1st level regardless.
  const boonActive = level >= 3;
  const effBoon: Boon = boonActive ? boon : "tome";
  const pactBlade = effBoon === "blade";
  const wieldsWeapon = pactBlade || (hexblade && boon === "blade");
  const inv = chooseInvocations(level, effBoon, hexblade);
  const has = (id: string) => inv.has(id);
  const pact = pactSlotLevel(level);
  const cc: CasterCtx = { kind: "warlock", level, pb, spellMod: cha };
  const ctx = { casterLevel: level, spellMod: cha, pb, dc, toHit: pb + cha, slotLevel: 0 };
  const genieType = GENIE_TYPE[patron];

  // ---- spells known: the class's signature list, with the patron's own spells in the last places
  const budget = preparedCount("warlock", "warlock", level, cha);
  const patronFloor = Math.min(3, Math.floor(budget / 3));
  const patronSpells = EXPANDED[patron].flatMap(([, ids]) => ids).filter((id) => castable(id, pact))
    .sort((a, b) => SPELLS_BY_ID[b].level - SPELLS_BY_ID[a].level).slice(0, patronFloor);
  const core = CORE_SPELLS.filter((id) => castable(id, pact) && !patronSpells.includes(id));
  const known = [...new Set([...core.slice(0, budget - patronSpells.length), ...patronSpells])].slice(0, budget);
  // Mystic Arcanum: one spell each of the 6th, 7th, 8th and 9th level, as the table gives them
  const arcanum: string[] = [];
  for (const [lvl, need] of [[6, 11], [7, 13], [8, 15], [9, 17]] as const) {
    if (level < need) continue;
    const spell = ARCANUM[lvl].find((id) => !!SPELLS_BY_ID[id]?.build);
    if (spell) arcanum.push(spell);
  }
  // cantrips: Eldritch Blast is the `attack` action; the rest of the two / three / four, then the Tome's three, then the patron's own
  const cantrips = ["chill-touch", "poison-spray"].filter((id) => !!SPELLS_BY_ID[id]?.build).slice(0, Math.max(0, cantripsKnown("warlock", level) - 1));
  if (effBoon === "tome" && boonActive) cantrips.push(...TOME_CANTRIPS.filter((id) => !!SPELLS_BY_ID[id]?.build).slice(0, 3));
  if (patron === "celestial") cantrips.push(...["sacred-flame", "light"].filter((id) => !!SPELLS_BY_ID[id]?.build && !cantrips.includes(id)));

  // ---- riders that ride on a hit: Genie's Wrath, Lifedrinker, Grave Touched (every hit, once a turn where the book says so) and the once-a-turn saves (Form of Dread's fear)
  const everyHitBlast: AutomationNode[] = [];
  const everyHitWeapon: AutomationNode[] = [];
  const firstHit: AutomationNode[] = [];
  if (genieType) { const w: AutomationNode = { type: "damage", amount: String(pb), damageType: genieType, oncePerTurn: "genies-wrath" }; everyHitBlast.push(w); everyHitWeapon.push(w); }
  if (pactBlade && has("lifedrinker")) everyHitWeapon.push({ type: "damage", amount: String(Math.max(1, cha)), damageType: "necrotic" });
  // Grasp of Hadar and Lance of Lethargy (once on each of your turns when you hit with the blast) and Repelling Blast (every hit): pull, slow and push
  if (has("grasp-of-hadar")) everyHitBlast.push({ type: "move", kind: "pull", distance: 10, oncePerTurn: "grasp-of-hadar" });
  if (has("lance-of-lethargy")) everyHitBlast.push({ type: "applyEffect", name: "lance-of-lethargy", durationRounds: 1, mods: { speedBonusFt: -10, untilSourceNextTurn: true }, oncePerTurn: "lance-of-lethargy" });
  if (has("repelling-blast")) everyHitBlast.push({ type: "move", kind: "push", distance: 10 });
  if (patron === "undead") {
    if (level >= 6) {
      everyHitBlast.push({ type: "branch", if: "self.has('form-of-dread')", then: [{ type: "damage", amount: "1d10", damageType: "necrotic", oncePerTurn: "grave-touched" }] });
      everyHitWeapon.push({ type: "branch", if: "self.has('form-of-dread')", then: [{ type: "damage", amount: "1d8", damageType: "necrotic", oncePerTurn: "grave-touched" }] });
    }
    firstHit.push({ type: "branch", if: "self.has('form-of-dread')", then: [{ type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "frightened", durationRounds: 1 }], onSuccess: [] }] });
  }
  const withRiders = (nodes: AutomationNode[], every: AutomationNode[], first: AutomationNode[]): AutomationNode[] => {
    let seen = false;
    return mapNodes(nodes, (n) => {
      if (n.type !== "attack") return n;
      const extra = seen ? every : [...every, ...first];
      seen = true;
      return { ...n, onHit: [...n.onHit, ...extra] };
    });
  };

  // ---- Eldritch Blast, with Agonizing Blast (+ Charisma to each beam's damage)
  const blastBase = SPELLS_BY_ID["eldritch-blast"].build!(ctx);
  const agonizing = has("agonizing-blast") ? mapNodes(blastBase, (n) => (n.type === "damage" ? { ...n, amount: addFlatBonus(n.amount, cha) } : n)) : blastBase;
  const blastNodes = withRiders(agonizing, everyHitBlast, firstHit);
  const blast = (id: string): Action => ({ id, name: "Eldritch Blast", cost: { action: 1 }, recharge: "none", isSpell: true, school: "evocation", spellLevel: 0, ranged: true, automation: blastNodes });

  // ---- the pact weapon (Pact of the Blade): a longsword for the Hexblade (Charisma), a rapier for the rest (Dexterity); Thirsting Blade makes two attacks
  const improved = pactBlade && has("improved-pact-weapon") ? 1 : 0;
  const weaponMod = hexblade ? cha : DEX;
  const weaponAttack = (extraOnFirst: AutomationNode[] = []): AutomationNode[] => {
    const dmg: DamageType = hexblade ? "slashing" : "piercing";
    const one = (): AutomationNode => ({ type: "attack", bonus: pb + weaponMod + improved, onHit: [{ type: "damage", amount: `1d8+${weaponMod + improved}`, damageType: dmg }] });
    const swings = pactBlade && has("thirsting-blade") ? 2 : 1;
    return [{ type: "target", who: { who: "aiChoice" }, effects: withRiders(Array.from({ length: swings }, one), everyHitWeapon, [...firstHit, ...extraOnFirst]) }];
  };
  const weapon: Action[] = wieldsWeapon ? [{ id: "attack", name: hexblade ? "Pact Longsword" : "Pact Rapier", cost: { action: 1 }, recharge: "none", automation: weaponAttack() }] : [];

  const actions: Action[] = [];
  const bonusRoutine: string[] = [];
  const reactions: Combatant["reactions"] = [];
  const traits: NonNullable<Combatant["traits"]> = [];
  const rules: NonNullable<Combatant["specialRules"]> = [];
  const resources: NonNullable<Combatant["resources"]> = {};
  const resistances: DamageType[] = [];
  const conditionImmunities: NonNullable<Combatant["conditionImmunities"]> = [];

  actions.push(wieldsWeapon ? blast("cast-eldritch-blast") : blast("attack"), ...weapon);

  // Eldritch Smite (5th, Blade): once a turn, a pact-weapon hit spends a slot for 1d8 + 1d8 a slot level of force damage, and a Huge or smaller creature is knocked prone
  if (pactBlade && has("eldritch-smite")) {
    actions.push({
      id: "attack-eldritch-smite", name: "Eldritch Smite", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "pactSlot", amount: 1 },
      automation: weaponAttack([{ type: "damage", amount: `${1 + pact}d8`, damageType: "force", oncePerTurn: "eldritch-smite" }, { type: "applyCondition", condition: "prone", durationRounds: 1 }]),
    });
  }

  // ---- Hex: the spell is a bonus action that curses one creature; it is cast when nothing else holds the warlock's concentration, and moved when its target dies
  const hexAction = spellActions(SPELLS_BY_ID["hex"], cc)[0];
  const hexOk = castable("hex", pact) && known.includes("hex");
  if (hexOk) bonusRoutine.push("hex-move", "cast-hex");
  const hexMove: Action = {
    id: "hex-move", name: "Hex (move the curse)", cost: { bonus: 1 }, recharge: "none", // (no `concentration`: the spell simply carries on, and running it as a new one would drop the concentration before the gate is read)
    automation: [{ type: "branch", if: "self.hex_needs_target", then: hexAction.automation }],
  };
  if (hexOk) actions.push(hexMove);

  // ---- Fiendish Vigor (False Life at will, as a 1st-level spell) and Maddening Hex (Charisma psychic damage to a cursed creature, as a bonus action)
  if (has("fiendish-vigor")) traits.push({ id: "fiendish-vigor", name: "Fiendish Vigor", trigger: "encounterStart", automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: "1d4+4" }] }] });
  if (has("maddening-hex")) {
    actions.push({
      id: "maddening-hex", name: "Maddening Hex", cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "branch", if: "self.has_curse", then: [{ type: "target", who: { who: "eachEnemy" }, effects: [{
        type: "branch", if: "target.has('hex')", then: [{ type: "damage", amount: String(Math.max(1, cha)), damageType: "psychic" }],
        else: [{ type: "branch", if: "target.has('hexblades-curse')", then: [{ type: "damage", amount: String(Math.max(1, cha)), damageType: "psychic" }] }],
      }] }] }],
    });
    bonusRoutine.push("maddening-hex");
  }
  if (has("eldritch-mind")) rules.push({ rule: "concentrationAdvantage" });

  // Relentless Hex (7th): a bonus action to teleport beside the creature cursed by the warlock's Hex or curse (only worth it once that creature is out of reach)
  if (has("relentless-hex")) {
    actions.push({
      id: "relentless-hex", name: "Relentless Hex", cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "branch", if: "self.curse_out_of_reach", then: [{ type: "move", kind: "teleportSelf", distance: 30, nearEffects: ["hex", "hexblades-curse"] }] }],
    });
    bonusRoutine.push("relentless-hex");
  }

  // ---- Pact of the Chain (3rd): a familiar — the imp, the best of the four special forms — that takes the Help action on its own turn ("A familiar can't attack"); with Investment of the Chain Master
  // the warlock orders it to sting as a bonus action, and the sting forces the warlock's own save DC
  if (boon === "chain" && boonActive) {
    const invest = has("investment-of-the-chain-master");
    traits.push({ id: "familiar", name: "Familiar (Pact of the Chain)", trigger: "encounterStart", automation: [{ type: "summon", statBlock: impFamiliarFor(invest ? dc : 11), count: "1", max: 1 }] });
    if (invest) {
      actions.push({
        id: "command-familiar", name: "Command the familiar (Attack)", cost: { bonus: 1 }, recharge: "none",
        automation: [{ type: "branch", if: "self.has_companion", then: [{ type: "commandSummon", action: "sting", limit: 1 }] }],
      });
      bonusRoutine.push("command-familiar");
      reactions.push({ id: "chain-master-resistance", name: "Investment of the Chain Master (resistance)", cost: { reaction: 1 }, recharge: "none", trigger: "the familiar takes damage", automation: [{ type: "note", text: "resistance for the familiar (engine hook)" }] });
    }
    if (has("gift-of-the-ever-living-ones")) rules.push({ rule: "familiarGift" });
    // Chains of Carceri (15th): Hold Monster at will, without a slot, on a celestial, fiend or elemental — and not again on the same creature until a long rest
    const hold = SPELLS_BY_ID["hold-monster"];
    const holdBuilt = hold?.build ? spellActions(hold, cc).find((a) => a.id === "cast-hold-monster") : undefined;
    if (has("chains-of-carceri") && holdBuilt) {
      actions.push({
        ...holdBuilt, id: "cast-hold-monster-chains", name: "Hold Monster (Chains of Carceri)", limitedUse: undefined,
        automation: holdBuilt.automation.map((n): AutomationNode => (n.type === "target"
          ? { ...n, filter: { types: ["celestial", "fiend", "elemental"], strictTypes: true, notEffects: ["chains-of-carceri"] }, effects: [...n.effects, { type: "applyEffect", name: "chains-of-carceri", durationRounds: 999999 }] }
          : n)),
      });
    }
  }

  // ---- Pact of the Talisman (3rd): an amulet on the sturdiest ally (or the warlock, alone) — the wearer adds a d4 to a failed ability check, proficiency-bonus times a long rest. Rebuke of the
  // Talisman (a reaction when the wearer is hit), Protection of the Talisman (7th: the same d4 on a failed save) and Bond of the Talisman (12th: teleport to the wearer)
  if (boon === "talisman" && boonActive) {
    resources.talisman_checks = { max: pb, recharge: "longRest" };
    traits.push({ id: "talisman", name: "Talisman (Pact of the Talisman)", trigger: "encounterStart", automation: [{ type: "target", who: { who: "eachAlly", limit: 1 }, effects: [{ type: "applyEffect", name: "talisman", durationRounds: 999999 }] }] });
    if (has("rebuke-of-the-talisman")) reactions.push({ id: "rebuke-of-the-talisman", name: "Rebuke of the Talisman", cost: { reaction: 1 }, recharge: "none", trigger: "the talisman's wearer is hit", automation: [{ type: "note", text: "Rebuke of the Talisman (engine hook)" }] });
    if (has("protection-of-the-talisman")) resources.protection_of_the_talisman = { max: pb, recharge: "longRest" };
    if (has("bond-of-the-talisman")) {
      resources.bond_of_the_talisman = { max: pb, recharge: "longRest" };
      actions.push({
        id: "bond-of-the-talisman", name: "Bond of the Talisman", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "bond_of_the_talisman", amount: 1 },
        automation: [{ type: "move", kind: "teleportSelf", distance: 9999, nearEffects: ["talisman"] }],
      });
    }
  }

  // ---- the invocations that cast a spell once a long rest
  for (const key of inv) {
    const si = SPELL_INVOCATIONS[key];
    if (!si || !SPELLS_BY_ID[si.spell]?.build || level < si.minLevel) continue;
    const spell = SPELLS_BY_ID[si.spell];
    const built = spellActions(spell, cc).find((a) => a.id === `cast-${spell.id}`);
    if (!built) continue;
    resources[`inv_${key}`] = { max: 1, recharge: "longRest" };
    actions.push({
      ...built, id: `cast-${spell.id}-${key}`, name: `${spell.name} (${si.name})`, ...(si.free ? { limitedUse: undefined } : {}),
      automation: [{ type: "branch", if: `self.resource('inv_${key}') >= 1`, then: [{ type: "spendResource", resource: `inv_${key}`, amount: 1 }, ...built.automation] }],
    });
  }

  // ---- the patron's features
  const pool = (name: string, max: number, recharge: "shortRest" | "longRest") => { resources[name] = { max, recharge }; return { resource: name, amount: 1 }; };

  if (patron === "archfey") {
    actions.push({
      id: "fey-presence", name: "Fey Presence", cost: { action: 1 }, recharge: "none", limitedUse: pool("fey_presence", 1, "shortRest"),
      automation: [{ type: "target", who: { who: "area", shape: "emanation", size: 10 }, effects: [{ type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "charmed", durationRounds: 1 }], onSuccess: [] }] }],
    });
    if (level >= 6) reactions.push({ id: "misty-escape", name: "Misty Escape", cost: { reaction: 1 }, recharge: "none", trigger: "self.tookDamageFromAttackOrSpell", limitedUse: pool("misty_escape", 1, "shortRest"), automation: [{ type: "note", text: "Misty Escape (engine hook)" }] });
    if (level >= 10) conditionImmunities.push("charmed");
    if (level >= 14) {
      actions.push({
        id: "dark-delirium", name: "Dark Delirium", cost: { action: 1 }, recharge: "none", concentration: true, limitedUse: pool("dark_delirium", 1, "shortRest"),
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "save", ability: "wis", dc, onFail: [{ type: "applyCondition", condition: "turned", durationRounds: 10, endsOnDamage: true }], onSuccess: [] }] }],
      });
    }
  }

  if (patron === "celestial") {
    const dice = Math.max(1, Math.min(cha, 1 + level));
    resources.healing_light = { max: 1 + level, recharge: "longRest" };
    actions.push({
      id: "healing-light", name: "Healing Light", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "healing_light", amount: dice }, usableWhen: { allyHpBelow: 0.5 },
      automation: [{ type: "target", who: { who: "lowestHpAlly", includeDowned: true }, effects: [{ type: "heal", amount: `${dice}d6` }] }],
    });
    bonusRoutine.unshift("healing-light");
    if (level >= 6) resistances.push("radiant");
    if (level >= 10) {
      resources.celestial_resilience = { max: 1, recharge: "shortRest" };
      traits.push({
        id: "celestial-resilience", name: "Celestial Resilience", trigger: "encounterStart",
        automation: [{ type: "branch", if: "self.resource('celestial_resilience') >= 1", then: [
          { type: "spendResource", resource: "celestial_resilience", amount: 1 },
          { type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: String(level + cha) }] },
          { type: "target", who: { who: "eachAlly", excludeSelf: true, limit: 5 }, effects: [{ type: "tempHp", amount: String(Math.floor(level / 2) + cha) }] },
        ] }],
      });
    }
    if (level >= 14) { resources.searing_vengeance = { max: 1, recharge: "longRest" }; rules.push({ rule: "searingVengeance", resource: "searing_vengeance" }); }
  }

  if (patron === "fathomless") {
    const tentacleDice = level >= 10 ? "2d8" : "1d8";
    const tentacleAttack: AutomationNode = { type: "attack", bonus: pb + cha, onHit: [{ type: "damage", amount: tentacleDice, damageType: "cold" }, { type: "applyEffect", name: "tentacle-slow", durationRounds: 1, mods: { speedBonusFt: -10, untilSourceNextTurn: true } }] }; // "reduces its speed by 10 feet until the start of your next turn"
    actions.push({
      id: "tentacle-of-the-deeps", name: "Tentacle of the Deeps", cost: { bonus: 1 }, recharge: "none", ranged: true, limitedUse: pool("tentacle_of_the_deeps", pb, "longRest"),
      automation: [{ type: "branch", if: "self.hasnt('tentacle')", then: [
        { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "tentacle", durationRounds: 10 }] },
        { type: "target", who: { who: "aiChoice" }, effects: [tentacleAttack] },
      ] }],
    }, {
      id: "tentacle-strike", name: "Tentacle of the Deeps (strike)", cost: { bonus: 1 }, recharge: "none", ranged: true,
      automation: [{ type: "branch", if: "self.has('tentacle')", then: [{ type: "target", who: { who: "aiChoice" }, effects: [tentacleAttack] }] }],
    });
    bonusRoutine.push("tentacle-strike", "tentacle-of-the-deeps");
    if (level >= 6) { resistances.push("cold"); reactions.push({ id: "guardian-coil", name: "Guardian Coil", cost: { reaction: 1 }, recharge: "none", trigger: "a creature near the tentacle takes damage", automation: [{ type: "note", text: "Guardian Coil (engine hook)" }] }); }
    if (level >= 10 && SPELLS_BY_ID["evards-black-tentacles"]?.build) {
      const tentacles = SPELLS_BY_ID["evards-black-tentacles"].build({ ...ctx, slotLevel: 4 });
      actions.push({
        id: "grasping-tentacles", name: "Grasping Tentacles (Evard's Black Tentacles)", cost: { action: 1 }, recharge: "none", isSpell: true, school: "conjuration", spellLevel: 4, concentration: true, ranged: true,
        limitedUse: pool("grasping_tentacles", 1, "longRest"),
        automation: [...tentacles, { type: "target", who: { who: "self" }, effects: [
          { type: "tempHp", amount: String(level) },
          { type: "applyEffect", name: "grasping-tentacles", durationRounds: 10, mods: { noConcentrationLoss: true } }, // "you can't lose concentration on it from taking damage"
        ] }],
      });
    }
  }

  if (patron === "fiend") {
    traits.push({ id: "dark-ones-blessing", name: "Dark One's Blessing", trigger: "onKill", automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: String(Math.max(1, cha + level)) }] }] });
    if (level >= 6) { resources.dark_ones_own_luck = { max: 1, recharge: "shortRest" }; rules.push({ rule: "luckDie", resource: "dark_ones_own_luck", sides: 10 }); }
    if (level >= 10) resistances.push("fire"); // Fiendish Resilience: one damage type chosen at each rest — fire, the one that isn't undone by magical weapons
    if (level >= 14) {
      const hurl = (nodes: AutomationNode[]) => nodes.map((n): AutomationNode => (n.type === "target" ? { ...n, effects: hurlOnFirstHit(n.effects) } : n));
      const hurlRider: AutomationNode[] = [
        { type: "applyCondition", condition: "incapacitated", durationRounds: 1 },
        { type: "branch", if: "target.is('fiend')", then: [], else: [{ type: "damage", amount: "10d10", damageType: "psychic" }] },
      ];
      const hurlOnFirstHit = (effects: AutomationNode[]): AutomationNode[] => {
        let done = false;
        return effects.map((e): AutomationNode => {
          if (e.type !== "attack" || done) return e;
          done = true;
          return { ...e, onHit: [...e.onHit, ...hurlRider] };
        });
      };
      const source = actions.find((a) => a.id === "attack")!;
      actions.push({
        ...source, id: "attack-hurl-through-hell", name: "Hurl Through Hell", limitedUse: pool("hurl_through_hell", 1, "longRest"),
        automation: hurl(source.automation),
      });
    }
  }

  if (patron === "great-old-one") {
    if (level >= 6) reactions.push({ id: "entropic-ward", name: "Entropic Ward", cost: { reaction: 1 }, recharge: "none", trigger: "a creature attacks you", limitedUse: pool("entropic_ward", 1, "shortRest"), automation: [{ type: "note", text: "Entropic Ward (engine hook)" }] });
    if (level >= 10) { resistances.push("psychic"); rules.push({ rule: "thoughtShield" }); }
    if (level >= 14) {
      actions.push({
        id: "create-thrall", name: "Create Thrall", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "branch", if: "any_enemy.incapacitated('humanoid')", then: [
          { type: "target", who: { who: "eachEnemy" }, filter: { types: ["humanoid"] }, effects: [{ type: "branch", if: "target.incapacitated", then: [{ type: "takeControl" }] }] },
        ] }],
      });
    }
  }

  if (hexblade) {
    resources.hexblades_curse = { max: 1, recharge: "shortRest" };
    const curseMods = { extraDamageWhenHitBySource: { amount: String(pb), damageType: (wieldsWeapon ? "slashing" : "force") as DamageType }, critRangeAgainstBySource: 19 };
    const curseOn: AutomationNode = { type: "target", who: { who: "aiChoice" }, effects: [{ type: "applyEffect", name: "hexblades-curse", durationRounds: 10, mods: curseMods }] };
    actions.push({ id: "hexblades-curse", name: "Hexblade's Curse", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "hexblades_curse", amount: 1 }, automation: [curseOn] });
    bonusRoutine.unshift("hexblades-curse");
    // "you regain hit points equal to your warlock level + your Charisma modifier" when the cursed creature dies; Master of Hexes (14th) passes the curse on instead (no healing)
    const heal: AutomationNode = { type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: String(Math.max(1, level + cha)) }] };
    traits.push({
      id: "hexblades-curse-death", name: "Hexblade's Curse (the cursed creature dies)", trigger: "onKill",
      automation: [{ type: "branch", if: "target.has('hexblades-curse')", then: level >= 14 ? [{ type: "branch", if: "enemies >= 1", then: [curseOn], else: [heal] }] : [heal] }],
    });
    // Accursed Specter (6th): slay a humanoid and its spirit rises as a specter with temporary hit points equal to half the warlock level and the Charisma modifier added to its attacks; once a long rest
    if (level >= 6) {
      resources.accursed_specter = { max: 1, recharge: "longRest" };
      traits.push({
        id: "accursed-specter", name: "Accursed Specter", trigger: "onKill",
        automation: [{ type: "branch", if: "target.is('humanoid')", then: [{ type: "branch", if: "self.resource('accursed_specter') >= 1", then: [
          { type: "spendResource", resource: "accursed_specter", amount: 1 },
          { type: "summon", statBlock: accursedSpecterFor(Math.max(0, cha)), count: "1", max: 1, tempHp: String(Math.floor(level / 2)) },
        ] }] }],
      });
    }
    if (level >= 10) reactions.push({ id: "armor-of-hexes", name: "Armor of Hexes", cost: { reaction: 1 }, recharge: "none", trigger: "the cursed creature hits you", automation: [{ type: "note", text: "Armor of Hexes (engine hook)" }] });
  }

  if (patron === "undead") {
    const formOn: AutomationNode = { type: "applyEffect", name: "form-of-dread", durationRounds: 10, mods: { immuneConditions: ["frightened"] } };
    actions.push({
      id: "form-of-dread", name: "Form of Dread", cost: { bonus: 1 }, recharge: "none", limitedUse: pool("form_of_dread", pb, "longRest"),
      automation: [{ type: "branch", if: "self.hasnt('form-of-dread')", then: [{ type: "target", who: { who: "self" }, effects: [formOn, { type: "tempHp", amount: `1d10+${level}` }] }] }],
    });
    bonusRoutine.unshift("form-of-dread");
    if (level >= 10) {
      resistances.push("necrotic");
      resources.necrotic_husk = { max: 1, recharge: "longRest" };
      rules.push({ rule: "necroticHusk", resource: "necrotic_husk", damage: `2d10+${level}` });
    }
  }

  if (patron === "undying") {
    rules.push({ rule: "natureSanctuary", types: ["undead"] }); // Among the Dead
    if (level >= 6) { resources.defy_death = { max: 1, recharge: "longRest" }; rules.push({ rule: "defyDeath", resource: "defy_death" }); }
    if (level >= 14) {
      actions.push({
        id: "indestructible-life", name: "Indestructible Life", cost: { bonus: 1 }, recharge: "none", limitedUse: pool("indestructible_life", 1, "shortRest"),
        automation: [{ type: "branch", if: "self.hp <= self.maxhp / 2", then: [{ type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: `1d8+${level}` }] }] }],
      });
      bonusRoutine.push("indestructible-life");
    }
  }

  if (genieType && level >= 6) resistances.push(genieType); // Elemental Gift

  // ---- the spell list itself
  const built = makeCaster({
    id: spec.idOverride ?? `${patron === "dao" || patron === "djinni" || patron === "efreeti" || patron === "marid" ? `${patron}-genie` : patron}-warlock${boon === (hexblade ? "blade" : "tome") ? "" : `-${boon}`}`,
    name: `Warlock ${level}`, level, spellClass: "warlock", casterKind: "warlock", spellAbility: "cha",
    ac: hexblade ? 18 : has("armor-of-shadows") ? 15 : 14, hp: between(level, 10, 10 + 19 * 7),
    abilities: { str: score(-1), dex: score(DEX), con: score(CON), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["wis", "cha"],
    prepared: [...known, ...arcanum], cantrips,
    extraActions: actions, extraReactions: reactions, extraTraits: traits,
    keepDistance: !wieldsWeapon, targetPriority: "lowestHp", opener: [],
  });

  // Hex is cast only when nothing else holds the concentration and no creature carries it already; Radiant Soul (Celestial, 6th) rides on the spells
  const radiantSoul = (a: Action): Action => {
    if (patron !== "celestial" || level < 6 || !a.isSpell || (a.spellLevel ?? 0) < 0) return a;
    let done = false;
    return { ...a, automation: mapNodes(a.automation, (n) => {
      if (done || n.type !== "damage" || (n.damageType !== "radiant" && n.damageType !== "fire")) return n;
      done = true; // "you add your Charisma modifier to one damage roll of that spell"
      return { ...n, amount: addFlatBonus(n.amount, cha) };
    }) };
  };
  const gated = (a: Action): Action => (a.id === "cast-hex" ? { ...a, automation: [{ type: "branch", if: "self.needs_hex", then: a.automation }] } : a);
  const finalActions = built.actions.map((a) => gated(radiantSoul(a)));

  return {
    ...built,
    actions: finalActions,
    reactions: built.reactions.map(radiantSoul),
    resources: { ...built.resources, ...resources },
    specialRules: [...built.specialRules, ...rules],
    resistances: [...built.resistances, ...resistances],
    conditionImmunities: [...built.conditionImmunities, ...conditionImmunities],
    ai: { ...built.ai, bonusRoutine: [...new Set(bonusRoutine)] },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------- the templates
const PATRON_IDS: [Patron, string][] = [
  ["archfey", "archfey"], ["celestial", "celestial"], ["fathomless", "fathomless"], ["fiend", "fiend"], ["great-old-one", "great-old-one"], ["hexblade", "hexblade"], ["undead", "undead"], ["undying", "undying"],
  ["dao", "dao-genie"], ["djinni", "djinni-genie"], ["efreeti", "efreeti-genie"], ["marid", "marid-genie"],
];

export const WARLOCK_BUILDERS: Record<string, (level: number) => Combatant> = {};
const BOONS: Boon[] = ["tome", "blade", "chain", "talisman"];
for (const [patron, stem] of PATRON_IDS) {
  const primary: Boon = patron === "hexblade" ? "blade" : "tome";
  WARLOCK_BUILDERS[`${stem}-warlock`] = (level) => build({ patron, boon: primary, level });
  for (const other of BOONS.filter((b) => b !== primary)) WARLOCK_BUILDERS[`${stem}-warlock-${other}`] = (level) => build({ patron, boon: other, level });
}
// the pre-rebuild id, still the Fiend patron
WARLOCK_BUILDERS.warlock = (level) => build({ patron: "fiend", boon: "tome", level, idOverride: "warlock" });

