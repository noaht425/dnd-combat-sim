// Battle-mode state = the shared CombatState plus a position side-table and a
// frame recorder. Positions live in `state.pos` (not on CombatantState) so every
// reused engine function keeps working unchanged.

import type { CombatState, CombatantState, ReactionAsk } from "../engine/state";
import { footprint, reachFt as sizeReachFt } from "./grid";
import { boxOf, feetBetweenBoxes, type Box } from "./geometry";
import type { BattleGrid } from "./grid";
import type { AwaitingInput, BattleDecision } from "./control";

export interface Pos {
  x: number;
  y: number;
}

export interface BattleState extends CombatState {
  grid: BattleGrid;
  /** unitId -> anchor square (top-left of its footprint) */
  pos: Map<string, Pos>;
  glyphs: Map<string, string>;
  frames: BattleFrame[];
  recordFrames: boolean;
  frameSeq: number;
  /** the AI writes this just before runAction so the interpreter's geometry seam can read it */
  intent?: BattleIntent;
  /** unit ids the player is driving; the rest stay AI */
  controlled?: Set<string>;
  /** recorded player choices, replayed each run */
  decisions?: BattleDecision[];
  /** set when the loop stopped on a controlled unit that has no decision yet */
  awaiting?: AwaitingInput;
  pausedForInput?: boolean;
  /** reinforcement waves: extra monsters that arrive at a map edge on a given round */
  waves?: Wave[];
  spawnedWaves: Set<number>;
  /** ids whose reactions the player has handed back to the AI ("stop asking") */
  reactionAuto?: Set<string>;
  /** recorded player answers to reaction prompts, replayed each run */
  reactionChoices?: ReactionChoice[];
  /** monotonic per-run counter, bumped at every controlled-unit reaction decision point */
  reactionSeq: number;
  /** set when the loop stopped to ask a controlled unit about a reaction */
  awaitingReaction?: AwaitingReaction;
}

export interface Wave {
  round: number;
  /** enemy id strings ("id" / "id x3") */
  enemies: string[];
  edge: "top" | "bottom" | "left" | "right";
}

export interface ReactionChoice {
  round: number;
  unitId: string;
  /** the reactionSeq value this answer belongs to */
  seq: number;
  /** true = spend the reaction, false = decline */
  take: boolean;
}

export interface AwaitingReaction extends ReactionAsk {
  round: number;
  seq: number;
  unitName: string;
}

/** thrown by the askReaction seam to unwind out of deep action resolution so the
 *  loop can pause the fight and surface the prompt. Caught in runBattleLoop. */
export class ReactionPause extends Error {
  constructor() {
    super("battle paused for a reaction decision");
    this.name = "ReactionPause";
  }
}

export interface BattleIntent {
  unitId: string;
  /** the single enemy this action is aimed at (multiattack / single-target spells) */
  targetId?: string;
  /** for an AoE action: the exact units the template caught */
  templateHitIds?: string[];
  /** cover AC bonus the interpreter should add per target id */
  coverAcById?: Map<string, number>;
  /** disadvantage on the attack against these ids (long range) */
  longRangeIds?: Set<string>;
}

export interface UnitSnap {
  id: string;
  name: string;
  side: "party" | "monster";
  glyph: string;
  x: number;
  y: number;
  fp: number;
  hp: number;
  maxHp: number;
  tempHp: number;
  alive: boolean;
  downed: boolean;
  zone: "melee" | "ranged";
  conditions: string[];
  concentrating: boolean;
  isActor: boolean;
}

export interface BattleFrame {
  round: number;
  seq: number;
  kind: "start" | "turn" | "move" | "action" | "legendary" | "lair" | "reaction" | "reinforce" | "end";
  actorId?: string;
  text?: string;
  /** kind "move": anchor squares walked, start..end inclusive */
  path?: Array<[number, number]>;
  targetIds?: string[];
  templateCells?: string[];
  units: UnitSnap[];
  /** present only on the first ("start") frame */
  terrain?: { width: number; height: number; tiles: string };
}

export const posOf = (state: BattleState, id: string): Pos => state.pos.get(id) ?? { x: 0, y: 0 };

export function boxOfUnit(state: BattleState, u: CombatantState): Box {
  const p = posOf(state, u.id);
  return boxOf(p.x, p.y, footprint(u.ref.size));
}

/** natural + weapon reach in feet (a monster whose attack text says "reach 10" gets 10) */
export function unitReachFt(u: CombatantState): number {
  let r = sizeReachFt(u.ref.size);
  const blob = JSON.stringify(u.ref.actions);
  if (/reach 1[05] ?ft|reach 1[05]\b/i.test(blob)) r = Math.max(r, 10);
  return r;
}

/** walk speed in feet (default 30) */
/** movement budget: the walk speed, or the fly speed for a creature that can
 *  ONLY fly (no walk). A flyer whose fly == walk (a Fairy) is unchanged. */
export const speedFt = (u: CombatantState): number =>
  u.ref.speeds?.walk ?? u.ref.speeds?.fly ?? 30;

/** does this unit have a flying speed? (it ignores difficult terrain + ground hazards) */
export const canFly = (u: CombatantState): boolean => (u.ref.speeds?.fly ?? 0) > 0;

/** min edge-to-edge feet from `u` to any living enemy */
export function nearestEnemyFt(state: BattleState, u: CombatantState): number {
  const me = boxOfUnit(state, u);
  let best = Infinity;
  for (const e of state.units.values()) {
    if (e.side === u.side || !e.alive || e.downed) continue;
    best = Math.min(best, feetBetweenBoxes(me, boxOfUnit(state, e)));
  }
  return best;
}

/** recompute every unit's melee/ranged zone from the current board */
export function deriveZones(state: BattleState): void {
  for (const u of state.units.values()) {
    if (!u.alive) continue;
    const me = boxOfUnit(state, u);
    const myReach = unitReachFt(u);
    let inMelee = false;
    for (const e of state.units.values()) {
      if (e.side === u.side || !e.alive || e.downed) continue;
      const d = feetBetweenBoxes(me, boxOfUnit(state, e));
      // "in melee" = I threaten it, or it threatens me
      if (d <= myReach || d <= unitReachFt(e)) {
        inMelee = true;
        break;
      }
    }
    // a keep-distance monster that has escaped stays "ranged"; otherwise derive
    u.zone = inMelee ? "melee" : "ranged";
  }
}

export function snapshotUnits(state: BattleState, actorId?: string): UnitSnap[] {
  const out: UnitSnap[] = [];
  for (const u of state.units.values()) {
    const p = posOf(state, u.id);
    out.push({
      id: u.id,
      name: u.name,
      side: u.side,
      glyph: state.glyphs.get(u.id) ?? "?",
      x: p.x,
      y: p.y,
      fp: footprint(u.ref.size),
      hp: Math.max(0, Math.round(u.hp)),
      maxHp: u.maxHp,
      tempHp: u.tempHp,
      alive: u.alive,
      downed: u.downed,
      zone: u.zone,
      conditions: [...u.conditions.keys()],
      concentrating: !!u.concentratingOn,
      isActor: u.id === actorId,
    });
  }
  return out;
}

export function recordFrame(
  state: BattleState,
  f: Omit<BattleFrame, "round" | "seq" | "units"> & { units?: UnitSnap[] },
): void {
  if (!state.recordFrames) return;
  state.frames.push({
    round: state.round,
    seq: state.frameSeq++,
    ...f,
    units: f.units ?? snapshotUnits(state, f.actorId),
  });
}
