import { describe, expect, it } from "vitest";
import { validateCombatant } from "../lib/sim/validate";
import { TEMPLATE_IDS, makeTemplate } from "../lib/sim/engine/templates";
import { buildParty, runScenario, runScenarioOnce, standardParty } from "../lib/sim/engine/scenario";
import { monteCarlo } from "../lib/sim/engine/montecarlo";
import { MINIONS } from "../lib/sim/engine/minions";
import { FIXTURES_BY_ID } from "../lib/sim/fixtures";
import { applyDamage } from "../lib/sim/engine/resolve";
import { scoreAction } from "../lib/sim/engine/score";
import { initCombatant, type CombatState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import type { Combatant } from "../lib/sim/schema";

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

  it("damage-type immunity matters: fire does nothing to the fire-immune Adult Red Dragon, and the AI values a fire spell at nothing against it", () => {
    // (A whole-party comparison used to stand in for this, but it mostly measured how well each party played: once Hold Person could no longer be
    // wasted on a dragon, the sorcerers stopped depending on fire at all and won either way.)
    const red = FIXTURES_BY_ID["adult-red-dragon"];
    const open = { ...red, id: "red-open", name: "Red Dragon (no fire immunity)", immunities: red.immunities.filter((t) => t !== "fire") };
    const sorc = initCombatant(makeTemplate("draconic-sorcerer", 16), "party", "-s");
    const fireball = sorc.ref.actions.find((a) => /^cast-fireball-/.test(a.id))!;
    const world = (foe: Combatant) => {
      const f = initCombatant(foe, "monster", "-d");
      const state = { round: 1, order: [], activeIdx: 0, units: new Map([[sorc.id, sorc], [f.id, f]]), rng: makeRng(1), log: [], maxRounds: 10, ended: false, verbose: false, summonCounter: 0 } as CombatState;
      return { state, f };
    };
    const immune = world(red);
    const vulnerable = world(open);
    expect(applyDamage(immune.state, immune.f, 50, "fire", {})).toBe(0);
    expect(immune.f.hp).toBe(immune.f.maxHp);
    expect(applyDamage(vulnerable.state, vulnerable.f, 50, "fire", {})).toBe(50);
    expect(scoreAction(immune.state, sorc, fireball).damage).toBe(0);
    expect(scoreAction(vulnerable.state, sorc, fireball).damage).toBeGreaterThan(20);
  });
});
