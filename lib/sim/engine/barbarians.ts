// The barbarian and its nine published subclasses, built from the printed text (dnd5e.wikidot.com/barbarian and
// each path's page): Berserker and Totem Warrior (Player's Handbook), Battlerager (Sword Coast Adventurer's Guide),
// Ancestral Guardian / Storm Herald / Zealot (Xanathar's), Beast / Wild Magic (Tasha's), Giant (Bigby Presents).
//
// Base class (the Barbarian table): rages per day 2, 2, 3, 3, 3, 4 ... 6, unlimited at 20th; Rage damage +2 / +3 / +4
// (levels 1 / 9 / 16); Unarmored Defense (10 + Dex + Con); Danger Sense 2nd; Reckless Attack 2nd; Extra Attack 5th;
// Fast Movement 5th (+10 ft); Feral Instinct 7th (advantage on initiative); Brutal Critical 9th / 13th / 17th; Relentless
// Rage 11th; Persistent Rage 15th; Indomitable Might 18th; Primal Champion 20th (Str and Con +4, to 24).
//
// Rage is an effect on the barbarian: resistance to bludgeoning / piercing / slashing, advantage on Strength saves, and
// the Rage-damage bonus on every hit. It lasts a minute, ends if you fall unconscious, and ends at the end of a turn on
// which you neither attacked nor took damage (Persistent Rage waives that).
//
// Build assumptions the books leave open: a greataxe (1d12); Str 18 (20 from 17th, 24 at 20th); Con 18; Dex 14; the
// AI attacks recklessly (advantage on its swings, and attacks against it have advantage); a subclass's optional
// choices are made as noted on its builder.
//
// Not modeled anywhere: exhaustion, heavy-armor limits, spellcasting restrictions, the non-combat features (Primal
// Knowledge, Spirit Seeker, Aspect of the Beast, Magic Awareness, ...), and features that only move or resize a creature
// on the grid (Battlerager Charge, Mighty Impel, Giant Stature's size change, Eagle / Elk totems).

import { DAMAGE_TYPES, type Action, type AutomationNode, type Combatant, type DamageType, type EffectMods } from "../schema";
import { between, pbFor, pc, score } from "./pcBase";

const BPS: DamageType[] = ["bludgeoning", "piercing", "slashing"];
const ALL_BUT_PSYCHIC = DAMAGE_TYPES.filter((t) => t !== "psychic") as DamageType[];
const RAGES = [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6]; // levels 1-19; 20th is unlimited
const rageDamage = (level: number) => (level >= 16 ? 4 : level >= 9 ? 3 : 2);

interface Kit {
  level: number;
  pb: number;
  str: number; // ability modifiers
  con: number;
  dex: number;
  rageDmg: number;
  attacks: number;
}

function kit(level: number): Kit {
  const pb = pbFor(level);
  const primal = level >= 20; // Primal Champion: Str and Con +4, maximum 24
  const base = pb === 6 ? 5 : 4;
  return { level, pb, str: primal ? 7 : base, con: primal ? 7 : base, dex: 2, rageDmg: rageDamage(level), attacks: level >= 5 ? 2 : 1 };
}

interface SwingOpts {
  die: string;
  type: DamageType;
  adv?: boolean;
  /** nodes that run on a hit right after the weapon damage */
  riders?: AutomationNode[];
}

const swing = (k: Kit, o: SwingOpts): AutomationNode => ({
  type: "attack", bonus: k.pb + k.str, ...(o.adv ? { adv: "adv" as const } : {}),
  onHit: [{ type: "damage", amount: `${o.die}+${k.str}`, damageType: o.type, weaponDice: true }, ...(o.riders ?? [])],
});

interface AttackOpts extends SwingOpts {
  id?: string;
  name?: string;
  count?: number;
  /** attack recklessly (2nd level+): advantage on the swings, attacks against you have advantage until your next turn */
  reckless?: boolean;
  /** extra nodes when attacking recklessly (Reckless Abandon's temporary HP) */
  recklessExtras?: AutomationNode[];
  /** the action is only available while this expression holds (a single top-level branch) */
  gate?: string;
}

function attackAction(k: Kit, o: AttackOpts): Action {
  const reckless = !!o.reckless && k.level >= 2;
  const nodes: AutomationNode[] = [
    ...(reckless ? [{
      type: "target" as const, who: { who: "self" as const },
      effects: [
        { type: "applyEffect" as const, name: "reckless", mods: { attacksAgainstItAdvantage: "adv" as const, untilSourceNextTurn: true } },
        ...(o.recklessExtras ?? []),
      ],
    }] : []),
    { type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: o.count ?? k.attacks }, () => swing(k, { ...o, adv: reckless })) },
  ];
  return {
    id: o.id ?? "attack", name: o.name ?? (reckless ? "Reckless Attack" : "Attack"), cost: { action: 1 }, recharge: "none",
    automation: o.gate ? [{ type: "branch", if: o.gate, then: nodes }] : nodes,
  };
}

