// The monk and its ten published traditions, built from the printed text (dnd5e.wikidot.com/monk and each tradition's page): Open Hand, Shadow
// and Four Elements (Player's Handbook), Long Death and Sun Soul (Sword Coast / Xanathar's), Drunken Master and Kensei (Xanathar's), Mercy and
// Astral Self (Tasha's), Ascendant Dragon (Fizban's).
//
// Base class (the Monk table): Martial Arts die d4 / d6 / d8 / d10 (levels 1 / 5 / 11 / 17); ki points equal to your level from 2nd; Unarmored
// Defense (10 + Dex + Wis); Unarmored Movement +10 / +15 / +20 / +25 / +30 ft (2nd / 6th / 10th / 14th / 18th); Deflect Missiles 3rd; Extra Attack and
// Stunning Strike 5th; Ki-Empowered Strikes 6th; Evasion 7th; Stillness of Mind 7th; Purity of Body 10th; Diamond Soul 14th; Empty Body 18th; Perfect
// Self 20th. A monk attacks with unarmed strikes (Dex, a Martial Arts die of bludgeoning damage); after the Attack action one more unarmed strike is
// a bonus action, or Flurry of Blows (1 ki) makes two.
//
// Ki policy (the AI's, not a rule): Stunning Strike is tried on the first hit of an Attack action while at least 2 ki remain and the target isn't
// already stunned; Flurry of Blows is used after the Attack action while any ki remains, otherwise the free Martial Arts strike.
//
// Not modeled anywhere: the optional Tasha's features (Dedicated Weapon, Ki-Fueled Attack, Quickened Healing, Focused Aim — all marked Optional),
// Slow Fall, catching and throwing a deflected missile, Tongue of the Sun and Moon, Timeless Body, Ki-Empowered Strikes (magical damage isn't tracked),
// Wings Unfurled and other flight, and each tradition's out-of-combat features.

import { DAMAGE_TYPES, type Action, type AutomationNode, type Combatant, type DamageType } from "../schema";
import { SPELLS_BY_ID } from "../spells/catalog";
import { between, pbFor, pc, score } from "./pcBase";

const ALL_BUT_FORCE = DAMAGE_TYPES.filter((t) => t !== "force") as DamageType[];

const martialDie = (level: number) => (level >= 17 ? 10 : level >= 11 ? 8 : level >= 5 ? 6 : 4);
const unarmoredSpeed = (level: number) => (level >= 18 ? 30 : level >= 14 ? 25 : level >= 10 ? 20 : level >= 6 ? 15 : level >= 2 ? 10 : 0);

interface Kit {
  level: number;
  pb: number;
  dex: number;
  wis: number;
  die: number;
  ki: number;
  dc: number; // ki save DC
}

function kit(level: number): Kit {
  const pb = pbFor(level);
  return { level, pb, dex: pb === 6 ? 5 : 4, wis: 3, die: martialDie(level), ki: level >= 2 ? level : 0, dc: 8 + pb + 3 };
}

const spendKi = (n: number): AutomationNode => ({ type: "spendResource", resource: "ki", amount: n });
const kiAtLeast = (n: number) => `self.resource('ki') >= ${n}`;

interface StrikeOpts {
  type?: DamageType;
  /** modifier added to the damage (default Dex) */
  mod?: number;
  /** the die (default the Martial Arts die) */
  die?: string;
  riders?: AutomationNode[];
  adv?: boolean;
  ranged?: boolean;
}

function strike(k: Kit, o: StrikeOpts = {}): AutomationNode {
  return {
    type: "attack", bonus: k.pb + k.dex, ...(o.adv ? { adv: "adv" as const } : {}),
    onHit: [{ type: "damage", amount: `${o.die ?? `1d${k.die}`}+${o.mod ?? k.dex}`, damageType: o.type ?? "bludgeoning" }, ...(o.riders ?? [])],
  };
}

/** Stunning Strike (5th): 1 ki on a melee hit — Constitution save or stunned until the end of your next turn (once the target is stunned, don't pay again) */
const stunRider = (k: Kit): AutomationNode[] => k.level < 5 ? [] : [{
  type: "branch", if: "target.has('stunned')", then: [],
  else: [{ type: "branch", if: kiAtLeast(2), then: [
    spendKi(1),
    { type: "save", ability: "con", dc: k.dc, onFail: [{ type: "applyCondition", condition: "stunned", durationRounds: 1 }], onSuccess: [] },
  ] }],
}];

interface AttackOpts {
  id?: string;
  name?: string;
  count?: number;
  type?: DamageType;
  mod?: number;
  die?: string;
  /** extra riders on every strike */
  every?: AutomationNode[];
  /** extra riders on the first strike only (with Stunning Strike) */
  first?: AutomationNode[];
  gate?: string;
  ranged?: boolean;
  stun?: boolean;
  /** nodes after the strikes (a kensei's Agile Parry) */
  after?: AutomationNode[];
  /** strikes to append that replace the ordinary ones */
  strikes?: AutomationNode[];
}

const attackCount = (k: Kit) => (k.level >= 5 ? 2 : 1);

