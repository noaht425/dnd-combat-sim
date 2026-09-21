// Battle-mode turn brain: reuse the engine's action scorer to pick WHAT to do,
// then add the spatial layer — pick a concrete target, path toward it (or kite
// away), and expose geometry seams so the shared interpreter resolves targets
// and cover on the grid.

import type { Action, AutomationNode } from "../schema";
import { chooseBest } from "../engine/ai";
import { runAction } from "../engine/interpreter";
import { provokeOpportunityAttacks } from "../engine/reactions";
import { canTakeReactions, isIncapacitated, livingEnemies, say, type CombatantState } from "../engine/state";
import {
  BattleState,
  boxOfUnit,
  canFly,
  deriveZones,
  nearestEnemyFt,
  posOf,
  recordFrame,
  speedFt,
  unitReachFt,
} from "./state";
import { footprint } from "./grid";
import {
  boxOf,
  coneCells,
  coverAcBonus,
  coverBetween,
  feetBetweenBoxes,
  hasLineOfSight,
  lineTemplateCells,
  sphereCells,
  type Box,
} from "./geometry";
import { canOccupy, pathToward, reachable, type MoveContext } from "./movement";

export interface BattleIntentPlan {
  action?: Action;
  targetId?: string;
  /** unit ids an AoE template caught */
  templateHitIds?: string[];
  templateCells?: string[];
  /** the actor must close to melee for this action */
  needsMelee: boolean;
}

// -------------------------------------------------------------- pick an action

const isAoeNode = (n: AutomationNode): boolean =>
  n.type === "target" && (n.who.who === "area" || n.who.who === "eachEnemy");

function actionHasAoe(a: Action): boolean {
  return a.automation.some(isAoeNode);
}

/** does this action (following useAction / branch) ever make an attack roll? */
export function actionMakesAttacks(u: CombatantState, a: Action, seen = new Set<string>()): boolean {
  if (seen.has(a.id)) return false;
  seen.add(a.id);
  const walk = (nodes: AutomationNode[]): boolean =>
    nodes.some((n) => {
      if (n.type === "attack") return true;
      if (n.type === "target") return walk(n.effects);
      if (n.type === "branch") return walk(n.then) || (n.else ? walk(n.else) : false);
      if (n.type === "useAction") {
        const sub = u.ref.actions.find((x) => x.id === n.action);
        return sub ? actionMakesAttacks(u, sub, seen) : false;
      }
      return false;
    });
  return walk(a.automation);
}

/** the action's text/name reads as a ranged / thrown attack (so the attacker
 *  doesn't need to close to melee) */
function isRangedAction(a: Action): boolean {
  const t = `${a.name} ${a.text ?? ""}`;
  return /\brange(?:d)?\b|\brange \d|\b\d{1,3}\/\d{2,3}\b|longbow|shortbow|crossbow|\bsling\b|blowgun|javelin|hand ?axe|\bdart\b|\bbolt\b|\brock\b|\bspit\b|hurl|thrown|\bweb\b|\bbreath\b|\bray\b|\bbeam\b|\bshot\b/i.test(t);
}

/** the enemy this unit should aim at: the side's shared focus if it's sane, else grid-nearest with sight */
function pickTarget(state: BattleState, u: CombatantState): CombatantState | undefined {
  const foes = livingEnemies(state, u);
  if (!foes.length) return undefined;
  const focusId = u.side === "party" ? state.focusId : u.ref.ai.focusFire ? state.monsterFocusId : undefined;
  const focus = focusId ? state.units.get(focusId) : undefined;
  const me = boxOfUnit(state, u);
  const withSight = foes.filter((f) => hasLineOfSight(state.grid, me, boxOfUnit(state, f)));
  const pool = withSight.length ? withSight : foes;
  if (focus && focus.alive && !focus.downed && pool.includes(focus)) return focus;
  return [...pool].sort(
    (a, b) => feetBetweenBoxes(me, boxOfUnit(state, a)) - feetBetweenBoxes(me, boxOfUnit(state, b)),
  )[0];
}

