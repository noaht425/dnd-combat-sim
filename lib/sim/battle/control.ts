// Player control: the battle engine replays a list of recorded decisions and
// pauses (does NOT end) when it reaches a controlled unit with no decision yet.
// The UI reads `awaiting`, collects the player's move + action, appends a
// decision, and re-runs from the seed — so it's all deterministic and "undo
// turn" is just popping the last decision.

import type { AutomationNode } from "../schema";
import { runAction, type RunActionOpts } from "../engine/interpreter";
import { actionAvailable, markEconomy, spend } from "../engine/ai";
import { provokeOpportunityAttacks } from "../engine/reactions";
import { isIncapacitated, livingEnemies, say, type CombatantState } from "../engine/state";
import { footprint } from "./grid";
import {
  BattleState,
  boxOfUnit,
  canFly,
  deriveZones,
  posOf,
  recordFrame,
  speedFt,
  unitReachFt,
} from "./state";
import { attackModsFor } from "./ai";
import {
  boxOf,
  coneCells,
  feetBetweenBoxes,
  lineTemplateCells,
  sphereCells,
  type Box,
} from "./geometry";
import { canOccupy, pathToward, reachable, type MoveContext } from "./movement";

/** run an action and return the play-by-play line(s) it produced, for the frame
 *  text (the mockup's "Dragon breathes fire → Bront FAIL -38, …" event line). */
