// Summoned / raised minion stat blocks. A `summon` automation node names one of
// these by id; the interpreter spawns `initCombatant`s from the registry and
// drops them into the initiative order on the summoner's side. They also show
// up in the enemy picker's "Minions" group as standalone options.
//
// Kept deliberately light. Both entries are SRD 5.2.1 (CC-BY-4.0); homebrew
// summons live in the git-ignored local monster JSON, not here.

import type { Action, Combatant } from "../schema";
import { parseCombatant } from "../schema";
import { FIXTURES_BY_ID } from "../fixtures";

const AI = {
  targetPriority: "squishiest" as const,
  aoeMinTargets: 2,
  opener: [] as string[],
  saveLegendaryResistanceFor: [] as string[],
  keepDistance: false,
  neverRetreat: true,
  focusFire: true,
};

function minion(base: Partial<Combatant> & Pick<Combatant, "id" | "name" | "ac" | "maxHp" | "abilities" | "pb">): Combatant {
  return parseCombatant({
    kind: "monster",
    size: "medium",
    proficientSaves: [],
    saveBonusAll: 0,
    resistances: [],
    resistancesNonmagical: [],
    immunities: [],
    vulnerabilities: [],
    conditionImmunities: [],
    specialRules: [],
    resources: {},
    traits: [],
    reactions: [],
    ai: AI,
    ...base,
  });
}

const fireElemental = minion({
  id: "fire-elemental",
  creatureType: "elemental",
  name: "Fire Elemental",
  cr: "5",
  ac: 13,
  maxHp: "12d10+36",
  speeds: { walk: 50 },
  abilities: { str: 10, dex: 17, con: 16, int: 6, wis: 10, cha: 7 },
  pb: 3,
  immunities: ["fire", "poison"],
  conditionImmunities: ["exhaustion", "grappled", "paralyzed", "petrified", "poisoned", "prone", "restrained", "unconscious"],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "touch", times: 2 }],
    },
    {
      id: "touch",
      name: "Fire Touch",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 6,
              onHit: [
                { type: "damage", amount: "2d6", damageType: "fire" },
                { type: "damage", amount: "1d10", damageType: "fire" },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const chainDevil = minion({
  id: "chain-devil",
  creatureType: "fiend",
  name: "Chain Devil",
  cr: "8",
  ac: 16,
  maxHp: "10d8+40",
  speeds: { walk: 30 },
  abilities: { str: 18, dex: 15, con: 18, int: 11, wis: 12, cha: 14 },
  pb: 3,
  immunities: ["fire", "poison"],
  resistances: ["cold"],
  resistancesNonmagical: ["bludgeoning", "piercing", "slashing"],
  conditionImmunities: ["poisoned"],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "chain", times: 2 }],
    },
    {
      id: "chain",
      name: "Animated Chain",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 8,
              onHit: [
                { type: "damage", amount: "2d6+4", damageType: "slashing" },
                {
                  type: "save",
                  ability: "str",
                  dc: 15,
                  onFail: [{ type: "applyCondition", condition: "restrained", durationRounds: 1, saveEnds: { ability: "str", dc: 15, at: "endOfTurn" } }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

// Light SRD stand-ins for the party's summon spells (Animate Dead, Conjure
// Animals, Giant Insect, …) so those spells actually field something.
const zombie = minion({
  id: "zombie",
  creatureType: "undead",
  name: "Zombie",
  cr: "1/4",
  ac: 8,
  maxHp: "3d8+9",
  speeds: { walk: 20 },
  abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  pb: 2,
  immunities: ["poison"],
  conditionImmunities: ["poisoned"],
  actions: [
    {
      id: "slam",
      name: "Slam",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        { type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 3, onHit: [{ type: "damage", amount: "1d6+1", damageType: "bludgeoning" }] }] },
      ],
    },
  ],
});

const wolf = minion({
  id: "wolf",
  creatureType: "beast",
  name: "Wolf",
  cr: "1/4",
  ac: 13,
  maxHp: "2d8+2",
  speeds: { walk: 40 },
  abilities: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
  pb: 2,
  actions: [
    {
      id: "bite",
      name: "Bite",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            {
              type: "attack",
              bonus: 4,
              onHit: [
                { type: "damage", amount: "2d4+2", damageType: "piercing" },
                { type: "save", ability: "str", dc: 11, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] },
              ],
            },
          ],
        },
      ],
    },
  ],
});

