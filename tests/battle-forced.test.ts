// Forced movement, teleporting and speed penalties on the battle grid: the `move` node's push, pull and teleport kinds, which used to do nothing in battle mode (a Misty Step never moved the caster).
// The rules being modeled are the printed ones: "push the creature up to 10 feet away from you in a straight line" (Repelling Blast), "move that creature in a straight line 10 feet closer to yourself"
// (Grasp of Hadar, once on each of your turns), "reduce that creature's speed by 10 feet" (Lance of Lethargy).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { runAutomation } from "../lib/sim/engine/interpreter";
import { beginTurn, initCombatant, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { makeGrid, setTerrain } from "../lib/sim/battle/grid";
import { BattleState, deriveZones, speedFt } from "../lib/sim/battle/state";
import { moveCreatureInBattle } from "../lib/sim/battle/forced";
import { feetBetweenBoxes } from "../lib/sim/battle/geometry";
import { boxOfUnit } from "../lib/sim/battle/state";
import type { AutomationNode, Combatant, Size } from "../lib/sim/schema";

function battle(width = 20, height = 20): BattleState {
  const rng = makeRng(1);
  rng.d20 = () => 15;
  rng.d20mode = () => ({ used: 15, nat: 15 });
  rng.dice = (n, sides) => n * sides;
  const s: BattleState = {
    round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [], maxRounds: 10, ended: false, verbose: true, summonCounter: 0,
    grid: makeGrid(width, height), pos: new Map(), glyphs: new Map(), frames: [], recordFrames: true, frameSeq: 0, spawnedWaves: new Set(), reactionSeq: 0,
  };
  s.moveCreature = (req) => moveCreatureInBattle(s, req);
  return s;
}
const unit = (s: BattleState, id: string, side: "party" | "monster", x: number, y: number, over: Partial<Combatant> = {}): CombatantState => {
  const base = makeTemplate("gwm-fighter", 5);
  const u = initCombatant({ ...base, ...over }, side, `-${id}`);
  s.units.set(u.id, u);
  s.pos.set(u.id, { x, y });
  s.glyphs.set(u.id, id[0].toUpperCase());
  deriveZones(s);
  return u;
};
const at = (s: BattleState, u: CombatantState) => s.pos.get(u.id)!;
const push = (s: BattleState, src: CombatantState, tgt: CombatantState, ft = 10) => moveCreatureInBattle(s, { kind: "push", source: src, target: tgt, distance: ft });
const pull = (s: BattleState, src: CombatantState, tgt: CombatantState, ft = 10) => moveCreatureInBattle(s, { kind: "pull", source: src, target: tgt, distance: ft });

describe("push", () => {
  it("slides the creature 10 feet — two squares — straight away from the source", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 6, 5);
    push(s, w, o);
    expect(at(s, o)).toEqual({ x: 8, y: 5 });
    expect(at(s, w)).toEqual({ x: 5, y: 5 }); // the source doesn't move
  });

  it("follows the nearest of the eight directions: straight down, and diagonally", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const down = unit(s, "d", "monster", 5, 6);
    push(s, w, down);
    expect(at(s, down)).toEqual({ x: 5, y: 8 });
    const diag = unit(s, "g", "monster", 6, 6);
    push(s, w, diag);
    expect(at(s, diag)).toEqual({ x: 8, y: 8 });
  });

  it("stops at a wall, at another creature, and at the edge of the map", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const a = unit(s, "a", "monster", 6, 5);
    setTerrain(s.grid, 8, 5, "wall");
    push(s, w, a);
    expect(at(s, a)).toEqual({ x: 7, y: 5 }); // one square, then the wall
    const b = unit(s, "b", "monster", 6, 8);
    unit(s, "c", "monster", 6, 10);
    push(s, unit(s, "x", "party", 6, 7), b);
    expect(at(s, b)).toEqual({ x: 6, y: 9 }); // one square, then the creature behind it
    const e = battle(10, 10);
    const w2 = unit(e, "w", "party", 7, 5);
    const edge = unit(e, "e", "monster", 8, 5);
    push(e, w2, edge);
    expect(at(e, edge)).toEqual({ x: 9, y: 5 }); // the map ends at 9
  });

  it("carries a Large creature by its whole footprint, and won't squeeze it through a gap it doesn't fit", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const ogre = unit(s, "ogre", "monster", 6, 5, { size: "large" as Size });
    push(s, w, ogre);
    expect(at(s, ogre)).toEqual({ x: 8, y: 5 });
    const s2 = battle();
    const w2 = unit(s2, "w", "party", 5, 5);
    const big = unit(s2, "big", "monster", 6, 5, { size: "large" as Size });
    setTerrain(s2.grid, 9, 6, "wall"); // the second row of its footprint hits this on the second step
    push(s2, w2, big);
    expect(at(s2, big)).toEqual({ x: 7, y: 5 });
  });

  it("ends a fight in melee: the pushed creature is no longer beside the warlock", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 6, 5);
    expect(o.zone).toBe("melee");
    push(s, w, o);
    expect(o.zone).toBe("ranged");
    expect(feetBetweenBoxes(boxOfUnit(s, w), boxOfUnit(s, o))).toBe(15); // 5 feet apart, then 10 feet more
  });

  it("logs the movement, and records it as a move frame for the battle view", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 6, 5);
    push(s, w, o);
    expect(s.log.map((l) => l.text).join("\n")).toMatch(/pushed 10 ft/);
    const frame = s.frames.at(-1)!;
    expect(frame.kind).toBe("move");
    expect(frame.path).toEqual([[6, 5], [8, 5]]);
  });
});