interface RageOpts {
  id?: string;
  name?: string;
  /** resistances while raging (Bear totem: everything but psychic) */
  resist?: DamageType[];
  /** damage type of the Rage bonus — the weapon's */
  type?: DamageType;
  /** more effect mods (Mindless Rage's immunities, a Giant's reach, Spiked Retribution) */
  mods?: EffectMods;
  /** more nodes on entering the rage: an aura, a wild surge, a form marker */
  onRage?: AutomationNode[];
}

function rageAction(k: Kit, o: RageOpts = {}): Action {
  const mods: EffectMods = {
    resistTypes: o.resist ?? BPS,
    saveAdvantageOn: ["str"],
    extraDamageOnHit: { amount: String(k.rageDmg), damageType: o.type ?? "slashing" },
    ...(o.mods ?? {}),
  };
  return {
    id: o.id ?? "rage", name: o.name ?? "Rage", cost: { bonus: 1 }, recharge: "none",
    limitedUse: { resource: "rage", amount: 1 },
    automation: [{
      type: "branch", if: "self.hasnt('rage')", // a rage already going can't be entered again
      then: [{ type: "target", who: { who: "self" }, effects: [
        { type: "applyEffect", name: "rage", durationRounds: 10, mods },
        ...(o.onRage ?? []),
      ] }],
    }],
  };
}

interface BuildOpts {
  actions?: Action[];
  /** replaces the default reckless + careful greataxe attacks */
  attackActions?: Action[];
  reactions?: Combatant["reactions"];
  specialRules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  /** the rage action(s); default one plain Rage */
  rages?: Action[];
  bonusRoutine?: string[];
  bonusAfterAttack?: string[];
  opener?: string[];
  resistances?: DamageType[];
  speeds?: Combatant["speeds"];
  /** swing riders on the default greataxe attacks */
  riders?: AutomationNode[];
  recklessExtras?: AutomationNode[];
}

function build(k: Kit, id: string, o: BuildOpts = {}): Combatant {
  const { level } = k;
  const rages = o.rages ?? [rageAction(k)];
  const greataxe = { die: "1d12", type: "slashing" as DamageType, riders: o.riders };
  const attacks = o.attackActions ?? [
    attackAction(k, { ...greataxe, reckless: true, recklessExtras: o.recklessExtras }),
    ...(level >= 2 ? [attackAction(k, { ...greataxe, id: "careful-attack", name: "Attack (not reckless)" })] : []),
  ];
  const c = pc({
    id, name: `Barbarian ${level}`, level,
    ac: 10 + k.dex + k.con, // Unarmored Defense
    hp: between(level, 15, 10 * 20 + 20), // d12 hit die
    abilities: { str: score(k.str), dex: score(k.dex), con: score(k.con), int: score(-1), wis: score(1), cha: score(0) },
    proficientSaves: ["str", "con"],
    specialRules: [
      ...(level >= 2 ? [{ rule: "advantageOnSaves" as const, abilities: ["dex" as const] }] : []), // Danger Sense
      ...(level >= 7 ? [{ rule: "initiativeAdvantage" as const }] : []), // Feral Instinct
      ...(level >= 9 ? [{ rule: "brutalCritical" as const, dice: level >= 17 ? 3 : level >= 13 ? 2 : 1 }] : []),
      ...(level >= 11 ? [{ rule: "relentlessRage" as const }] : []),
      ...(level >= 15 ? [{ rule: "persistentRage" as const }] : []),
      ...(o.specialRules ?? []),
    ],
    resources: { rage: { max: level >= 20 ? "unbounded" as const : RAGES[level - 1], recharge: "longRest" as const }, ...(o.resources ?? {}) },
    actions: [...rages, ...attacks, ...(o.actions ?? [])],
    reactions: o.reactions ?? [],
    speed: level >= 5 ? 40 : 30, // Fast Movement
    opener: o.opener ?? [rages[0].id],
    targetPriority: "lowestHp",
    bonusRoutine: o.bonusRoutine ?? rages.map((r) => r.id),
    bonusAfterAttack: o.bonusAfterAttack,
  });
  return {
    ...c,
    ...(o.resistances ? { resistances: o.resistances } : {}),
    ...(o.speeds ? { speeds: { ...c.speeds, ...o.speeds } } : {}),
  };
}

