// Phase 3 — real per-class PC builds, each a function of level. Not min-maxed,
// but they actually cast Fireball, Spirit Guardians, a control spell, smite,
// Shield, Counterspell, etc. — so the engine's read means something.
//
// `makeTemplate("blaster-wizard", 15)` -> a schema-valid Combatant.

import type { Ability, AutomationNode, Combatant } from "../schema";
import { CASTER_BUILDERS } from "../spells/casterTemplates";
import { rogueKit, type RogueKit } from "./rogueKit";

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
  /** walking speed in feet (default 30) */
  speed?: number;
  initiativeBonus?: number;
  /** bonus-action ids the AI takes before its main action / right after its Attack action */
  bonusRoutine?: string[]; bonusAfterAttack?: string[];
}): Combatant {
  return {
    id: base.id, name: base.name, kind: "pc", size: "medium", level: base.level,
    templateId: base.id, ac: base.ac, maxHp: base.hp, speeds: { walk: base.speed ?? 30 },
    ...(base.initiativeBonus !== undefined ? { initiativeBonus: base.initiativeBonus } : {}),
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
      ...(base.bonusRoutine ? { bonusRoutine: base.bonusRoutine } : {}),
      ...(base.bonusAfterAttack ? { bonusAfterAttack: base.bonusAfterAttack } : {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────── the templates

// Fighter base (Player's Handbook): Fighting Style at 1st (Great Weapon Fighting here: a greatsword, so a 1 or 2 on
// the weapon dice is rerolled), Second Wind (bonus action, 1d10 + fighter level, once per short rest), Action Surge
// (one extra action; twice from 17th), Extra Attack at 5th / 11th / 20th. Action Surge is modeled as a bonus-cost
// action that makes one more Attack action's worth of swings. Indomitable (9th) is not modeled.
const fighterSecondWind = (level: number): Combatant["actions"][number] => ({
  id: "second-wind", name: "Second Wind", cost: { bonus: 1 }, recharge: "none",
  limitedUse: { resource: "second_wind", amount: 1 },
  // the AI uses it once it is hurt (half HP or below)
  automation: [{ type: "branch", if: "self.hp <= self.maxhp / 2", then: [
    { type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: `1d10+${level}` }] },
  ] }],
});

// Champion (Player's Handbook): Improved Critical (3rd, 19-20), Remarkable Athlete (7th, checks), Additional
// Fighting Style (10th, not modeled), Superior Critical (15th, 18-20), Survivor (18th). This is the template "fighter"
// resolves to; a Great Weapon Master feat, when a custom PC has it, is applied separately (applyFeats).
function championFighter(level: number): Combatant {
  const pb = pbFor(level);
  const baseAttacks = level >= 20 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
  const str = pb === 6 ? 5 : 4;
  const swing = () =>
    ({ type: "attack" as const, bonus: pb + str, onHit: [{ type: "damage" as const, amount: `2d6+${str}`, damageType: "slashing" as const, weaponDice: true }] });
  return pc({
    id: "gwm-fighter", name: `Fighter ${level}`, level,
    ac: 19, hp: between(level, 13, 9 * 20 + 15),
    abilities: { str: score(str), dex: score(1), con: score(3), int: score(0), wis: score(1), cha: score(0) },
    proficientSaves: ["str", "con"],
    resources: { action_surge: { max: level >= 17 ? 2 : 1, recharge: "shortRest" }, second_wind: { max: 1, recharge: "shortRest" } },
    specialRules: [
      { rule: "greatWeaponFighting" },
      ...(level >= 3 ? [{ rule: "critRange" as const, value: level >= 15 ? 18 : 19 }] : []),
    ],
    // Survivor (18th): at the start of each of your turns, regain 5 + Con modifier HP if you have no more than half
    // your hit points left (Con +3 here). Applied as a standing effect whose tick fires at the start of the turn.
    traits: level >= 18 ? [{
      id: "survivor", name: "Survivor", trigger: "encounterStart",
      automation: [{ type: "target", who: { who: "self" }, effects: [{
        type: "applyEffect", name: "survivor",
        tick: [{ type: "branch", if: "self.hp <= self.maxhp / 2", then: [{ type: "heal", amount: "8" }] }],
      }] }],
      text: "start of turn: regain 5 + Con HP while at half HP or below",
    }] : [],
    actions: [
      {
        id: "attack", name: "Attack", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: baseAttacks }, swing) }],
      },
      {
        id: "action-surge", name: "Action Surge", cost: { bonus: 1 }, recharge: "none",
        limitedUse: { resource: "action_surge", amount: 1 },
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: baseAttacks }, swing) }],
      },
      fighterSecondWind(level),
    ],
    opener: ["action-surge"], targetPriority: "lowestHp", bonusRoutine: ["second-wind"],
  });
}

