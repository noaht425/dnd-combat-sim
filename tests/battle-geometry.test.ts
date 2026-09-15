import { describe, expect, it } from "vitest";
import { makeGrid, setTerrain, footprint, reachFt, terrainAt } from "../src/lib/sim/battle/grid";
import {
  feetBetweenCells,
  feetBetweenBoxes,
  boxOf,
  hasLineOfSight,
  coverBetween,
  sphereCells,
  coneCells,
  lineTemplateCells,
} from "../src/lib/sim/battle/geometry";
import { reachable, pathToward, type MoveContext } from "../src/lib/sim/battle/movement";

describe("grid basics", () => {
  it("footprint + reach scale with size", () => {
    expect(footprint("medium")).toBe(1);
    expect(footprint("large")).toBe(2);
    expect(footprint("gargantuan")).toBe(4);
    expect(reachFt("medium")).toBe(5);
    expect(reachFt("huge")).toBe(10);
  });
  it("terrain reads out of bounds as wall", () => {
    const g = makeGrid(5, 5);
    expect(terrainAt(g, 0, 0)).toBe("floor");
    expect(terrainAt(g, -1, 0)).toBe("wall");
    expect(terrainAt(g, 99, 0)).toBe("wall");
  });
});

describe("distance — PHB alternating 5-10-5 diagonals", () => {
  it("orthogonal is 5 ft per square", () => {
    expect(feetBetweenCells(0, 0, 3, 0)).toBe(15);
    expect(feetBetweenCells(0, 0, 0, 4)).toBe(20);
  });
  it("first diagonal is 5, second is 10", () => {
    expect(feetBetweenCells(0, 0, 1, 1)).toBe(5); // 1 diagonal
    expect(feetBetweenCells(0, 0, 2, 2)).toBe(15); // 5 + 10
    expect(feetBetweenCells(0, 0, 3, 3)).toBe(20); // 5 + 10 + 5
    expect(feetBetweenCells(0, 0, 4, 4)).toBe(30); // 5+10+5+10
  });
  it("mixed move: diagonals then straight", () => {
    expect(feetBetweenCells(0, 0, 5, 2)).toBe(30); // 2 diag (15) + 3 straight (15)
  });
  it("edge-to-edge distance between footprints — adjacent squares are 5 ft apart", () => {
    expect(feetBetweenBoxes(boxOf(0, 0, 1), boxOf(1, 0, 1))).toBe(5); // adjacent -> 5-ft reach hits it
    expect(feetBetweenBoxes(boxOf(0, 0, 1), boxOf(3, 0, 1))).toBe(15); // 3 squares
    const big = boxOf(0, 0, 2); // large creature occupies x 0..1
    expect(feetBetweenBoxes(big, boxOf(3, 0, 1))).toBe(10); // 2 squares from its near edge -> 10-ft reach hits it
  });
});

describe("line of sight", () => {
  it("clear across open floor", () => {
    const g = makeGrid(10, 10);
    expect(hasLineOfSight(g, boxOf(0, 0, 1), boxOf(9, 9, 1))).toBe(true);
  });
  it("a wall between two units blocks it", () => {
    const g = makeGrid(10, 3);
    for (let y = 0; y < 3; y++) setTerrain(g, 5, y, "wall");
    expect(hasLineOfSight(g, boxOf(0, 1, 1), boxOf(9, 1, 1))).toBe(false);
  });
  it("a gap in the wall restores it", () => {
    const g = makeGrid(10, 3);
    for (let y = 0; y < 3; y++) setTerrain(g, 5, y, "wall");
    setTerrain(g, 5, 1, "floor");
    expect(hasLineOfSight(g, boxOf(0, 1, 1), boxOf(9, 1, 1))).toBe(true);
  });
});

describe("cover", () => {
  it("open ground = no cover", () => {
    const g = makeGrid(10, 10);
    expect(coverBetween(g, boxOf(0, 0, 1), boxOf(9, 0, 1))).toBe("none");
  });
  it("a pillar between grants at least half cover", () => {
    const g = makeGrid(10, 3);
    setTerrain(g, 5, 1, "wall");
    const c = coverBetween(g, boxOf(0, 1, 1), boxOf(9, 1, 1));
    expect(["half", "threequarters", "total"]).toContain(c);
  });
  it("another creature in the way is half cover", () => {
    const g = makeGrid(10, 3);
    const c = coverBetween(g, boxOf(0, 1, 1), boxOf(9, 1, 1), [boxOf(5, 1, 1)]);
    expect(c).toBe("half");
  });
});

describe("AoE templates", () => {
  it("a 20-ft-radius sphere covers the origin and its neighbours", () => {
    const g = makeGrid(20, 20);
    const cells = sphereCells(g, 10, 10, 20);
    expect(cells.has("10,10")).toBe(true);
    expect(cells.has("13,10")).toBe(true); // 15 ft
    expect(cells.has("10,14")).toBe(true); // 20 ft
    expect(cells.has("15,10")).toBe(false); // 25 ft, outside
  });
  it("a wall shadows squares behind it from a burst", () => {
    const g = makeGrid(20, 5);
    for (let y = 0; y < 5; y++) setTerrain(g, 12, y, "wall");
    const cells = sphereCells(g, 8, 2, 40);
    expect(cells.has("11,2")).toBe(true);
    expect(cells.has("15,2")).toBe(false); // behind the wall
  });
  it("a 15-ft cone points where you aim it", () => {
    const g = makeGrid(20, 20);
    const east = coneCells(g, 5, 10, 15, 10, 15);
    expect(east.has("6,10")).toBe(true);
    expect(east.has("8,10")).toBe(true);
    expect(east.has("4,10")).toBe(false); // behind the origin
    expect(east.has("5,3")).toBe(false); // perpendicular, far off-axis
  });
  it("a line template is one square wide by default", () => {
    const g = makeGrid(20, 20);
    const cells = lineTemplateCells(g, 2, 10, 20, 10, 30);
    expect(cells.has("5,10")).toBe(true);
    expect(cells.has("8,10")).toBe(true);
    expect(cells.has("5,12")).toBe(false);
  });
});

