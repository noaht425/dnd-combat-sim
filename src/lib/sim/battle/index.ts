// Battle mode entry point: build the combatants (reusing the scenario party /
// enemy builders), lay them on a grid, run the grid loop, and hand back the
// frame stream + the same CombatResult the Monte-Carlo engine produces.

import type { Combatant } from "../schema";
import { makeRng } from "../engine/rng";
import { buildParty, resolveEnemies, type PartyMemberSpec } from "../engine/scenario";
import { summarise, type CombatResult } from "../engine/loop";
import { initCombatant, type CombatantState } from "../engine/state";
import type { Size } from "../schema";
import type { AwaitingInput, BattleDecision } from "./control";
import { BattleGrid, BattleMapDef, blocksMove, footprint, gridFromDef, inBounds, makeGrid, terrainAt } from "./grid";
import { runBattleLoop } from "./loop";
import {
  BattleState,
  ReactionPause,
  type AwaitingReaction,
  type BattleFrame,
  type Pos,
  type ReactionChoice,
  type Wave,
} from "./state";

export type { BattleFrame, BattleGrid, BattleMapDef };
export { makeGrid, gridFromDef };
export type { AwaitingReaction, ReactionChoice, Wave };
export type { ReactionAsk } from "../engine/state";
export type { BattleDecision, AwaitingInput, AwaitAction, AwaitUnit } from "./control";

export interface BattleSetup {
  party: PartyMemberSpec[];
  /** enemy id strings, "id" or "id x3", same as a scenario */
  enemies: string[];
  /** custom-loaded stat blocks resolvable as enemy ids / summons */
  extraById?: Record<string, Combatant>;
  /** a hand-built map; a plain open room sized to the crowd is used when omitted */
  grid?: BattleGrid;
  /** unitId -> starting square (from the map editor); auto-placed otherwise */
  placements?: Record<string, { x: number; y: number }>;
  seed?: number;
  maxRounds?: number;
  recordFrames?: boolean;
  /** reinforcement waves — extra monsters arriving at a map edge on a given round */
  waves?: Wave[];
  /** unit ids the player is driving (the rest stay AI) */
  controlled?: string[];
  /** recorded player choices, replayed on every run */
  decisions?: BattleDecision[];
  /** recorded answers to reaction prompts, replayed on every run */
  reactionChoices?: ReactionChoice[];
  /** controlled ids whose reactions the player has handed back to the AI */
  reactionAuto?: string[];
}

export interface RosterInit {
  id: string;
  name: string;
  glyph: string;
  side: "party" | "monster";
}

export interface BattleOutcome {
  frames: BattleFrame[];
  result: CombatResult;
  grid: BattleGrid;
  /** final unitId -> glyph, so the UI can label the roster */
  glyphs: Record<string, string>;
  /** initiative order (rolled once), for the header + roster sort */
  initiative: RosterInit[];
  /** set when the loop stopped waiting for a controlled unit's decision */
  awaiting?: AwaitingInput;
  /** set when the loop stopped to ask a controlled unit about a reaction */
  awaitingReaction?: AwaitingReaction;
  /** true when the fight actually concluded (not paused for input) */
  done: boolean;
}

function defaultGrid(nUnits: number): BattleGrid {
  const w = Math.max(16, Math.min(28, 12 + nUnits * 2));
  const h = Math.max(12, Math.min(20, 8 + nUnits));
  return makeGrid(w, h, "floor");
}

const monsterGlyph = (i: number): string =>
  i < 9 ? String(i + 1) : String.fromCharCode(97 + (i - 9)); // 1..9 then a..z

export interface RosterEntry {
  id: string;
  name: string;
  side: "party" | "monster";
  size: Size;
  glyph: string;
}

/** ids + glyphs the fight WILL use, without running it — for the map editor's
 *  token tray. Kept in lock-step with runBattle's own assignment. */