/** a swing that carries no rider: the bare weapon attack a subclass bonus action or reaction makes */
const plainSwing = (k: Kit, die = "1d12", type: DamageType = "slashing", adv = false): AutomationNode => swing(k, { die, type, adv });

// ---------------------------------------------------------------------------------------------- Berserker (PHB)
// Frenzy (3rd): while raging, one melee weapon attack as a bonus action on each of your turns after the one you
// entered the rage on (entering the rage IS that turn's bonus action, so it can't come earlier). The exhaustion when the
// rage ends isn't modeled. Mindless Rage (6th): can't be charmed or frightened while raging. Intimidating Presence
// (10th): action, Wisdom save (DC 8 + PB + Cha) or frightened until the end of your next turn. Retaliation (14th).
function berserker(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  return build(k, "berserker-barbarian", {
    rages: [rageAction(k, { mods: level >= 6 ? { immuneConditions: ["charmed", "frightened"] } : {} })],
    actions: [
      ...(sub ? [{
        id: "frenzy", name: "Frenzy", cost: { bonus: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "self.has('rage')", then: [{
          type: "branch" as const, if: "self.has('reckless')",
          then: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [plainSwing(k, "1d12", "slashing", true)] }],
          else: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [plainSwing(k)] }],
        }] }],
      }] : []),
      ...(level >= 10 ? [{
        id: "intimidating-presence", name: "Intimidating Presence", cost: { action: 1 }, recharge: "none" as const,
        automation: [{ type: "target" as const, who: { who: "chosenEnemies" as const, upTo: 1, withinFt: 30 }, effects: [{
          type: "save" as const, ability: "wis" as const, dc: 8 + k.pb, // Cha +0
          onFail: [{ type: "applyCondition" as const, condition: "frightened" as const, durationRounds: 1 }],
        }] }],
      }] : []),
    ],
    reactions: level >= 14 ? [{
      id: "retaliation", name: "Retaliation", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasHitByMeleeAttack",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [plainSwing(k)] }],
    }] : [],
    bonusAfterAttack: sub ? ["frenzy"] : undefined,
  });
}

// ---------------------------------------------------------------------------------------- Totem Warrior (PHB)
// The totem spirit is the player's choice. Bear (the default): 3rd level, resistance to all damage except psychic while raging;
// 14th (Totemic Attunement), hostile creatures beside you have disadvantage on attacks against anyone else. Wolf: while raging, your
// allies have advantage on melee attacks against hostile creatures within 5 ft of you; 14th, a bonus action to knock a Large or smaller
// creature prone when you hit it with a melee attack. Elk: +15 ft speed while raging (14th, moving through a creature's space: not
// modeled). Eagle: opportunity attacks against you are made with disadvantage while raging (Dash as a bonus action and the 14th-level
// flying speed aren't modeled). The Tiger's jumps and charge bonus attack (a straight 20-ft run) aren't built. Aspect of the Beast,
// Spirit Seeker and Spirit Walker are non-combat.
type Totem = "bear" | "wolf" | "elk" | "eagle";
function totemWarrior(level: number, spirit: Totem): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const topple: AutomationNode[] = spirit === "wolf" && level >= 14 ? [{
    type: "branch", if: "self.has('rage')", then: [{
      type: "branch", if: "self.bonus_free", then: [
        { type: "spendBonusAction" },
        { type: "branch", if: "target.size<=large", then: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] },
      ],
    }],
  }] : [];
  const mods: EffectMods = !sub ? {} : spirit === "elk" ? { speedBonusFt: 15 } : spirit === "eagle" ? { disadvantageOnOpportunityAttacks: true } : {};
  return build(k, spirit === "bear" ? "totem-barbarian" : `totem-${spirit}-barbarian`, {
    rages: [rageAction(k, { resist: sub && spirit === "bear" ? ALL_BUT_PSYCHIC : BPS, mods })],
    specialRules: [
      ...(spirit === "bear" && level >= 14 ? [{ rule: "bearAttunement" as const }] : []),
      ...(spirit === "wolf" && sub ? [{ rule: "wolfTotem" as const }] : []),
    ],
    riders: topple,
  });
}