/** try centring an AoE template to catch the most enemies and fewest allies */
function planTemplate(
  state: BattleState,
  u: CombatantState,
  node: Extract<AutomationNode, { type: "target" }>,
): { hitIds: string[]; cells: string[] } {
  const shape = node.who.who === "area" && "shape" in node.who ? node.who.shape : "sphere";
  const size = node.who.who === "area" && "size" in node.who ? node.who.size : 20;
  const foes = livingEnemies(state, u);
  const me = posOf(state, u.id);
  const boxes = new Map<string, Box>();
  for (const x of state.units.values()) if (x.alive) boxes.set(x.id, boxOfUnit(state, x));

  const score = (cells: Set<string>): number => {
    let s = 0;
    for (const x of state.units.values()) {
      if (!x.alive || x.downed) continue;
      const hit = boxCellsIn(boxes.get(x.id)!, cells);
      if (!hit) continue;
      s += x.side === u.side ? -3 : x.side === "monster" && u.side === "monster" ? -3 : 2;
    }
    return s;
  };

  let best: { hitIds: string[]; cells: string[]; s: number } = { hitIds: [], cells: [], s: -Infinity };
  // an emanation (a cannon's detonation) is centred on the caster itself, not aimed at a foe
  const centres = shape === "emanation" ? [me] : foes.map((f) => posOf(state, f.id));
  for (const c of centres) {
    let cells: Set<string>;
    if (shape === "cone") cells = coneCells(state.grid, me.x, me.y, c.x, c.y, size);
    else if (shape === "line") cells = lineTemplateCells(state.grid, me.x, me.y, c.x, c.y, size);
    else cells = sphereCells(state.grid, c.x, c.y, size);
    const s = score(cells);
    if (s > best.s) {
      const hitIds = [...state.units.values()]
        .filter((x) => x.alive && !x.downed && boxCellsIn(boxes.get(x.id)!, cells))
        .map((x) => x.id);
      best = { hitIds, cells: [...cells], s };
    }
  }
  return { hitIds: best.hitIds, cells: best.cells };
}

function boxCellsIn(b: Box, cells: Set<string>): boolean {
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (cells.has(`${x},${y}`)) return true;
  return false;
}

export function planTurn(state: BattleState, u: CombatantState): BattleIntentPlan {
  const action = chooseBest(state, u) ?? u.ref.actions.find((a) => a.id === "attack");
  return planForAction(state, u, action);
}

/** the spatial plan (target, AoE template, melee-or-not) for taking a specific `action` */
export function planForAction(state: BattleState, u: CombatantState, action: Action | undefined): BattleIntentPlan {
  const target = pickTarget(state, u);
  const plan: BattleIntentPlan = { action, targetId: target?.id, needsMelee: false };
  if (!action) return plan;

  if (actionHasAoe(action)) {
    const node = action.automation.find(isAoeNode) as Extract<AutomationNode, { type: "target" }> | undefined;
    if (node) {
      const t = planTemplate(state, u, node);
      plan.templateHitIds = t.hitIds;
      plan.templateCells = t.cells;
    }
  }
  // "melee" = the action makes an attack roll, isn't an AoE or a ranged/thrown
  // routine, and the unit isn't a deliberate skirmisher. Catches Bite / Claw /
  // Slam / Gore / Tentacle etc., not just actions literally named "Attack".
  plan.needsMelee =
    actionMakesAttacks(u, action) &&
    !actionHasAoe(action) &&
    !isRangedAction(action) &&
    !u.ref.ai.keepDistance;
  return plan;
}

// ---------------------------------------------------------------- move / kite

function occupiedByOthers(state: BattleState, selfId: string): Set<string> {
  const s = new Set<string>();
  for (const x of state.units.values()) {
    if (x.id === selfId || !x.alive) continue;
    const p = posOf(state, x.id);
    const fp = footprint(x.ref.size);
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) s.add(`${p.x + dx},${p.y + dy}`);
  }
  return s;
}

/** move `u` this turn according to `plan`. Records a "move" frame if it stepped.
 *  Returns whether it actually moved. */