function attackAction(k: Kit, o: AttackOpts = {}): Action {
  const n = o.count ?? attackCount(k);
  const strikes = o.strikes ?? Array.from({ length: n }, (_, i) => strike(k, {
    type: o.type, mod: o.mod, die: o.die,
    riders: [...(i === 0 ? [...(o.stun === false ? [] : stunRider(k)), ...(o.first ?? [])] : []), ...(o.every ?? [])],
  }));
  const nodes: AutomationNode[] = [{ type: "target", who: { who: "aiChoice" }, effects: [...strikes, ...(o.after ?? [])] }];
  return {
    id: o.id ?? "attack", name: o.name ?? "Unarmed Strikes", cost: { action: 1 }, recharge: "none", ...(o.ranged ? { ranged: true } : {}),
    automation: o.gate ? [{ type: "branch", if: o.gate, then: nodes }] : nodes,
  };
}

interface BuildOpts {
  actions?: Action[];
  attackActions?: Action[];
  reactions?: Combatant["reactions"];
  traits?: Combatant["traits"];
  specialRules?: Combatant["specialRules"];
  resources?: Combatant["resources"];
  /** riders on the Flurry of Blows strikes */
  flurry?: AutomationNode[];
  /** the Flurry action's own nodes replace the ordinary two strikes */
  flurryStrikes?: AutomationNode[];
  /** nodes run first when you use Flurry (Drunken Technique) */
  flurryPrefix?: AutomationNode[];
  /** riders on the free Martial Arts strike */
  martial?: AutomationNode[];
  /** damage type / modifier for the bonus strikes */
  type?: DamageType;
  mod?: number;
  bonusRoutine?: string[];
  bonusAfterAttack?: string[];
  opener?: string[];
  acBonus?: number;
  keepDistance?: boolean;
}

function build(k: Kit, id: string, o: BuildOpts = {}): Combatant {
  const { level } = k;
  const hasKi = level >= 2;
  const bonusStrike = (riders: AutomationNode[]) => strike(k, { type: o.type, mod: o.mod, riders });
  const flurry: Action[] = hasKi ? [{
    id: "flurry", name: "Flurry of Blows", cost: { bonus: 1 }, recharge: "none", limitedUse: { resource: "ki", amount: 1 },
    automation: [
      ...(o.flurryPrefix ? [{ type: "target" as const, who: { who: "self" as const }, effects: o.flurryPrefix }] : []),
      { type: "target", who: { who: "aiChoice" }, effects: o.flurryStrikes ?? [bonusStrike(o.flurry ?? []), bonusStrike(o.flurry ?? [])] },
    ],
  }] : [];
  const martial: Action = {
    id: "martial-arts", name: "Martial Arts (bonus strike)", cost: { bonus: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: [bonusStrike(o.martial ?? o.flurry ?? [])] }],
  };
  const actions: Action[] = [
    ...(o.attackActions ?? [attackAction(k)]),
    ...flurry, martial,
    ...(hasKi ? [
      {
        id: "patient-defense", name: "Patient Defense", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "ki", amount: 1 },
        automation: [{ type: "target" as const, who: { who: "self" as const }, effects: [
          { type: "applyEffect" as const, name: "dodging", mods: { attacksAgainstItAdvantage: "dis" as const, untilSourceNextTurn: true } },
        ] }],
      },
      {
        id: "step-of-the-wind", name: "Step of the Wind (Disengage)", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "ki", amount: 1 },
        automation: [{ type: "target" as const, who: { who: "self" as const }, effects: [
          { type: "applyEffect" as const, name: "disengaged", mods: { noOpportunityAttacks: true, untilSourceNextTurn: true } },
        ] }],
      },
    ] : []),
    // Stillness of Mind (7th): an action to end an effect that is charming or frightening you
    ...(level >= 7 ? (["frightened", "charmed"] as const).map((c) => ({
      id: `stillness-of-mind-${c}`, name: `Stillness of Mind (${c})`, cost: { action: 1 }, recharge: "none" as const,
      automation: [{ type: "branch" as const, if: `self.has('${c}')`, then: [{ type: "removeEffect" as const, name: c }] }],
    })) : []),
    // Empty Body (18th): 4 ki for a minute of invisibility and resistance to everything but force
    ...(level >= 18 ? [{
      id: "empty-body", name: "Empty Body", cost: { action: 1 }, recharge: "none" as const,
      automation: [{ type: "branch" as const, if: "self.hasnt('empty-body')", then: [{
        type: "branch" as const, if: kiAtLeast(4), then: [
          spendKi(4),
          { type: "target" as const, who: { who: "self" as const }, effects: [
            { type: "applyCondition" as const, condition: "invisible" as const, durationRounds: 10 },
            { type: "applyEffect" as const, name: "empty-body", durationRounds: 10, mods: { resistTypes: ALL_BUT_FORCE } },
          ] },
        ],
      }] }],
    }] : []),
    ...(o.actions ?? []),
  ];
  const c = pc({
    id, name: `Monk ${level}`, level,
    ac: 10 + k.dex + k.wis + (o.acBonus ?? 0), // Unarmored Defense
    hp: between(level, 10, 10 + 19 * 7), // d8 hit die, Con +2
    abilities: { str: score(0), dex: score(k.dex), con: score(2), int: score(0), wis: score(k.wis), cha: score(0) },
    proficientSaves: level >= 14 ? ["str", "dex", "con", "int", "wis", "cha"] : ["str", "dex"], // Diamond Soul
    speed: 30 + unarmoredSpeed(level),
    specialRules: [
      ...(level >= 3 ? [{ rule: "deflectMissiles" as const, bonus: k.dex + level }] : []),
      ...(level >= 14 ? [{ rule: "rerollFailedSave" as const, resource: "ki" }] : []), // Diamond Soul: 1 ki to reroll a failed save
      ...(o.specialRules ?? []),
    ],
    resources: { ...(hasKi ? { ki: { max: k.ki, recharge: "shortRest" as const } } : {}), ...(o.resources ?? {}) },
    traits: [
      ...(level >= 7 ? [{ id: "evasion", name: "Evasion", trigger: "always" as const, automation: [], text: "half on a failed Dex save, none on a success (engine hook)" }] : []),
      // Perfect Self (20th): regain 4 ki on rolling initiative if you have none
      ...(level >= 20 ? [{
        id: "perfect-self", name: "Perfect Self", trigger: "encounterStart" as const,
        automation: [{ type: "branch" as const, if: kiAtLeast(1), then: [], else: [spendKi(-4)] }],
        text: "no ki at initiative: regain 4",
      }] : []),
      ...(o.traits ?? []),
    ],
    actions,
    reactions: [
      ...(level >= 3 ? [{
        id: "deflect-missiles", name: "Deflect Missiles", cost: { reaction: 1 }, recharge: "none" as const,
        trigger: "you are hit by a ranged weapon attack", automation: [{ type: "note" as const, text: "reduces the damage by 1d10 + Dex + monk level (engine hook)" }],
      }] : []),
      ...(o.reactions ?? []),
    ],
    keepDistance: o.keepDistance ?? false, targetPriority: "lowestHp",
    bonusAfterAttack: o.bonusAfterAttack ?? (hasKi ? ["flurry", "martial-arts"] : ["martial-arts"]),
    bonusRoutine: o.bonusRoutine,
    opener: o.opener,
  });
  return {
    ...c,
    ...(level >= 10 ? { immunities: [...c.immunities, "poison" as const], conditionImmunities: [...c.conditionImmunities, "poisoned" as const] } : {}), // Purity of Body
  };
}