// Battle Master (Player's Handbook): superiority dice — four d8s, a fifth at 7th, a sixth at 15th; d10s at 10th,
// d12s at 18th; maneuver save DC 8 + PB + Str. Three maneuvers known at 3rd, two more at 7th, 10th and 15th
// (3 / 5 / 7 / 9). Which maneuvers is the player's choice; the ones the engine can express are learned in this
// order: Precision Attack, Trip Attack, Riposte (the first three), then Menacing Attack, Rally (7th), then
// Disarming Attack (10th). Not modeled: Parry, Distracting Strike, Sweeping Attack and the rest — so a 10th-level
// build has six of its seven maneuvers, and a 15th-level one six of nine. Relentless (15th) only matters when a
// fight starts with the dice already spent, which a single encounter never does.
// Simplifications worth knowing: a swing is a greatsword (2d6 + Str, Great Weapon Fighting), and the maneuver
// variants of Attack spend their die on the FIRST swing only. Precision Attack adds the die to a roll that would
// miss and is spent only if that turns it into a hit.
const BM_LEARNED = ["precision-attack", "trip-attack", "riposte", "menacing-attack", "rally", "disarming-attack"];

function battleMasterFighter(level: number): Combatant {
  const pb = pbFor(level);
  const str = pb === 6 ? 5 : 4;
  const cha = 0;
  const baseAttacks = level >= 20 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
  const toHit = pb + str;
  const dmgPerHit = `2d6+${str}`;
  const dieSize = level >= 18 ? 12 : level >= 10 ? 10 : 8;
  const dc = 8 + pb + str;
  const known = new Set(BM_LEARNED.slice(0, level >= 15 ? 9 : level >= 10 ? 7 : level >= 7 ? 5 : 3));
  const sub = level >= 3;
  const has = (m: string) => sub && known.has(m);
  const mkSwing = (maneuver?: "trip" | "menacing" | "disarming"): AutomationNode => ({
    type: "attack", bonus: toHit, onHit: [
      { type: "damage", amount: dmgPerHit, damageType: "slashing", weaponDice: true },
      ...(maneuver
        ? [{
            type: "branch" as const, if: "self.resource('superiority') > 0",
            then: [
              { type: "spendResource" as const, resource: "superiority", amount: 1 },
              { type: "damage" as const, amount: `1d${dieSize}`, damageType: "slashing" as const },
              ...(maneuver === "trip"
                // Trip Attack: only a Large or smaller target makes the save
                ? [{ type: "branch" as const, if: "target.size<=large", then: [{ type: "save" as const, ability: "str" as const, dc, onFail: [{ type: "applyCondition" as const, condition: "prone" as const, durationRounds: 1 }] }] }]
                : maneuver === "menacing"
                  ? [{ type: "save" as const, ability: "wis" as const, dc, onFail: [{ type: "applyCondition" as const, condition: "frightened" as const, durationRounds: 1 }] }]
                  // Disarming Attack: the target drops one item. What that costs a monster (a weapon it must
                  // pick back up) isn't modeled, so beyond the die of damage this is only narration.
                  : [{ type: "save" as const, ability: "str" as const, dc, onFail: [{ type: "applyEffect" as const, name: "disarmed", durationRounds: 1 }] }]),
            ],
          }]
        : []),
    ],
  });
  const variant = (id: string, name: string, m: "trip" | "menacing" | "disarming") => ({
    id, name, cost: { action: 1 }, recharge: "none" as const,
    automation: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: Array.from({ length: baseAttacks }, (_, i) => mkSwing(i === 0 ? m : undefined)) }],
  });
  return pc({
    id: "battlemaster-fighter", name: `Fighter ${level}`, level,
    ac: 18, hp: between(level, 13, 9 * 20 + 15),
    abilities: { str: score(str), dex: score(1), con: score(3), int: score(0), wis: score(1), cha: score(cha) },
    proficientSaves: ["str", "con"],
    specialRules: [
      { rule: "greatWeaponFighting" },
      ...(has("precision-attack") ? [{ rule: "boostMissedAttack" as const, bonusDice: `1d${dieSize}`, resource: "superiority" }] : []),
    ],
    resources: {
      action_surge: { max: level >= 17 ? 2 : 1, recharge: "shortRest" },
      ...(sub ? { superiority: { max: level >= 15 ? 6 : level >= 7 ? 5 : 4, recharge: "shortRest" as const } } : {}),
      second_wind: { max: 1, recharge: "shortRest" },
    },
    actions: [
      {
        id: "attack", name: "Attack", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: baseAttacks }, () => mkSwing()) }],
      },
      ...(has("trip-attack") ? [variant("attack-trip", "Attack + Trip Attack", "trip")] : []),
      ...(has("menacing-attack") ? [variant("attack-menacing", "Attack + Menacing Attack", "menacing")] : []),
      ...(has("disarming-attack") ? [variant("attack-disarming", "Attack + Disarming Attack", "disarming")] : []),
      {
        id: "action-surge", name: "Action Surge", cost: { bonus: 1 }, recharge: "none",
        limitedUse: { resource: "action_surge", amount: 1 },
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: baseAttacks }, () => mkSwing()) }],
      },
      // Rally: a bonus action, spend a die — a friendly creature gains temporary hit points equal to the die
      // roll + your Charisma modifier
      fighterSecondWind(level),
      ...(has("rally") ? [{
        id: "rally", name: "Rally", cost: { bonus: 1 }, recharge: "none" as const,
        automation: [{
          type: "branch" as const, if: "self.resource('superiority') > 0",
          then: [{
            type: "branch" as const, if: "self.has_ally",
            then: [
              { type: "spendResource" as const, resource: "superiority", amount: 1 },
              { type: "target" as const, who: { who: "lowestHpAlly" as const }, effects: [{ type: "tempHp" as const, amount: cha ? `1d${dieSize}+${cha}` : `1d${dieSize}` }] },
            ],
          }],
        }],
      }] : []),
    ],
    // Riposte: when a creature misses you with a melee attack, spend a die and reaction to make ONE melee weapon
    // attack against it; on a hit the die is added to the damage.
    reactions: has("riposte") ? [{
      id: "riposte", name: "Riposte", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasMissedByMeleeAttack", limitedUse: { resource: "superiority", amount: 1 },
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{
        type: "attack", bonus: toHit, onHit: [
          { type: "damage", amount: dmgPerHit, damageType: "slashing", weaponDice: true },
          { type: "damage", amount: `1d${dieSize}`, damageType: "slashing" },
        ],
      }] }],
    }] : [],
    opener: ["action-surge"], targetPriority: "lowestHp", bonusRoutine: ["second-wind"],
  });
}

