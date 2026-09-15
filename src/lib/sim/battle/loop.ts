// The battle-mode round loop. Same skeleton as engine/loop.ts — initiative,
// per-turn economy, start/end-of-turn ticks, legendary + lair timing, death
// saves, end check — but with a movement phase and geometry-aware action
// resolution, and it records a frame after every step.

import { abilityMod } from "../math";
import {
  actionAvailable,
  markEconomy,
  pick,
  spend,
  takeLairAction,
  takeLegendaryActions,
} from "../engine/ai";
import { chooseFocusTarget } from "../engine/score";
import {
  checkEnd,
  endOfTurn,
  rollDeathSave,
  startOfTurn,
} from "../engine/loop";
import { applyDamage, rollSave } from "../engine/resolve";
import {
  initCombatant,
  isIncapacitated,
  livingEnemies,
  say,
  startTurnEconomy,
  type CombatantState,
} from "../engine/state";
import { resolveEnemies } from "../engine/scenario";
import { TERRAIN_GLYPH, blocksMove, footprint, inBounds, terrainAt } from "./grid";
import { actionMakesAttacks, attackModsFor, geoTargetsFor, planTurn, reposition } from "./ai";
import { applyDecision, computeAwaiting, runActionLogged } from "./control";
import { BattleState, ReactionPause, canFly, deriveZones, nearestEnemyFt, recordFrame, unitReachFt } from "./state";

const monsterGlyph = (i: number): string => (i < 9 ? String(i + 1) : String.fromCharCode(97 + (i - 9)));

/** first free anchor square for a footprint-`fp` creature along the given edge */
function edgeAnchor(state: BattleState, fp: number, edge: string, occ: Set<string>): { x: number; y: number } | null {
  const { width: w, height: h } = state.grid;
  const fits = (x: number, y: number): boolean => {
    for (let dy = 0; dy < fp; dy++)
      for (let dx = 0; dx < fp; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        if (!inBounds(state.grid, cx, cy) || blocksMove(terrainAt(state.grid, cx, cy)) || occ.has(`${cx},${cy}`)) return false;
      }
    return true;
  };
  const lanes = edge === "top" || edge === "bottom" ? w : h;
  const cx = Math.floor(lanes / 2);
  const order: number[] = [];
  for (let d = 0; d < lanes; d++) {
    order.push(cx + d);
    if (d) order.push(cx - d);
  }
  const depth = edge === "top" || edge === "bottom" ? h : w;
  for (let layer = 0; layer < depth; layer++) {
    for (const p of order) {
      const x = edge === "left" ? layer : edge === "right" ? w - 1 - layer - (fp - 1) : p;
      const y = edge === "top" ? layer : edge === "bottom" ? h - 1 - layer - (fp - 1) : p;
      if (fits(x, y)) return { x, y };
    }
  }
  return null;
}

function spawnWaves(state: BattleState): void {
  if (!state.waves) return;
  const occ = new Set<string>();
  for (const u of state.units.values()) {
    if (!u.alive) continue;
    const p = state.pos.get(u.id);
    if (!p) continue;
    const fp = footprint(u.ref.size);
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.add(`${p.x + dx},${p.y + dy}`);
  }
  let mi = [...state.units.values()].filter((u) => u.side === "monster").length;

  for (let wi = 0; wi < state.waves.length; wi++) {
    const wave = state.waves[wi];
    if (wave.round !== state.round || state.spawnedWaves.has(wi)) continue;
    state.spawnedWaves.add(wi);
    const mons = resolveEnemies(wave.enemies, state.summonRegistry);
    const names: string[] = [];
    for (const ref of mons) {
      const ms = initCombatant(ref, "monster", `~w${wi}.${names.length}`);
      ms.name = ref.name; // resolveEnemies already numbered duplicates
      const a = edgeAnchor(state, footprint(ref.size), wave.edge, occ);
      if (!a) continue;
      const fp = footprint(ref.size);
      for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.add(`${a.x + dx},${a.y + dy}`);
      state.units.set(ms.id, ms);
      state.order.push(ms.id);
      state.pos.set(ms.id, a);
      state.glyphs.set(ms.id, monsterGlyph(mi++));
      names.push(ms.name);
    }
    if (names.length) {
      deriveZones(state);
      recordFrame(state, { kind: "reinforce", text: `Reinforcements arrive from the ${wave.edge}: ${names.join(", ")}` });
    }
  }
}

function rollInitiative(state: BattleState): void {
  for (const u of state.units.values()) {
    if (u.ref.specialRules.some((r) => r.rule === "ambush")) u.assassinateUntilRound = 1;
  }
  const order = [...state.units.values()]
    .map((u) => ({
      id: u.id,
      init:
        state.rng.d20() +
        (u.ref.initiativeBonus ?? abilityMod(u.ref.abilities.dex)) +
        (u.assassinateUntilRound ? 100 : 0),
      side: u.side,
    }))
    .sort((a, b) => b.init - a.init || (a.side === "monster" ? -1 : 1))
    .map((x) => x.id);
  state.order = order;
  say(state, `Initiative: ${order.map((id) => state.units.get(id)!.name).join(" > ")}`);
}

