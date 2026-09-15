// The battle map: a rectangular grid of 5-ft squares. Terrain is one glyph per
// square. This module is pure data + cheap lookups; movement cost / line-of-sight
// / templates live in geometry.ts and movement.ts.

import type { Size } from "../schema";

export const FT_PER_SQUARE = 5;

/** floor = normal; difficult = 2x move cost; wall = impassable + blocks sight;
 *  hazard = passable at normal cost but deals damage on enter / start of turn;
 *  cover = passable? no — a low obstacle: blocks movement, grants cover, does NOT
 *  fully block sight (half cover). */
export type Terrain = "floor" | "difficult" | "wall" | "hazard" | "cover";

export const TERRAIN_GLYPH: Record<Terrain, string> = {
  floor: ".",
  difficult: "~",
  wall: "#",
  hazard: "!",
  cover: "o",
};

export interface HazardSpec {
  /** dice string, e.g. "2d6" */
  amount: string;
  damageType: string;
  /** "enter" = on first entering the square this turn; "start" = at start of turn while standing in it */
  when: "enter" | "start" | "both";
  /** a DEX save to halve, if set */
  save?: { ability: "str" | "dex" | "con" | "int" | "wis" | "cha"; dc: number };
}

export interface BattleGrid {
  width: number;
  height: number;
  /** row-major, length width*height */
  tiles: Terrain[];
  /** optional per-map hazard rule (all `hazard` tiles use it); a sane default is filled in when omitted */
  hazard: HazardSpec;
}

export const DEFAULT_HAZARD: HazardSpec = { amount: "2d6", damageType: "fire", when: "both", save: { ability: "dex", dc: 12 } };

export function makeGrid(width: number, height: number, fill: Terrain = "floor"): BattleGrid {
  return { width, height, tiles: new Array(width * height).fill(fill), hazard: { ...DEFAULT_HAZARD } };
}

const GLYPH_TERRAIN: Record<string, Terrain> = Object.fromEntries(
  Object.entries(TERRAIN_GLYPH).map(([k, v]) => [v, k as Terrain]),
);

/** parse a row-major glyph string ("." "~" "#" "!" "o", also " " -> floor) */
export function parseTiles(str: string, width: number, height: number): Terrain[] {
  const out: Terrain[] = new Array(width * height).fill("floor");
  for (let i = 0; i < out.length; i++) {
    const c = str[i];
    if (c && GLYPH_TERRAIN[c]) out[i] = GLYPH_TERRAIN[c];
  }
  return out;
}

export function tilesToString(g: BattleGrid): string {
  return g.tiles.map((t) => TERRAIN_GLYPH[t]).join("");
}

/** a serialisable map: dimensions + terrain glyphs + starting squares by unit id */
export interface BattleMapDef {
  width: number;
  height: number;
  tiles: string;
  placements: Record<string, { x: number; y: number }>;
}

export function gridFromDef(def: BattleMapDef): BattleGrid {
  const w = Math.max(4, Math.min(60, Math.round(def.width)));
  const h = Math.max(4, Math.min(60, Math.round(def.height)));
  return { width: w, height: h, tiles: parseTiles(def.tiles ?? "", w, h), hazard: { ...DEFAULT_HAZARD } };
}

export function defFromGrid(g: BattleGrid, placements: BattleMapDef["placements"] = {}): BattleMapDef {
  return { width: g.width, height: g.height, tiles: tilesToString(g), placements };
}

export const inBounds = (g: BattleGrid, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < g.width && y < g.height;

export function terrainAt(g: BattleGrid, x: number, y: number): Terrain {
  return inBounds(g, x, y) ? g.tiles[y * g.width + x] : "wall";
}

export function setTerrain(g: BattleGrid, x: number, y: number, t: Terrain): void {
  if (inBounds(g, x, y)) g.tiles[y * g.width + x] = t;
}

/** a square you can never stand in or move through */
export const blocksMove = (t: Terrain): boolean => t === "wall" || t === "cover";

/** a square that fully blocks line of sight (cover only half-blocks) */
export const blocksSightFull = (t: Terrain): boolean => t === "wall";

/** extra move cost in feet to ENTER this square (on top of the base 5) */
export function enterCostFt(t: Terrain): number {
  if (t === "difficult") return FT_PER_SQUARE; // doubles the step
  return 0;
}

// --------------------------- creature footprints ---------------------------

/** side length in squares of a creature of this size (D&D space) */
export function footprint(size: Size): number {
  switch (size) {
    case "tiny":
    case "small":
    case "medium":
      return 1;
    case "large":
      return 2;
    case "huge":
      return 3;
    case "gargantuan":
      return 4;
  }
}

/** natural melee reach in feet by size (weapon reach is folded in elsewhere) */
export function reachFt(size: Size): number {
  return size === "huge" || size === "gargantuan" ? 10 : 5;
}

/** the squares a creature anchored at (x,y) with the given footprint occupies */
export function cells(x: number, y: number, fp: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) out.push([x + dx, y + dy]);
  return out;
}

export const cellKey = (x: number, y: number): string => `${x},${y}`;
export const parseCellKey = (k: string): [number, number] => {
  const [x, y] = k.split(",").map(Number);
  return [x, y];
};