// Generic stand-ins for a PC's summoned ally (Beastmaster Primal Companion,
// Wildfire / Shepherd spirit, Summon-X spells). Fixed mid-tier stats — good for
// a level ~12-16 party, an abstraction otherwise.
const primalCompanion = minion({
  id: "primal-companion",
  creatureType: "beast",
  name: "Primal Companion",
  cr: "4",
  ac: 14,
  maxHp: "9d10+18",
  speeds: { walk: 40 },
  abilities: { str: 18, dex: 15, con: 15, int: 6, wis: 13, cha: 8 },
  pb: 3,
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "maul", times: 2 }],
    },
    {
      id: "maul",
      name: "Maul",
      cost: {},
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [{ type: "attack", bonus: 7, onHit: [{ type: "damage", amount: "2d6+4", damageType: "slashing" }] }],
        },
      ],
    },
  ],
});

const primalSpirit = minion({
  id: "primal-spirit",
  creatureType: "elemental",
  name: "Primal Spirit",
  cr: "3",
  ac: 13,
  maxHp: "6d8+12",
  speeds: { walk: 30, fly: 30 },
  abilities: { str: 10, dex: 14, con: 14, int: 13, wis: 15, cha: 11 },
  pb: 3,
  conditionImmunities: ["charmed", "frightened", "grappled", "prone", "restrained"],
  actions: [
    {
      id: "flame-seed",
      name: "Flame Seed",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [{ type: "attack", bonus: 6, onHit: [{ type: "damage", amount: "2d6+3", damageType: "fire" }] }],
        },
      ],
    },
  ],
});

// Battle Smith artificer's Steel Defender — fixed mid-tier stats, same
// abstraction as Primal Companion above.
const steelDefender = minion({
  id: "steel-defender",
  creatureType: "construct",
  name: "Steel Defender",
  cr: "2",
  ac: 15,
  maxHp: "7d8+14",
  speeds: { walk: 40 },
  abilities: { str: 14, dex: 12, con: 14, int: 6, wis: 10, cha: 6 },
  pb: 3,
  conditionImmunities: ["poisoned", "charmed", "frightened", "exhaustion"],
  actions: [
    {
      id: "rend",
      name: "Force-Empowered Rend",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [{ type: "attack", bonus: 6, onHit: [{ type: "damage", amount: "1d6+4", damageType: "force" }] }],
        },
      ],
    },
  ],
});

export const MINIONS: Record<string, Combatant> = {
  "fire-elemental": fireElemental,
  "chain-devil": chainDevil,
  zombie,
  wolf,
  "primal-companion": primalCompanion,
  "primal-spirit": primalSpirit,
  "steel-defender": steelDefender,
};

// ---------------------------------------------------------------------------
// Level-scaled PC companions — the Battle Smith's Steel Defender and the
// Artillerist's Eldritch Cannon (both Tasha's Cauldron of Everything; stat
// lines below are from the printed text). Unlike the fixed stat blocks above,
// these depend on the summoner's level / INT modifier / proficiency bonus, so
// the artificer template builders call `steelDefenderFor` / `eldritchCannonFor`
// to register the exact block they need (idempotent — same inputs, same id) and
// name it in their `summon` node. Kept out of `MINIONS` so they don't show up
// as options in the enemy picker.
export const PC_SUMMONS: Record<string, Combatant> = {};

/** Steel Defender: HP 2 + INT + 5×level, AC 15 (+2 at 15th, Improved Defender), Rend uses the
 *  artificer's spell attack modifier for 1d8 + PB force, Repair 3/day (2d8 + PB), Deflect
 *  Attack reaction. Only Dodges on its own turn unless the artificer commands it. */