// ────────────────────────────────────────────────────────────────────── rogues
// Everything below is checked against the printed Rogue table and each subclass's text — see rogueKit.ts for
// the shared base (Sneak Attack, Uncanny Dodge 5th, Evasion 7th, ..., the split main-hand / off-hand attacks).
// Build assumptions the books don't decide: Dex 18 (20 from 17th); a weapon loadout per subclass — rapier +
// shortsword up close (Swashbuckler, Thief, Inquisitive) or a shortbow from range (Assassin, Mastermind, Scout,
// Arcane Trickster), chosen by what the subclass's features reward; and, for the skill checks a subclass leans on,
// proficiency in that skill (Insight, Persuasion).

/** the shared chassis, with a subclass's own bits layered on */
function buildRogue(level: number, id: string, kit: RogueKit, o: {
  cha?: number; // Charisma modifier (default +1)
  actions?: Combatant["actions"];
  resources?: Combatant["resources"];
  specialRules?: Combatant["specialRules"];
  speed?: number; initiativeBonus?: number; keepDistance?: boolean;
  bonusRoutine?: string[]; bonusAfterAttack?: string[];
} = {}): Combatant {
  return pc({
    id, name: `Rogue ${level}`, level,
    ac: 18, hp: between(level, 10, 7 * 20 + 12),
    abilities: { str: score(0), dex: score(kit.dex), con: score(2), int: score(2), wis: score(2), cha: score(o.cha ?? 1) },
    proficientSaves: kit.proficientSaves,
    specialRules: [...kit.specialRules, ...(o.specialRules ?? [])],
    resources: { ...kit.resources, ...(o.resources ?? {}) },
    traits: kit.traits,
    actions: [kit.attack, ...(kit.offhand ? [kit.offhand] : []), ...(o.actions ?? [])],
    reactions: kit.reactions,
    // a bow build shoots from range; the melee loadout fights up close (each subclass picks — see its comment)
    keepDistance: o.keepDistance ?? kit.ranged, targetPriority: "squishiest",
    speed: o.speed, initiativeBonus: o.initiativeBonus,
    bonusRoutine: o.bonusRoutine, bonusAfterAttack: o.bonusAfterAttack ?? (kit.offhand ? ["offhand"] : []),
  });
}