// ------------------------------------------------------------------------------------ Ancestral Guardian (XGtE)
// Ancestral Protectors (3rd): the first creature you hit on your turn while raging has disadvantage on attacks that
// aren't against you, and creatures other than you it hits have resistance to the damage, until the start of your next
// turn. Spirit Shield (6th): reaction, reduce damage another creature within 30 ft takes by 2d6 (3d6 at 10th, 4d6 at
// 14th); Vengeful Ancestors (14th) returns the prevented damage as force damage. Consult the Spirits is non-combat.
function ancestralGuardian(level: number): Combatant {
  const k = kit(level);
  const dice = level >= 14 ? "4d6" : level >= 10 ? "3d6" : "2d6";
  return build(k, "ancestral-guardian-barbarian", {
    riders: level >= 3 ? [{
      type: "branch", if: "self.has('rage')",
      then: [{
        type: "applyEffect", name: "ancestral-protectors", oncePerTurn: "ancestral-protectors",
        mods: { disadvantageUnlessTargetingSource: true, halveDamageToOthers: true, untilSourceNextTurn: true },
      }],
    }] : [],
    specialRules: level >= 6 ? [{ rule: "spiritShield", dice, vengeful: level >= 14 }] : [],
    reactions: level >= 6 ? [{
      id: "spirit-shield", name: "Spirit Shield", cost: { reaction: 1 }, recharge: "none",
      trigger: "an ally within 30 ft takes damage", automation: [{ type: "note", text: `reduces the damage by ${dice}${level >= 14 ? " and returns it as force damage" : ""} (engine hook)` }],
    }] : [],
  });
}

// --------------------------------------------------------------------------------------- Storm Herald (XGtE)
// Storm Aura (3rd): a 10-ft aura while raging whose effect fires on entering the rage and again as a bonus action each
// turn; the environment is a choice each level (built: sea by default, plus desert and tundra). DC 8 + PB + Con.
//   Desert: every OTHER creature in the aura (allies too) takes fire damage 2 / 3 / 4 / 5 / 6 (3rd / 5th / 10th / 15th / 20th).
//   Sea: one creature in the aura, Dexterity save, 1d6 lightning (2d6 / 3d6 / 4d6 at 10th / 15th / 20th), half on a save.
//   Tundra: each creature you choose in the aura gains temporary HP 2 / 3 / 4 / 5 / 6.
// Storm Soul (6th): resistance to that damage type, always. Shielding Storm (10th): allies in the aura share the resistance.
// Raging Storm (14th): desert — reaction, Dex save or fire damage equal to half your level against a creature that hits you;
// sea — reaction when you hit a creature in the aura, Strength save or knocked prone; tundra — one creature in the aura
// on each activation, Strength save or speed 0 until your next turn.
type StormEnv = "desert" | "sea" | "tundra";
const STORM_TYPE: Record<StormEnv, DamageType> = { desert: "fire", sea: "lightning", tundra: "cold" };