export function steelDefenderFor(level: number, int: number, pb: number): string {
  const id = `steel-defender-L${level}`;
  if (PC_SUMMONS[id]) return id;
  REVERTS_ON_SUMMONER_DEATH.add(id); // "The defender also perishes if you die."
  const improved = level >= 15;
  // Arcane Jolt (9th level): when the defender hits, the artificer can channel the shared pool of
  // uses (INT mod per long rest) through the strike for extra force damage
  const joltDice = level >= 15 ? "4d6" : "2d6";
  PC_SUMMONS[id] = minion({
    id, creatureType: "construct", name: "Steel Defender", size: "medium",
    ac: improved ? 17 : 15,
    maxHp: 2 + int + 5 * level,
    speeds: { walk: 40 },
    abilities: { str: 14, dex: 12, con: 14, int: 4, wis: 10, cha: 6 },
    pb,
    proficientSaves: ["dex", "con"],
    immunities: ["poison"],
    conditionImmunities: ["charmed", "exhaustion", "poisoned"],
    specialRules: [{ rule: "cannotBeSurprised" }], // Vigilant
    commandOnly: true,
    resources: { repair: { max: 3, recharge: "longRest" } },
    actions: [
      {
        id: "dodge", name: "Dodge", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "self" }, effects: [
          { type: "applyEffect", name: "dodging", durationRounds: 1, mods: { attacksAgainstItAdvantage: "dis" } },
        ] }],
      },
      {
        id: "rend", name: "Force-Empowered Rend", cost: {}, recharge: "none",
        text: "Melee weapon attack, reach 5 ft.",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{
          type: "attack", bonus: pb + int, onHit: [
            { type: "damage", amount: `1d8+${pb}`, damageType: "force" },
            ...(level >= 9 ? [{
              type: "branch" as const, if: "party.resource('arcane_jolt') > 0",
              then: [
                { type: "spendResource" as const, resource: "arcane_jolt", from: "party" as const },
                { type: "damage" as const, amount: joltDice, damageType: "force" as const },
              ],
            }] : []),
          ],
        }] }],
      },
      {
        id: "repair", name: "Repair", cost: {}, recharge: "none",
        limitedUse: { resource: "repair", amount: 1 },
        automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: `2d8+${pb}` }] }],
      },
    ],
    reactions: [{
      id: "deflect-attack", name: "Deflect Attack", cost: { reaction: 1 }, recharge: "none",
      trigger: "ally.isAttacked",
      // Improved Defender (15th): the attacker takes 1d4 + INT force damage (engine hook in
      // reactions.ts imposes the disadvantage; this automation is the retaliation, run at the attacker)
      automation: improved
        ? [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: `1d4+${int}`, damageType: "force" }] }]
        : [{ type: "note", text: "imposes disadvantage on the attack roll (engine hook)" }],
    }],
  });
  return id;
}

/** Shadow Magic's Hound of Ill Omen: "uses the dire wolf's statistics" but Medium instead of Large (and
 *  a monstrosity, not a beast — no mechanical effect here). The temporary hit points come from the
 *  summon node. Its forced target and the save-disadvantage aura are not simulated. */
export function houndOfIllOmenFor(level: number): string {
  const id = `hound-of-ill-omen-L${level}`;
  if (PC_SUMMONS[id]) return id;
  const wolf = FIXTURES_BY_ID["dire-wolf"];
  if (!wolf) throw new Error("houndOfIllOmenFor needs the SRD dire wolf fixture");
  PC_SUMMONS[id] = parseCombatant({ ...wolf, id, name: "Hound of Ill Omen", size: "medium", creatureType: "monstrosity" }); // "it counts as a monstrosity, not a beast"
  return id;
}

export type CannonVariant = "flamethrower" | "ballista" | "protector";

/** Eldritch Cannon: AC 18, HP 5×level, immune to poison and psychic damage, all ability scores 10.
 *  Its variant's activation is a bonus action from the artificer. Explosive Cannon (9th): damage
 *  rolls +1d8 and the artificer can detonate it for a 20-ft burst. */
