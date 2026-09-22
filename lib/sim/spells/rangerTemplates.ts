// The ranger and its published conclaves, built from the printed text (dnd5e.wikidot.com/ranger and each conclave's page):
// Hunter and Beast Master (Player's Handbook), Gloom Stalker / Horizon Walker / Monster Slayer (Xanathar's), Fey Wanderer /
// Swarmkeeper and the optional Primal Companion (Tasha's), Drakewarden (Fizban's).
//
// Base class (the Ranger table): a half caster — spells known 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11 from
// 2nd level, slots per the table, Wisdom as the spellcasting ability, and no cantrips of its own. Fighting Style (2nd; Archery
// here, +2 to ranged attack rolls), Extra Attack (5th; two attacks, never three), Land's Stride, Hide in Plain Sight, Vanish and
// Feral Senses (non-combat or sight-based; not modeled). A conclave's own spells are "always known" and don't count against the total.
//
// Not modeled anywhere: Favored Enemy's own benefit (advantage on Wisdom (Survival) checks to track it and Intelligence checks to recall
// information about it — ability checks aren't modeled anywhere in this sim — plus a language), Natural Explorer / Deft Explorer, Primeval
// Awareness, and other exploration features.
//
// Build assumptions the books leave open: a longbow (1d8) and the Archery style; studded leather (AC 12 + Dex); Dex 18 (20 from 17th);
// Wisdom 16; a favored enemy of undead (`kit().favoredEnemy` — the book leaves the type open, and creature types now exist in this engine,
// so Foe Slayer (20th: once a turn, the Wisdom modifier added to the damage roll of a hit against that type) is built); and each conclave's
// own optional choices as noted on its builder.

import type { Action, AutomationNode, Combatant, CreatureType, DamageType, EffectMods } from "../schema";
import { drakeFor, feySpiritFor, primalBeastFor, rangerCompanionFor, type PrimalBeastKind } from "../engine/minions";
import { between, pbFor, score } from "../engine/pcBase";
import { makeCaster } from "./caster";

const WIS = 3; // Wisdom modifier (score 16)

interface Kit {
  level: number;
  pb: number;
  dex: number;
  attacks: number;
  dc: number; // spell save DC
  favoredEnemy: CreatureType; // Favored Enemy (1st): fixed here — see the header. Its only combat payoff is Foe Slayer (20th)
}

function kit(level: number): Kit {
  const pb = pbFor(level);
  return { level, pb, dex: pb === 6 ? 5 : 4, attacks: level >= 5 ? 2 : 1, dc: 8 + pb + WIS, favoredEnemy: "undead" };
}

/** one longbow shot: +Archery to hit, 1d8 + Dex piercing, then whatever rides on a hit or a miss, and (20th) Foe Slayer */
function shot(k: Kit, onHit: AutomationNode[] = [], onMiss?: AutomationNode[]): AutomationNode {
  // Foe Slayer (20th): "Once on each of your turns, you can add your Wisdom modifier to the attack roll or the damage
  // roll of an attack you make against one of your favored enemies" — added to the damage roll here, once a turn
  const foeSlayer: AutomationNode[] = k.level >= 20 ? [{
    type: "branch", if: `target.is('${k.favoredEnemy}')`, then: [{ type: "damage", amount: String(WIS), damageType: "piercing", oncePerTurn: "foe-slayer" }],
  }] : [];
  return {
    type: "attack", bonus: k.pb + k.dex + 2,
    onHit: [{ type: "damage", amount: `1d8+${k.dex}`, damageType: "piercing", weaponDice: true }, ...onHit, ...foeSlayer],
    ...(onMiss ? { onMiss } : {}),
  };
}

interface AttackOpts {
  id?: string;
  name?: string;
  /** the shots of the Attack action (default Extra Attack: 1, then 2 from 5th level) */
  count?: number;
  onHit?: AutomationNode[];
  onMiss?: AutomationNode[];
  /** extra nodes after the shots (Dread Ambusher's bonus shot) */
  after?: AutomationNode[];
  gate?: string;
}