/** a ki-cost action: only when there's ki for it */
const kiAction = (id: string, name: string, cost: number, nodes: AutomationNode[], extra: Partial<Action> = {}): Action => ({
  id, name, cost: { action: 1 }, recharge: "none", ...extra,
  automation: [{ type: "branch", if: kiAtLeast(cost), then: [spendKi(cost), ...nodes] }],
});

// ------------------------------------------------------------------------------------------------ Open Hand (PHB)
// Open Hand Technique (3rd): a Flurry of Blows hit can knock the target prone (Dex save), push it 15 ft (Str save) or stop its reactions until
// the end of your next turn — prone here. Wholeness of Body (6th): an action, three times your monk level in hit points, once per long rest (used once
// you're at half HP). Tranquility (11th) is Sanctuary at the start of the day and isn't modeled. Quivering Palm (17th): 3 ki on an unarmed hit sets the
// vibrations; an action later ends them — a Constitution save or the creature drops to 0, else 10d10 necrotic (only one creature at a time).
function openHand(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const quivering: AutomationNode[] = level >= 17 ? [{
    type: "branch", if: "any_enemy.has('quivering-palm')", then: [],
    else: [{ type: "branch", if: kiAtLeast(3), then: [spendKi(3), { type: "applyEffect", name: "quivering-palm", durationRounds: 600 }] }],
  }] : [];
  return build(k, "open-hand-monk", {
    attackActions: [attackAction(k, { first: quivering })],
    flurry: sub ? [{ type: "save", ability: "dex", dc: k.dc, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }], onSuccess: [] }] : [],
    martial: [],
    actions: [
      ...(level >= 6 ? [{
        id: "wholeness-of-body", name: "Wholeness of Body", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "wholeness_of_body", amount: 1 },
        automation: [{ type: "branch" as const, if: "self.hp <= self.maxhp / 2", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [{ type: "heal" as const, amount: String(3 * level) }] }] }],
      }] : []),
      ...(level >= 17 ? [{
        id: "end-vibrations", name: "End the vibrations (Quivering Palm)", cost: { action: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "any_enemy.has('quivering-palm')", then: [{ type: "target" as const, who: { who: "eachEnemy" as const }, effects: [{
          type: "branch" as const, if: "target.has('quivering-palm')", then: [
            { type: "save" as const, ability: "con" as const, dc: k.dc,
              onFail: [{ type: "damage" as const, amount: "9999", damageType: "force" as const, ignoreResistances: true }], // reduced to 0 hit points
              onSuccess: [{ type: "damage" as const, amount: "10d10", damageType: "necrotic" as const }] },
            { type: "removeEffect" as const, name: "quivering-palm" },
          ],
        }] }] }],
      }] : []),
    ],
    resources: level >= 6 ? { wholeness_of_body: { max: 1, recharge: "longRest" as const } } : {},
    bonusRoutine: [...(level >= 6 ? ["wholeness-of-body"] : []), ...(level >= 17 ? ["end-vibrations"] : [])],
  });
}