export function runActionLogged(
  state: BattleState,
  u: CombatantState,
  action: Parameters<typeof runAction>[2],
  opts: RunActionOpts,
  fallback: string,
): string {
  const before = state.log.length;
  runAction(state, u, action, opts);
  const lines = state.log.slice(before).map((l) => l.text).filter(Boolean);
  if (!lines.length) return fallback;
  // `runAction` logs its own headline ("X uses <action> -> …") LAST, after the
  // sub-lines produced mid-resolution (a target dropping to 0, a triggered
  // reaction). Hoist that headline to the front so the frame reads in order:
  // what happened, then its consequences.
  const headRe = new RegExp(`^${escapeRe(u.name)} (?:\\([^)]+\\) )?uses `);
  let headIdx = -1;
  for (let i = lines.length - 1; i > 0; i--) if (headRe.test(lines[i])) { headIdx = i; break; }
  if (headIdx > 0) lines.unshift(lines.splice(headIdx, 1)[0]);
  return lines.join("  ·  ");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface BattleDecision {
  round: number;
  unitId: string;
  /** don't pause — let the AI take this turn (still recorded so replays stay stable) */
  auto?: boolean;
  /** anchor square to move to (the engine paths there, applying opportunity attacks) */
  move?: { x: number; y: number };
  /** which action to take; omit to take no action */
  actionId?: string;
  /** single-target action: the unit to aim at */
  targetId?: string;
  /** AoE action: the square to centre / aim the template at */
  aoeOrigin?: { x: number; y: number };
  /** an optional bonus action to take as well */
  bonusActionId?: string;
  bonusTargetId?: string;
  bonusAoeOrigin?: { x: number; y: number };
}

export interface AwaitAction {
  id: string;
  name: string;
  needsMelee: boolean;
  /** targets an ally / self rather than an enemy (heals, buffs) */
  friendly: boolean;
  aoe?: { shape: string; sizeFt: number };
}

export interface AwaitUnit {
  id: string;
  name: string;
  side: "party" | "monster";
  glyph: string;
  box: Box;
}

export interface AwaitingInput {
  unitId: string;
  unitName: string;
  round: number;
  pos: { x: number; y: number };
  speedFt: number;
  reachFt: number;
  /** "x,y" anchor squares this unit can move to this turn (its current square included) */
  reachable: string[];
  actions: AwaitAction[];
  /** bonus-action options (cost.bonus > 0) available this turn */
  bonusActions: AwaitAction[];
  /** every living combatant + its footprint box, for the panel's range / line-of-sight maths */
  units: AwaitUnit[];
  /** round 1 only: the id of this unit's recommended opener (Rage / Action Surge /
   *  Hunter's Mark / …) if it's available — the UI tags it and it fires first */
  openerId?: string;
}

const isAreaNode = (n: AutomationNode): n is Extract<AutomationNode, { type: "target" }> =>
  n.type === "target" && n.who.who === "area";

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

/** what the UI needs to let the player run `u`'s turn */
export function computeAwaiting(state: BattleState, u: CombatantState): AwaitingInput {
  const p = posOf(state, u.id);
  const ctx: MoveContext = { grid: state.grid, size: u.ref.size, blocked: occupiedByOthers(state, u.id), flying: canFly(u) };
  const flood = reachable(ctx, p.x, p.y, speedFt(u));
  const fp = footprint(u.ref.size);
  const reachableCells = [`${p.x},${p.y}`];
  for (const key of flood.keys()) {
    const [x, y] = key.split(",").map(Number);
    if (canOccupy(ctx, x, y, fp)) reachableCells.push(key);
  }

  const describe = (a: (typeof u.ref.actions)[number]): AwaitAction => {
    const areaNode = a.automation.find(isAreaNode) as Extract<AutomationNode, { type: "target" }> | undefined;
    const aoe =
      areaNode && areaNode.who.who === "area" ? { shape: areaNode.who.shape, sizeFt: areaNode.who.size } : undefined;
    const touchesEnemy = JSON.stringify(a.automation).match(
      /"who":"(aiChoice|nearestEnemy|lowestHpEnemy|squishiestEnemy|marked|eachEnemy|area|chosenEnemies)"/,
    );
    const weaponRoutine = a.id === "attack" || a.id === "multiattack" || /multiattack|attack/i.test(a.name);
    return { id: a.id, name: a.name, needsMelee: weaponRoutine && !u.ref.ai.keepDistance && !aoe, friendly: !touchesEnemy, aoe };
  };
  const actions: AwaitAction[] = [];
  const bonusActions: AwaitAction[] = [];
  for (const a of u.ref.actions) {
    if (!actionAvailable(state, u, a)) continue;
    if ((a.cost.action ?? 0) > 0) actions.push(describe(a));
    else if ((a.cost.bonus ?? 0) > 0) bonusActions.push(describe(a));
  }

  // round-1 opener: the first ai.opener id that's still an available action here
  const openerId =
    state.round === 1
      ? u.ref.ai.opener.find((id) =>
          [...actions, ...bonusActions].some((x) => x.id === id),
        )
      : undefined;

  const units: AwaitUnit[] = [];
  for (const x of state.units.values()) {
    if (!x.alive) continue;
    units.push({
      id: x.id,
      name: x.name,
      side: x.side,
      glyph: state.glyphs.get(x.id) ?? "?",
      box: boxOfUnit(state, x),
    });
  }

  return {
    unitId: u.id,
    unitName: u.name,
    round: state.round,
    pos: { x: p.x, y: p.y },
    speedFt: speedFt(u),
    reachFt: unitReachFt(u),
    reachable: reachableCells,
    actions,
    bonusActions,
    units,
    openerId,
  };
}

/** template cells + hit unit ids for a player-aimed AoE */
function aoeHits(
  state: BattleState,
  from: { x: number; y: number },
  origin: { x: number; y: number },
  shape: string,
  sizeFt: number,
): { cells: string[]; ids: string[] } {
  let cells: Set<string>;
  if (shape === "cone") cells = coneCells(state.grid, from.x, from.y, origin.x, origin.y, sizeFt);
  else if (shape === "line") cells = lineTemplateCells(state.grid, from.x, from.y, origin.x, origin.y, sizeFt);
  else cells = sphereCells(state.grid, origin.x, origin.y, sizeFt);
  const ids: string[] = [];
  for (const x of state.units.values()) {
    if (!x.alive || x.downed) continue;
    const b = boxOfUnit(state, x);
    let hit = false;
    for (let yy = b.y0; yy <= b.y1 && !hit; yy++) for (let xx = b.x0; xx <= b.x1; xx++) if (cells.has(`${xx},${yy}`)) hit = true;
    if (hit) ids.push(x.id);
  }
  return { cells: [...cells], ids };
}

/** Apply a recorded decision for `u`. Returns false when the caller should run
 *  the AI instead (an `auto` decision). */
export function applyDecision(state: BattleState, u: CombatantState, d: BattleDecision): boolean {
  if (d.auto) return false;
  const ctx: MoveContext = { grid: state.grid, size: u.ref.size, blocked: occupiedByOthers(state, u.id), flying: canFly(u) };
  const start = posOf(state, u.id);

  // --- move ---
  if (d.move && (d.move.x !== start.x || d.move.y !== start.y)) {
    const r = pathToward(ctx, start.x, start.y, boxOf(d.move.x, d.move.y, 1), 0, speedFt(u));
    if (r.path.length > 1) {
      const wasMelee = u.zone === "melee";
      if (wasMelee) {
        provokeOpportunityAttacks(state, u);
        if (!u.alive || isIncapacitated(u)) return true;
      }
      const [ex, ey] = r.path[r.path.length - 1];
      state.pos.set(u.id, { x: ex, y: ey });
      deriveZones(state);
      recordFrame(state, { kind: "move", actorId: u.id, text: `${u.name} moves`, path: r.path });
    }
  }
  if (!u.alive || isIncapacitated(u)) return true;

  // run one chosen action (main or bonus) with its target / template forced
  const runOne = (actionId: string | undefined, targetId: string | undefined, aoeOrigin: { x: number; y: number } | undefined): void => {
    if (!actionId) return;
    const action = u.ref.actions.find((a) => a.id === actionId);
    if (!action || !actionAvailable(state, u, action)) return;

    const meleeRoutine =
      !u.ref.ai.keepDistance &&
      !action.automation.some(isAreaNode) &&
      (action.id === "attack" || action.id === "multiattack" || /multiattack|attack/i.test(action.name));
    if (meleeRoutine && targetId) {
      const t = state.units.get(targetId);
      if (t && feetBetweenBoxes(boxOfUnit(state, u), boxOfUnit(state, t)) > unitReachFt(u) + 0.001) {
        say(state, `${u.name} can't reach ${t.name} — the attack is wasted`, u.id);
        spend(u, action);
        markEconomy(u, action);
        recordFrame(state, { kind: "action", actorId: u.id, text: `${u.name} — ${action.name} (out of reach)` });
        return;
      }
    }

    const areaNode = action.automation.find(isAreaNode) as Extract<AutomationNode, { type: "target" }> | undefined;
    let templateCells: string[] | undefined;
    let templateHitIds: string[] | undefined;
    if (areaNode && areaNode.who.who === "area" && aoeOrigin) {
      const here = posOf(state, u.id);
      const t = aoeHits(state, here, aoeOrigin, areaNode.who.shape, areaNode.who.size);
      templateCells = t.cells;
      templateHitIds = t.ids;
    }

    const geo: NonNullable<RunActionOpts["geo"]> = {
      geoTargets: (node, source) => {
        const who = node.who.who;
        if (who === "self" || who === "eachAlly" || who === "lowestHpAlly" || who === "chosenEnemies") return null;
        if (who === "area" || who === "eachEnemy") {
          if (templateHitIds && templateHitIds.length) {
            return templateHitIds
              .map((id) => state.units.get(id))
              .filter((x): x is CombatantState => !!x && x.alive && x.side !== source.side);
          }
          return livingEnemies(state, source);
        }
        if (targetId) {
          const tt = state.units.get(targetId);
          if (tt && tt.alive && !tt.downed && tt.side !== source.side) return [tt];
        }
        const foes = livingEnemies(state, source);
        const me = boxOfUnit(state, source);
        return foes.length
          ? [[...foes].sort((a, b) => feetBetweenBoxes(me, boxOfUnit(state, a)) - feetBetweenBoxes(me, boxOfUnit(state, b)))[0]]
          : [];
      },
      attackMods: attackModsFor(state, u),
    };

    spend(u, action);
    markEconomy(u, action);
    const text = runActionLogged(state, u, action, { geo }, `${u.name} uses ${action.name}`);
    recordFrame(state, {
      kind: "action",
      actorId: u.id,
      text,
      targetIds: templateHitIds ?? (targetId ? [targetId] : undefined),
      templateCells,
    });
  };

  if (!d.actionId && !d.bonusActionId) {
    say(state, `${u.name} holds`, u.id);
    return true;
  }
  // an opener / self-buff bonus (Rage, Divine Favor, Hunter's Mark, Action
  // Surge) has to land BEFORE the main action to matter; anything else (Healing
  // Word, an off-hand swing) goes after the main action as usual
  const bonusFirst = !!d.bonusActionId && u.ref.ai.opener.includes(d.bonusActionId);
  if (bonusFirst) runOne(d.bonusActionId, d.bonusTargetId, d.bonusAoeOrigin);
  runOne(d.actionId, d.targetId, d.aoeOrigin);
  if (!bonusFirst && u.alive && !isIncapacitated(u)) runOne(d.bonusActionId, d.bonusTargetId, d.bonusAoeOrigin);
  return true;
}

export { say };