// Assassin (Player's Handbook), a shortbow ambusher: Assassinate (3rd) — advantage on attack rolls against any
// creature that hasn't taken a turn in the combat yet, and any hit on a SURPRISED creature is a critical hit.
// It grants no initiative bonus, and the sim has no surprise, so there is no automatic crit. Infiltration Expertise
// is utility; Impostor and Death Strike (17th) are not modeled.
function assassinRogue(level: number): Combatant {
  return buildRogue(level, "assassin-rogue", rogueKit(level, { ranged: true }), {
    specialRules: level >= 3 ? [{ rule: "assassinate" }] : [],
  });
}

// Thief (Player's Handbook): Fast Hands, Second-Story Work, Supreme Sneak and Use Magic Device are utility. The
// one combat feature is Thief's Reflexes (17th): two turns in the first round of combat — your normal initiative
// and initiative − 10 — unless you're surprised. The turn order really does get a second slot (see rollTurnOrder).
function thiefRogue(level: number): Combatant {
  return buildRogue(level, "thief-rogue", rogueKit(level), {
    keepDistance: false,
    specialRules: level >= 17 ? [{ rule: "extraFirstRoundTurn" }] : [],
  });
}

// Swashbuckler (Xanathar's Guide to Everything), assuming Charisma 14:
//   Fancy Footwork (3rd) — no opportunity attacks from a creature you made a melee attack against this turn.
//   Rakish Audacity (3rd) — + Charisma to initiative; Sneak Attack without advantage when you're within 5 ft of the
//     target, no OTHER creature is within 5 ft of you, and you don't have disadvantage.
//   Panache (9th) — action: Persuasion vs Insight; a hostile creature that loses has disadvantage on attacks against
//     anyone but you (until a companion attacks it, 1 minute). The opportunity-attack clause and the spell trigger
//     for ending it are not modeled.
//   Master Duelist (17th) — a missed attack is rolled again with advantage, once per short or long rest.
// Elegant Maneuver (13th) only buys advantage on Acrobatics / Athletics checks, which the sim has no use for.
function swashbucklerRogue(level: number): Combatant {
  const kit = rogueKit(level);
  const cha = 2;
  const sub = level >= 3;
  return buildRogue(level, "swashbuckler-rogue", kit, {
    cha, keepDistance: false, // the duelist fights at arm's length — Rakish Audacity needs it
    initiativeBonus: sub ? kit.dex + cha : undefined,
    specialRules: [
      ...(sub ? [{ rule: "fancyFootwork" as const }, { rule: "soloSneak" as const }] : []),
      ...(level >= 17 ? [{ rule: "rerollMissWithAdvantage" as const, resource: "master_duelist" }] : []),
    ],
    resources: level >= 17 ? { master_duelist: { max: 1, recharge: "shortRest" as const } } : {},
    actions: level >= 9 ? [{
      id: "panache", name: "Panache", cost: { action: 1 }, recharge: "none" as const,
      automation: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [{
        type: "contest" as const, bonus: cha + kit.pb, theirs: "wis" as const,
        onSuccess: [{ type: "applyEffect" as const, name: "panache", durationRounds: 10, mods: { disadvantageUnlessTargetingSource: true, endOnAllyAttack: true } }],
      }] }],
    }] : [],
  });
}