function attackAction(k: Kit, o: AttackOpts = {}): Action {
  const nodes: AutomationNode[] = [{
    type: "target", who: { who: "aiChoice" },
    effects: [...Array.from({ length: o.count ?? k.attacks }, () => shot(k, o.onHit, o.onMiss)), ...(o.after ?? [])],
  }];
  return {
    id: o.id ?? "attack", name: o.name ?? "Longbow", cost: { action: 1 }, recharge: "none", ranged: true,
    text: "Ranged weapon attack, range 150/600 ft.",
    automation: o.gate ? [{ type: "branch", if: o.gate, then: nodes }] : nodes,
  };
}

type SubclassSpells = [number, string[]][];

/**
 * The spells a ranger knows, in the order they're learned. The printed Ranger table gives how many (2 at 2nd level, then 3, 3, 4,
 * 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11) and that each must be of a level you have slots for (1st at 2nd, 2nd at 5th,
 * 3rd at 9th, 4th at 13th, 5th at 17th); WHICH spells is the player's choice. This is one legal martial build — Hunter's Mark first —
 * chosen from the spells the sim implements.
 */
export const RANGER_LEARNED: { level: number; spell: string }[] = [
  { level: 2, spell: "hunters-mark" },
  { level: 2, spell: "cure-wounds" },
  { level: 3, spell: "hail-of-thorns" },
  { level: 5, spell: "spike-growth" },
  { level: 7, spell: "barkskin" },
  { level: 9, spell: "lightning-arrow" },
  { level: 11, spell: "conjure-barrage" },
  { level: 13, spell: "freedom-of-movement" },
  { level: 15, spell: "stoneskin" },
  { level: 17, spell: "conjure-volley" },
  { level: 19, spell: "swift-quiver" },
];

interface BuildOpts {
  spells?: SubclassSpells;
  cantrips?: string[];
  /** replaces the default Longbow attack */
  attacks?: Action[];
  actions?: Action[];
  reactions?: Combatant["reactions"];
  traits?: Combatant["traits"];
  specialRules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  proficientSaves?: Combatant["proficientSaves"];
  bonusRoutine?: string[];
  opener?: string[];
  initiativeBonus?: number;
}

function build(k: Kit, id: string, o: BuildOpts = {}): Combatant {
  const { level } = k;
  const known = RANGER_LEARNED.filter((l) => l.level <= level).map((l) => l.spell);
  const always = level >= 3 ? (o.spells ?? []).filter(([l]) => level >= l).flatMap(([, ids]) => ids) : [];
  const c = makeCaster({
    id, name: `Ranger ${level}`, level, spellClass: "ranger", casterKind: "half", spellAbility: "wis",
    ac: 12 + k.dex, // studded leather
    hp: between(level, 12, 8 * 19 + 12), // d10 hit die
    abilities: { str: score(0), dex: score(k.dex), con: score(2), int: score(0), wis: score(WIS), cha: score(0) },
    proficientSaves: o.proficientSaves ?? ["str", "dex"], focus: "balanced",
    cantrips: level >= 3 ? (o.cantrips ?? []) : [],
    prepared: [...new Set([...always, ...known])],
    extraActions: [...(o.attacks ?? [attackAction(k)]), ...(o.actions ?? [])],
    extraReactions: o.reactions ?? [],
    extraTraits: o.traits ?? [],
    keepDistance: true, opener: o.opener ?? [], targetPriority: "lowestHp",
  });
  return {
    ...c,
    ...(o.initiativeBonus !== undefined ? { initiativeBonus: o.initiativeBonus } : {}),
    specialRules: [...c.specialRules, ...(o.specialRules ?? [])],
    resources: { ...c.resources, ...(o.resources ?? {}) },
    ai: { ...c.ai, ...(o.bonusRoutine ? { bonusRoutine: o.bonusRoutine } : {}) },
  };
}

const reaction = (id: string, name: string, trigger: string, text: string, limitedUse?: string): Combatant["reactions"][number] => ({
  id, name, cost: { reaction: 1 }, recharge: "none", trigger,
  ...(limitedUse ? { limitedUse: { resource: limitedUse, amount: 1 } } : {}),
  automation: [{ type: "note", text }],
});

const evasion = { id: "evasion", name: "Evasion", trigger: "always" as const, automation: [], text: "half on a failed Dex save, none on a success (engine hook)" };