export function reposition(state: BattleState, u: CombatantState, plan: BattleIntentPlan, opts: { budgetFt?: number; free?: boolean } = {}): boolean {
  if (isIncapacitated(u) || !u.alive) return false;
  const budget = opts.budgetFt ?? speedFt(u);
  const ctx: MoveContext = { grid: state.grid, size: u.ref.size, blocked: occupiedByOthers(state, u.id), flying: canFly(u) };
  const start = posOf(state, u.id);
  const myReach = unitReachFt(u);
  const target = plan.targetId ? state.units.get(plan.targetId) : undefined;

  let endPath: Array<[number, number]> | null = null;

  if (plan.needsMelee && target && target.alive) {
    const d = feetBetweenBoxes(boxOfUnit(state, u), boxOfUnit(state, target));
    if (d > myReach) {
      const r = pathToward(ctx, start.x, start.y, boxOfUnit(state, target), myReach, budget);
      if (r.path.length > 1) endPath = r.path;
    }
  } else if (!plan.needsMelee && nearestEnemyFt(state, u) <= myReach + 5) {
    // a ranged / caster combatant that's been pinned kites to open ground with sight
    const flood = reachable(ctx, start.x, start.y, budget);
    let bestKey: string | null = null;
    let bestGap = nearestEnemyFt(state, u);
    for (const key of flood.keys()) {
      const [x, y] = key.split(",").map(Number);
      if (!canOccupy(ctx, x, y, footprint(u.ref.size))) continue;
      const box = boxOf(x, y, footprint(u.ref.size));
      const gap = minEnemyGap(state, u, box);
      const seesTarget = !target || hasLineOfSight(state.grid, box, boxOfUnit(state, target));
      if (gap > bestGap && seesTarget) {
        bestGap = gap;
        bestKey = key;
      }
    }
    if (bestKey) {
      const [x, y] = bestKey.split(",").map(Number);
      endPath = [[start.x, start.y], [x, y]];
    }
  }

  if (!endPath) return false;

  // opportunity attacks: resolve while the mover is still where it started and
  // adjacent enemies are still flagged "melee"
  const wasMelee = u.zone === "melee";
  if (wasMelee && !opts.free) {
    // Cunning Action: a rogue spends its bonus action to Disengage rather than eat opportunity attacks
    const dis = u.ref.actions.find((a) => a.id === "cunning-disengage");
    if (dis && !u.bonusUsedThisTurn) {
      u.bonusUsedThisTurn = true;
      runAction(state, u, dis);
      say(state, `${u.name} disengages (Cunning Action)`, u.id);
    }
    provokeOpportunityAttacks(state, u); // a Disengage makes this a no-op
    if (!u.alive || isIncapacitated(u)) return false;
  }

  const [ex, ey] = endPath[endPath.length - 1];
  state.pos.set(u.id, { x: ex, y: ey });
  deriveZones(state);
  // if this was a melee approach that still hasn't closed, say how far is left
  let text = `${u.name} moves`;
  if (plan.needsMelee && target && target.alive) {
    const left = feetBetweenBoxes(boxOfUnit(state, u), boxOfUnit(state, target));
    if (left > myReach + 0.001) text = `${u.name} advances on ${target.name} — ${Math.round(left)} ft to go`;
  }
  recordFrame(state, { kind: "move", actorId: u.id, text, path: endPath });
  return true;
}

/**
 * Skirmisher (Scout, 3rd): when an enemy ends its turn within 5 ft of you, your reaction moves you up to half your speed, provoking
 * no opportunity attacks. Taken by AI-run scouts (a player-controlled one isn't interrupted to be asked).
 */
export function skirmish(state: BattleState, enemy: CombatantState): void {
  if (!enemy.alive) return;
  for (const r of state.units.values()) {
    if (r.side === enemy.side || !r.alive || r.downed || r.reactionUsed || isIncapacitated(r) || !canTakeReactions(r)) continue;
    if (!r.ref.reactions.some((x) => x.id === "skirmisher") || state.controlled?.has(r.id)) continue;
    if (feetBetweenBoxes(boxOfUnit(state, r), boxOfUnit(state, enemy)) > 5.001) continue;
    r.reactionUsed = true;
    say(state, `${r.name} slips away (Skirmisher)`, r.id);
    reposition(state, r, { needsMelee: false, targetId: enemy.id }, { budgetFt: Math.floor(speedFt(r) / 2), free: true });
  }
}

function minEnemyGap(state: BattleState, u: CombatantState, box: Box): number {
  let g = Infinity;
  for (const e of state.units.values()) {
    if (e.side === u.side || !e.alive || e.downed) continue;
    g = Math.min(g, feetBetweenBoxes(box, boxOfUnit(state, e)));
  }
  return g;
}

// ------------------------------------------------------------- summons & commands

/** put a freshly summoned minion on the free squares nearest its summoner (a summon has no
 *  position of its own, and `posOf` would otherwise drop it in the top-left corner) */
export function placeSummon(state: BattleState, summoner: CombatantState, minion: CombatantState): void {
  const fp = footprint(minion.ref.size);
  const ctx: MoveContext = { grid: state.grid, size: minion.ref.size, blocked: occupiedByOthers(state, minion.id), flying: canFly(minion) };
  const home = boxOfUnit(state, summoner);
  let best: { x: number; y: number; gap: number } | undefined;
  for (let y = 0; y < state.grid.height; y++) {
    for (let x = 0; x < state.grid.width; x++) {
      if (!canOccupy(ctx, x, y, fp)) continue;
      const gap = feetBetweenBoxes(boxOf(x, y, fp), home);
      if (!best || gap < best.gap) best = { x, y, gap };
    }
  }
  if (!best) return;
  state.pos.set(minion.id, { x: best.x, y: best.y });
  state.glyphs.set(minion.id, (state.glyphs.get(summoner.id) ?? "?").toLowerCase());
  deriveZones(state);
}

