import { describe, expect, it } from "vitest";
import {
  parseTiles,
  tilesToString,
  gridFromDef,
  defFromGrid,
  makeGrid,
  setTerrain,
  type BattleMapDef,
} from "../src/lib/sim/battle/grid";
import { battleRoster, autoPlace, runBattle } from "../src/lib/sim/battle";
import { standardParty } from "../src/lib/sim/engine/scenario";

describe("map def serialisation", () => {
  it("tiles round-trip through the glyph string", () => {
    const g = makeGrid(6, 4, "floor");
    setTerrain(g, 1, 1, "wall");
    setTerrain(g, 2, 1, "difficult");
    setTerrain(g, 3, 2, "hazard");
    setTerrain(g, 4, 3, "cover");
    const def = defFromGrid(g, { "pc-1": { x: 0, y: 0 } });
    expect(def.tiles.length).toBe(24);
    const g2 = gridFromDef(def);
    expect(tilesToString(g2)).toBe(def.tiles);
    expect(g2.tiles[1 * 6 + 1]).toBe("wall");
    expect(g2.tiles[2 * 6 + 3]).toBe("hazard");
    expect(def.placements["pc-1"]).toEqual({ x: 0, y: 0 });
  });

  it("parseTiles fills short / unknown chars with floor and clamps size", () => {
    const t = parseTiles("##", 4, 2); // only 2 chars for an 8-cell grid
    expect(t.length).toBe(8);
    expect(t.slice(0, 2)).toEqual(["wall", "wall"]);
    expect(t.slice(2).every((x) => x === "floor")).toBe(true);
    const g = gridFromDef({ width: 1, height: 1, tiles: "", placements: {} });
    expect(g.width).toBeGreaterThanOrEqual(4); // clamped up
  });
});

describe("battleRoster", () => {
  it("matches the ids + glyphs runBattle actually assigns", () => {
    const setup = { party: standardParty(12), enemies: ["ogre", "ogre", "gladiator"] };
    const roster = battleRoster(setup);
    const out = runBattle({ ...setup, seed: 1 });
    const firstFrame = out.frames[0];
    for (const r of roster) {
      const u = firstFrame.units.find((x) => x.id === r.id);
      expect(u, `roster id ${r.id} exists in the fight`).toBeDefined();
      expect(u!.glyph).toBe(r.glyph);
      expect(u!.side).toBe(r.side);
    }
    expect(roster.filter((r) => r.side === "party")).toHaveLength(4);
    expect(roster.filter((r) => r.side === "monster")).toHaveLength(3);
  });
});

describe("autoPlace", () => {
  const def: BattleMapDef = { width: 16, height: 12, tiles: ".".repeat(16 * 12), placements: {} };

  it("puts party at the bottom, monsters at the top, none overlapping or on walls", () => {
    const g = gridFromDef(def);
    for (let x = 0; x < 16; x++) setTerrain(g, x, 5, "wall");
    const walled = defFromGrid(g);
    const roster = battleRoster({ party: standardParty(12), enemies: ["adult-red-dragon"] });
    const places = autoPlace(walled, roster);
    const seen = new Set<string>();
    for (const r of roster) {
      const p = places[r.id];
      expect(p, `${r.name} placed`).toBeDefined();
      expect(gridFromDef(walled).tiles[p.y * 16 + p.x]).not.toBe("wall");
      const key = `${p.x},${p.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      if (r.side === "party") expect(p.y).toBeGreaterThan(6);
      else expect(p.y).toBeLessThan(6);
    }
  });

  it("respects a fixed placement", () => {
    const roster = battleRoster({ party: standardParty(10), enemies: ["ogre"] });
    const places = autoPlace(def, roster, { [roster[0].id]: { x: 1, y: 1 } });
    expect(places[roster[0].id]).toEqual({ x: 1, y: 1 });
  });
});

describe("runBattleFromSetup honours setup.battleMap", () => {
  it("a walled-off map still resolves and uses the given dimensions", async () => {
    const { runBattleFromSetup } = await import("../src/lib/sim/ui");
    const g = makeGrid(24, 18, "floor");
    for (let y = 0; y < 14; y++) setTerrain(g, 12, y, "wall");
    const setup = {
      party: standardParty(15),
      enemies: [{ id: "gladiator", count: 2 }],
      trials: 100,
      seed: 5,
      customMonsters: [],
      battleMap: defFromGrid(g),
    };
    const run = runBattleFromSetup(setup);
    expect(run.frames[0].terrain).toEqual({ width: 24, height: 18, tiles: tilesToString(g) });
    expect(["party", "monster", "draw"]).toContain(run.winner);
  });
});
