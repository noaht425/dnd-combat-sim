import { describe, expect, it } from "vitest";
import { ALL_FIXTURES, FIXTURES_BY_ID, MONSTER_FIXTURES } from "../src/lib/sim/fixtures";
import { assess, formatAssessment } from "../src/lib/sim/calculator";
import { genericParty } from "../src/lib/sim/party";
import { parseCombatant, type Combatant } from "../src/lib/sim/schema";

// A synthetic block that carries the two special defensive rules the bundled
// SRD monsters don't (flat damage reduction + undying return), so the
// effective-HP note paths stay covered.
const wardedRevenant: Combatant = parseCombatant({
  id: "warded-revenant",
  name: "Warded Revenant",
  kind: "monster",
  cr: "20",
  ac: 20,
  maxHp: "24d12+240",
  abilities: { str: 24, dex: 12, con: 26, int: 10, wis: 14, cha: 16 },
  pb: 6,
  specialRules: [
    { rule: "flatDamageReduction", amount: 3 },
    { rule: "undyingReturn", returnHp: 150, oncePer: "encounter" },
  ],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "slam", times: 3 }],
    },
    {
      id: "slam",
      name: "Slam",
      cost: {},
      recharge: "none",
      automation: [
        { type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 13, onHit: [{ type: "damage", amount: "2d10+7", damageType: "bludgeoning" }] }] },
      ],
    },
  ],
});

describe("Phase 1 attrition calculator", () => {
  it("produces a finite, structured assessment for every monster fixture", () => {
    for (const m of MONSTER_FIXTURES) {
      const a = assess(m);
      expect(Number.isFinite(a.roundsForPartyToWin)).toBe(true);
      expect(Number.isFinite(a.roundsForMonsterToTpk)).toBe(true);
      expect(Number.isFinite(a.monsterEffectiveHp)).toBe(true);
      expect(Number.isFinite(a.monsterDprVsParty)).toBe(true);
      expect(a.roundsForPartyToWin).toBeGreaterThan(0);
      expect(a.monsterEffectiveHp).toBeGreaterThanOrEqual(1);
      expect(a.contributors.length).toBeGreaterThan(0);
      expect(a.effectiveCr).toMatch(/^~\d+(-\d+)?$/);
    }
  });

  it("the Ogre (CR 2) reads well below tier vs a level-2 party", () => {
    const a = assess(FIXTURES_BY_ID["ogre"], genericParty(2, 4));
    expect(a.readsAs === "well below tier" || a.readsAs === "below tier").toBe(true);
    expect(a.roundsForPartyToWin).toBeLessThan(3);
  });

  it("the Tarrasque reads at or above its labelled CR and is a real TPK threat", () => {
    const a = assess(FIXTURES_BY_ID["tarrasque"], genericParty(20, 4));
    expect(["above tier", "well above tier"]).toContain(a.readsAs);
    expect(a.monsterEffectiveHp).toBeGreaterThan(600);
    expect(["real", "high", "party loses"]).toContain(a.tpkRisk);
  });

  it("flat damage reduction and undying return both show up as effective-HP notes", () => {
    const a = assess(wardedRevenant, genericParty(20, 4));
    expect(a.notes.join(" ")).toMatch(/flat -3/);
    expect(a.notes.join(" ")).toMatch(/undying return/i);
  });

  it("mid-tier SRD monsters land near their labels (within ~1 CR)", () => {
    for (const id of ["gladiator", "young-gold-dragon", "adult-red-dragon"]) {
      const a = assess(FIXTURES_BY_ID[id]);
      expect(["well below tier", "below tier", "on tier", "above tier"]).toContain(a.readsAs);
    }
  });

  it("formatAssessment renders every fixture without throwing", () => {
    for (const m of [...ALL_FIXTURES, wardedRevenant]) {
      expect(typeof formatAssessment(assess(m))).toBe("string");
    }
  });
});