// ----------------------------------------------------------------------------------------------- Hunter (PHB)
// Hunter's Prey (3rd), Defensive Tactics (7th), Multiattack (11th) and Superior Hunter's Defense (15th) are each a choice among
// three. Hunter's Prey is built all three ways (three templates): Colossus Slayer (an extra 1d8 once per turn against a creature
// below its hit point maximum), Horde Breaker (once a turn, a second attack against a different creature) and Giant Killer (a
// reaction attack against a Large or larger creature after its attack, hit or miss). The other tiers use one option each: Multiattack
// Defense (+4 AC against a creature that has hit you, until its next turn), Volley (one ranged attack against each creature within
// 10 ft of a point) and Evasion. Escape the Horde, Steel Will, Whirlwind Attack, Stand Against the Tide and Uncanny Dodge aren't built.
type HuntersPrey = "colossus-slayer" | "horde-breaker" | "giant-killer";
function hunter(level: number, prey: HuntersPrey = "colossus-slayer"): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const colossus: AutomationNode[] = sub && prey === "colossus-slayer" ? [{
    type: "branch", if: "target.wounded_at_hit", // below its maximum when the hit lands, before this hit's own damage
    then: [{ type: "damage", amount: "1d8", damageType: "piercing", oncePerTurn: "colossus-slayer" }],
  }] : [];
  // Horde Breaker: once a turn, another attack with the same weapon against a different creature beside the first target
  const horde: AutomationNode[] = sub && prey === "horde-breaker" ? [{
    type: "branch", if: "enemies >= 2",
    then: [{ type: "target", who: { who: "anotherEnemy" }, effects: [shot(k)] }],
  }] : [];
  const id = prey === "colossus-slayer" ? "hunter-ranger" : prey === "horde-breaker" ? "hunter-horde-breaker-ranger" : "hunter-giant-killer-ranger";
  return build(k, id, {
    attacks: [{ ...attackAction(k, { onHit: colossus }), automation: [
      ...attackAction(k, { onHit: colossus }).automation,
      ...horde,
    ] }],
    actions: level >= 11 ? [{
      id: "volley", name: "Volley", cost: { action: 1 }, recharge: "none", ranged: true,
      text: "One ranged attack against any number of creatures within 10 feet of a point you can see.",
      automation: [{ type: "target", who: { who: "area", shape: "sphere", size: 10 }, effects: [shot(k, colossus)] }],
    }] : [],
    specialRules: level >= 7 ? [{ rule: "multiattackDefense" }] : [],
    traits: level >= 15 ? [evasion] : [],
    reactions: sub && prey === "giant-killer" ? [{
      id: "giant-killer", name: "Giant Killer", cost: { reaction: 1 }, recharge: "none",
      trigger: "a Large or larger creature within 5 feet of you hits or misses you with an attack",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [shot(k)] }],
    }] : [],
  });
}

// ------------------------------------------------------------------------------------------ Beast Master (PHB)
// Ranger's Companion (3rd): a beast (the SRD wolf here) that takes its turn on your initiative, Dodges unless you use YOUR ACTION to
// command it to Attack, and adds your proficiency bonus to AC, attack and damage; with Extra Attack you make one weapon attack
// yourself when you command it. Bestial Fury (11th): it attacks twice. The AI always commands the companion while it lives (a player
// may not choose to shoot twice instead). Exceptional Training and Share Spells don't change the sim.
function beastMaster(level: number): Combatant {
  const k = kit(level);
  if (level < 3) return build(k, "beastmaster-ranger");
  const companion = rangerCompanionFor(level, k.pb);
  return build(k, "beastmaster-ranger", {
    attacks: [
      attackAction(k, { gate: "self.no_companion" }),
      {
        id: "command-attack", name: "Command the beast to Attack", cost: { action: 1 }, recharge: "none", ranged: true, // (the ranger's own shot; the beast's bite is its own action)
        automation: [{ type: "branch", if: "self.has_companion", then: [
          { type: "commandSummon", action: "attack", limit: 1 },
          ...(level >= 5 ? [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [shot(k)] }] : []),
        ] }],
      },
    ],
    traits: [{
      id: "rangers-companion", name: "Ranger's Companion", trigger: "encounterStart",
      automation: [{ type: "summon", statBlock: companion, count: "1", max: 1 }],
      text: "a wolf fights beside you from the start of every encounter",
    }],
  });
}