function stormHerald(level: number, env: StormEnv): Combatant {
  const k = kit(level);
  const dc = 8 + k.pb + k.con;
  const flat = level >= 20 ? 6 : level >= 15 ? 5 : level >= 10 ? 4 : level >= 5 ? 3 : 2;
  const seaDice = level >= 20 ? "4d6" : level >= 15 ? "3d6" : level >= 10 ? "2d6" : "1d6";
  const resist = STORM_TYPE[env];

  const aura: AutomationNode[] = level < 3 ? [] : [
    ...(env === "desert" ? [
      { type: "target" as const, who: { who: "eachEnemy" as const, withinFt: 10 }, effects: [{ type: "damage" as const, amount: String(flat), damageType: "fire" as const }] },
      { type: "target" as const, who: { who: "eachAlly" as const, withinFt: 10, excludeSelf: true }, effects: [{ type: "damage" as const, amount: String(flat), damageType: "fire" as const }] },
    ] : []),
    ...(env === "sea" ? [{
      type: "target" as const, who: { who: "chosenEnemies" as const, upTo: 1, withinFt: 10 },
      effects: [{ type: "save" as const, ability: "dex" as const, dc,
        onFail: [{ type: "damage" as const, amount: seaDice, damageType: "lightning" as const }],
        onSuccess: [{ type: "damage" as const, amount: seaDice, damageType: "lightning" as const, half: true }] }],
    }] : []),
    ...(env === "tundra" ? [
      { type: "target" as const, who: { who: "eachAlly" as const, withinFt: 10 }, effects: [{ type: "tempHp" as const, amount: String(flat) }] },
      ...(level >= 14 ? [{
        type: "target" as const, who: { who: "chosenEnemies" as const, upTo: 1, withinFt: 10 },
        effects: [{ type: "save" as const, ability: "str" as const, dc,
          onFail: [{ type: "applyEffect" as const, name: "frozen", mods: { speedZero: true, untilSourceNextTurn: true } }] }],
      }] : []),
    ] : []),
    // Shielding Storm: allies in the aura share the resistance
    ...(level >= 10 ? [{
      type: "target" as const, who: { who: "eachAlly" as const, withinFt: 10, excludeSelf: true },
      effects: [{ type: "applyEffect" as const, name: "shielding-storm", mods: { resistTypes: [resist], untilSourceNextTurn: true } }],
    }] : []),
  ];

  const seaProne: AutomationNode[] = env === "sea" && level >= 14 ? [{
    type: "branch", if: "self.has('rage')", then: [{
      type: "branch", if: "self.reactionfree", then: [
        { type: "spendReaction" },
        { type: "save", ability: "str", dc, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] },
      ],
    }],
  }] : [];

  const c = build(k, env === "sea" ? "storm-herald-barbarian" : `storm-herald-${env}-barbarian`, {
    rages: [rageAction(k, { onRage: aura })],
    riders: seaProne,
    actions: level >= 3 ? [{
      id: "storm-aura", name: "Storm Aura", cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "branch", if: "self.has('rage')", then: aura }],
    }] : [],
    bonusRoutine: level >= 3 ? ["rage", "storm-aura"] : ["rage"],
    reactions: env === "desert" && level >= 14 ? [{
      id: "raging-storm-desert", name: "Raging Storm", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasHitByAttack",
      automation: [{ type: "branch", if: "self.has('rage')", then: [{ type: "target", who: { who: "aiChoice" }, effects: [{
        type: "save", ability: "dex", dc,
        onFail: [{ type: "damage", amount: String(Math.floor(level / 2)), damageType: "fire" }], onSuccess: [],
      }] }] }],
    }] : [],
    resistances: level >= 6 ? [resist] : undefined, // Storm Soul
    speeds: env === "sea" && level >= 6 ? { swim: 30 } : undefined,
  });
  return c;
}

// -------------------------------------------------------------------------------------------- Zealot (XGtE)
// Divine Fury (3rd): while raging, the first creature you hit on each of your turns takes 1d6 + half your level extra
// damage — radiant here (necrotic is the other choice). Warrior of the Gods is non-combat. Fanatical Focus (6th): reroll a
// failed save while raging, once per rage. Zealous Presence (10th): bonus action, up to ten other creatures within 60 ft
// have advantage on attack rolls and saves until the start of your next turn (once per long rest). Rage Beyond Death
// (14th): while raging, 0 hit points doesn't knock you unconscious — you still make death saves and take failures from
// damage, but you can't die until the rage ends, and die then only if you're still at 0.
function zealot(level: number): Combatant {
  const k = kit(level);
  return build(k, "zealot-barbarian", {
    riders: level >= 3 ? [{
      type: "branch", if: "self.has('rage')",
      then: [{ type: "damage", amount: `1d6+${Math.floor(level / 2)}`, damageType: "radiant", oncePerTurn: "divine-fury" }],
    }] : [],
    specialRules: [
      ...(level >= 6 ? [{ rule: "rerollFailedSave" as const, resource: "fanatical_focus", whileEffect: "rage" }] : []),
      ...(level >= 14 ? [{ rule: "rageBeyondDeath" as const }] : []),
    ],
    resources: {
      ...(level >= 6 ? { fanatical_focus: { max: 1, recharge: "none" as const } } : {}),
      ...(level >= 10 ? { zealous_presence: { max: 1, recharge: "longRest" as const } } : {}),
    },
    rages: [rageAction(k, { onRage: level >= 6 ? [{ type: "spendResource", resource: "fanatical_focus", amount: -1 }] : [] })], // a fresh rage refreshes it
    actions: level >= 10 ? [{
      id: "zealous-presence", name: "Zealous Presence", cost: { bonus: 1 }, recharge: "none",
      limitedUse: { resource: "zealous_presence", amount: 1 },
      automation: [{ type: "target", who: { who: "eachAlly", withinFt: 60, excludeSelf: true }, effects: [{
        type: "applyEffect", name: "zealous-presence", mods: { attackAdvantage: "adv", saveAdvantage: "adv", untilSourceNextTurn: true },
      }] }],
    }] : [],
    bonusRoutine: level >= 10 ? ["rage", "zealous-presence"] : ["rage"],
  });
}