export function eldritchCannonFor(variant: CannonVariant, level: number, int: number, pb: number): string {
  const id = `eldritch-cannon-${variant}-L${level}`;
  if (PC_SUMMONS[id]) return id;
  const dc = 8 + pb + int;
  const explosive = level >= 9;
  const dmg = explosive ? "3d8" : "2d8"; // 2d8, +1d8 from Explosive Cannon
  const activate: Action =
    variant === "flamethrower"
      ? {
          id: "activate", name: "Flamethrower", cost: {}, recharge: "none",
          text: "Exhales fire in an adjacent 15-foot cone: Dexterity save, 2d8 fire, half on a success.",
          automation: [{ type: "target", who: { who: "area", shape: "cone", size: 15 }, effects: [{
            type: "save", ability: "dex", dc,
            onFail: [{ type: "damage", amount: dmg, damageType: "fire" }],
            onSuccess: [{ type: "damage", amount: dmg, damageType: "fire", half: true }],
          }] }],
        }
      : variant === "ballista"
        ? {
            id: "activate", name: "Force Ballista", cost: {}, recharge: "none",
            text: "Ranged spell attack, range 120 ft: 2d8 force damage, pushed up to 5 feet.",
            // the 5-foot push happens in battle mode (forced movement on the grid); Monte-Carlo has no positions
            automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{
              type: "attack", bonus: pb + int, onHit: [
                { type: "damage", amount: dmg, damageType: "force" },
                { type: "move", kind: "push", distance: 5 },
              ],
            }] }],
          }
        : {
            id: "activate", name: "Protector", cost: {}, recharge: "none",
            text: "Burst of positive energy: itself and each ally within 10 feet gains 1d8 + INT temporary hit points.",
            automation: [{ type: "target", who: { who: "eachAlly", withinFt: 10 }, effects: [
              { type: "tempHp", amount: `1d8+${Math.max(1, int)}` },
            ] }],
          };
  const detonate: Action[] = explosive ? [{
    id: "detonate", name: "Detonate", cost: {}, recharge: "none",
    text: "Destroys the cannon; each creature within 20 feet: Dexterity save, 3d8 force, half on a success.",
    automation: [
      { type: "target", who: { who: "area", shape: "emanation", size: 20 }, effects: [{
        type: "save", ability: "dex", dc,
        onFail: [{ type: "damage", amount: "3d8", damageType: "force" }],
        onSuccess: [{ type: "damage", amount: "3d8", damageType: "force", half: true }],
      }] },
      { type: "target", who: { who: "self" }, effects: [{ type: "damage", amount: "999", damageType: "force", ignoreResistances: true }] },
    ],
  }] : [];
  PC_SUMMONS[id] = minion({
    id, name: `Eldritch Cannon (${variant === "ballista" ? "Force Ballista" : variant === "flamethrower" ? "Flamethrower" : "Protector"})`,
    size: "small", ac: 18, maxHp: 5 * level,
    speeds: { walk: 0 }, // "walk or climb up to 15 feet ... provided it has legs" — this one doesn't
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    pb, immunities: ["poison", "psychic"], commandOnly: true,
    actions: [activate, ...detonate],
    ai: { ...AI, keepDistance: true },
  });
  return id;
}

/**
 * Minions of these stat blocks vanish the instant their summoner dies. Empty
 * for the bundled SRD set; homebrew summons that revert are re-registered when
 * a custom monster pack declares them.
 */
export const REVERTS_ON_SUMMONER_DEATH = new Set<string>();

// ------------------------------------------------------------------------------------------ ranger companions
// Level-scaled companions for the ranger subclasses, built from the printed text (dnd5e.wikidot.com/ranger:beast-master and
// ranger:drakewarden) and the SRD wolf (open5e). All are `commandOnly`: they only Dodge on their own turn unless their
// ranger commands them, and the ranger's command runs their "attack" / "bite" action.

const dodgeAction: Action = {
  id: "dodge", name: "Dodge", cost: { action: 1 }, recharge: "none",
  automation: [{ type: "target", who: { who: "self" }, effects: [
    { type: "applyEffect", name: "dodging", durationRounds: 1, mods: { attacksAgainstItAdvantage: "dis" } },
  ] }],
};

/**
 * Beast Master (Player's Handbook): the Ranger's Companion. A beast no larger than Medium and CR 1/4 or lower — the SRD wolf
 * here (AC 13, 11 HP, bite +4 for 2d4+2 with a DC 11 Strength save or prone, Pack Tactics). "Add your proficiency bonus to the
 * beast's AC, attack rolls, and damage rolls, as well as to any saving throws and skills it is proficient in" (the wolf has
 * none). Hit points are its normal maximum or four times the ranger's level, whichever is higher. Bestial Fury (11th):
 * two attacks when commanded to Attack. Exceptional Training's magical attacks (7th) don't matter in the sim.
 */