// ------------------------------------------------------------------------------------------------- Shadow (PHB)
// Shadow Arts (3rd) casts Darkness, Darkvision, Pass Without Trace and Silence for 2 ki — light and stealth aren't modeled. Shadow Step (6th): a bonus
// action teleport (60 ft, dim light or darkness at both ends) and advantage on the first melee attack that turn — assumed to have the light it needs, used
// as the round-1 opener with the teleport itself not modeled. Cloak of Shadows (11th): an action to turn invisible until you attack. Opportunist (17th):
// when a creature within 5 ft of you is hit by someone else's attack, a reaction melee attack against it.
function shadow(level: number): Combatant {
  const k = kit(level);
  return build(k, "shadow-monk", {
    actions: [
      ...(level >= 6 ? [{
        id: "shadow-step", name: "Shadow Step", cost: { bonus: 1 }, recharge: "none" as const,
        automation: [{ type: "target" as const, who: { who: "self" as const }, effects: [
          { type: "applyEffect" as const, name: "shadow-step", mods: { advantageOnNextAttack: true, untilSourceNextTurn: true } },
        ] }],
      }] : []),
      ...(level >= 11 ? [{
        id: "cloak-of-shadows", name: "Cloak of Shadows", cost: { action: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "self.hasnt('cloak-of-shadows')", then: [{ type: "target" as const, who: { who: "self" as const }, effects: [
          { type: "applyCondition" as const, condition: "invisible" as const, durationRounds: 600 },
          { type: "applyEffect" as const, name: "cloak-of-shadows", durationRounds: 600, mods: { endsOnAttacking: true } },
        ] }] }],
      }] : []),
    ],
    reactions: level >= 17 ? [{
      id: "opportunist", name: "Opportunist", cost: { reaction: 1 }, recharge: "none",
      trigger: "a creature within 5 ft of you is hit by another creature's attack",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [strike(k)] }],
    }] : [],
    opener: level >= 6 ? ["shadow-step"] : undefined,
  });
}

// ------------------------------------------------------------------------------------------ Four Elements (PHB)
// Disciplines: Elemental Attunement (flavor) plus one at 3rd and one more at 6th, 11th and 17th. Built: Fangs of the Fire Snake (3rd), Fist of Unbroken Air
// (6th), Flames of the Phoenix (11th, Fireball for 4 ki) and Breath of Winter (17th, Cone of Cold for 6 ki) — one legal choice. Fangs: 1 ki for
// fire-damage strikes with 10 ft more reach, and 1 ki on a hit for 1d10 more fire. Fist of Unbroken Air: 2 ki, a Strength save, 3d10 bludgeoning (half on a
// save) and prone. The spells run at their base level (spending extra ki to upcast, from 5th, isn't modeled).
function fourElements(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const spellNodes = (id: string, slot: number): AutomationNode[] =>
    SPELLS_BY_ID[id].build!({ slotLevel: slot, casterLevel: level, spellMod: k.wis, dc: k.dc, toHit: k.pb + k.wis, pb: k.pb });
  const spell = (id: string, name: string, cost: number, slot: number): Action =>
    kiAction(`discipline-${id}`, name, cost, spellNodes(id, slot), { isSpell: true });
  const fangsHit: AutomationNode[] = [{ type: "branch", if: kiAtLeast(2), then: [spendKi(1), { type: "damage", amount: "1d10", damageType: "fire" }] }];
  const fangs = attackAction(k, { type: "fire", every: fangsHit });
  const plain = attackAction(k);
  return build(k, "four-elements-monk", {
    attackActions: sub ? [{
      ...plain,
      name: "Unarmed Strikes (Fangs of the Fire Snake)",
      automation: [{ type: "branch", if: kiAtLeast(3), then: [spendKi(1), ...fangs.automation], else: plain.automation }],
    }] : [plain],
    actions: [
      ...(level >= 6 ? [kiAction("fist-of-unbroken-air", "Fist of Unbroken Air", 2, [{
        type: "target", who: { who: "aiChoice" }, effects: [{
          type: "save", ability: "str", dc: k.dc,
          onFail: [{ type: "damage", amount: "3d10", damageType: "bludgeoning" }, { type: "applyCondition", condition: "prone", durationRounds: 1 }],
          onSuccess: [{ type: "damage", amount: "3d10", damageType: "bludgeoning", half: true }],
        }],
      }])] : []),
      ...(level >= 11 ? [spell("fireball", "Flames of the Phoenix (Fireball)", 4, 3)] : []),
      ...(level >= 17 ? [spell("cone-of-cold", "Breath of Winter (Cone of Cold)", 6, 5)] : []),
    ],
  });
}

// ---------------------------------------------------------------------------------------------- Long Death (SCAG)
// Touch of Death (3rd): reducing a creature to 0 hit points gives you temporary hit points equal to Wis + monk level. Hour of Reaping (6th): an action, each
// creature within 30 ft that can see you makes a Wisdom save or is frightened until the end of your next turn. Mastery of Death (11th): 1 ki, no action, to
// stay at 1 hit point. Touch of the Long Death (17th): an action and 1-10 ki — a Constitution save, 2d10 necrotic per ki (half on a save); built for 5 and 10 ki.
function longDeath(level: number): Combatant {
  const k = kit(level);
  const touch = (points: number): Action => kiAction(`touch-of-the-long-death-${points}`, `Touch of the Long Death (${points} ki)`, points, [{
    type: "target", who: { who: "aiChoice" }, effects: [{
      type: "save", ability: "con", dc: k.dc,
      onFail: [{ type: "damage", amount: `${2 * points}d10`, damageType: "necrotic" }],
      onSuccess: [{ type: "damage", amount: `${2 * points}d10`, damageType: "necrotic", half: true }],
    }],
  }]);
  return build(k, "long-death-monk", {
    traits: level >= 3 ? [{
      id: "touch-of-death", name: "Touch of Death", trigger: "onKill",
      automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: String(Math.max(1, k.wis + level)) }] }],
      text: "reducing a creature to 0 HP: temporary HP equal to Wis + monk level",
    }] : [],
    actions: [
      ...(level >= 6 ? [{
        id: "hour-of-reaping", name: "Hour of Reaping", cost: { action: 1 }, recharge: "none" as const,
        automation: [{ type: "target" as const, who: { who: "eachEnemy" as const, withinFt: 30 }, effects: [{
          type: "save" as const, ability: "wis" as const, dc: k.dc, onFail: [{ type: "applyCondition" as const, condition: "frightened" as const, durationRounds: 1 }], onSuccess: [],
        }] }],
      }] : []),
      ...(level >= 17 ? [touch(5), touch(10)] : []),
    ],
    specialRules: level >= 11 ? [{ rule: "spendToSurvive", resource: "ki" }] : [],
  });
}

