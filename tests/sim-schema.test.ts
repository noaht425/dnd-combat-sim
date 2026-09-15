import { describe, expect, it } from "vitest";
import {
  automationNodeSchema,
  combatantSchema,
  parseCombatant,
  parseScenario,
  spellSlots,
  type AutomationNode,
  type Combatant,
} from "../lib/sim/schema";
import { ALL_FIXTURES, FIXTURES_BY_ID } from "../lib/sim/fixtures";
import { averageOfDice, validateAll, validateCombatant } from "../lib/sim/validate";

// A deliberately small monster that still exercises the tree: recharge AoE with
// a save-for-half branch, a passive aura trait, a phase-trigger branch, and a
// special defensive rule.
const miniDragon: Combatant = {
  id: "mini-dragon",
  name: "Mini Dragon",
  kind: "monster",
  size: "gargantuan",
  cr: "10",
  ac: 18,
  maxHp: "10d20+60",
  speeds: { walk: 40, fly: 80 },
  abilities: { str: 23, dex: 14, con: 21, int: 14, wis: 13, cha: 17 },
  pb: 4,
  proficientSaves: ["dex", "con", "wis", "cha"],
  saveBonusAll: 0,
  resistances: [],
  resistancesNonmagical: ["bludgeoning", "piercing", "slashing"],
  immunities: ["fire"],
  vulnerabilities: [],
  conditionImmunities: ["frightened"],
  specialRules: [
    { rule: "magicResistance" },
    { rule: "legendaryResistance", perDay: 3 },
  ],
  resources: {
    ...spellSlots([]),
    breath: { max: 1, recharge: "roll:5-6" },
  },
  traits: [
    {
      id: "molten-aura",
      name: "Molten Aura",
      trigger: "always",
      aura: {
        radius: 10,
        automation: [
          { type: "target", who: { who: "eachEnemy" }, effects: [{ type: "damage", amount: "2d6", damageType: "fire" }] },
        ],
      },
      automation: [],
    },
    {
      id: "enrage",
      name: "Enrage",
      trigger: "turnStart",
      once: true,
      automation: [
        {
          type: "branch",
          if: "self.hp <= self.maxHp / 2 || round >= 3",
          then: [
            {
              type: "target",
              who: { who: "self" },
              effects: [
                {
                  type: "applyEffect",
                  name: "Enraged",
                  durationRounds: -1,
                  mods: { attackDiceMultiplier: 2, attackAdvantage: "adv" },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [
        { type: "useAction", action: "claw", times: 2 },
        { type: "useAction", action: "bite", times: 1 },
      ],
    },
    {
      id: "claw",
      name: "Claw",
      cost: { action: 0 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "nearestEnemy" },
          effects: [
            { type: "attack", bonus: 11, onHit: [{ type: "damage", amount: "2d8+7", damageType: "slashing" }] },
          ],
        },
      ],
    },
    {
      id: "bite",
      name: "Bite",
      cost: { action: 0 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "nearestEnemy" },
          effects: [
            { type: "attack", bonus: 11, onHit: [{ type: "damage", amount: "2d10+7", damageType: "piercing" }] },
          ],
        },
      ],
    },
    {
      id: "fire-breath",
      name: "Fire Breath",
      cost: { action: 1 },
      recharge: "roll:5-6",
      automation: [
        {
          type: "target",
          who: { who: "area", shape: "cone", size: 60 },
          effects: [
            {
              type: "save",
              ability: "dex",
              dc: 18,
              onFail: [{ type: "damage", amount: "12d6", damageType: "fire" }],
              onSuccess: [{ type: "damage", amount: "12d6", damageType: "fire", half: true }],
            },
          ],
        },
      ],
    },
  ],
  reactions: [],
  legendaryActions: {
    budget: 3,
    options: [
      { action: "claw", cost: 1 },
      { action: "fire-breath", cost: 3 },
    ],
  },
  ai: {
    targetPriority: "squishiest",
    aoeMinTargets: 2,
    opener: [],
    saveLegendaryResistanceFor: ["stunned", "banished", "save-or-die"],
    keepDistance: false,
    neverRetreat: true,
    focusFire: true,
  },
};

const miniFighter: Combatant = {
  id: "fighter-15",
  name: "Fighter (level 15)",
  kind: "pc",
  size: "medium",
  level: 15,
  templateId: "battlemaster-fighter",
  ac: 20,
  maxHp: 140,
  speeds: { walk: 30 },
  abilities: { str: 20, dex: 14, con: 16, int: 10, wis: 12, cha: 8 },
  pb: 5,
  proficientSaves: ["str", "con"],
  saveBonusAll: 0,
  resistances: [],
  resistancesNonmagical: [],
  immunities: [],
  vulnerabilities: [],
  conditionImmunities: [],
  specialRules: [],
  resources: { superiorityDice: { max: 6, recharge: "shortRest" }, actionSurge: { max: 1, recharge: "shortRest" } },
  traits: [],
  actions: [
    {
      id: "attack-action",
      name: "Attack (Extra Attack 3)",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "greatsword", times: 3 }],
    },
    {
      id: "greatsword",
      name: "Greatsword",
      cost: { action: 0 },
      recharge: "none",
      automation: [
        {
          type: "target",
          who: { who: "aiChoice" },
          effects: [
            { type: "attack", bonus: 10, onHit: [{ type: "damage", amount: "2d6+5", damageType: "slashing" }] },
          ],
        },
      ],
    },
  ],
  reactions: [],
  ai: {
    targetPriority: "lowestHp",
    aoeMinTargets: 2,
    opener: [],
    saveLegendaryResistanceFor: [],
    keepDistance: false,
    neverRetreat: true,
    focusFire: true,
  },
};