// ---------------------------------------------------------------------- Beast Master, Primal Companion (Tasha's, optional)
// Replaces the Ranger's Companion: Beast of the Land, Sea or Sky (see primalBeastFor). It Dodges unless you use a BONUS ACTION to
// command it; you may also sacrifice one of your attacks instead (the bonus action is used here).
function primalBeastMaster(level: number, kind: PrimalBeastKind): Combatant {
  const k = kit(level);
  const id = `beastmaster-${kind}-ranger`;
  if (level < 3) return build(k, id);
  return build(k, id, {
    actions: [{
      id: "command-beast", name: "Command the beast", cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "branch", if: "self.has_companion", then: [{ type: "commandSummon", action: "attack", limit: 1 }] }],
    }],
    bonusRoutine: ["command-beast"],
    traits: [{
      id: "primal-companion", name: "Primal Companion", trigger: "encounterStart",
      automation: [{ type: "summon", statBlock: primalBeastFor(kind, level, k.pb, WIS), count: "1", max: 1 }],
      text: `a Beast of the ${kind} fights beside you from the start of every encounter`,
    }],
  });
}

// -------------------------------------------------------------------------------------------- Gloom Stalker (XGtE)
// Dread Ambusher (3rd): + Wisdom to initiative; on your first turn of a combat one extra shot as part of the Attack action, +1d8
// damage on a hit, and +10 ft of speed that turn. Umbral Sight is darkvision (not modeled). Iron Mind (7th): Wisdom saves.
// Stalker's Flurry (11th): once a turn a missed weapon attack is followed by another. Shadowy Dodge (15th): a reaction imposing
// disadvantage on an attack against you that has no advantage.
const GLOOM_SPELLS: SubclassSpells = [[3, ["disguise-self"]], [5, ["rope-trick"]], [9, ["fear"]], [13, ["greater-invisibility"]], [17, ["seeming"]]];
function gloomStalker(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const flurryShot = shot(k);
  const onMiss: AutomationNode[] = level >= 11 ? [{
    type: "branch", if: "self.hasnt('stalkers-flurry')", then: [
      { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "stalkers-flurry", mods: { untilSourceNextTurn: true } }] },
      flurryShot,
    ],
  }] : [];
  return build(k, "gloom-stalker-ranger", {
    spells: GLOOM_SPELLS,
    initiativeBonus: sub ? k.dex + WIS : undefined,
    attacks: [attackAction(k, {
      onMiss,
      after: sub ? [{ type: "branch", if: "round <= 1", then: [shot(k, [{ type: "damage", amount: "1d8", damageType: "piercing" }])] }] : [],
    })],
    proficientSaves: level >= 7 ? ["str", "dex", "wis"] : ["str", "dex"],
    specialRules: sub ? [{ rule: "firstTurnSpeed", ft: 10 }] : [],
    reactions: level >= 15 ? [reaction("shadowy-dodge", "Shadowy Dodge", "an attack roll is made against you", "imposes disadvantage on the attack (engine hook)")] : [],
  });
}

// ------------------------------------------------------------------------------------------ Horizon Walker (XGtE)
// Planar Warrior (3rd): a bonus action marks a creature within 30 ft; the next weapon hit on it this turn deals an extra 1d8 force
// (2d8 at 11th) — the conversion of the weapon's own damage to force isn't modeled. Detect Portal and Ethereal Step are utility.
// Distant Strike (11th): teleport 10 ft before each attack, and attacking two different creatures earns one more attack against a
// third — used only when three enemies are alive. Spectral Defense (15th): a reaction giving resistance to an attack's damage.
const HORIZON_SPELLS: SubclassSpells = [[3, ["protection-from-evil-and-good"]], [5, ["misty-step"]], [9, ["haste"]], [13, ["banishment"]], [17, ["teleportation-circle"]]];
function horizonWalker(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  return build(k, "horizon-walker-ranger", {
    spells: HORIZON_SPELLS,
    attacks: [
      attackAction(k),
      ...(level >= 11 ? [{
        id: "distant-strike", name: "Distant Strike", cost: { action: 1 }, recharge: "none" as const, ranged: true,
        text: "Teleport up to 10 ft before each attack; attack three different creatures.",
        automation: [{ type: "branch" as const, if: "enemies >= 3", then: [0, 1, 2].map((rank) => ({
          type: "target" as const, who: { who: "enemyRank" as const, rank }, effects: [shot(k)],
        })) }],
      }] : []),
    ],
    actions: sub ? [{
      id: "planar-warrior", name: "Planar Warrior", cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{
        type: "applyEffect", name: "planar-warrior",
        mods: { extraDamageWhenHitBySource: { amount: level >= 11 ? "2d8" : "1d8", damageType: "force", oncePerTurn: true }, untilSourceNextTurn: true },
      }] }],
    }] : [],
    bonusRoutine: sub ? ["planar-warrior"] : undefined,
    reactions: level >= 15 ? [reaction("spectral-defense", "Spectral Defense", "you take damage from an attack", "resistance to all of that attack's damage (engine hook)")] : [],
  });
}