// ---------------------------------------------------------------------------------------------- Sun Soul (SCAG)
// Radiant Sun Bolt (3rd): a ranged spell attack (30 ft) using the Martial Arts die of radiant damage, usable for any Attack-action attack, and 1 ki for two
// of them as a bonus action. Built as separate options — the AI keeps to unarmed strikes (Stunning Strike needs melee). Searing Arc Strike (6th): after the
// Attack action, 2 ki for Burning Hands as a bonus action. Searing Sunburst (11th): an action, a 20-ft-radius orb (150 ft) — Constitution save or 2d6 radiant,
// +2d6 per ki spent (up to 3). Sun Shield (17th): a reaction dealing 5 + Wis radiant damage to a creature that hits you in melee.
function sunSoul(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const bolt = (): AutomationNode => strike(k, { type: "radiant" });
  const burning = SPELLS_BY_ID["burning-hands"];
  return build(k, "sun-soul-monk", {
    attackActions: [
      attackAction(k),
      ...(sub ? [attackAction(k, { id: "attack-sun-bolt", name: "Radiant Sun Bolts", strikes: Array.from({ length: attackCount(k) }, bolt), ranged: true })] : []),
    ],
    actions: [
      ...(sub ? [{
        id: "sun-bolt-flurry", name: "Radiant Sun Bolts (1 ki, bonus action)", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "ki", amount: 1 }, ranged: true,
        automation: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [bolt(), bolt()] }],
      }] : []),
      ...(level >= 6 ? [{
        id: "searing-arc-strike", name: "Searing Arc Strike (Burning Hands)", cost: { bonus: 1 }, recharge: "none" as const, isSpell: true,
        automation: [{ type: "branch" as const, if: kiAtLeast(2), then: [spendKi(2), ...burning.build!({ slotLevel: 1, casterLevel: level, spellMod: k.wis, dc: k.dc, toHit: k.pb + k.wis, pb: k.pb })] }],
      }] : []),
      ...(level >= 11 ? [{
        id: "searing-sunburst", name: "Searing Sunburst", cost: { action: 1 }, recharge: "none" as const,
        automation: [{ type: "target" as const, who: { who: "area" as const, shape: "sphere" as const, size: 20 }, effects: [{
          type: "branch" as const, if: kiAtLeast(3),
          then: [spendKi(3), { type: "save" as const, ability: "con" as const, dc: k.dc, onFail: [{ type: "damage" as const, amount: "8d6", damageType: "radiant" as const }], onSuccess: [] }],
          else: [{ type: "save" as const, ability: "con" as const, dc: k.dc, onFail: [{ type: "damage" as const, amount: "2d6", damageType: "radiant" as const }], onSuccess: [] }],
        }] }],
      }] : []),
    ],
    reactions: level >= 17 ? [{
      id: "sun-shield", name: "Sun Shield", cost: { reaction: 1 }, recharge: "none",
      trigger: "a creature hits you with a melee attack",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: String(5 + k.wis), damageType: "radiant" }] }],
    }] : [],
  });
}

// ------------------------------------------------------------------------------------------- Drunken Master (XGtE)
// Drunken Technique (3rd): Flurry of Blows also Disengages and adds 10 ft of speed for the turn. Tipsy Sway (6th): Redirect Attack — 1 ki and a reaction to make
// a melee attack that missed you hit a different creature beside you instead (standing up cheaply is a movement rule). Drunkard's Luck (11th): 2 ki to cancel
// disadvantage on an attack roll or save. Intoxicated Frenzy (17th): Flurry of Blows can make up to five attacks provided each targets a different creature —
// used against two or more foes; against one, the ordinary two-strike Flurry.
function drunkenMaster(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const frenzy: AutomationNode[] = level >= 17
    ? [0, 1, 2, 3, 4].map((i) => ({ type: "branch" as const, if: `enemies >= ${i + 1}`, then: [{ type: "target" as const, who: { who: "enemyRank" as const, rank: i }, effects: [strike(k)] }] }))
    : [];
  const c = build(k, "drunken-master-monk", {
    flurryPrefix: sub ? [{ type: "applyEffect", name: "drunken-technique", mods: { noOpportunityAttacks: true, speedBonusFt: 10, untilSourceNextTurn: true } }] : undefined,
    reactions: level >= 6 ? [{
      id: "redirect-attack", name: "Redirect Attack", cost: { reaction: 1 }, recharge: "none", limitedUse: { resource: "ki", amount: 1 },
      trigger: "a creature misses you with a melee attack", automation: [{ type: "note", text: "the attack hits another creature beside you instead (engine hook)" }],
    }] : [],
    specialRules: level >= 11 ? [{ rule: "cancelDisadvantage", resource: "ki", cost: 2 }] : [],
  });
  if (level < 17) return c;
  // Intoxicated Frenzy replaces the two-strike Flurry with up to five strikes on different creatures
  // (with a single foe the ordinary two-strike Flurry stays: the extra attacks must each pick a different creature)
  return { ...c, actions: c.actions.map((a) => a.id !== "flurry" ? a : { ...a, automation: [...a.automation.slice(0, -1), {
    type: "branch" as const, if: "enemies >= 2", then: frenzy, else: [a.automation[a.automation.length - 1]],
  }] }) };
}

