// Forced movement and teleporting on the battle grid — the `move` node's push, pull and teleport kinds (the shared interpreter calls `state.moveCreature`, which battle mode installs).
//
// Push / pull: the creature slides in a straight line away from / toward the source, one square (5 feet) at a time, and stops at a wall, the edge of the map, or another creature (a pull
// also stops once it is beside the source: "10 feet closer" never carries it past). Terrain costs nothing and nothing provokes: forced movement is not the creature's own.
//
// Teleport: the creature lands on an unoccupied square within `distance` feet. Beside a named creature when it has one (Relentless Hex, Bond of the Talisman, a marked target); otherwise
// where its stance wants it — a ranged creature (`keepDistance`) as far from the enemy as the hop allows, a melee creature next to the nearest one, and an escape (Misty Escape) always
// the far one.

import type { CombatantState } from "../engine/state";
import { say } from "../engine/state";
import { BattleState, boxOfUnit, canFly, deriveZones, posOf, recordFrame } from "./state";
import { FT_PER_SQUARE, footprint } from "./grid";
import { boxOf, feetBetweenBoxes, type Box } from "./geometry";
import { canOccupy, type MoveContext } from "./movement";
import { occupiedByOthers } from "./ai";

export interface MoveRequest {
  kind: "push" | "pull" | "teleportSelf";
  source: CombatantState;
  target?: CombatantState;
  distance: number;
  near?: CombatantState[];
  /** a teleport that is a flight, not an approach (Misty Escape) */
  escape?: boolean;
}

export function moveCreatureInBattle(state: BattleState, req: MoveRequest): void {
  if (req.kind === "teleportSelf") teleportUnit(state, req.source, req.distance, req.near, req.escape);
  else if (req.target) forcedMove(state, req.source, req.target, req.kind, req.distance);
}

const centre = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

function forcedMove(state: BattleState, source: CombatantState, target: CombatantState, kind: "push" | "pull", distance: number): void {
  const from = posOf(state, target.id);
  const fp = footprint(target.ref.size);
  const srcBox = boxOfUnit(state, source);
  const s = centre(srcBox);
  const t = centre(boxOfUnit(state, target));
  let dx = t.x - s.x;
  let dy = t.y - s.y;
  if (kind === "pull") { dx = -dx; dy = -dy; }
  if (dx === 0 && dy === 0) return;
  // the nearest of the eight directions to the straight line
  const stepX = 2 * Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
  const stepY = 2 * Math.abs(dy) >= Math.abs(dx) ? Math.sign(dy) : 0;
  const ctx: MoveContext = { grid: state.grid, size: target.ref.size, blocked: occupiedByOthers(state, target.id), flying: canFly(target) };
  let x = from.x;
  let y = from.y;
  let squares = 0;
  for (let i = 0; i < Math.floor(distance / FT_PER_SQUARE); i++) {
    if (kind === "pull" && feetBetweenBoxes(boxOf(x, y, fp), srcBox) <= FT_PER_SQUARE) break; // beside the source already
    const nx = x + stepX;
    const ny = y + stepY;
    if (!canOccupy(ctx, nx, ny, fp)) break;
    x = nx;
    y = ny;
    squares++;
  }
  if (!squares) return;
  state.pos.set(target.id, { x, y });
  deriveZones(state);
  const text = `${target.name} is ${kind === "push" ? "pushed" : "pulled"} ${squares * FT_PER_SQUARE} ft`;
  say(state, text, source.id);
  recordFrame(state, { kind: "move", actorId: target.id, text, path: [[from.x, from.y], [x, y]] });
}

function enemyGap(state: BattleState, u: CombatantState, box: Box): number {
  let g = Infinity;
  for (const e of state.units.values()) {
    if (e.side === u.side || !e.alive || e.downed) continue;
    g = Math.min(g, feetBetweenBoxes(box, boxOfUnit(state, e)));
  }
  return g;
}

function teleportUnit(state: BattleState, u: CombatantState, distance: number, near: CombatantState[] | undefined, escape = false): void {
  if (near && !near.length) return; // "beside" a creature that isn't there
  const fp = footprint(u.ref.size);
  const ctx: MoveContext = { grid: state.grid, size: u.ref.size, blocked: occupiedByOthers(state, u.id), flying: true };
  const here = boxOfUnit(state, u);
  const start = posOf(state, u.id);
  // already beside the creature it was going to: nothing to do
  if (near?.length && near.some((n) => feetBetweenBoxes(here, boxOfUnit(state, n)) <= FT_PER_SQUARE)) return;
  const ranged = escape || !!u.ref.ai.keepDistance;
  let best: { x: number; y: number; score: number } | undefined;
  for (let y = 0; y < state.grid.height; y++) {
    for (let x = 0; x < state.grid.width; x++) {
      if ((x === start.x && y === start.y) || !canOccupy(ctx, x, y, fp)) continue;
      const box = boxOf(x, y, fp);
      const hop = feetBetweenBoxes(here, box);
      if (hop > distance + 0.001) continue;
      let score: number;
      if (near?.length) {
        if (!near.some((n) => feetBetweenBoxes(box, boxOfUnit(state, n)) <= FT_PER_SQUARE)) continue;
        score = -hop; // the nearest such square
      } else if (ranged) {
        score = Math.min(enemyGap(state, u, box), 60) * 10 - hop * 0.01; // as far from the fight as the hop allows (past 60 feet it stops helping)
      } else {
        const gap = enemyGap(state, u, box);
        if (gap <= 0) continue;
        score = -gap * 10 - hop * 0.01; // beside the nearest enemy
      }
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  if (!best) return;
  const moved = Math.round(feetBetweenBoxes(here, boxOf(best.x, best.y, fp)));
  state.pos.set(u.id, { x: best.x, y: best.y });
  deriveZones(state);
  const text = `${u.name} teleports ${moved} ft`;
  say(state, text, u.id);
  recordFrame(state, { kind: "move", actorId: u.id, text, path: [[start.x, start.y], [best.x, best.y]] });
}