// ------------------------------------------------------------------------------------------ Monster Slayer (XGtE)
// Slayer's Prey (3rd): a bonus action designates a creature within 60 ft; the first weapon hit on it each turn deals an extra 1d6,
// until you designate another. Magic-User's Nemesis (11th): a reaction — a creature casting a spell within 60 ft makes a Wisdom save
// against your spell save DC or the spell fails (once per short rest). Supernatural Defense (7th): + 1d6 on saves against your prey's
// effects. Slayer's Counter (15th): your reaction attacks the prey before the save, and a hit makes the save succeed. Not modeled:
// Hunter's Sense (learning resistances).
const SLAYER_SPELLS: SubclassSpells = [[3, ["protection-from-evil-and-good"]], [5, ["zone-of-truth"]], [9, ["magic-circle"]], [13, ["banishment"]], [17, ["hold-monster"]]];
function monsterSlayer(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  return build(k, "monster-slayer-ranger", {
    spells: SLAYER_SPELLS,
    actions: sub ? [{
      id: "slayers-prey", name: "Slayer's Prey", cost: { bonus: 1 }, recharge: "none",
      automation: [
        { type: "target", who: { who: "eachEnemy" }, effects: [{ type: "removeEffect", name: "slayers-prey" }] }, // designating a new prey ends the old
        { type: "target", who: { who: "aiChoice" }, effects: [{
          type: "applyEffect", name: "slayers-prey",
          mods: { extraDamageWhenHitBySource: { amount: "1d6", damageType: "piercing", oncePerTurn: true } },
        }] },
      ],
    }] : [],
    bonusRoutine: sub ? ["slayers-prey"] : undefined,
    specialRules: level >= 7 ? [{ rule: "supernaturalDefense" }] : [],
    resources: level >= 11 ? { magic_users_nemesis: { max: 1, recharge: "shortRest" as const } } : {},
    reactions: [
      ...(level >= 11 ? [reaction("magic-users-nemesis", "Magic-User's Nemesis", "a creature within 60 ft casts a spell", "a Wisdom save or the spell fails (engine hook)", "magic_users_nemesis")] : []),
      ...(level >= 15 ? [{
        id: "slayers-counter", name: "Slayer's Counter", cost: { reaction: 1 }, recharge: "none" as const,
        trigger: "your prey forces you to make a saving throw",
        automation: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [shot(k)] }],
      }] : []),
    ],
  });
}