export function battleRoster(s: Pick<BattleSetup, "party" | "enemies" | "extraById">): RosterEntry[] {
  const monsters = resolveEnemies(s.enemies, s.extraById);
  const pcs = buildParty(s.party);
  const out: RosterEntry[] = [];
  let mi = 0;
  let pi = 0;
  // runBattle inserts monsters first, then pcs, and assigns glyphs in that order
  for (const m of monsters) out.push({ id: m.id, name: m.name, side: "monster", size: m.size, glyph: monsterGlyph(mi++) });
  for (const p of pcs) out.push({ id: p.id, name: p.name, side: "party", size: p.size, glyph: String.fromCharCode(65 + (pi++ % 26)) });
  return out;
}

/** first anchor square in one of `rows` (scanning columns from the centre out)
 *  where a footprint-`fp` creature fits, is in bounds, not a wall, not occupied */
function freeAnchor(
  grid: BattleGrid,
  fp: number,
  rows: number[],
  occ: Set<string>,
): { x: number; y: number } | null {
  const cx = Math.floor(grid.width / 2) - Math.floor(fp / 2);
  const order: number[] = [];
  for (let d = 0; d < grid.width; d++) {
    order.push(cx + d);
    if (d) order.push(cx - d);
  }
  for (const y of rows) {
    for (const x of order) {
      if (!fits(grid, x, y, fp, occ)) continue;
      return { x, y };
    }
  }
  return null;
}

function fits(grid: BattleGrid, x: number, y: number, fp: number, occ: Set<string>): boolean {
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const cx = x + dx;
      const cy = y + dy;
      if (!inBounds(grid, cx, cy)) return false;
      if (blocksMove(terrainAt(grid, cx, cy))) return false;
      if (occ.has(`${cx},${cy}`)) return false;
    }
  }
  return true;
}

function placeUnits(
  grid: BattleGrid,
  units: Map<string, CombatantState>,
  pos: Map<string, Pos>,
  fixed?: Record<string, { x: number; y: number }>,
): void {
  const occ = new Set<string>();
  const put = (u: CombatantState, x: number, y: number): void => {
    pos.set(u.id, { x, y });
    const fp = footprint(u.ref.size);
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.add(`${x + dx},${y + dy}`);
  };

  for (const u of units.values()) {
    const f = fixed?.[u.id];
    if (f && fits(grid, f.x, f.y, footprint(u.ref.size), occ)) put(u, f.x, f.y);
  }

  const party = [...units.values()].filter((u) => u.side === "party" && !pos.has(u.id));
  const monsters = [...units.values()].filter((u) => u.side === "monster" && !pos.has(u.id));

  // party enters from the bottom, monsters from the top; a clear band between
  // each side deploys from the FRONT of its zone (toward the enemy) so a fight
  // actually starts in a round or two; the back rows are just spill-over for a crowd
  const partyRows = [grid.height - 4, grid.height - 5, grid.height - 3, grid.height - 6, grid.height - 2];
  const monsterRows = [3, 4, 2, 5, 1];

  for (const u of party) {
    const a = freeAnchor(grid, footprint(u.ref.size), partyRows, occ) ?? anywhere(grid, footprint(u.ref.size), occ);
    if (a) put(u, a.x, a.y);
  }
  for (const u of monsters) {
    const a = freeAnchor(grid, footprint(u.ref.size), monsterRows, occ) ?? anywhere(grid, footprint(u.ref.size), occ);
    if (a) put(u, a.x, a.y);
  }
}

function anywhere(grid: BattleGrid, fp: number, occ: Set<string>): { x: number; y: number } | null {
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) if (fits(grid, x, y, fp, occ)) return { x, y };
  return null;
}

/** default room dimensions for a crowd of `n` (used when the editor has no map yet) */
export function defaultGridSize(n: number): { width: number; height: number } {
  const g = defaultGrid(n);
  return { width: g.width, height: g.height };
}

/** starting squares for every roster entry not already in `fixed` — party at the
 *  bottom, monsters at the top, spread from the centre out. Editor-side only. */
