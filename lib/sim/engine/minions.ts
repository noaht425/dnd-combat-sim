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
    id, name: "Steel Defender", size: "medium",
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
  PC_SUMMONS[id] = parseCombatant({ ...wolf, id, name: "Hound of Ill Omen", size: "medium" });
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
            // the 5-foot push is not simulated (the interpreter's "move" push/pull nodes are no-ops)
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
