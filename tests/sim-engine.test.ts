import { describe, expect, it } from "vitest";
import { FIXTURES_BY_ID, MONSTER_FIXTURES } from "../src/lib/sim/fixtures";
import { runCombat, summarise } from "../src/lib/sim/engine/loop";
import { monteCarlo } from "../src/lib/sim/engine/montecarlo";
import { parseCombatant, type Combatant } from "../src/lib/sim/schema";

type Automation = Combatant["actions"][number]["automation"];

function levelFor(cr: string | undefined): number {
  const n = Number(cr ?? "10");
  return Math.max(1, Math.min(20, Math.round(Number.isNaN(n) ? 10 : n)));
}

// A synthetic bruiser used by two mechanic-level tests below. `withRestrain`
// adds a Str-save-or-restrained rider to its strike; everything else is equal.
function bruiser(id: string, withRestrain: boolean): Combatant {
  const hit: Automation = [{ type: "damage", amount: "2d10+8", damageType: "bludgeoning" }];
  if (withRestrain) {
    hit.push({
      type: "save",
      ability: "str",
      dc: 16,
      onFail: [{ type: "applyCondition", condition: "restrained", durationRounds: 1, saveEnds: { ability: "str", dc: 16, at: "endOfTurn" } }],
    });
  }
  return parseCombatant({
    id,
    name: id,
    kind: "monster",
    cr: "15",
    ac: 19,
    maxHp: "24d12+192",
    abilities: { str: 24, dex: 12, con: 26, int: 6, wis: 10, cha: 8 },
    pb: 5,
    actions: [
      { id: "multiattack", name: "Multiattack", cost: { action: 1 }, recharge: "none", automation: [{ type: "useAction", action: "slam", times: 4 }] },
      { id: "slam", name: "Slam", cost: {}, recharge: "none", automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 13, onHit: hit }] }] },
    ],
  });
}

// A synthetic fragile ambusher — the only special rule the bundled SRD set
// doesn't carry.
const ambusher: Combatant = parseCombatant({
  id: "ambusher",
  name: "Ambusher",
  kind: "monster",
  cr: "3",
  ac: 15,
  maxHp: "8d8",
  abilities: { str: 10, dex: 17, con: 10, int: 12, wis: 14, cha: 12 },
  pb: 2,
  specialRules: [{ rule: "ambush" }],
  actions: [
    {
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: [{ type: "useAction", action: "strike", times: 2 }],
    },
    {
      id: "strike",
      name: "Strike",
      cost: {},
      recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 6, onHit: [{ type: "damage", amount: "2d6+3", damageType: "piercing" }] }] }],
    },
  ],
});