// -------------------------------------------------------------------------------------------------- Kensei (XGtE)
// A longsword is the kensei melee weapon (1d8, or the Martial Arts die once it's larger). Agile Parry (3rd): with an unarmed strike in the same Attack action
// (from 5th level) you gain +2 AC until your next turn. Deft Strike (6th): 1 ki adds a Martial Arts die to a weapon hit, once a turn. Sharpen the Blade (11th): a
// bonus action and up to 3 ki for a +1 to +3 bonus to attack and damage for a minute. Unerring Accuracy (17th): a missed monk-weapon attack is rerolled once a
// turn. The ranged kensei weapon and Kensei's Shot aren't built.
function kensei(level: number): Combatant {
  const k = kit(level);
  const die = Math.max(8, k.die);
  const deft: AutomationNode[] = level >= 6 ? [{ type: "branch", if: kiAtLeast(2), then: [spendKi(1), { type: "damage", amount: `1d${k.die}`, damageType: "slashing", oncePerTurn: "deft-strike" }] }] : [];
  const sword = (riders: AutomationNode[]): AutomationNode => strike(k, { type: "slashing", die: `1d${die}`, riders });
  const parry: AutomationNode[] = level >= 5 && level >= 3 ? [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "agile-parry", mods: { acBonus: 2, untilSourceNextTurn: true } }] }] : [];
  const attack: Action = {
    id: "attack", name: "Longsword + unarmed strike", cost: { action: 1 }, recharge: "none",
    automation: [
      { type: "target", who: { who: "aiChoice" }, effects: level >= 5
        ? [sword([...stunRider(k), ...deft]), strike(k)]
        : [sword(deft)] },
      ...parry,
    ],
  };
  return build(k, "kensei-monk", {
    attackActions: [attack],
    actions: level >= 11 ? [{
      id: "sharpen-the-blade", name: "Sharpen the Blade", cost: { bonus: 1 }, recharge: "none" as const,
      automation: [{ type: "branch" as const, if: "self.hasnt('sharpened-blade')", then: [{ type: "branch" as const, if: kiAtLeast(3), then: [
        spendKi(3),
        { type: "target" as const, who: { who: "self" as const }, effects: [
          { type: "applyEffect" as const, name: "sharpened-blade", durationRounds: 10, mods: { attackBonusAll: 3, extraDamageOnHit: { amount: "3", damageType: "slashing" as const } } },
        ] },
      ] }] }],
    }] : [],
    specialRules: level >= 17 ? [{ rule: "rerollMissOncePerTurn" }] : [],
    bonusRoutine: level >= 11 ? ["sharpen-the-blade"] : undefined,
  });
}

// --------------------------------------------------------------------------------------------------- Mercy (TCoE)
// Hands of Harm (3rd): 1 ki on an unarmed hit for extra necrotic damage (a Martial Arts die + Wis), once a turn; from 6th it also poisons the target until the end
// of your next turn (Physician's Touch). Hands of Healing (3rd): an action and 1 ki restore a Martial Arts die + Wis — as an action that's poor value, so the AI
// uses it only to stand a downed ally back up. Flurry of Healing and Harm (11th): Hands of Harm on Flurry strikes for free, and each Flurry strike may instead
// be a free Hands of Healing — built as a Flurry of Healing (two heals) chosen once the party is missing 30+ hit points, in place of the ordinary Flurry (a
// mix of heals and strikes isn't chosen). Hand of Ultimate Mercy (17th): 5 ki, once per long rest, returns a fallen ally to life with 4d10 + Wis hit points.
function mercy(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const harm = (free: boolean): AutomationNode[] => !sub ? [] : [{
    type: "branch", if: free ? "round >= 1" : kiAtLeast(2), then: [
      ...(free ? [] : [spendKi(1)]),
      { type: "damage", amount: `1d${k.die}+${k.wis}`, damageType: "necrotic", oncePerTurn: "hands-of-harm" },
      ...(level >= 6 ? [{ type: "applyCondition" as const, condition: "poisoned" as const, durationRounds: 1 }] : []),
    ],
  }];
  return build(k, "mercy-monk", {
    attackActions: [attackAction(k, { first: harm(false) })],
    flurry: level >= 11 ? harm(true) : harm(false),
    martial: harm(false),
    actions: [
      // Hands of Healing as an action is only worth it to stand a downed ally back up
      ...(sub ? [{
        id: "hands-of-healing", name: "Hands of Healing", cost: { action: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "party.has_downed", then: [{ type: "branch" as const, if: kiAtLeast(1), then: [
          spendKi(1),
          { type: "target" as const, who: { who: "lowestHpAlly" as const, includeDowned: true }, effects: [{ type: "heal" as const, amount: `1d${k.die}+${k.wis}` }] },
        ] }] }],
      }] : []),
      // Flurry of Healing and Harm (11th): each Flurry strike can be a free Hands of Healing instead — used once the party has lost a fair amount
      ...(level >= 11 ? [{
        id: "flurry-of-healing", name: "Flurry of Healing", cost: { bonus: 1 }, recharge: "none" as const, limitedUse: { resource: "ki", amount: 1 },
        automation: [{ type: "branch" as const, if: "party.missing_hp >= 30", then: [1, 2].map(() => ({
          type: "target" as const, who: { who: "lowestHpAlly" as const }, effects: [{ type: "heal" as const, amount: `1d${k.die}+${k.wis}` }],
        })) }],
      }] : []),
      ...(level >= 17 ? [{
        id: "hand-of-ultimate-mercy", name: "Hand of Ultimate Mercy", cost: { action: 1 }, recharge: "none" as const, limitedUse: { resource: "ultimate_mercy", amount: 1 },
        automation: [{ type: "branch" as const, if: "party.has_dead", then: [{ type: "branch" as const, if: kiAtLeast(5), then: [
          spendKi(5), { type: "revive" as const, dice: `4d10+${k.wis}` },
        ] }] }],
      }] : []),
    ],
    resources: level >= 17 ? { ultimate_mercy: { max: 1, recharge: "longRest" as const } } : {},
    bonusAfterAttack: [...(level >= 11 ? ["flurry-of-healing"] : []), "flurry", "martial-arts"],
    bonusRoutine: level >= 17 ? ["hand-of-ultimate-mercy"] : undefined,
  });
}

