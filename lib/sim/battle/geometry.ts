// Distances, line of sight, cover, and area-of-effect templates on the grid.
// Distance uses the PHB "alternating 5-10-5" diagonal rule (Noah's choice): the
// 1st, 3rd, 5th … diagonal step costs 5 ft, the 2nd, 4th … costs 10 ft.

import { BattleGrid, blocksSightFull, cellKey, FT_PER_SQUARE, inBounds, terrainAt } from "./grid";

/** feet between two squares under the alternating-diagonal rule */
export function feetBetweenCells(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  const diag = Math.min(dx, dy);
  const straight = Math.max(dx, dy) - diag;
  // alternating: diag diagonals cost 5*diag + 5*floor(diag/2)
  return (straight + diag) * FT_PER_SQUARE + Math.floor(diag / 2) * FT_PER_SQUARE;
}

/** an axis-aligned box in squares: [x0..x1] x [y0..y1] inclusive */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const boxOf = (x: number, y: number, fp: number): Box => ({ x0: x, y0: y, x1: x + fp - 1, y1: y + fp - 1 });

/** edge-to-edge feet between two creature footprints (0 if they touch/overlap) */
export function feetBetweenBoxes(a: Box, b: Box): number {
  const gapX = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const gapY = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return feetBetweenCells(0, 0, gapX, gapY);
}

/** are two footprints within `ft` of each other, edge to edge? */
export const withinReach = (a: Box, b: Box, ft: number): boolean => feetBetweenBoxes(a, b) <= ft;

// ------------------------------- line of sight -------------------------------

/** integer supercover line from (x0,y0) to (x1,y1), endpoints included */
export function lineCells(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  let x = x0;
  let y = y0;
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  // limit guards a pathological call
  for (let guard = 0; guard < 512; guard++) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

/** corners (in "grid units", 0..width) of the square (cx,cy) */
const cornersOf = (cx: number, cy: number): Array<[number, number]> => [
  [cx + 0.15, cy + 0.15],
  [cx + 0.85, cy + 0.15],
  [cx + 0.15, cy + 0.85],
  [cx + 0.85, cy + 0.85],
  [cx + 0.5, cy + 0.5],
];

/** is there an unobstructed sight line between any point of box A and any of box B?
 *  walls fully block; `cover` terrain and (optionally) blocker squares half-block
 *  but don't deny LoS on their own. */
export function hasLineOfSight(g: BattleGrid, a: Box, b: Box): boolean {
  const aCells = boxCells(a);
  const bCells = boxCells(b);
  for (const [axc, ayc] of aCells) {
    for (const [bxc, byc] of bCells) {
      for (const [ax, ay] of cornersOf(axc, ayc)) {
        for (const [bx, by] of cornersOf(bxc, byc)) {
          if (segmentClear(g, ax, ay, bx, by)) return true;
        }
      }
    }
  }
  return false;
}

function segmentClear(g: BattleGrid, ax: number, ay: number, bx: number, by: number): boolean {
  // sample along the segment; if it passes through a wall square's interior, blocked
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 4) + 1;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    if (!inBounds(g, cx, cy)) return false;
    if (blocksSightFull(terrainAt(g, cx, cy))) return false;
  }
  return true;
}

export function boxCells(b: Box): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) out.push([x, y]);
  return out;
}

// ---------------------------------- cover ----------------------------------

export type Cover = "none" | "half" | "threequarters" | "total";
export const coverAcBonus = (c: Cover): number => (c === "half" ? 2 : c === "threequarters" ? 5 : 0);

/** cover the target (box `t`) has from an attacker at box `a`, considering walls,
 *  `cover` terrain, and other creatures' footprints (`blockers`). */