describe("Phase 2 turn engine", () => {
  it("runs one fight to completion for every monster fixture without throwing", () => {
    for (const m of MONSTER_FIXTURES) {
      const state = runCombat([m], { seed: 7, level: levelFor(m.cr) });
      const r = summarise(state);
      expect(state.ended).toBe(true);
      expect(["party", "monster", "draw"]).toContain(r.winner);
      expect(r.rounds).toBeGreaterThan(0);
      expect(r.rounds).toBeLessThanOrEqual(25);
    }
  });

  it("is deterministic — same (fight, seed) gives an identical result", () => {
    const a = summarise(runCombat([FIXTURES_BY_ID["adult-red-dragon"]], { seed: 42, level: 16 }));
    const b = summarise(runCombat([FIXTURES_BY_ID["adult-red-dragon"]], { seed: 42, level: 16 }));
    expect(a).toEqual(b);
  });

  it("varies with the seed on a contested matchup", () => {
    // A Young Gold Dragon vs a level-8 party lands ~50/50 for the bare generic
    // party — the fight genuinely swings on the dice.
    const winners = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((s) => summarise(runCombat([FIXTURES_BY_ID["young-gold-dragon"]], { seed: s, level: 8 })).winner),
    );
    expect(winners.size).toBeGreaterThan(1);
  });

  it("a level-20 party crushes the Ogre (CR 2)", () => {
    const mc = monteCarlo([FIXTURES_BY_ID["ogre"]], { trials: 200, level: 20 });
    expect(mc.partyWinRate).toBeGreaterThan(0.95);
    expect(mc.avgRounds).toBeLessThan(4);
  });

  it("difficulty is ordered: trivial < contested < capstone", () => {
    const wr = (id: string, level: number) => monteCarlo([FIXTURES_BY_ID[id]], { trials: 200, level }).partyWinRate;
    const trivial = wr("ogre", 20);
    const contested = wr("young-gold-dragon", 8); // ~50/50 for a bare party
    const capstone = wr("tarrasque", 20);
    expect(trivial).toBeGreaterThan(contested);
    expect(contested).toBeGreaterThan(capstone);
    // contested lands in a genuinely uncertain band
    expect(contested).toBeGreaterThan(0.2);
    expect(contested).toBeLessThan(0.85);
  });

  it("a capstone solo (the Tarrasque) is a wipe for a bare party of 4", () => {
    const mc = monteCarlo([FIXTURES_BY_ID["tarrasque"]], { trials: 150, level: 20 });
    expect(mc.partyWinRate).toBeLessThan(0.15);
    expect(mc.tpkRate).toBeGreaterThan(0.6);
  });

  it("a party that wins is bruised, not untouched (a big solo dragon)", () => {
    const mc = monteCarlo([FIXTURES_BY_ID["adult-red-dragon"]], { trials: 200, level: 16 });
    if (mc.partyWinRate > 0.1) expect(mc.avgPartyHpPctOnWin).toBeLessThan(70);
  });

  it("Monte-Carlo output is well-formed", () => {
    const mc = monteCarlo([FIXTURES_BY_ID["adult-red-dragon"]], { trials: 100, level: 16 });
    expect(mc.partyWinRate).toBeGreaterThanOrEqual(0);
    expect(mc.partyWinRate).toBeLessThanOrEqual(1);
    expect(mc.roundsP10).toBeLessThanOrEqual(mc.roundsP50);
    expect(mc.roundsP50).toBeLessThanOrEqual(mc.roundsP90);
  });
});

describe("Phase 3 part 7 — 5e accuracy", () => {
  it("a stabilised PC stays down and does not act", () => {
    // a fight the party loses, so PCs go down and roll death saves
    const s = runCombat([FIXTURES_BY_ID["tarrasque"]], { seed: 11, level: 20, keepLog: true });
    const r = summarise(s, true);
    // any PC that stabilised should read DOWN, never contribute after
    const stabilisers = r.log.filter((l) => /stabilises/.test(l));
    for (const line of stabilisers) {
      const name = line.replace(/^R\d+:\s*/, "").split(" stabilises")[0];
      const after = r.log.slice(r.log.indexOf(line) + 1);
      expect(after.some((l) => l.startsWith(`R`) && l.includes(`${name} uses `))).toBe(false);
    }
  });

  it("an ambusher opens the fight (acts first, round 1)", () => {
    const s = runCombat([ambusher], { seed: 4, level: 3, keepLog: true });
    const r = summarise(s, true);
    const firstAction = r.log.find((l) => / uses /.test(l));
    expect(firstAction).toMatch(/Ambusher/);
  });

  it("restrained cuts the party's damage — a restrain rider drops the win rate", () => {
    const plain = monteCarlo([bruiser("plain-bruiser", false)], { trials: 250, level: 10 });
    const restrains = monteCarlo([bruiser("restrain-bruiser", true)], { trials: 250, level: 10 });
    // identical block + a restrain-on-hit rider ⇒ the party wins less often
    // (restrained gives disadvantage on the party's own attacks — the 5e-accuracy fix)
    expect(restrains.partyWinRate).toBeLessThan(plain.partyWinRate);
  });
});