// ------------------------------------------------------------------------------------------ Fey Wanderer (Tasha's)
// Dreadful Strikes (3rd): an extra 1d4 psychic (1d6 at 11th) once per turn on a weapon hit. Beguiling Twist (7th): advantage on saves
// against being charmed or frightened, and a reaction turns a shrugged-off charm or fear on another creature (frightened, Wisdom save
// against your spell DC). Misty Wanderer (15th):
// Misty Step Wisdom-modifier times per long rest. Fey Reinforcements (11th): Summon Fey once per long rest without a slot (or with a 3rd-level
// slot), no concentration — a Fey Spirit (see feySpiritFor) fights beside you; the AI summons it first. Otherworldly Glamour is social.
const FEY_SPELLS: SubclassSpells = [[3, ["charm-person"]], [5, ["misty-step"]], [9, ["dispel-magic"]], [13, ["dimension-door"]], [17, ["mislead"]]];
function feyWanderer(level: number): Combatant {
  const k = kit(level);
  const dreadful: AutomationNode[] = level >= 3 ? [{ type: "damage", amount: level >= 11 ? "1d6" : "1d4", damageType: "psychic", oncePerTurn: "dreadful-strikes" }] : [];
  return build(k, "fey-wanderer-ranger", {
    spells: FEY_SPELLS,
    attacks: [attackAction(k, { onHit: dreadful })],
    specialRules: level >= 7 ? [{ rule: "advantageOnSavesAgainst", conditions: ["charmed", "frightened"] }] : [],
    opener: level >= 11 ? ["fey-reinforcements"] : [],
    reactions: level >= 7 ? [reaction("beguiling-twist", "Beguiling Twist", "a creature within 120 ft succeeds on a save against being charmed or frightened", "a different creature makes a Wisdom save or is frightened (engine hook)")] : [],
    resources: {
      ...(level >= 11 ? { fey_reinforcements: { max: 1, recharge: "longRest" as const } } : {}),
      ...(level >= 15 ? { misty_wanderer: { max: WIS, recharge: "longRest" as const } } : {}),
    },
    actions: [
      ...(level >= 11 ? [{
        id: "fey-reinforcements", name: "Summon Fey (Fey Reinforcements)", cost: { action: 1 }, recharge: "none" as const,
        limitedUse: { resource: "fey_reinforcements", amount: 1 },
        text: "Summon Fey without a spell slot or concentration (a minute), once per long rest.",
        automation: [{ type: "summon" as const, statBlock: feySpiritFor(3, k.pb, WIS), count: "1", max: 1 }],
      }, {
        id: "summon-fey", name: "Summon Fey (3rd-level slot)", cost: { action: 1 }, recharge: "none" as const,
        limitedUse: { resource: "slot3", amount: 1 },
        text: "Summon Fey with a 3rd-level spell slot (Fey Reinforcements: no material component, and you may skip concentration).",
        automation: [{ type: "summon" as const, statBlock: feySpiritFor(3, k.pb, WIS), count: "1", max: 1 }],
      }] : []),
      ...(level >= 15 ? [{
        id: "misty-wanderer", name: "Misty Step (Misty Wanderer)", cost: { bonus: 1 }, recharge: "none" as const,
        limitedUse: { resource: "misty_wanderer", amount: 1 },
        automation: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "move" as const, kind: "teleportSelf" as const, distance: 30 }] }],
      }] : []),
    ],
  });
}

// ------------------------------------------------------------------------------------------ Swarmkeeper (Tasha's)
// Gathered Swarm (3rd): once a turn, after a hit, the swarm deals 1d6 piercing (1d8 at 11th) — its other two options, shoving the
// target 15 ft or moving you 5 ft, are positional and not chosen. Mighty Swarm's prone rider and half cover aren't modeled. Writhing
// Tide (7th) is a hover. Swarming Dispersal (15th): a reaction giving resistance to damage you take, proficiency-bonus times per long
// rest (the 30-ft teleport isn't modeled). Swarmkeeper Magic also grants the Mage Hand cantrip.
const SWARM_SPELLS: SubclassSpells = [[3, ["faerie-fire"]], [5, ["web"]], [9, ["gaseous-form"]], [13, ["arcane-eye"]], [17, ["insect-plague"]]];
function swarmkeeper(level: number): Combatant {
  const k = kit(level);
  const swarm: AutomationNode[] = level >= 3 ? [{ type: "damage", amount: level >= 11 ? "1d8" : "1d6", damageType: "piercing", oncePerTurn: "gathered-swarm" }] : [];
  return build(k, "swarmkeeper-ranger", {
    spells: SWARM_SPELLS, cantrips: ["mage-hand"],
    attacks: [attackAction(k, { onHit: swarm })],
    resources: level >= 15 ? { swarming_dispersal: { max: k.pb, recharge: "longRest" as const } } : {},
    reactions: level >= 15 ? [reaction("swarming-dispersal", "Swarming Dispersal", "you take damage", "resistance to that damage (engine hook)", "swarming_dispersal")] : [],
  });
}