describe("pull", () => {
  it("moves the creature 10 feet closer in a straight line", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 11, 5);
    pull(s, w, o);
    expect(at(s, o)).toEqual({ x: 9, y: 5 });
  });

  it("never carries it past the source: it stops beside it", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 7, 5);
    pull(s, w, o);
    expect(at(s, o)).toEqual({ x: 6, y: 5 });
    expect(o.zone).toBe("melee");
  });

  it("does nothing to a creature already beside the source", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 6, 5);
    pull(s, w, o);
    expect(at(s, o)).toEqual({ x: 6, y: 5 });
    expect(s.frames).toHaveLength(0);
  });
});

describe("teleport", () => {
  const tele = (s: BattleState, u: CombatantState, ft: number, over: { near?: CombatantState[]; escape?: boolean } = {}) =>
    moveCreatureInBattle(s, { kind: "teleportSelf", source: u, distance: ft, ...over });

  it("a ranged creature lands as far from the enemy as the hop allows, never farther than the hop", () => {
    const s = battle(30, 30);
    const w = unit(s, "w", "party", 10, 10, { ai: { ...makeTemplate("fiend-warlock", 5).ai } });
    const o = unit(s, "o", "monster", 11, 10);
    tele(s, w, 30);
    const gap = feetBetweenBoxes(boxOfUnit(s, w), boxOfUnit(s, o));
    expect(gap).toBeGreaterThanOrEqual(30);
    expect(feetBetweenBoxes({ x0: 10, y0: 10, x1: 10, y1: 10 }, boxOfUnit(s, w))).toBeLessThanOrEqual(30);
  });

  it("a melee creature lands beside the nearest enemy", () => {
    const s = battle(30, 30);
    const f = unit(s, "f", "party", 2, 2); // a fighter: not a keep-distance creature
    const o = unit(s, "o", "monster", 8, 2);
    tele(s, f, 30);
    expect(feetBetweenBoxes(boxOfUnit(s, f), boxOfUnit(s, o))).toBe(5);
  });

  it("an escape is always the far side, even for a melee creature", () => {
    const s = battle(30, 30);
    const f = unit(s, "f", "party", 10, 10);
    const o = unit(s, "o", "monster", 11, 10);
    tele(s, f, 60, { escape: true });
    expect(feetBetweenBoxes(boxOfUnit(s, f), boxOfUnit(s, o))).toBeGreaterThanOrEqual(45);
  });

  it("beside a named creature, on the nearest free square, and not at all if already there", () => {
    const s = battle(30, 30);
    const w = unit(s, "w", "party", 2, 2);
    const cursed = unit(s, "c", "monster", 7, 2); // 25 feet away
    tele(s, w, 30, { near: [cursed] });
    expect(feetBetweenBoxes(boxOfUnit(s, w), boxOfUnit(s, cursed))).toBe(5);
    const here = { ...at(s, w) };
    tele(s, w, 30, { near: [cursed] });
    expect(at(s, w)).toEqual(here);
  });

  it("never farther than the distance, so a 30-foot hop can't reach a creature 60 feet away", () => {
    const s = battle(40, 10);
    const w = unit(s, "w", "party", 1, 5);
    const far = unit(s, "c", "monster", 20, 5);
    tele(s, w, 30, { near: [far] });
    expect(at(s, w)).toEqual({ x: 1, y: 5 });
  });

  it("only onto free squares: not a wall, not another creature", () => {
    const s = battle(6, 3);
    const w = unit(s, "w", "party", 0, 1);
    const o = unit(s, "o", "monster", 2, 1);
    for (const [x, y] of [[1, 0], [1, 1], [1, 2], [2, 0]]) setTerrain(s.grid, x, y, "wall");
    unit(s, "b", "monster", 2, 2);
    unit(s, "c", "monster", 3, 0);
    unit(s, "d", "monster", 3, 1);
    tele(s, w, 60, { near: [o] });
    expect(at(s, w)).toEqual({ x: 3, y: 2 }); // the one free square beside it
  });
});

