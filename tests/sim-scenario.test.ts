import { describe, expect, it } from "vitest";
import { validateCombatant } from "../src/lib/sim/validate";
import { TEMPLATE_IDS, makeTemplate } from "../src/lib/sim/engine/templates";
import { buildParty, runScenario, runScenarioOnce, standardParty } from "../src/lib/sim/engine/scenario";
import { monteCarlo } from "../src/lib/sim/engine/montecarlo";
import { MINIONS } from "../src/lib/sim/engine/minions";

describe("Phase 3 — PC templates & scenarios", () => {
  it("every template builds a schema-valid PC at every key level", () => {
    for (const id of TEMPLATE_IDS) {
      for (const lvl of [1, 5, 8, 11, 14, 17, 20]) {
        const c = makeTemplate(id, lvl);
        const res = validateCombatant(c);
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok).toBe(true);
        expect(c.kind).toBe("pc");
        expect(c.level).toBe(lvl);
      }
    }
  });

  it("buildParty gives unique ids and shares the paladin's aura", () => {
    const party = buildParty(standardParty(20));
    expect(new Set(party.map((p) => p.id)).size).toBe(4);
    const paladin = party.find((p) => p.templateId === "vengeance-paladin")!;
    expect(paladin.saveBonusAll).toBeGreaterThan(0);
    for (const p of party) expect(p.saveBonusAll).toBeGreaterThanOrEqual(paladin.saveBonusAll);
  });

  it("runs a scenario to a well-formed distribution", () => {
    const mc = runScenario({ party: standardParty(16), enemies: ["adult-red-dragon"], trials: 150 });
    expect(mc.partyWinRate).toBeGreaterThanOrEqual(0);
    expect(mc.partyWinRate).toBeLessThanOrEqual(1);
    expect(mc.vsParty).toMatch(/paladin|fighter|wizard|cleric/i);
  });

  it("narrates a scenario", () => {
    const { result, log } = runScenarioOnce({ party: standardParty(16), enemies: ["adult-red-dragon"], seed: 3 });
    expect(log.length).toBeGreaterThan(3);
    expect(["party", "monster", "draw"]).toContain(result.winner);
  });

  it("'bump the party a level' moves the needle", () => {
    const lo = runScenario({ party: standardParty(12), enemies: ["adult-red-dragon"], trials: 200, seed: 5 });
    const hi = runScenario({ party: standardParty(16), enemies: ["adult-red-dragon"], trials: 200, seed: 5 });
    expect(hi.partyWinRate).toBeGreaterThanOrEqual(lo.partyWinRate);
  });

  it("the templated party clears a swarm faster than the abstract generic one", () => {
    // Real class builds bring AoE and coordination; against a pack of adds the
    // templated party should do at least as well as the abstract Phase-1 party.
    const t = runScenario({ party: standardParty(10), enemies: ["chain-devil x4"], trials: 200 }).partyWinRate;
    const g = monteCarlo([MINIONS["chain-devil"], MINIONS["chain-devil"], MINIONS["chain-devil"], MINIONS["chain-devil"]], { trials: 200, level: 10 }).partyWinRate;
    expect(t).toBeGreaterThanOrEqual(g - 0.1);
  });

  it("damage-type immunity matters: a fire-heavy party underperforms vs the fire-immune Adult Red Dragon", () => {
    // The Adult Red Dragon is immune to fire. A draconic sorcerer party leans on
    // fire damage (Scorching Ray, Fireball, Empowered/Elemental-affinity fire);
    // an all-physical party of the same level pays no such tax.
    const fire = runScenario({
      party: [
        { template: "draconic-sorcerer", name: "Ada", level: 16 },
        { template: "draconic-sorcerer", name: "Dax", level: 16 },
        { template: "draconic-sorcerer", name: "Eli", level: 16 },
        { template: "draconic-sorcerer", name: "Fen", level: 16 },
      ],
      enemies: ["adult-red-dragon"], trials: 300, seed: 11,
    });
    const physical = runScenario({
      party: [
        { template: "gwm-fighter", name: "Ada", level: 16 },
        { template: "hunter-ranger", name: "Dax", level: 16 },
        { template: "totem-barbarian", name: "Eli", level: 16 },
        { template: "gwm-fighter", name: "Fen", level: 16 },
      ],
      enemies: ["adult-red-dragon"], trials: 300, seed: 11,
    });
    expect(fire.partyWinRate + 0.1).toBeLessThan(physical.partyWinRate); // fire immunity bites
  });
});