// ------------------------------------------------------------------------------------------- Drakewarden (Fizban's)
// Drake Companion (3rd): summoned with an action (once per long rest, or with a spell slot); it Dodges unless you use a bonus action
// to command it. Its essence is a choice each summoning — fire here. Bond of Fang and Scale (7th): wings, Magic Fang (+1d6 on its
// bite), and you resist the essence damage. Drake's Breath (11th): an action, a 30-ft cone, Dexterity save, 8d6 (10d6 at 15th) of a
// chosen type (fire), once per long rest (the spell-slot reuse isn't modeled). Perfected Bond (15th): 2d6 extra bite damage and
// Reflexive Resistance (a reaction to halve damage to you — the drake's side isn't modeled), proficiency-bonus times per long rest.
function drakewarden(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const essence: DamageType = "fire";
  return build(k, "drakewarden-ranger", {
    cantrips: ["thaumaturgy"],
    resources: {
      ...(sub ? { drake_summon: { max: 1, recharge: "longRest" as const } } : {}),
      ...(level >= 11 ? { drakes_breath: { max: 1, recharge: "longRest" as const } } : {}),
      ...(level >= 15 ? { reflexive_resistance: { max: k.pb, recharge: "longRest" as const } } : {}),
    },
    actions: [
      ...(sub ? [{
        id: "summon-drake", name: "Summon Drake", cost: { action: 1 }, recharge: "none" as const,
        limitedUse: { resource: "drake_summon", amount: 1 },
        automation: [
          { type: "summon" as const, statBlock: drakeFor(level, k.pb, essence), count: "1", max: 1 },
          ...(level >= 7 ? [{ type: "target" as const, who: { who: "self" as const }, effects: [
            { type: "applyEffect" as const, name: "drake-resistance", durationRounds: 100, mods: { resistTypes: [essence] } as EffectMods },
          ] }] : []),
        ],
      }, {
        id: "command-drake", name: "Command the drake", cost: { bonus: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "self.has_companion", then: [{ type: "commandSummon" as const, action: "bite", limit: 1 }] }],
      }] : []),
      ...(level >= 11 ? [{
        id: "drakes-breath", name: "Drake's Breath", cost: { action: 1 }, recharge: "none" as const,
        limitedUse: { resource: "drakes_breath", amount: 1 },
        text: "30-foot cone: Dexterity save, 8d6 (10d6 at 15th), half on a success.",
        automation: [{ type: "target" as const, who: { who: "area" as const, shape: "cone" as const, size: 30 }, effects: [{
          type: "save" as const, ability: "dex" as const, dc: k.dc,
          onFail: [{ type: "damage" as const, amount: level >= 15 ? "10d6" : "8d6", damageType: essence }],
          onSuccess: [{ type: "damage" as const, amount: level >= 15 ? "10d6" : "8d6", damageType: essence, half: true }],
        }] }],
      }] : []),
    ],
    opener: sub ? ["summon-drake"] : [],
    bonusRoutine: sub ? ["command-drake"] : undefined,
    reactions: level >= 15 ? [reaction("reflexive-resistance", "Reflexive Resistance", "you take damage", "resistance to that damage (engine hook)", "reflexive_resistance")] : [],
  });
}

export const RANGER_BUILDERS: Record<string, (level: number) => Combatant> = {
  "hunter-ranger": (l) => hunter(l),
  "hunter-horde-breaker-ranger": (l) => hunter(l, "horde-breaker"),
  "hunter-giant-killer-ranger": (l) => hunter(l, "giant-killer"),
  "beastmaster-ranger": beastMaster,
  "beastmaster-land-ranger": (l) => primalBeastMaster(l, "land"),
  "beastmaster-sea-ranger": (l) => primalBeastMaster(l, "sea"),
  "beastmaster-sky-ranger": (l) => primalBeastMaster(l, "sky"),
  "gloom-stalker-ranger": gloomStalker,
  "horizon-walker-ranger": horizonWalker,
  "monster-slayer-ranger": monsterSlayer,
  "fey-wanderer-ranger": feyWanderer,
  "swarmkeeper-ranger": swarmkeeper,
  "drakewarden-ranger": drakewarden,
};