// Mastermind (Xanathar's): Master of Intrigue is social. Master of Tactics (3rd) — the Help action as a BONUS
// action, from up to 30 ft away: the first attack an ally makes against the creature before the start of your next
// turn has advantage. Misdirection (13th) is a positional reaction and isn't modeled. The Help takes the bonus
// action, so the off-hand swing is given up on turns the Mastermind helps someone.
function mastermindRogue(level: number): Combatant {
  const kit = rogueKit(level, { ranged: true }); // Help reaches 30 ft, so the Mastermind stays back with a bow
  return buildRogue(level, "mastermind-rogue", kit, {
    actions: level >= 3 ? [{
      id: "master-of-tactics", name: "Master of Tactics (Help)", cost: { bonus: 1 }, recharge: "none" as const,
      automation: [{ type: "branch" as const, if: "self.has_ally", then: [{ type: "target" as const, who: { who: "aiChoice" as const }, effects: [
        { type: "applyEffect" as const, name: "helped", mods: { attacksAgainstItAdvantage: "adv" as const, consumeOnAttacked: true, untilSourceNextTurn: true } },
      ] }] }],
    }] : [],
    bonusRoutine: level >= 3 ? ["master-of-tactics"] : undefined,
  });
}

// Inquisitive (Xanathar's): Ear for Deceit, Eye for Detail, Steady Eye and Unerring Eye are perception features.
//   Insightful Fighting (3rd) — bonus action: Wisdom (Insight) against the target's Charisma (Deception); on a
//     success Sneak Attack works on it without advantage (not with disadvantage), for 1 minute or until you read a
//     different creature. Assumes Insight proficiency.
//   Eye for Weakness (17th) — +3d6 Sneak Attack damage against the creature you're reading.
function inquisitiveRogue(level: number): Combatant {
  const kit0 = rogueKit(level);
  const type = "piercing" as const;
  const kit = rogueKit(level, {
    riders: level >= 17 ? [{ type: "branch", if: "lastattack.insightmarked", then: [{ type: "damage", amount: "3d6", damageType: type }] }] : [],
  });
  return buildRogue(level, "inquisitive-rogue", kit, {
    keepDistance: false,
    actions: level >= 3 ? [{
      id: "insightful-fighting", name: "Insightful Fighting", cost: { bonus: 1 }, recharge: "none" as const,
      automation: [{ type: "branch" as const, if: "self.not_reading", then: [{ type: "target" as const, who: { who: "squishiestEnemy" as const }, effects: [
        { type: "insightfulFighting" as const, bonus: 2 + kit0.pb }, // Wisdom +2, proficient in Insight
      ] }] }],
    }] : [],
    bonusRoutine: level >= 3 ? ["insightful-fighting"] : undefined,
  });
}