export function rangerCompanionFor(level: number, pb: number): string {
  const id = `ranger-companion-wolf-L${level}`;
  if (PC_SUMMONS[id]) return id;
  const wolfBase = MINIONS["wolf"];
  const bite = {
    type: "attack" as const, bonus: 4 + pb,
    onHit: [
      { type: "damage" as const, amount: `2d4+${2 + pb}`, damageType: "piercing" as const },
      { type: "save" as const, ability: "str" as const, dc: 11, onFail: [{ type: "applyCondition" as const, condition: "prone" as const, durationRounds: 1 }] },
    ],
  };
  PC_SUMMONS[id] = parseCombatant({
    ...wolfBase, id, name: "Wolf (companion)", ac: wolfBase.ac + pb, maxHp: Math.max(11, 4 * level), pb,
    commandOnly: true, specialRules: [{ rule: "packTactics" }],
    actions: [dodgeAction, {
      id: "attack", name: "Bite", cost: {}, recharge: "none", text: "Melee weapon attack, reach 5 ft.",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: level >= 11 ? 2 : 1 }, () => bite) }],
    }],
  });
  return id;
}

export type PrimalBeastKind = "land" | "sea" | "sky";

/**
 * Beast Master's optional Primal Companion (Tasha's): Beast of the Land, Sea or Sky. AC 13 + PB, HP 5 + 5 × level (4 + 4 × level for
 * the Sky), attacks at the ranger's spell attack modifier, and PB added to every ability check and saving throw. Bestial Fury
 * (11th): two attacks. Not modeled: the Land beast's Charge (needs a 20-ft straight run), the Sea beast's water-only speed, Flyby.
 */
export function primalBeastFor(kind: PrimalBeastKind, level: number, pb: number, wis: number): string {
  const id = `primal-beast-${kind}-L${level}`;
  if (PC_SUMMONS[id]) return id;
  REVERTS_ON_SUMMONER_DEATH.add(id); // "The beast also vanishes if you die."
  const attackBonus = pb + wis; // your spell attack modifier
  const sky = kind === "sky";
  const strike: Action["automation"][number] =
    kind === "land"
      ? { type: "attack", bonus: attackBonus, onHit: [{ type: "damage", amount: `1d8+${2 + pb}`, damageType: "slashing" }] }
      : kind === "sea"
        ? { type: "attack", bonus: attackBonus, onHit: [
            { type: "damage", amount: `1d6+${2 + pb}`, damageType: "piercing" },
            { type: "applyCondition", condition: "grappled" }, // escape DC is your spell save DC on the page; the engine's own grapple-escape rule is used
          ] }
        : { type: "attack", bonus: attackBonus, onHit: [{ type: "damage", amount: `1d4+${3 + pb}`, damageType: "slashing" }] };
  PC_SUMMONS[id] = minion({
    id, creatureType: "beast", name: `Beast of the ${kind[0].toUpperCase()}${kind.slice(1)}`, size: sky ? "small" : "medium",
    ac: 13 + pb,
    maxHp: sky ? 4 + 4 * level : 5 + 5 * level,
    speeds: kind === "land" ? { walk: 40, climb: 40 } : kind === "sea" ? { walk: 5, swim: 60 } : { walk: 10, fly: 60 },
    abilities: sky ? { str: 6, dex: 16, con: 13, int: 8, wis: 14, cha: 11 } : { str: 14, dex: 14, con: 15, int: 8, wis: 14, cha: 11 },
    pb,
    saveBonusAll: pb, // Primal Bond
    commandOnly: true,
    actions: [dodgeAction, {
      id: "attack", name: kind === "land" ? "Maul" : kind === "sea" ? "Binding Strike" : "Shred", cost: {}, recharge: "none",
      text: "Melee weapon attack, reach 5 ft.",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: level >= 11 ? 2 : 1 }, () => strike) }],
    }],
  });
  return id;
}

/**
 * Drakewarden's Drake Companion (Fizban's): Small dragon, AC 14 + PB, HP 5 + 5 × level, bite +3 + PB for 1d6 + PB piercing, immune to
 * the essence damage type chosen when it's summoned, and Infused Strikes — a reaction adding 1d6 of that type to another creature's
 * weapon hit within 30 ft. 7th level: wings (fly speed = walk), Medium, and Magic Fang (the bite deals an extra 1d6 of the essence
 * type); 15th: Large, and 2d6 of it. The ranger's own resistance and Reflexive Resistance live on the ranger.
 */
