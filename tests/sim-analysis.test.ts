import { describe, expect, it } from "vitest";
import { FIXTURES_BY_ID } from "../src/lib/sim/fixtures";
import { runCombat, summarise } from "../src/lib/sim/engine/loop";
import { monteCarlo } from "../src/lib/sim/engine/montecarlo";
import { sweep } from "../src/lib/sim/engine/sweep";
import {
  damageReport,
  levelLadder,
  rosterCheck,
  runScenarioOnce,
  scenarioSweep,
  standardParty,
} from "../src/lib/sim/engine/scenario";
import { encounterBudget } from "../src/lib/sim/encounterBudget";
import { applyLoadout, makeTemplate, TEMPLATE_IDS } from "../src/lib/sim/engine/templates";
import { parseCombatant } from "../src/lib/sim/schema";
import { validateCombatant } from "../src/lib/sim/validate";

describe("Phase 3 part 3-4 — analysis, tuning, depth", () => {
  it("damage attribution: contributions sum and a first-casualty is recorded on a loss", () => {
    const r = summarise(runCombat([FIXTURES_BY_ID["tarrasque"]], { seed: 3, level: 20, keepLog: true }), true);
    const partyDealt = r.contributions.filter((c) => c.side === "party").reduce((s, c) => s + c.dealt, 0);
    expect(partyDealt).toBeGreaterThan(0);
    expect(r.winner).toBe("monster");
    expect(r.firstPartyDownRound).toBeGreaterThan(0);
    expect(damageReport(r)).toMatch(/first casualty/i);
  });

  it("monteCarlo surfaces per-actor damage share and who falls first", () => {
    const mc = monteCarlo([FIXTURES_BY_ID["adult-red-dragon"]], { trials: 120, level: 16 });
    expect(mc.partyDamage.length).toBeGreaterThan(1);
    expect(mc.partyDamage[0].pctOfSide).toBeGreaterThan(mc.partyDamage[mc.partyDamage.length - 1].pctOfSide - 1e-9);
    expect(mc.anyDownRate).toBeGreaterThanOrEqual(0);
    expect(mc.anyDownRate).toBeLessThanOrEqual(1);
  });

  it("HP sweep is monotone — more monster HP never helps the party", () => {
    const s = sweep([FIXTURES_BY_ID["young-gold-dragon"]], { level: 10, trials: 120 }, "monsterHpMult", [0.7, 1, 1.4]);
    const wr = s.points.map((p) => p.mc.partyWinRate);
    expect(wr[0]).toBeGreaterThanOrEqual(wr[1] - 0.08);
    expect(wr[1]).toBeGreaterThanOrEqual(wr[2] - 0.08);
  });

  it("a scenario sweep on party to-hit runs and stays well-formed", () => {
    const s = scenarioSweep({ party: standardParty(16), enemies: ["adult-red-dragon"], trials: 120 }, "partyToHitDelta", [-2, 0, 2]);
    expect(s.points).toHaveLength(3);
    for (const p of s.points) expect(p.mc.partyWinRate).toBeGreaterThanOrEqual(0);
  });

  it("level ladder is non-decreasing vs a fixed monster", () => {
    const rows = levelLadder(
      { party: [{ template: "gwm-fighter" }, { template: "life-cleric" }, { template: "blaster-wizard" }, { template: "hunter-ranger" }], enemies: ["adult-red-dragon"], trials: 120, seed: 5 },
      [12, 16, 20],
    );
    expect(rows[0].mc.partyWinRate).toBeLessThanOrEqual(rows[2].mc.partyWinRate + 0.1);
  });

  it("rosterCheck returns one row per monster, ordered as given", () => {
    const rows = rosterCheck(standardParty(20), ["ogre", "adult-red-dragon", "tarrasque"], 80);
    expect(rows.map((r) => r.enemy)).toEqual(["ogre", "adult-red-dragon", "tarrasque"]);
    expect(rows[0].mc.partyWinRate).toBeGreaterThan(rows[2].mc.partyWinRate);
  });

  it("encounterBudget rates a solo capstone Deadly and a triple-sphinx Overwhelming", () => {
    expect(encounterBudget(["25"], 20, 4).rating).toBe("deadly");
    expect(encounterBudget(["23", "23", "23"], 20, 4).rating).toBe("overwhelming");
    expect(encounterBudget(["1/4"], 20, 4).rating).toBe("trivial");
  });

  it("multi-monster: a boss with pre-placed adds runs to completion", () => {
    const { result } = runScenarioOnce({ party: standardParty(14), enemies: ["adult-red-dragon", "chain-devil x3"], seed: 2 });
    expect(["party", "monster", "draw"]).toContain(result.winner);
    expect(result.contributions.some((c) => c.name.startsWith("Chain Devil"))).toBe(true);
  });

  it("every template parses and validates at 1 / 10 / 20", () => {
    expect(TEMPLATE_IDS.length).toBeGreaterThanOrEqual(12);
    for (const id of TEMPLATE_IDS) {
      for (const lvl of [1, 10, 20]) {
        const v = validateCombatant(parseCombatant(makeTemplate(id, lvl)));
        expect(v.ok, `${id} L${lvl}: ${v.errors.join("; ")}`).toBe(true);
      }
    }
  });

  it("applyLoadout raises to-hit, AC and saves", () => {
    const base = makeTemplate("gwm-fighter", 20);
    const kitted = applyLoadout(base, { weaponBonus: 2, acItem: 1, saveItem: 1, resilientCon: true });
    expect(kitted.ac).toBe(base.ac + 1);
    expect(kitted.saveBonusAll).toBe(base.saveBonusAll + 1);
    expect(kitted.proficientSaves).toContain("con");
    const firstBonus = (a: typeof base) => JSON.stringify(a.actions).match(/"bonus":(\d+)/)?.[1];
    expect(Number(firstBonus(kitted))).toBe(Number(firstBonus(base)) + 2);
  });

  it("tuning knobs shift the outcome in the expected direction", () => {
    const base = monteCarlo([FIXTURES_BY_ID["adult-red-dragon"]], { level: 14, trials: 150 });
    const nerfed = monteCarlo([FIXTURES_BY_ID["adult-red-dragon"]], { level: 14, trials: 150, tuning: { monsterDamageMult: 0.6, monsterHpMult: 0.7 } });
    expect(nerfed.partyWinRate).toBeGreaterThanOrEqual(base.partyWinRate);
  });
});