// Scout (Xanathar's):
//   Skirmisher (3rd) — a reaction move away from an enemy that ends its turn beside you: positional, not modeled.
//   Survivalist (3rd) — Nature / Survival expertise: not a combat feature.
//   Superior Mobility (9th) — +10 ft walking speed.
//   Ambush Master (13th) — advantage on initiative; the first creature you hit in round 1 can be hit with
//     advantage by everyone until the start of your next turn.
//   Sudden Strike (17th) — with the Attack action, one extra attack as a BONUS action that may Sneak Attack even
//     if you already did this turn, but never against the same target twice.
function scoutRogue(level: number): Combatant {
  const kit = rogueKit(level, { ranged: true }); // Skirmisher / Superior Mobility: a bow-armed skirmisher
  const sudden = level >= 17;
  const swing = (kit.attack.automation[0] as { type: "target"; who: { who: "squishiestEnemy" }; effects: AutomationNode[] });
  return buildRogue(level, "scout-rogue", kit, {
    speed: level >= 9 ? 40 : 30,
    specialRules: [
      ...(level >= 13 ? [{ rule: "initiativeAdvantage" as const }, { rule: "ambushMaster" as const }] : []),
      ...(sudden ? [{ rule: "suddenStrike" as const }] : []),
    ],
    actions: sudden ? [{
      id: "sudden-strike", name: "Sudden Strike", cost: { bonus: 1 }, recharge: "none" as const,
      automation: [{ type: "target" as const, who: { who: "squishiestEnemy" as const, preferFresh: true }, effects: swing.effects }],
    }] : [],
    bonusAfterAttack: sudden ? ["sudden-strike"] : [],
  });
}