export function autoPlace(
  def: BattleMapDef,
  roster: RosterEntry[],
  fixed: Record<string, { x: number; y: number }> = {},
): Record<string, { x: number; y: number }> {
  const grid = gridFromDef(def);
  const occ = new Set<string>();
  const out: Record<string, { x: number; y: number }> = {};
  const claim = (x: number, y: number, fp: number): void => {
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.add(`${x + dx},${y + dy}`);
  };
  for (const [id, p] of Object.entries(fixed)) {
    const e = roster.find((r) => r.id === id);
    if (e && fits(grid, p.x, p.y, footprint(e.size), occ)) {
      out[id] = p;
      claim(p.x, p.y, footprint(e.size));
    }
  }
  // each side deploys from the FRONT of its zone (toward the enemy) so a fight
  // actually starts in a round or two; the back rows are just spill-over for a crowd
  const partyRows = [grid.height - 4, grid.height - 5, grid.height - 3, grid.height - 6, grid.height - 2];
  const monsterRows = [3, 4, 2, 5, 1];
  for (const e of roster) {
    if (out[e.id]) continue;
    const fp = footprint(e.size);
    const a =
      freeAnchor(grid, fp, e.side === "party" ? partyRows : monsterRows, occ) ?? anywhere(grid, fp, occ);
    if (a) {
      out[e.id] = a;
      claim(a.x, a.y, fp);
    }
  }
  return out;
}

export function runBattle(s: BattleSetup): BattleOutcome {
  const pcs = buildParty(s.party);
  const monsters = resolveEnemies(s.enemies, s.extraById);
  const grid = s.grid ?? defaultGrid(pcs.length + monsters.length);
  const rng = makeRng(s.seed ?? 1, pcs.length, monsters.length, 0x5e17);

  const units = new Map<string, CombatantState>();
  for (const m of monsters) units.set(m.id, initCombatant(m, "monster"));
  for (const pc of pcs) units.set(pc.id, initCombatant(pc, "party"));

  const glyphs = new Map<string, string>();
  let pi = 0;
  let mi = 0;
  for (const u of units.values()) {
    glyphs.set(u.id, u.side === "party" ? String.fromCharCode(65 + (pi++ % 26)) : monsterGlyph(mi++));
  }

  const pos = new Map<string, Pos>();
  placeUnits(grid, units, pos, s.placements);

  const state: BattleState = {
    round: 0,
    order: [],
    activeIdx: 0,
    units,
    rng,
    log: [],
    maxRounds: s.maxRounds ?? 30,
    ended: false,
    verbose: true,
    summonCounter: 0,
    summonRegistry: s.extraById,
    grid,
    pos,
    glyphs,
    frames: [],
    recordFrames: s.recordFrames ?? true,
    frameSeq: 0,
    controlled: s.controlled && s.controlled.length ? new Set(s.controlled) : undefined,
    decisions: s.decisions ?? [],
    waves: s.waves && s.waves.length ? s.waves : undefined,
    spawnedWaves: new Set(),
    reactionChoices: s.reactionChoices ?? [],
    reactionAuto: s.reactionAuto && s.reactionAuto.length ? new Set(s.reactionAuto) : undefined,
    reactionSeq: 0,
  };

  // Battle-mode reaction seam: for an AI unit (or one the player handed back),
  // keep the engine's auto-heuristic; for a controlled unit, replay a recorded
  // answer or pause the fight and throw to unwind out to runBattleLoop.
  state.askReaction = (p) => {
    if (!state.controlled?.has(p.unitId) || state.reactionAuto?.has(p.unitId)) return true;
    const seq = state.reactionSeq++;
    const rec = state.reactionChoices?.find(
      (c) => c.unitId === p.unitId && c.seq === seq && c.round === state.round,
    );
    if (rec) return rec.take;
    state.awaitingReaction = {
      ...p,
      seq,
      round: state.round,
      unitName: state.units.get(p.unitId)?.name ?? p.unitId,
    };
    state.pausedForInput = true;
    throw new ReactionPause();
  };

  runBattleLoop(state);

  const initiative: RosterInit[] = state.order
    .map((id) => state.units.get(id))
    .filter((u): u is CombatantState => !!u)
    .map((u) => ({ id: u.id, name: u.name, glyph: glyphs.get(u.id) ?? "?", side: u.side }));

  return {
    frames: state.frames,
    result: summarise(state, true),
    grid,
    glyphs: Object.fromEntries(glyphs),
    initiative,
    awaiting: state.awaiting,
    awaitingReaction: state.awaitingReaction,
    done: !state.pausedForInput,
  };
}