// ---------------------------------------------------------------------------------------------- Astral Self (TCoE)
// Arms of the Astral Self (3rd): a bonus action and 1 ki — each creature of your choice within 10 ft makes a Dexterity save or takes two Martial Arts dice of force
// damage; for 10 minutes the arms make unarmed strikes of force damage with 5 ft more reach. Visage (6th) is folded into activating the arms (1 more ki; its
// sight and social benefits aren't modeled). Body (11th): Deflect Energy, a reaction cutting acid / cold / fire / force / lightning / thunder damage by 1d10 + Wis,
// and Empowered Arms, an extra Martial Arts die once a turn with the arms. Awakened Astral Self (17th): 5 ki for all three, +2 AC, and three attacks with the arms.
function astralSelf(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const empowered: AutomationNode[] = level >= 11 ? [{ type: "damage", amount: `1d${k.die}`, damageType: "force", oncePerTurn: "empowered-arms" }] : [];
  const armStrike = (): AutomationNode => strike(k, { type: "force", riders: empowered });
  const burst = (cost: number): AutomationNode[] => [
    spendKi(cost),
    { type: "target", who: { who: "eachEnemy", withinFt: 10 }, effects: [{ type: "save", ability: "dex", dc: k.dc, onFail: [{ type: "damage", amount: `2d${k.die}`, damageType: "force" }], onSuccess: [] }] },
    { type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "astral-arms", durationRounds: 100, mods: { reachBonusFt: 5 } }] },
  ];
  const summonKi = level >= 6 ? 2 : 1;
  const armsAware = (plain: AutomationNode): AutomationNode => ({ type: "branch", if: "self.has('astral-arms')", then: [armStrike()], else: [plain] });
  const c = build(k, "astral-self-monk", {
    attackActions: sub ? [
      attackAction(k, { gate: "self.hasnt('astral-arms')" }),
      attackAction(k, { id: "attack-astral-arms", name: "Astral Arms", gate: "self.has('astral-arms')", strikes: Array.from({ length: attackCount(k) }, (_, i) => strike(k, { type: "force", riders: [...(i === 0 ? stunRider(k) : []), ...empowered] })) }),
      ...(level >= 17 ? [attackAction(k, { id: "attack-astral-barrage", name: "Astral Barrage", gate: "self.has('awakened-astral-self')", strikes: [0, 1, 2].map((i) => strike(k, { type: "force", riders: [...(i === 0 ? stunRider(k) : []), ...empowered] })) })] : []),
    ] : [attackAction(k)],
    flurryStrikes: sub ? [armsAware(strike(k)), armsAware(strike(k))] : undefined,
    actions: [
      ...(sub ? [{
        id: "arms-of-the-astral-self", name: "Arms of the Astral Self", cost: { bonus: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "self.hasnt('astral-arms')", then: [{ type: "branch" as const, if: kiAtLeast(summonKi), then: burst(summonKi) }] }],
      }] : []),
      ...(level >= 17 ? [{
        id: "awakened-astral-self", name: "Awakened Astral Self", cost: { bonus: 1 }, recharge: "none" as const,
        automation: [{ type: "branch" as const, if: "self.hasnt('awakened-astral-self')", then: [{ type: "branch" as const, if: kiAtLeast(5), then: [
          ...burst(5).filter((n) => n.type !== "target" || (n.who.who !== "self")),
          { type: "target" as const, who: { who: "self" as const }, effects: [
            { type: "applyEffect" as const, name: "astral-arms", durationRounds: 100, mods: { reachBonusFt: 5 } },
            { type: "applyEffect" as const, name: "awakened-astral-self", durationRounds: 100, mods: { acBonus: 2 } },
          ] },
        ] }] }],
      }] : []),
    ],
    reactions: level >= 11 ? [{
      id: "deflect-energy", name: "Deflect Energy", cost: { reaction: 1 }, recharge: "none",
      trigger: "you take acid, cold, fire, force, lightning or thunder damage",
      automation: [{ type: "branch", if: "self.has('astral-arms')", then: [{ type: "note", text: "reduces the damage by 1d10 + Wis (engine hook)" }] }],
    }] : [],
    specialRules: level >= 11 ? [{ rule: "deflectEnergy", bonus: k.wis }] : [],
    opener: sub ? [level >= 17 ? "awakened-astral-self" : "arms-of-the-astral-self"] : undefined,
  });
  return c;
}