export function drakeFor(level: number, pb: number, essence: import("../schema").DamageType): string {
  const id = `drake-${essence}-L${level}`;
  if (PC_SUMMONS[id]) return id;
  REVERTS_ON_SUMMONER_DEATH.add(id); // "The drake remains until ... you die."
  const magicFang = level >= 15 ? "2d6" : level >= 7 ? "1d6" : undefined;
  PC_SUMMONS[id] = minion({
    id, creatureType: "dragon", name: "Drake Companion", size: level >= 15 ? "large" : level >= 7 ? "medium" : "small",
    ac: 14 + pb,
    maxHp: 5 + 5 * level,
    speeds: level >= 7 ? { walk: 40, fly: 40 } : { walk: 40 },
    abilities: { str: 16, dex: 12, con: 15, int: 8, wis: 14, cha: 8 },
    pb,
    proficientSaves: ["dex", "wis"],
    immunities: [essence],
    specialRules: [{ rule: "infusedStrikes", dice: "1d6", damageType: essence }],
    commandOnly: true,
    actions: [dodgeAction, {
      id: "bite", name: "Bite", cost: {}, recharge: "none", text: "Melee weapon attack, reach 5 ft.",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{
        type: "attack", bonus: 3 + pb,
        onHit: [
          { type: "damage", amount: `1d6+${pb}`, damageType: "piercing" },
          ...(magicFang ? [{ type: "damage" as const, amount: magicFang, damageType: essence }] : []),
        ],
      }] }],
    }],
  });
  return id;
}

/**
 * Summon Fey (Tasha's), as the Fey Wanderer's Fey Reinforcements (11th) casts it: a Small fey, AC 12 + the spell's level, HP 30 + 10 for
 * each spell level above 3rd, Multiattack of half the spell's level (rounded down) shortsword attacks at the caster's spell attack
 * modifier for 1d6 + 3 + the spell's level piercing plus 1d6 force. Fey Step (a bonus action) is assumed used every turn with the
 * Fuming mood — advantage on its next attack — so its attacks are made with advantage; the teleport isn't modeled. It shares the caster's
 * initiative, obeys without needing an action, and (Fey Reinforcements) needs no concentration.
 */
export function feySpiritFor(spellLevel: number, pb: number, wis: number): string {
  const id = `fey-spirit-L${spellLevel}-pb${pb}-wis${wis}`; // its attack bonus depends on the caster, so the caster's numbers are part of the key
  if (PC_SUMMONS[id]) return id;
  const swings = Math.max(1, Math.floor(spellLevel / 2));
  PC_SUMMONS[id] = minion({
    id, creatureType: "fey", name: "Fey Spirit", size: "small",
    ac: 12 + spellLevel,
    maxHp: 30 + 10 * (spellLevel - 3),
    speeds: { walk: 40 },
    abilities: { str: 13, dex: 16, con: 14, int: 14, wis: 11, cha: 16 },
    pb,
    conditionImmunities: ["charmed"],
    actions: [{
      id: "multiattack", name: "Shortsword", cost: { action: 1 }, recharge: "none", text: "Melee weapon attack, reach 5 ft.",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: swings }, () => ({
        type: "attack" as const, bonus: pb + wis, adv: "adv" as const,
        onHit: [
          { type: "damage" as const, amount: `1d6+${3 + spellLevel}`, damageType: "piercing" as const },
          { type: "damage" as const, amount: "1d6", damageType: "force" as const },
        ],
      })) }],
    }],
  });
  return id;
}

/**
 * The Circle of Wildfire's wildfire spirit (Tasha's): a Small elemental, AC 13, HP 5 + 5 × the druid's level, walk 30 and fly 30 (hover), immune to fire and to
 * charmed / frightened / grappled / prone / restrained. Flame Seed is a ranged spell attack at the druid's spell attack modifier for 1d6 + PB fire, at 60 ft.
 * It "shares your initiative count" but only Dodges unless the druid uses a bonus action to command it. Not modeled: Fiery Teleportation.
 */
/**
 * The specter a Hexblade binds with Accursed Specter (6th): the Monster Manual's specter — Medium undead, armor class 12, 22 hit points, fly 50 ft., Life Drain (melee spell
 * attack +4, 3d6 necrotic) — that "gains a special bonus to its attack rolls equal to your Charisma modifier". Resistant to acid, cold, fire, lightning and thunder, and to nonmagical
 * bludgeoning, piercing and slashing; immune to necrotic and poison. Life Drain's maximum-hit-point reduction (Constitution save, DC 10) and Sunlight Sensitivity aren't modeled.
 */