// Soulknife (Tasha's Cauldron of Everything): Psionic Energy dice — 2 × proficiency bonus, d6 (d8 at 5th, d10 at
// 11th, d12 at 17th), all back on a long rest, and a bonus action recovers one (once per short or long rest).
//   Psychic Blades (3rd) — the Attack action swings a psychic blade: finesse, thrown 60 ft, 1d6 + ability modifier
//     psychic; then a bonus-action second blade for 1d4 + the modifier. (Sneak Attack damage is psychic too.)
//   Soul Blades (9th) — Homing Strikes: add a psionic die to a missed blade attack, spending it only if that turns the
//     miss into a hit. (Psychic Teleportation is a positional bonus action: not modeled.)
//   Psychic Veil (13th) — invisibility that ends when you deal damage: not modeled.
//   Rend Mind (17th) — Sneak Attack with the blades: Wisdom save (DC 8 + PB + Dex) or stunned for 1 minute, save each
//     turn; once per long rest, or spend three psionic dice.
function soulknifeRogue(level: number): Combatant {
  const pb0 = pbFor(level);
  const dex = pb0 === 6 ? 5 : 4;
  const dc = 8 + pb0 + dex;
  const dieSize = level >= 17 ? 12 : level >= 11 ? 10 : level >= 5 ? 8 : 6;
  const stun: AutomationNode[] = [{
    type: "save", ability: "wis", dc,
    onFail: [{ type: "applyCondition", condition: "stunned", durationRounds: 10, saveEnds: { ability: "wis", dc, at: "endOfTurn" } }],
  }];
  const rendMind: AutomationNode = {
    type: "branch", if: "lastattack.sneaklanded", then: [{
      type: "branch", if: "self.resource('rend_mind') > 0",
      then: [{ type: "spendResource", resource: "rend_mind" }, ...stun],
      else: [{ type: "branch", if: "self.resource('psi_die') >= 3", then: [{ type: "spendResource", resource: "psi_die", amount: 3 }, ...stun] }],
    }],
  };
  const sub = level >= 3;
  const kit = rogueKit(level, sub ? {
    die: "1d6", type: "psychic", offhandDie: "1d4", offhandMod: true, offhandName: "Second Psychic Blade",
    riders: level >= 17 ? [rendMind] : [],
  } : {});
  return buildRogue(level, "soulknife-rogue", kit, {
    keepDistance: true, // thrown blades (60 ft), or melee: it fights from range
    specialRules: level >= 9 ? [{ rule: "boostMissedAttack" as const, bonusDice: `1d${dieSize}`, resource: "psi_die" }] : [],
    resources: sub ? {
      psi_die: { max: 2 * pb0, recharge: "longRest" as const },
      psi_recovery: { max: 1, recharge: "shortRest" as const },
      ...(level >= 17 ? { rend_mind: { max: 1, recharge: "longRest" as const } } : {}),
    } : {},
    actions: sub ? [{
      id: "psionic-recovery", name: "Regain a Psionic Energy die", cost: { bonus: 1 }, recharge: "none" as const,
      limitedUse: { resource: "psi_recovery", amount: 1 },
      automation: [{ type: "spendResource" as const, resource: "psi_die", amount: -1 }],
    }] : [],
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
    // Danger Sense — advantage on Dex saves.
    specialRules: [{ rule: "advantageOnSaves", abilities: ["dex"] }],
    resources: { rage: { max: level >= 17 ? 6 : level >= 12 ? 5 : 4, recharge: "longRest" } },
    actions: [
      {
        id: "rage", name: "Rage", cost: { bonus: 1 }, recharge: "none",
        limitedUse: { resource: "rage", amount: 1 },
        automation: [{ type: "target", who: { who: "self" }, effects: [
          // Totem Spirit: Bear (3rd level) upgrades bare Rage's resistance to
          // physical damage only into resistance to everything but psychic —
          // modeled as a flat multiplier since EffectMods has no per-type
          // resistance list, reasonable since it only applies while raging.
          { type: "applyEffect", name: "rage", durationRounds: 10, mods: { damageTakenMultiplier: level >= 3 ? 0.5 : 0.75 } },
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
  const baseAttacks = level >= 5 ? 2 : 1; // Extra Attack from level 5
  const mkSwing = (stunAttempt: boolean, openHand = false): AutomationNode => ({
    type: "attack", bonus: pb + dex, onHit: [
      { type: "damage", amount: `1d${die}+${dex}`, damageType: "bludgeoning" },
      // spends ki to try a Stunning Strike — only on the variant that asks for it
      ...(stunAttempt
        ? [{
            type: "branch" as const, if: "self.resource('ki') > 0",
            then: [
              { type: "spendResource" as const, resource: "ki", amount: 1 },
              { type: "save" as const, ability: "con" as const, dc, onFail: [{ type: "applyCondition" as const, condition: "stunned" as const, durationRounds: 1, saveEnds: { ability: "con" as const, dc, at: "endOfTurn" as const } }] },
            ],
          }]
        : []),
      // Open Hand Technique — Way of the Open Hand's actual signature feature,
      // free on any Flurry of Blows hit (no ki cost): knock prone (picking
      // one of the 3 real options — prone / push 15ft / no reactions — same
      // simplification as Battle Master picking one save-or-effect per die)
      ...(openHand
        ? [{ type: "save" as const, ability: "dex" as const, dc, onFail: [{ type: "applyCondition" as const, condition: "prone" as const, durationRounds: 1 }] }]
        : []),
    ],
  });
  return pc({
    id: "open-hand-monk", name: `Monk ${level}`, level,
    ac: 18, hp: between(level, 9, 6 * 20 + 12),
    abilities: { str: score(1), dex: score(dex), con: score(2), int: score(0), wis: score(pb === 6 ? 4 : 3), cha: score(0) },
    // Diamond Soul (14+): proficient in every save
    proficientSaves: level >= 14 ? ["str", "dex", "con", "int", "wis", "cha"] : ["str", "dex"],
    resources: { ki: { max: Math.max(2, level), recharge: "shortRest" } },
    actions: [
      {
        id: "attack", name: "Attack", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: baseAttacks }, () => mkSwing(false)) }],
      },
      {
        // Stunning Strike is a per-hit choice in the real rules; the sim
        // opts in on up to the first 2 hits when it's picked, same cap as
        // before, rather than a wholly separate roll per swing
        id: "attack-stun", name: "Attack + Stunning Strike", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: baseAttacks }, (_, i) => mkSwing(i < 2)) }],
      },
      {
        // real cost: a bonus action AND 1 ki for 2 extra unarmed strikes —
        // previously folded into every attack for free
        id: "flurry", name: "Flurry of Blows", cost: { bonus: 1 }, recharge: "none",
        limitedUse: { resource: "ki", amount: 1 },
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: 2 }, (_, i) => mkSwing(false, i === 0)) }],
      },
    ],
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
  "gwm-fighter": championFighter,
  "battlemaster-fighter": battleMasterFighter,
  "assassin-rogue": assassinRogue,
  "thief-rogue": thiefRogue,
  "swashbuckler-rogue": swashbucklerRogue,
  "mastermind-rogue": mastermindRogue,
  "inquisitive-rogue": inquisitiveRogue,
  "scout-rogue": scoutRogue,
  "soulknife-rogue": soulknifeRogue,
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