// ------------------------------------------------------------------------------------------ Ascendant Dragon (Fizban's)
// Breath of the Dragon (3rd): replaces one Attack-action attack with a 20-ft cone — Dexterity save against your ki DC, two Martial Arts dice of fire damage
// (three at 11th), half on a save; proficiency-bonus times per long rest, then 2 ki each. Aspect of the Wyrm (11th): a bonus action, once per long rest or for 3
// ki — built as the Frightful Presence option (a Wisdom save or frightened) and, from 17th (Explosive Fury), 3d10 fire to creatures in the aura who fail a Dexterity
// save. Ascendant Aspect (17th): Augment Breath, 1 ki more for four dice. Not modeled: Draconic Strike's damage types, Draconic Presence's rerolls, Wings Unfurled,
// the Resistance option, blindsight. The breath's damage type is fire.
function ascendantDragon(level: number): Combatant {
  const k = kit(level);
  const sub = level >= 3;
  const dice = level >= 17 ? 4 : level >= 11 ? 3 : 2;
  const breath = (extra: number): AutomationNode => ({
    type: "target", who: { who: "area", shape: "cone", size: 20 }, effects: [{
      type: "save", ability: "dex", dc: k.dc,
      onFail: [{ type: "damage", amount: `${dice - extra}d${k.die}`, damageType: "fire" }],
      onSuccess: [{ type: "damage", amount: `${dice - extra}d${k.die}`, damageType: "fire", half: true }],
    }],
  });
  const withBreath = (id: string, name: string, extra: Partial<Action>, guard: (nodes: AutomationNode[]) => AutomationNode[]): Action => ({
    id, name, cost: { action: 1 }, recharge: "none", ...extra,
    automation: guard([
      { type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attackCount(k) - 1 }, () => strike(k, { riders: stunRider(k) })) },
      // (below 17th level there is no augment: the ordinary breath)
      breath(level >= 17 ? 0 : 0),
    ]),
  });
  const aspect: AutomationNode[] = [
    { type: "target", who: { who: "eachEnemy", withinFt: 10 }, effects: [{ type: "save", ability: "wis", dc: k.dc, onFail: [{ type: "applyCondition", condition: "frightened", durationRounds: 10 }], onSuccess: [] }] },
    ...(level >= 17 ? [{ type: "target" as const, who: { who: "eachEnemy" as const, withinFt: 10 }, effects: [{
      type: "save" as const, ability: "dex" as const, dc: k.dc, onFail: [{ type: "damage" as const, amount: "3d10", damageType: "fire" as const }], onSuccess: [],
    }] }] : []),
  ];
  return build(k, "ascendant-dragon-monk", {
    attackActions: sub ? [
      attackAction(k),
      withBreath("attack-breath", "Unarmed Strike + Breath of the Dragon", { limitedUse: { resource: "dragon_breath", amount: 1 } }, (n) => n),
      withBreath("attack-breath-ki", "Unarmed Strike + Breath of the Dragon (2 ki)", {}, (n) => [{ type: "branch", if: kiAtLeast(2), then: [spendKi(2), ...n] }]),
    ] : [attackAction(k)],
    resources: sub ? { dragon_breath: { max: k.pb, recharge: "longRest" as const }, ...(level >= 11 ? { aspect_of_the_wyrm: { max: 1, recharge: "longRest" as const } } : {}) } : {},
    actions: level >= 11 ? [{
      id: "aspect-of-the-wyrm", name: "Aspect of the Wyrm (Frightful Presence)", cost: { bonus: 1 }, recharge: "none" as const,
      automation: [{ type: "branch" as const, if: "self.hasnt('aspect-of-the-wyrm')", then: [{
        type: "branch" as const, if: "self.resource('aspect_of_the_wyrm') > 0",
        then: [{ type: "spendResource" as const, resource: "aspect_of_the_wyrm", amount: 1 }, { type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "aspect-of-the-wyrm", durationRounds: 10 }] }, ...aspect],
        else: [{ type: "branch" as const, if: kiAtLeast(3), then: [spendKi(3), { type: "target" as const, who: { who: "self" as const }, effects: [{ type: "applyEffect" as const, name: "aspect-of-the-wyrm", durationRounds: 10 }] }, ...aspect] }],
      }] }],
    }] : [],
    bonusRoutine: level >= 11 ? ["aspect-of-the-wyrm"] : undefined,
  });
}

/** the plain Monk with no tradition (before 3rd level a monk of any tradition looks like this) */
export const MONK_BUILDERS: Record<string, (level: number) => Combatant> = {
  "open-hand-monk": openHand,
  "shadow-monk": shadow,
  "four-elements-monk": fourElements,
  "long-death-monk": longDeath,
  "sun-soul-monk": sunSoul,
  "drunken-master-monk": drunkenMaster,
  "kensei-monk": kensei,
  "mercy-monk": mercy,
  "astral-self-monk": astralSelf,
  "ascendant-dragon-monk": ascendantDragon,
};