export function coverBetween(
  g: BattleGrid,
  a: Box,
  t: Box,
  blockers: Box[] = [],
): Cover {
  // fire from the attacker's centre to each of the target's four corners; count
  // how many of those four lines are interrupted, and by what.
  const src: [number, number] = [(a.x0 + a.x1) / 2 + 0.5, (a.y0 + a.y1) / 2 + 0.5];
  const tCorners: Array<[number, number]> = [
    [t.x0 + 0.05, t.y0 + 0.05],
    [t.x1 + 0.95, t.y0 + 0.05],
    [t.x0 + 0.05, t.y1 + 0.95],
    [t.x1 + 0.95, t.y1 + 0.95],
  ];
  let wallBlocked = 0;
  let softBlocked = 0;
  for (const [cx, cy] of tCorners) {
    let wall = false;
    let soft = false;
    const steps = Math.ceil(Math.hypot(cx - src[0], cy - src[1]) * 4) + 1;
    for (let i = 1; i < steps; i++) {
      const p = i / steps;
      const px = src[0] + (cx - src[0]) * p;
      const py = src[1] + (cy - src[1]) * p;
      const gx = Math.floor(px);
      const gy = Math.floor(py);
      if (gx >= t.x0 && gx <= t.x1 && gy >= t.y0 && gy <= t.y1) continue; // inside the target itself
      if (gx >= a.x0 && gx <= a.x1 && gy >= a.y0 && gy <= a.y1) continue; // inside the attacker
      const terr = terrainAt(g, gx, gy);
      if (terr === "wall") wall = true;
      else if (terr === "cover") soft = true;
      for (const bl of blockers) {
        if (gx >= bl.x0 && gx <= bl.x1 && gy >= bl.y0 && gy <= bl.y1) soft = true;
      }
    }
    if (wall) wallBlocked++;
    else if (soft) softBlocked++;
  }
  if (wallBlocked === 4) return "total";
  if (wallBlocked >= 2) return "threequarters";
  if (wallBlocked === 1 || softBlocked >= 1) return "half";
  return "none";
}

// ------------------------------ AoE templates ------------------------------
// Each returns a Set of "x,y" keys. Templates respect line-of-effect from the
// origin (a wall shadows the squares behind it).

/** sphere / "radius R" burst centred on the point between squares nearest (cx,cy) */
export function sphereCells(g: BattleGrid, cx: number, cy: number, radiusFt: number): Set<string> {
  const r = Math.round(radiusFt / FT_PER_SQUARE);
  const out = new Set<string>();
  const origin: Box = boxOf(cx, cy, 1);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!inBounds(g, x, y)) continue;
      if (feetBetweenCells(cx, cy, x, y) > radiusFt) continue;
      if (!hasLineOfSight(g, origin, boxOf(x, y, 1))) continue;
      out.add(cellKey(x, y));
    }
  }
  return out;
}

/** cone of length L from a corner of (ox,oy) toward (tx,ty). 5e cone: width == distance. */
export function coneCells(g: BattleGrid, ox: number, oy: number, tx: number, ty: number, lengthFt: number): Set<string> {
  const out = new Set<string>();
  const dirX = tx - ox;
  const dirY = ty - oy;
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len;
  const uy = dirY / len;
  const originBox = boxOf(ox, oy, 1);
  const reach = Math.round(lengthFt / FT_PER_SQUARE);
  for (let y = oy - reach; y <= oy + reach; y++) {
    for (let x = ox - reach; x <= ox + reach; x++) {
      if (!inBounds(g, x, y)) continue;
      const rx = x - ox;
      const ry = y - oy;
      const along = rx * ux + ry * uy; // projection onto the facing axis
      if (along <= 0 || along * FT_PER_SQUARE > lengthFt) continue;
      const perp = Math.abs(rx * uy - ry * ux);
      // 5e cone half-width at `along` is along/2 (full width == length at the far edge)
      if (perp > along / 2 + 0.5) continue;
      if (!hasLineOfSight(g, originBox, boxOf(x, y, 1))) continue;
      out.add(cellKey(x, y));
    }
  }
  return out;
}

/** line L long, W wide (feet) from (ox,oy) toward (tx,ty) */
export function lineTemplateCells(
  g: BattleGrid,
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  lengthFt: number,
  widthFt = FT_PER_SQUARE,
): Set<string> {
  const out = new Set<string>();
  const dirX = tx - ox;
  const dirY = ty - oy;
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len;
  const uy = dirY / len;
  const originBox = boxOf(ox, oy, 1);
  const reach = Math.round(lengthFt / FT_PER_SQUARE) + 1;
  const halfW = widthFt / FT_PER_SQUARE / 2;
  for (let y = oy - reach; y <= oy + reach; y++) {
    for (let x = ox - reach; x <= ox + reach; x++) {
      if (!inBounds(g, x, y)) continue;
      const rx = x - ox;
      const ry = y - oy;
      const along = rx * ux + ry * uy;
      if (along < 0 || along * FT_PER_SQUARE > lengthFt) continue;
      const perp = Math.abs(rx * uy - ry * ux);
      if (perp > halfW + 0.5) continue;
      if (!hasLineOfSight(g, originBox, boxOf(x, y, 1))) continue;
      out.add(cellKey(x, y));
    }
  }
  return out;
}