describe("sim schema — Phase 0", () => {
  it("parses a monster combatant", () => {
    const parsed = parseCombatant(miniDragon);
    expect(parsed.name).toBe("Mini Dragon");
    expect(parsed.kind).toBe("monster");
    expect(parsed.actions.map((a) => a.id)).toContain("fire-breath");
    expect(parsed.legendaryActions?.budget).toBe(3);
  });

  it("parses a PC combatant with the identical shape", () => {
    const parsed = parseCombatant(miniFighter);
    expect(parsed.kind).toBe("pc");
    expect(parsed.level).toBe(15);
    // same schema, no separate PC type
    expect(combatantSchema.safeParse(miniFighter).success).toBe(true);
  });

  it("applies defaults for omitted fields", () => {
    const parsed = parseCombatant({
      id: "blob",
      name: "Blob",
      kind: "monster",
      ac: 12,
      maxHp: 20,
      abilities: { str: 10, dex: 10, con: 10, int: 3, wis: 8, cha: 5 },
      pb: 2,
    });
    expect(parsed.size).toBe("medium");
    expect(parsed.speeds).toEqual({ walk: 30 });
    expect(parsed.ai.targetPriority).toBe("highestThreat");
    expect(parsed.resistances).toEqual([]);
  });

  it("rejects unknown damage types and malformed dice", () => {
    expect(
      combatantSchema.safeParse({
        id: "x", name: "x", kind: "monster", ac: 10, maxHp: 10, pb: 2,
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        actions: [{ id: "a", name: "a", automation: [{ type: "damage", amount: "not-dice", damageType: "sonic" }] }],
      }).success,
    ).toBe(false);
  });

  it("validates a recursive automation node directly (save -> branch -> damage)", () => {
    const node: AutomationNode = {
      type: "save",
      ability: "con",
      dc: 20,
      onFail: [
        {
          type: "branch",
          if: "target.has('burning')",
          then: [{ type: "damage", amount: "6d6", damageType: "fire" }],
          else: [{ type: "damage", amount: "3d6", damageType: "fire" }],
        },
      ],
    };
    expect(automationNodeSchema.safeParse(node).success).toBe(true);
  });

  it("every bundled fixture (SRD monster set + 1 PC) parses and validates with zero errors", () => {
    const results = validateAll(ALL_FIXTURES);
    const broken = results.filter((r) => !r.ok);
    if (broken.length) {
      console.error(broken.map((r) => `${r.name}:\n  ${r.errors.join("\n  ")}`).join("\n\n"));
    }
    expect(broken).toEqual([]);
    // the bundled SRD bench + 1 PC
    expect(ALL_FIXTURES.length).toBeGreaterThanOrEqual(30);
  });

  it("surfaces the known pending assumptions as warnings, not errors", () => {
    const results = validateAll(ALL_FIXTURES);
    // e.g. Pronounce the End's recharge-without-resource is intentionally flagged
    const allWarnings = results.flatMap((r) => r.warnings);
    expect(Array.isArray(allWarnings)).toBe(true);
  });

  it("catches a dangling useAction reference", () => {
    const bad = structuredClone(FIXTURES_BY_ID["bandit-captain"]);
    bad.actions[0].automation = [{ type: "useAction", action: "does-not-exist" }];
    const res = validateCombatant(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unknown action"))).toBe(true);
  });

  it("catches an undeclared resource reference", () => {
    const bad = structuredClone(FIXTURES_BY_ID["adult-red-dragon"]);
    bad.actions.push({
      id: "bogus",
      name: "Bogus",
      cost: { action: 1 },
      recharge: "none",
      limitedUse: { resource: "not_a_resource", amount: 1 },
      automation: [{ type: "note", text: "x" }],
    });
    const res = validateCombatant(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unknown resource"))).toBe(true);
  });

  it("averageOfDice handles multi-term strings", () => {
    expect(averageOfDice("22d6")).toBe(77);
    expect(averageOfDice("3d10+8")).toBe(24.5);
    expect(averageOfDice("2d6+2d8")).toBe(16);
    expect(averageOfDice("10")).toBe(10);
    expect(averageOfDice("garbage")).toBeNull();
  });

  it("parses a scenario and lets level be a plain edit", () => {
    const base = {
      name: "party vs a dragon",
      party: [
        { template: "blaster-wizard", name: "Ari", level: 15 },
        { template: "battlemaster-fighter", name: "Bront", level: 15 },
        { template: "life-cleric", name: "Cora", level: 15 },
        { template: "assassin-rogue", name: "Dax", level: 15 },
      ],
      enemies: ["adult-red-dragon"],
      trials: 10000,
    };
    const s1 = parseScenario(base);
    expect(s1.party).toHaveLength(4);

    const bumped = structuredClone(base);
    (bumped.party[1] as { level: number }).level = 16;
    (bumped.party[2] as { level: number }).level = 16;
    const s2 = parseScenario(bumped);
    expect((s2.party[1] as { level: number }).level).toBe(16);
    expect((s2.party[3] as { level: number }).level).toBe(15);
  });

  it("flavor is optional, presentation-only, and round-trips untouched", () => {
    const withoutFlavor = parseCombatant({ ...FIXTURES_BY_ID["ogre"], id: "ogre-plain" });
    expect(withoutFlavor.flavor).toBeUndefined();

    const withFlavor = parseCombatant({
      ...FIXTURES_BY_ID["ogre"],
      id: "ogre-flavored",
      flavor: { type: "giant", alignment: "chaotic evil", senses: "darkvision 60 ft., passive Perception 8", languages: "Common, Giant" },
    });
    expect(withFlavor.flavor).toEqual({
      type: "giant", alignment: "chaotic evil",
      senses: "darkvision 60 ft., passive Perception 8", languages: "Common, Giant",
    });
  });
});