describe("movement — reachable flood", () => {
  const ctx = (g = makeGrid(12, 12)): MoveContext => ({ grid: g, size: "medium", blocked: new Set() });

  it("a 30-ft move reaches 6 squares orthogonally", () => {
    const c = ctx();
    const r = reachable(c, 0, 0, 30);
    expect(r.get("6,0")).toBe(30);
    expect(r.has("7,0")).toBe(false);
  });
  it("difficult terrain halves how far you get", () => {
    const g = makeGrid(12, 1); // 1-wide corridor so there's no floor detour
    for (let x = 1; x < 12; x++) setTerrain(g, x, 0, "difficult");
    const r = reachable({ grid: g, size: "medium", blocked: new Set() }, 0, 0, 30);
    expect(r.get("3,0")).toBe(30); // each difficult square costs 10
    expect(r.has("4,0")).toBe(false);
  });
  it("walls and occupied squares are impassable", () => {
    const g = makeGrid(6, 3);
    for (let y = 0; y < 3; y++) setTerrain(g, 3, y, "wall");
    const r = reachable({ grid: g, size: "medium", blocked: new Set(["1,0"]) }, 0, 0, 60);
    expect(r.has("4,0")).toBe(false); // wall column blocks the row
    expect(r.has("1,0")).toBe(false); // occupied
  });
});

describe("movement — pathToward", () => {
  const mc = (g: ReturnType<typeof makeGrid>, blocked: string[] = []): MoveContext => ({ grid: g, size: "medium", blocked: new Set(blocked) });

  it("walks a straight line to melee reach of the target", () => {
    const g = makeGrid(12, 3);
    const res = pathToward(mc(g), 0, 1, boxOf(10, 1, 1), 5, 60);
    expect(res.reached).toBe(true);
    const [ex, ey] = res.path[res.path.length - 1];
    expect(ey).toBe(1);
    expect(Math.abs(ex - 10)).toBe(1); // stops adjacent
  });
  it("routes around a wall", () => {
    const g = makeGrid(9, 9);
    for (let y = 0; y < 6; y++) setTerrain(g, 4, y, "wall"); // wall with a gap at the bottom
    const res = pathToward(mc(g), 0, 0, boxOf(8, 0, 1), 5, 200);
    expect(res.reached).toBe(true);
    // the path must dip down past the wall's end (y >= 6) somewhere
    expect(res.path.some(([, y]) => y >= 6)).toBe(true);
  });
  it("stops as close as the budget allows when it can't reach", () => {
    const g = makeGrid(30, 3);
    const res = pathToward(mc(g), 0, 1, boxOf(28, 1, 1), 5, 30);
    expect(res.reached).toBe(false);
    expect(res.feet).toBeLessThanOrEqual(30);
    const [ex] = res.path[res.path.length - 1];
    expect(ex).toBeGreaterThanOrEqual(6); // made progress
  });
});

describe("fog of war — visibleCells", () => {
  it("a wall blocks sight past it", async () => {
    const { visibleCells } = await import("../src/lib/sim/ui");
    // 9x3 room, full-height wall at column 4
    const w = 9, h = 3;
    let tiles = "";
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles += x === 4 ? "#" : ".";
    const seen = new Set(visibleCells({ width: w, height: h, tiles }, [{ x: 1, y: 1, fp: 1 }], 999));
    expect(seen.has("1,1")).toBe(true);   // where the viewer stands
    expect(seen.has("3,1")).toBe(true);   // near side of the wall
    expect(seen.has("6,1")).toBe(false);  // behind the wall — hidden
    expect(seen.has("8,1")).toBe(false);
  });
  it("an open room is fully visible within range", async () => {
    const { visibleCells } = await import("../src/lib/sim/ui");
    const w = 10, h = 4;
    const tiles = ".".repeat(w * h);
    const near = new Set(visibleCells({ width: w, height: h, tiles }, [{ x: 0, y: 0, fp: 1 }], 30)); // 30 ft = 6 squares
    expect(near.has("5,0")).toBe(true);
    expect(near.has("9,3")).toBe(false); // ~13 squares away, out of range
    const all = new Set(visibleCells({ width: w, height: h, tiles }, [{ x: 0, y: 0, fp: 1 }], 999));
    expect(all.has("9,3")).toBe(true);
  });
});

describe("measurement ruler helpers", () => {
  it("cellDistanceFt matches PHB 5-10-5", async () => {
    const { cellDistanceFt } = await import("../src/lib/sim/ui");
    expect(cellDistanceFt({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(15);   // 3 straight
    expect(cellDistanceFt({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(20);   // 3 diagonal = 5+10+5
    expect(cellDistanceFt({ x: 14, y: 2 }, { x: 10, y: 8 })).toBe(40); // 2 straight + 4 diag
    expect(cellDistanceFt({ x: 12, y: 2 }, { x: 2, y: 8 })).toBe(65);  // 4 straight + 6 diag
  });
  it("rulerLine returns a connected cell path including both endpoints", async () => {
    const { rulerLine } = await import("../src/lib/sim/ui");
    const line = rulerLine({ x: 1, y: 1 }, { x: 4, y: 3 });
    expect(line[0]).toBe("1,1");
    expect(line[line.length - 1]).toBe("4,3");
    expect(line.length).toBeGreaterThanOrEqual(4);
  });
});
