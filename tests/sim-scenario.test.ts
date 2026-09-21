import { describe, expect, it } from "vitest";
import { validateCombatant } from "../lib/sim/validate";
import { TEMPLATE_IDS, makeTemplate } from "../lib/sim/engine/templates";
import { buildParty, runScenario, runScenarioOnce, standardParty } from "../lib/sim/engine/scenario";
import { monteCarlo } from "../lib/sim/engine/montecarlo";
import { MINIONS } from "../lib/sim/engine/minions";
import { FIXTURES_BY_ID } from "../lib/sim/fixtures";

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

  it("damage-type immunity matters: a fire-heavy party does worse against the fire-immune Adult Red Dragon than against the same dragon without the immunity", () => {
    // Compare like with like: the same party against the same stat block, with and without fire immunity. (Comparing two different parties mostly
    // measures how good each party's play is, which is what changed when casters stopped recasting spells on targets that already had the effect.)
    const red = FIXTURES_BY_ID["adult-red-dragon"];
    const open = { ...red, id: "red-open", name: "Red Dragon (no fire immunity)", immunities: red.immunities.filter((t) => t !== "fire") };
    const party = (templates: string[]) => templates.map((template, i) => ({ template, name: `P${i}`, level: 16 }));
    const run = (templates: string[], foe: string) =>
      runScenario({ party: party(templates), enemies: [foe], trials: 400, seed: 11, extraById: { "red-open": open } });
    const sorcerers = Array(4).fill("draconic-sorcerer");
    const immune = run(sorcerers, "adult-red-dragon");
    const vulnerable = run(sorcerers, "red-open");
    expect(vulnerable.partyWinRate).toBeGreaterThan(immune.partyWinRate + 0.05); // fire immunity bites
    expect(immune.avgRounds).toBeGreaterThan(vulnerable.avgRounds + 0.5);
    // ...and an all-physical party doesn't care either way
    const physical = ["gwm-fighter", "hunter-ranger", "totem-barbarian", "gwm-fighter"];
    expect(Math.abs(run(physical, "adult-red-dragon").partyWinRate - run(physical, "red-open").partyWinRate)).toBeLessThan(0.03);
  }, 30000);
});