describe("speed penalties (Lance of Lethargy, Tentacle of the Deeps)", () => {
  it("a speed reduced by 10 feet, and never below nothing", () => {
    const s = battle();
    const o = unit(s, "o", "monster", 5, 5);
    expect(speedFt(o)).toBe(30);
    o.effects.push({ name: "lance-of-lethargy", expiresRound: Infinity, sourceId: "x", mods: { speedBonusFt: -10 } });
    expect(speedFt(o)).toBe(20);
    o.effects.push({ name: "worse", expiresRound: Infinity, sourceId: "x", mods: { speedBonusFt: -100 } });
    expect(speedFt(o)).toBe(0);
  });
});

describe("the interpreter's move node", () => {
  const hit = (s: BattleState, src: CombatantState, tgt: CombatantState, rider: AutomationNode[]) =>
    runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "1", damageType: "force" }, ...rider] } as AutomationNode], { state: s, source: src, scope: [tgt], last: {}, depth: 0 });

  it("pushes the creature that was hit", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 6, 5);
    hit(s, w, o, [{ type: "move", kind: "push", distance: 10 }]);
    expect(at(s, o)).toEqual({ x: 8, y: 5 });
  });

  it("'once on each of your turns': the second hit in a turn doesn't pull again, the next turn's does", () => {
    const s = battle();
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 15, 5);
    const grasp: AutomationNode[] = [{ type: "move", kind: "pull", distance: 10, oncePerTurn: "grasp" }];
    beginTurn(s, w);
    hit(s, w, o, grasp);
    hit(s, w, o, grasp);
    expect(at(s, o)).toEqual({ x: 13, y: 5 }); // one pull of 10 feet
    beginTurn(s, w);
    hit(s, w, o, grasp);
    expect(at(s, o)).toEqual({ x: 11, y: 5 });
  });

  it("does nothing in a fight with no grid (Monte-Carlo), and doesn't fail", () => {
    const s = battle();
    delete s.moveCreature;
    const w = unit(s, "w", "party", 5, 5);
    const o = unit(s, "o", "monster", 6, 5);
    hit(s, w, o, [{ type: "move", kind: "push", distance: 10 }]);
    expect(at(s, o)).toEqual({ x: 6, y: 5 });
  });

  it("a teleport node moves the caster: Misty Step is a real hop now", () => {
    const s = battle(30, 30);
    const w = unit(s, "w", "party", 10, 10, { ai: { ...makeTemplate("fiend-warlock", 5).ai } });
    const o = unit(s, "o", "monster", 11, 10);
    runAutomation([{ type: "move", kind: "teleportSelf", distance: 30 }], { state: s, source: w, scope: [], last: {}, depth: 0 });
    expect(feetBetweenBoxes(boxOfUnit(s, w), boxOfUnit(s, o))).toBeGreaterThanOrEqual(30);
  });
});