function terrainString(state: BattleState): string {
  let s = "";
  for (let y = 0; y < state.grid.height; y++) {
    for (let x = 0; x < state.grid.width; x++) s += TERRAIN_GLYPH[terrainAt(state.grid, x, y)];
  }
  return s;
}

/** damage for standing in a hazard square at the start of your turn */
function hazardTick(state: BattleState, u: CombatantState): void {
  if (!u.alive || u.downed || canFly(u)) return; // a flyer hovers over ground hazards
  const p = state.pos.get(u.id);
  if (!p) return;
  const fp = footprint(u.ref.size);
  let inHazard = false;
  for (let dy = 0; dy < fp && !inHazard; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      if (terrainAt(state.grid, p.x + dx, p.y + dy) === "hazard") {
        inHazard = true;
        break;
      }
    }
  }
  if (!inHazard) return;
  const hz = state.grid.hazard;
  if (hz.when === "enter") return;
  let amt = rollDice(state, hz.amount);
  if (hz.save) {
    const sr = rollSave(state, u, hz.save.ability, hz.save.dc, { magical: false, stakes: "damage" });
    if (sr.passed) amt = Math.floor(amt / 2);
  }
  const dealt = applyDamage(state, u, amt, hz.damageType as never, { sourceId: u.id });
  if (dealt > 0) say(state, `${u.name} takes ${dealt} ${hz.damageType} from the hazard`, u.id);
}

function rollDice(state: BattleState, s: string): number {
  const m = /^(\d+)d(\d+)$/.exec(s.replace(/\s/g, ""));
  if (!m) return Number(s) || 0;
  return state.rng.dice(Number(m[1]), Number(m[2]));
}

function charmParalysed(state: BattleState, u: CombatantState): boolean {
  const c = u.conditions.get("charmed");
  if (!c) return false;
  const foes = livingEnemies(state, u);
  return foes.length > 0 && foes.every((f) => f.id === c.sourceId);
}

function takeBattleTurn(state: BattleState, u: CombatantState): void {
  if (!livingEnemies(state, u).length) return;
  if (charmParalysed(state, u)) {
    say(state, `${u.name} is charmed and won't act`, u.id);
    return;
  }

  // recharge rolls (mirror engine/ai.ts)
  for (const a of u.ref.actions) {
    if (a.recharge.startsWith("roll:") && a.limitedUse) {
      const res = a.limitedUse.resource;
      if ((u.resources.get(res) ?? 0) <= 0) {
        const need = a.recharge === "roll:5-6" ? 5 : a.recharge === "roll:4-6" ? 4 : 6;
        if (state.rng.int(1, 6) >= need) u.resources.set(res, a.limitedUse.amount);
      }
    }
  }

  // player control: replay a recorded decision, or pause for one
  if (state.controlled?.has(u.id)) {
    const d = state.decisions?.find((x) => x.round === state.round && x.unitId === u.id);
    if (!d) {
      state.awaiting = computeAwaiting(state, u);
      state.pausedForInput = true;
      return;
    }
    if (!d.auto) {
      applyDecision(state, u, d);
      return;
    }
    // d.auto -> fall through to the AI
  }

  const plan = planTurn(state, u);
  const moved = reposition(state, u, plan);
  if (!u.alive || isIncapacitated(u)) return;
  deriveZones(state);

  // the interpreter's attackMods seam also whiffs any melee swing from beyond reach
  const geo = { geoTargets: geoTargetsFor(state, u, plan), attackMods: attackModsFor(state, u, plan.needsMelee) };

  // a melee routine that ended the move still short of every enemy is a failed
  // approach — don't run the doomed action at all (mirrors applyDecision's guard)
  const meleeOutOfReach = plan.needsMelee && nearestEnemyFt(state, u) > unitReachFt(u) + 0.001;

  // round-1 opener (Action Surge, Hunter's Mark, Frightful Presence, …) — skip an
  // opener that swings if we can't reach; self-buffs (Rage, Bless) still fire
  if (state.round === 1 && u.ref.ai.opener.length) {
    const opener = pick(state, u, u.ref.ai.opener);
    if (opener && !(meleeOutOfReach && actionMakesAttacks(u, opener))) {
      spend(u, opener);
      markEconomy(u, opener);
      const text = runActionLogged(state, u, opener, { geo }, `${u.name} uses ${opener.name}`);
      recordFrame(state, {
        kind: "action",
        actorId: u.id,
        text,
        targetIds: plan.targetId ? [plan.targetId] : undefined,
      });
      if (opener.cost.action) return;
    }
  }
  if (u.actionUsedThisTurn) return;
  // the opener may have finished the fight (or killed the only target in range)
  if (state.ended || !livingEnemies(state, u).length) return;

  if (meleeOutOfReach) {
    // if it spent the turn moving, the "move" frame already tells the story;
    // only note it when the unit is genuinely stuck (no path, boxed in)
    if (!moved) {
      say(state, `${u.name} can't reach anyone and holds`, u.id);
      recordFrame(state, { kind: "action", actorId: u.id, text: `${u.name} can't reach anyone and holds` });
    }
    return;
  }

  let action = plan.action;
  if (action && !actionAvailable(state, u, action)) {
    action = u.ref.actions.find((a) => a.id === "attack" && actionAvailable(state, u, a));
  }
  if (!action) return;

  spend(u, action);
  markEconomy(u, action);
  const text = runActionLogged(state, u, action, { geo }, `${u.name} uses ${action.name}`);
  recordFrame(state, {
    kind: "action",
    actorId: u.id,
    text,
    targetIds: plan.templateHitIds ?? (plan.targetId ? [plan.targetId] : undefined),
    templateCells: plan.templateCells,
  });
}