/** a summoner's bonus-action command: the minion steps up if the action is a melee one, then takes
 *  `action` against real geometry (cones/emanations from where the minion actually stands) */
export function commandMinionAction(state: BattleState, m: CombatantState, action: Action): void {
  if (!m.alive || isIncapacitated(m)) return;
  const plan = planForAction(state, m, action);
  if (plan.needsMelee) {
    reposition(state, m, plan);
    if (!m.alive || isIncapacitated(m)) return;
  }
  deriveZones(state);
  const geo = { geoTargets: geoTargetsFor(state, m, plan), attackMods: attackModsFor(state, m, plan.needsMelee) };
  runAction(state, m, action, { asReaction: true, verb: "(commanded) ", geo });
}

// ----------------------------------------------------- interpreter geometry seams

/** the `geoTargets` seam for a given actor + plan */
export function geoTargetsFor(state: BattleState, u: CombatantState, plan: BattleIntentPlan) {
  return (node: Extract<AutomationNode, { type: "target" }>, source: CombatantState): CombatantState[] | null => {
    const who = node.who.who;
    if (who === "self" || who === "eachAlly" || who === "lowestHpAlly" || who === "chosenEnemies") return null;
    if (who === "eachEnemy" && node.who.withinFt) return null; // resolved by real distance in selectTargets
    const foes = livingEnemies(state, source);
    if (!foes.length) return [];
    const me = boxOfUnit(state, source);

    if (who === "area" || who === "eachEnemy") {
      // as in control.ts's runOne: a defined-but-empty templateHitIds is a
      // genuine whiff (real geometry was computed, nobody was in it), not
      // "no template was planned" — only the latter falls back to "everyone
      // visible."
      if (plan.templateHitIds !== undefined) {
        return plan.templateHitIds.map((id) => state.units.get(id)).filter((x): x is CombatantState => !!x && x.alive && x.side !== source.side);
      }
      // fall back: everyone the caster can see (front line)
      return foes.filter((f) => hasLineOfSight(state.grid, me, boxOfUnit(state, f)));
    }

    // single-target selectors
    if (plan.targetId) {
      const t = state.units.get(plan.targetId);
      if (t && t.alive && !t.downed && t.side !== source.side) return [t];
    }
    return [
      [...foes].sort((a, b) => feetBetweenBoxes(me, boxOfUnit(state, a)) - feetBetweenBoxes(me, boxOfUnit(state, b)))[0],
    ];
  };
}

/** the `attackMods` seam: cover -> +AC, long range -> disadvantage, and (for a
 *  melee routine) a target beyond the attacker's reach -> the swing can't land.
 *  `needsMelee` is the plan's melee flag, so ranged attackers are never blocked. */
export function attackModsFor(state: BattleState, u: CombatantState, needsMelee = false) {
  const LONG_RANGE_FT = 120;
  const reach = unitReachFt(u);
  return (target: CombatantState, info?: { ranged?: boolean }): { acBonus?: number; disadvantage?: boolean; unreachable?: boolean; allyAdjacent?: boolean; soloDuel?: boolean } => {
    const me = boxOfUnit(state, u);
    // a ranged attack made with a hostile creature within 5 ft (that isn't incapacitated) is made at disadvantage
    const pinned = !!info?.ranged && [...state.units.values()].some((x) =>
      x.side !== u.side && x.alive && !x.downed && !isIncapacitated(x) && feetBetweenBoxes(me, boxOfUnit(state, x)) <= 5.001);
    const tb = boxOfUnit(state, target);
    const blockers: Box[] = [];
    let allyAdjacent = false;
    let crowded = false; // some creature other than the target within 5 ft of the attacker (Rakish Audacity)
    for (const x of state.units.values()) {
      if (!x.alive || x.id === u.id || x.id === target.id) continue;
      blockers.push(boxOfUnit(state, x));
      if (feetBetweenBoxes(me, boxOfUnit(state, x)) <= 5.001) crowded = true;
      // Sneak Attack's other prerequisite: an ally of the attacker within
      // 5ft of the target (not incapacitated, i.e. still a threat)
      if (x.side === u.side && !x.downed && !isIncapacitated(x) && feetBetweenBoxes(boxOfUnit(state, x), tb) <= 5.001) allyAdjacent = true;
    }
    const gap = feetBetweenBoxes(me, tb);
    const cover = coverBetween(state.grid, me, tb, blockers);
    return {
      acBonus: coverAcBonus(cover),
      disadvantage: gap > LONG_RANGE_FT || pinned || undefined,
      unreachable: needsMelee && gap > reach + 0.001 ? true : undefined,
      allyAdjacent: allyAdjacent || undefined,
      soloDuel: (gap <= 5.001 && !crowded) || undefined,
    };
  };
}

export { say };