export function accursedSpecterFor(chaBonus: number): string {
  const id = `accursed-specter-C${chaBonus}`;
  if (PC_SUMMONS[id]) return id;
  PC_SUMMONS[id] = minion({
    id, creatureType: "undead", name: "Specter", cr: "1", size: "medium",
    ac: 12, maxHp: 22,
    speeds: { walk: 0, fly: 50 },
    abilities: { str: 1, dex: 14, con: 11, int: 10, wis: 10, cha: 11 },
    pb: 2,
    resistances: ["acid", "cold", "fire", "lightning", "thunder"],
    resistancesNonmagical: ["bludgeoning", "piercing", "slashing"],
    immunities: ["necrotic", "poison"],
    conditionImmunities: ["charmed", "exhaustion", "grappled", "paralyzed", "petrified", "poisoned", "prone", "restrained", "unconscious"],
    actions: [{
      id: "attack", name: "Life Drain", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 4 + chaBonus, onHit: [{ type: "damage", amount: "3d6", damageType: "necrotic" }] }] }],
    }],
  });
  return id;
}

/**
 * A warlock's familiar under Pact of the Chain: the Monster Manual's imp (the best of the four special forms — imp, pseudodragon, quasit, sprite): Tiny fiend, armor class 13, 10 hit points, walk 20 ft.
 * and fly 40 ft., Sting (+5, 1d4 + 3 piercing, and a Constitution save for 3d6 poison, half on a success), resistant to cold and to nonmagical bludgeoning, piercing and slashing, immune to fire and poison,
 * with Magic Resistance. "A familiar can't attack, but it can take other actions as normal": on its own turn it takes the Help action (an ally's next attack against a creature beside it has advantage),
 * and it stings only when the warlock commands it — the Attack action a Chain warlock with Investment of the Chain Master orders as a bonus action. `dc` is the save the Sting forces: 11, or the
 * warlock's own spell save DC with that invocation.
 */
export function impFamiliarFor(dc: number): string {
  const id = `familiar-imp-D${dc}`;
  if (PC_SUMMONS[id]) return id;
  PC_SUMMONS[id] = minion({
    id, creatureType: "fiend", name: "Imp", cr: "1", size: "tiny",
    ac: 13, maxHp: 10,
    speeds: { walk: 20, fly: 40 },
    abilities: { str: 6, dex: 17, con: 13, int: 11, wis: 12, cha: 14 },
    pb: 2,
    resistances: ["cold"], resistancesNonmagical: ["bludgeoning", "piercing", "slashing"],
    immunities: ["fire", "poison"], conditionImmunities: ["poisoned"],
    specialRules: [{ rule: "magicResistance" }],
    commandOnly: true,
    actions: [
      dodgeAction,
      {
        id: "help", name: "Help", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: [
          { type: "applyEffect", name: "helped", durationRounds: 1, mods: { attacksAgainstItAdvantage: "adv", consumeOnAttacked: true, untilSourceNextTurn: true } },
        ] }],
      },
      {
        id: "sting", name: "Sting", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{
          type: "attack", bonus: 5, onHit: [
            { type: "damage", amount: "1d4+3", damageType: "piercing" },
            { type: "save", ability: "con", dc, onFail: [{ type: "damage", amount: "3d6", damageType: "poison" }], onSuccess: [{ type: "damage", amount: "3d6", damageType: "poison", half: true }] },
          ],
        }] }],
      },
    ],
  });
  return id;
}

export function wildfireSpiritFor(level: number, pb: number, wis: number): string {
  const id = `wildfire-spirit-L${level}`;
  if (PC_SUMMONS[id]) return id;
  PC_SUMMONS[id] = minion({
    id, creatureType: "elemental", name: "Wildfire Spirit", size: "small",
    ac: 13, maxHp: 5 + 5 * level,
    speeds: { walk: 30, fly: 30 },
    abilities: { str: 10, dex: 14, con: 14, int: 13, wis: 15, cha: 11 },
    pb, immunities: ["fire"], conditionImmunities: ["charmed", "frightened", "grappled", "prone", "restrained"],
    commandOnly: true,
    actions: [dodgeAction, {
      id: "flame-seed", name: "Flame Seed", cost: {}, recharge: "none", ranged: true,
      text: "Ranged spell attack, 60 ft.",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb + wis, onHit: [{ type: "damage", amount: `1d6+${pb}`, damageType: "fire" }] }] }],
    }],
  });
  return id;
}