function partyHpFraction(state: BattleState): number {
  let cur = 0;
  let max = 0;
  for (const u of state.units.values()) if (u.side === "party") {
    cur += Math.max(0, u.hp);
    max += u.maxHp;
  }
  return max ? cur / max : 0;
}
function monsterHpFraction(state: BattleState): number {
  let cur = 0;
  let max = 0;
  for (const u of state.units.values()) if (u.side === "monster" && u.summonerId === undefined) {
    cur += Math.max(0, u.hp);
    max += u.maxHp;
  }
  return max ? cur / max : 0;
}

export function runBattleLoop(state: BattleState): void {
  rollInitiative(state);
  deriveZones(state);
  recordFrame(state, {
    kind: "start",
    text: "The battle begins",
    terrain: { width: state.grid.width, height: state.grid.height, tiles: terrainString(state) },
  });

  try {
   while (!state.ended && !state.pausedForInput && state.round < state.maxRounds) {
    state.round++;
    spawnWaves(state);
    for (const u of state.units.values()) {
      const precog = u.ref.specialRules.find((r) => r.rule === "d20Replacement");
      if (precog && precog.rule === "d20Replacement") u.d20SwapsLeft = precog.perRound;
    }
    state.focusId = chooseFocusTarget(state, "party");
    state.monsterFocusId = chooseFocusTarget(state, "monster");

    for (const u of state.units.values()) {
      if (u.side === "monster" && u.alive && u.ref.lairActions) {
        takeLairAction(state, u);
        recordFrame(state, { kind: "lair", actorId: u.id, text: `${u.name} — lair action` });
      }
    }
    checkEnd(state);
    if (state.ended) break;

    for (const id of state.order) {
      const u = state.units.get(id);
      if (!u || !u.alive || state.ended) continue;
      if (u.downed) {
        rollDeathSave(state, u);
        recordFrame(state, { kind: "turn", actorId: u.id, text: `${u.name} — death save` });
        continue;
      }
      startTurnEconomy(u);
      startOfTurn(state, u);
      if (state.ended) break;
      deriveZones(state);
      hazardTick(state, u);
      if (!u.alive) {
        recordFrame(state, { kind: "turn", actorId: u.id });
        checkEnd(state);
        if (state.ended) break;
        continue;
      }

      if (isIncapacitated(u)) {
        say(state, `${u.name} loses its turn`, u.id);
        recordFrame(state, { kind: "turn", actorId: u.id, text: `${u.name} can't act` });
      } else {
        if (u.side === "monster") u.legendaryBudget = u.legendaryMax;
        takeBattleTurn(state, u);
        if (state.pausedForInput) return; // wait for the player before ending this turn
        recordFrame(state, { kind: "turn", actorId: u.id, text: `${u.name} ends its turn` });
      }

      endOfTurn(state, u);
      checkEnd(state);
      if (state.ended) break;

      if (u.side === "party") {
        for (const m of state.units.values()) {
          if (m.side === "monster" && m.alive) {
            const before = state.log.length;
            takeLegendaryActions(state, m);
            const added = state.log.slice(before).map((l) => l.text).filter(Boolean);
            if (added.length) {
              recordFrame(state, { kind: "legendary", actorId: m.id, text: added.join("  ·  ") });
            }
          }
        }
        checkEnd(state);
        if (state.ended) break;
      }
    }
   }
  } catch (e) {
    // a controlled unit hit a reaction decision point mid-resolution; state
    // already carries awaitingReaction + pausedForInput, so just unwind.
    if (e instanceof ReactionPause) return;
    throw e;
  }

  if (state.pausedForInput) return; // stopped mid-round for player input, not over

  if (!state.ended) {
    state.ended = true;
    state.winner = partyHpFraction(state) >= monsterHpFraction(state) ? "party" : "monster";
  }
  recordFrame(state, { kind: "end", text: `${state.winner ?? "draw"} wins after ${state.round} rounds` });
}