// ------------------------------------------------------------------------------ Battlerager (SCAG, dwarves only)
// The path is restricted to dwarves (a DM can lift that); the template doesn't model race. Battlerager Armor (3rd): wearing
// spiked armor while raging, a bonus-action melee attack with the spikes, 1d4 piercing + Str. Reckless Abandon (6th):
// Reckless Attack while raging also grants temporary HP equal to your Con modifier. Battlerager Charge (10th): Dash as a
// bonus action — not modeled. Spiked Retribution (14th): a creature within 5 ft that hits you with a melee attack takes
// 3 piercing damage. (The grapple rider isn't modeled.)
function battlerager(level: number): Combatant {
  const k = kit(level);
  return build(k, "battlerager-barbarian", {
    rages: [rageAction(k, { mods: level >= 14 ? { hitBackDamage: { amount: "3", damageType: "piercing", meleeOnly: true } } : {} })],
    recklessExtras: level >= 6 ? [{ type: "branch", if: "self.has('rage')", then: [{ type: "tempHp", amount: String(Math.max(1, k.con)) }] }] : [],
    actions: level >= 3 ? [{
      id: "armor-spikes", name: "Armor Spikes", cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "branch", if: "self.has('rage')", then: [{ type: "target", who: { who: "aiChoice" }, effects: [
        { type: "attack", bonus: k.pb + k.str, onHit: [{ type: "damage", amount: `1d4+${k.str}`, damageType: "piercing" }] },
      ] }] }],
    }] : [],
    bonusAfterAttack: level >= 3 ? ["armor-spikes"] : undefined,
  });
}

// ------------------------------------------------------------------------------------------ Path of the Beast (TCoE)
// Form of the Beast (3rd): each rage you choose a natural weapon. Bite: 1d8 piercing, and once a turn a hit while you're
// below half HP heals you for your proficiency bonus. Claws: 1d6 slashing, and once a turn one additional claw attack
// with the Attack action. Tail: 1d8 piercing with reach, and a reaction d8 bonus to AC against one attack. Bestial Soul
// (6th) is non-combat here. Infectious Fury (10th): a natural-weapon hit while raging forces a Wisdom save (DC 8 + Con +
// PB) or 2d12 psychic (the other option, a forced reaction attack, isn't modeled), PB times per long rest. Call the Hunt
// (14th): on raging, 5 temporary HP for each companion who joins (up to Con mod) and each adds a d6 to one hit per turn.
function beast(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const dc = 8 + k.con + k.pb;
  const fury: AutomationNode[] = level >= 10 ? [{
    type: "branch", if: "self.has('rage')", then: [{
      type: "branch", if: "self.resource('infectious_fury') > 0", then: [
        { type: "spendResource", resource: "infectious_fury", amount: 1 },
        { type: "save", ability: "wis", dc, onFail: [{ type: "damage", amount: "2d12", damageType: "psychic" }], onSuccess: [] },
      ],
    }],
  }] : [];
  const hunt: AutomationNode[] = level >= 14 ? [{
    type: "branch", if: "self.resource('call_the_hunt') > 0", then: [
      { type: "spendResource", resource: "call_the_hunt", amount: 1 },
      { type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: "5", perAlly: { each: 5, max: Math.max(1, k.con) } }] },
      { type: "target", who: { who: "eachAlly", withinFt: 30, excludeSelf: true }, effects: [{
        type: "applyEffect", name: "call-the-hunt", durationRounds: 10,
        mods: { extraDamageOnHit: { amount: "1d6", damageType: "slashing" }, extraDamageOncePerTurn: true },
      }] },
    ],
  }] : [];
  const marker = (form: string): AutomationNode => ({ type: "applyEffect", name: `form-${form}`, durationRounds: 10 });
  const rageForm = (form: "claws" | "bite" | "tail", type: DamageType) =>
    rageAction(k, { id: `rage-${form}`, name: `Rage (${form})`, type, onRage: [marker(form), ...hunt] });
  const biteHeal: AutomationNode = {
    type: "branch", if: "self.hp < self.maxhp / 2", then: [{ type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: String(k.pb), oncePerTurn: "bite-heal" }] }],
  };
  if (!sub) return build(k, "beast-barbarian");
  return build(k, "beast-barbarian", {
    rages: [rageForm("claws", "slashing"), rageForm("bite", "piercing"), rageForm("tail", "piercing")],
    opener: ["rage-claws", "rage-bite", "rage-tail"], // the AI takes the first; a player may choose any form and attack in the same turn
    attackActions: [
      attackAction(k, { die: "1d12", type: "slashing", reckless: true, gate: "self.hasnt('rage')" }), // the greataxe, before the beast comes out
      attackAction(k, { id: "attack-claws", name: "Claws", die: "1d6", type: "slashing", count: k.attacks + 1, reckless: true, riders: fury, gate: "self.canform('claws')" }),
      attackAction(k, { id: "attack-bite", name: "Bite", die: "1d8", type: "piercing", reckless: true, riders: [biteHeal, ...fury], gate: "self.canform('bite')" }),
      attackAction(k, { id: "attack-tail", name: "Tail", die: "1d8", type: "piercing", reckless: true, riders: fury, gate: "self.canform('tail')" }),
    ],
    resources: {
      ...(level >= 10 ? { infectious_fury: { max: k.pb, recharge: "longRest" as const } } : {}),
      ...(level >= 14 ? { call_the_hunt: { max: k.pb, recharge: "longRest" as const } } : {}),
    },
    reactions: [{
      id: "tail-swipe", name: "Tail Swipe", cost: { reaction: 1 }, recharge: "none",
      trigger: "an attack hits you", automation: [{ type: "branch", if: "self.has('form-tail')", then: [{ type: "note", text: "+d8 AC against the attack (engine hook)" }] }],
    }],
  });
}

