// Grid movement: reachable-square flood and pathfinding, both honouring the
// alternating 5-10-5 diagonal rule and difficult terrain (2x cost). Walls,
// `cover` terrain, and squares occupied by other creatures are impassable.

import { BattleGrid, blocksMove, cellKey, FT_PER_SQUARE, footprint, inBounds, terrainAt } from "./grid";
import { Box, boxOf, feetBetweenBoxes } from "./geometry";
import type { Size } from "../schema";

export interface MoveContext {
  grid: BattleGrid;
  size: Size;
  /** "x,y" keys of squares blocked by OTHER creatures (the mover's own squares excluded) */
  blocked: Set<string>;
  /** the mover has a fly speed — difficult terrain and ground hazards don't slow it */
  flying?: boolean;
}

/** can a creature of footprint `fp` stand with its anchor at (x,y)? */
export function canOccupy(ctx: MoveContext, x: number, y: number, fp: number): boolean {
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const cx = x + dx;
      const cy = y + dy;
      if (!inBounds(ctx.grid, cx, cy)) return false;
      if (blocksMove(terrainAt(ctx.grid, cx, cy))) return false;
      if (ctx.blocked.has(cellKey(cx, cy))) return false;
    }
  }
  return true;
}

/** worst (max) difficult-terrain multiplier under a footprint anchored at (x,y) */
function stepTerrainExtra(ctx: MoveContext, x: number, y: number, fp: number): number {
  if (ctx.flying) return 0; // a flyer clears rubble / undergrowth / shallow water
  let extra = 0;
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      if (terrainAt(ctx.grid, x + dx, y + dy) === "difficult") extra = FT_PER_SQUARE;
    }
  }
  return extra;
}

interface Node {
  x: number;
  y: number;
  diagCount: number; // how many diagonal steps taken so far (for 5-10-5 parity)
  cost: number; // feet spent
}

const DIRS: Array<[number, number, boolean]> = [
  [1, 0, false],
  [-1, 0, false],
  [0, 1, false],
  [0, -1, false],
  [1, 1, true],
  [1, -1, true],
  [-1, 1, true],
  [-1, -1, true],
];

/** cost in feet to step onto (nx,ny); `diagCountBefore` = diagonals already taken */
function stepCost(ctx: MoveContext, nx: number, ny: number, fp: number, diagonal: boolean, diagCountBefore: number): number {
  let base = FT_PER_SQUARE;
  if (diagonal) {
    // alternating: the 2nd, 4th, … diagonal costs 10 instead of 5
    base = (diagCountBefore % 2 === 1) ? FT_PER_SQUARE * 2 : FT_PER_SQUARE;
  }
  return base + stepTerrainExtra(ctx, nx, ny, fp);
}

/** Dijkstra flood from (sx,sy): every anchor square reachable within `budgetFt`,
 *  mapped to the feet spent to get there (cheapest). */
export function reachable(ctx: MoveContext, sx: number, sy: number, budgetFt: number): Map<string, number> {
  const fp = footprint(ctx.size);
  const best = new Map<string, number>();
  const bestDiag = new Map<string, number>();
  const start: Node = { x: sx, y: sy, diagCount: 0, cost: 0 };
  best.set(cellKey(sx, sy), 0);
  bestDiag.set(cellKey(sx, sy), 0);
  // simple array frontier; battle maps are small so a binary heap isn't worth it
  const frontier: Node[] = [start];
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    const curKey = cellKey(cur.x, cur.y);
    if (cur.cost > (best.get(curKey) ?? Infinity)) continue;
    for (const [dx, dy, diag] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!canOccupy(ctx, nx, ny, fp)) continue;
      // diagonal squeeze: don't cut a wall corner
      if (diag && (!canOccupy(ctx, cur.x + dx, cur.y, fp) && !canOccupy(ctx, cur.x, cur.y + dy, fp))) continue;
      const c = cur.cost + stepCost(ctx, nx, ny, fp, diag, cur.diagCount);
      if (c > budgetFt) continue;
      const nKey = cellKey(nx, ny);
      const nDiag = cur.diagCount + (diag ? 1 : 0);
      if (c < (best.get(nKey) ?? Infinity) || (c === best.get(nKey) && nDiag < (bestDiag.get(nKey) ?? Infinity))) {
        best.set(nKey, c);
        bestDiag.set(nKey, nDiag);
        frontier.push({ x: nx, y: ny, diagCount: nDiag, cost: c });
      }
    }
  }
  return best;
}

export interface PathResult {
  /** anchor squares from start (inclusive) to the chosen stopping square (inclusive) */
  path: Array<[number, number]>;
  /** feet spent along `path` */
  feet: number;
  /** true if we reached a square within `reachFt` of the goal box */
  reached: boolean;
}

/** A* toward `goal` (a target's footprint). Stops at the first square within
 *  `reachFt` of the goal, or as close as `budgetFt` allows. */
export function pathToward(
  ctx: MoveContext,
  sx: number,
  sy: number,
  goal: Box,
  reachFt: number,
  budgetFt: number,
): PathResult {
  const fp = footprint(ctx.size);
  const h = (x: number, y: number): number => feetBetweenBoxes(boxOf(x, y, fp), goal);
  const startKey = cellKey(sx, sy);
  const g = new Map<string, number>([[startKey, 0]]);
  const diagAt = new Map<string, number>([[startKey, 0]]);
  const came = new Map<string, string>();
  const open: Array<{ x: number; y: number; f: number }> = [{ x: sx, y: sy, f: h(sx, sy) }];

  const atGoal = (x: number, y: number): boolean => h(x, y) <= reachFt;

  let bestSeen = startKey;
  let bestSeenH = h(sx, sy);
  let reachedKey: string | null = atGoal(sx, sy) ? startKey : null;

  while (open.length && !reachedKey) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    const curKey = cellKey(cur.x, cur.y);
    const curG = g.get(curKey) ?? Infinity;
    const curDiag = diagAt.get(curKey) ?? 0;
    for (const [dx, dy, diag] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!canOccupy(ctx, nx, ny, fp)) continue;
      if (diag && !canOccupy(ctx, cur.x + dx, cur.y, fp) && !canOccupy(ctx, cur.x, cur.y + dy, fp)) continue;
      const ng = curG + stepCost(ctx, nx, ny, fp, diag, curDiag);
      if (ng > budgetFt) continue;
      const nKey = cellKey(nx, ny);
      if (ng >= (g.get(nKey) ?? Infinity)) continue;
      g.set(nKey, ng);
      diagAt.set(nKey, curDiag + (diag ? 1 : 0));
      came.set(nKey, curKey);
      const hn = h(nx, ny);
      if (hn < bestSeenH) {
        bestSeenH = hn;
        bestSeen = nKey;
      }
      if (atGoal(nx, ny)) {
        reachedKey = nKey;
        break;
      }
      open.push({ x: nx, y: ny, f: ng + hn });
    }
  }

  const endKey = reachedKey ?? bestSeen;
  const path: Array<[number, number]> = [];
  let k: string | undefined = endKey;
  while (k) {
    const [x, y] = k.split(",").map(Number);
    path.unshift([x, y]);
    k = came.get(k);
  }
  return { path, feet: g.get(endKey) ?? 0, reached: reachedKey !== null };
}