// ------------------------------------------------------------------------------------------- Path of the Giant (Bigby)
// Giant's Havoc (3rd): while raging your reach grows by 5 ft (10 ft at 14th); the size change to Large (Huge at 14th) and
// Crushing Throw (thrown weapons add Rage damage) aren't modeled. Elemental Cleaver (6th): on raging, infuse your weapon
// with one damage type for the rage — it deals an extra 1d6 (2d6 at 14th) of that type; thunder here, the type the fewest
// monsters resist (acid, cold, fire, thunder or lightning are the choices, and it can change with a bonus action).
// Mighty Impel (10th) is not modeled; Giant's Power is a cantrip and a language.
function giant(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  return build(k, "giant-barbarian", {
    rages: [rageAction(k, {
      mods: sub ? { reachBonusFt: level >= 14 ? 10 : 5 } : {},
      onRage: level >= 6 ? [{
        type: "applyEffect", name: "elemental-cleaver", durationRounds: 10,
        mods: { extraDamageOnHit: { amount: level >= 14 ? "2d6" : "1d6", damageType: "thunder" } },
      }] : [],
    })],
  });
}

// ------------------------------------------------------------------------------------ Path of Wild Magic (TCoE)
// Wild Surge (3rd): on entering your rage, roll d8 on the Wild Magic table (DC 8 + PB + Con):
//   1 necrotic burst on foes within 30 ft (Con save) + 1d12 temporary HP        5 attackers take 1d6 force back
//   2 teleport 30 ft (positional: not modeled)                                  6 +1 AC to you and allies within 10 ft
//   3 an exploding spirit: 1d6 force (Dex save), and again each turn            7 difficult terrain (not modeled)
//   4 the weapon deals force damage (not modeled)                               8 a light bolt: Con save, 1d6 radiant + blinded, and again each turn
// (3 and 8 are modeled as hitting one creature; the spirit's blast is immediate rather than at end of turn.) Bolstering
// Magic (6th): an action that gives a creature d3 on attack rolls and ability checks for 10 minutes (the spell-slot option
// isn't modeled). Unstable Backlash (10th): a reaction re-rolling the table after you take damage. Controlled Surge (14th):
// roll twice and choose — the AI picks by the ranking below (this ranking is AI policy, not a rule): 1, 8, 6, 5, 3, 2, 4, 7;
// two equal dice let it choose any effect, so it takes its favorite.
function wildMagic(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const dc = 8 + k.pb + k.con;
  const foes30 = (effects: AutomationNode[]): AutomationNode => ({ type: "target", who: { who: "chosenEnemies", upTo: 1, withinFt: 30 }, effects });
  const surges: { label: string; then: AutomationNode[] }[] = [
    { label: "necrotic burst", then: [
      { type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [{ type: "save", ability: "con", dc, onFail: [{ type: "damage", amount: "1d12", damageType: "necrotic" }], onSuccess: [] }] },
      { type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: "1d12" }] },
    ] },
    { label: "teleport", then: [{ type: "note", text: "teleport up to 30 ft (positional; not modeled)" }] },
    { label: "spirit", then: [
      foes30([{ type: "save", ability: "dex", dc, onFail: [{ type: "damage", amount: "1d6", damageType: "force" }], onSuccess: [] }]),
      { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "wild-spirit", durationRounds: 10 }] },
    ] },
    { label: "force weapon", then: [{ type: "note", text: "the weapon deals force damage (not modeled)" }] },
    { label: "retribution", then: [{ type: "target", who: { who: "self" }, effects: [
      { type: "applyEffect", name: "wild-retribution", durationRounds: 10, mods: { hitBackDamage: { amount: "1d6", damageType: "force" } } },
    ] }] },
    { label: "protective lights", then: [{ type: "target", who: { who: "eachAlly", withinFt: 10 }, effects: [
      { type: "applyEffect", name: "wild-lights", durationRounds: 10, mods: { acBonus: 1 } },
    ] }] },
    { label: "flowers and vines", then: [{ type: "note", text: "difficult terrain for enemies (not modeled)" }] },
    { label: "light bolt", then: [
      foes30([{ type: "save", ability: "con", dc,
        onFail: [{ type: "damage", amount: "1d6", damageType: "radiant" }, { type: "applyCondition", condition: "blinded", durationRounds: 1 }], onSuccess: [] }]),
      { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "wild-bolt", durationRounds: 10 }] },
    ] },
  ];
  // d8 is uniform; with Controlled Surge (14th) the odds follow the AI's ranking (a 1..8 rank -> weight below)
  const RANK = [1, 8, 6, 5, 3, 2, 4, 7]; // best first, as indices into `surges` + 1
  const weights = surges.map((_, i) => {
    if (level < 14) return 1;
    const r = RANK.indexOf(i + 1) + 1; // 1 = favorite
    return r === 1 ? 22 : 16 - 2 * r; // best-of-two, with equal dice free to take the favorite
  });
  const surge: AutomationNode = { type: "randomEffect", options: surges.map((s, i) => ({ weight: weights[i], then: s.then, note: s.label })).filter((o) => o.weight > 0) };
  return build(k, "wild-magic-barbarian", {
    rages: [rageAction(k, { onRage: sub ? [surge] : [] })],
    resources: level >= 6 ? { bolstering_magic: { max: k.pb, recharge: "longRest" as const } } : {},
    actions: [
      ...(sub ? [
        { id: "wild-spirit", name: "Wild Spirit", cost: { bonus: 1 }, recharge: "none" as const, automation: [{ type: "branch" as const, if: "self.has('wild-spirit')", then: [
          foes30([{ type: "save", ability: "dex", dc, onFail: [{ type: "damage", amount: "1d6", damageType: "force" }], onSuccess: [] }]) ] }] },
        { id: "wild-bolt", name: "Wild Light Bolt", cost: { bonus: 1 }, recharge: "none" as const, automation: [{ type: "branch" as const, if: "self.has('wild-bolt')", then: [
          foes30([{ type: "save", ability: "con", dc, onFail: [{ type: "damage", amount: "1d6", damageType: "radiant" }, { type: "applyCondition", condition: "blinded", durationRounds: 1 }], onSuccess: [] }]) ] }] },
      ] : []),
      ...(level >= 6 ? [{
        id: "bolstering-magic", name: "Bolstering Magic", cost: { action: 1 }, recharge: "none" as const,
        limitedUse: { resource: "bolstering_magic", amount: 1 },
        automation: [{ type: "target" as const, who: { who: "lowestHpAlly" as const }, effects: [
          { type: "applyEffect" as const, name: "bolstering-magic", durationRounds: 100, mods: { attackBonusDice: "1d3" } },
        ] }],
      }] : []),
    ],
    reactions: level >= 10 ? [{
      id: "unstable-backlash", name: "Unstable Backlash", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.tookDamageFromAttackOrSpell",
      automation: [{ type: "branch", if: "self.has('rage')", then: [surge] }],
    }] : [],
    bonusRoutine: sub ? ["rage", "wild-spirit", "wild-bolt"] : ["rage"],
  });
}

export const BARBARIAN_BUILDERS: Record<string, (level: number) => Combatant> = {
  "berserker-barbarian": berserker,
  "totem-barbarian": (l) => totemWarrior(l, "bear"),
  "totem-wolf-barbarian": (l) => totemWarrior(l, "wolf"),
  "totem-elk-barbarian": (l) => totemWarrior(l, "elk"),
  "totem-eagle-barbarian": (l) => totemWarrior(l, "eagle"),
  "ancestral-guardian-barbarian": ancestralGuardian,
  "storm-herald-barbarian": (l) => stormHerald(l, "sea"),
  "storm-herald-desert-barbarian": (l) => stormHerald(l, "desert"),
  "storm-herald-tundra-barbarian": (l) => stormHerald(l, "tundra"),
  "zealot-barbarian": zealot,
  "battlerager-barbarian": battlerager,
  "beast-barbarian": beast,
  "giant-barbarian": giant,
  "wild-magic-barbarian": wildMagic,
};
