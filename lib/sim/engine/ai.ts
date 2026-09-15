// Phase 3 heuristic AI. Both sides score their options with `scoreAction` and
// take the best one; the party gangs up on a shared focus target; casters open
// with control, then blast; the boss uses control on the biggest threat and
// saves its 1/day powers unless they clearly swing the fight.

import type { Action, Combatant } from "../schema";
import { runAction, actionBranchGateFails } from "./interpreter";
import { scoreAction, estimatedThreat } from "./score";
import { provokeOpportunityAttacks } from "./reactions";
import {
  CombatantState,
  CombatState,
  applyHealing,
  hasCondition,
  isIncapacitated,
  livingAllies,
  livingEnemies,
  say,
} from "./state";

/** charmed: can't attack the charmer or target it with harmful effects. In a
 * solo fight the charmer is the whole enemy side, so the turn is a wash. */
function charmParalysed(state: CombatState, u: CombatantState): boolean {
  if (!hasCondition(u, "charmed")) return false;
  const charmerId = u.conditions.get("charmed")?.sourceId;
  const foes = livingEnemies(state, u);
  return foes.length > 0 && foes.every((f) => f.id === charmerId);
}
import { partyHealingPerRound } from "./party-build";

/** a spell that costs a slot (not a cantrip, not a reaction spell) */
function isLeveledSpell(a: Action): boolean {
  return a.isSpell === true && !!a.limitedUse && ((a.cost.action ?? 0) > 0 || (a.cost.bonus ?? 0) > 0);
}

/** mark a combatant's per-turn action economy after it takes `a` */
export function markEconomy(u: CombatantState, a: Action): void {
  if ((a.cost.action ?? 0) > 0) u.actionUsedThisTurn = true;
  if ((a.cost.bonus ?? 0) > 0) u.bonusUsedThisTurn = true;
  if (isLeveledSpell(a)) u.leveledSpellThisTurn = true;
}

export function actionAvailable(state: CombatState, u: CombatantState, a: Action): boolean {
  if (a.limitedUse && (u.resources.get(a.limitedUse.resource) ?? 0) < a.limitedUse.amount) return false;
  if (a.recharge.startsWith("roll:")) {
    const res = a.limitedUse?.resource;
    if (res && (u.resources.get(res) ?? 0) <= 0) return false;
  }
  // action economy: one action + one bonus action per turn; after casting a
  // leveled spell you may only cast a cantrip (bonus-action-spell rule, RAW)
  if ((a.cost.action ?? 0) > 0 && u.actionUsedThisTurn) return false;
  if ((a.cost.bonus ?? 0) > 0 && u.bonusUsedThisTurn) return false;
  if (isLeveledSpell(a) && u.leveledSpellThisTurn) return false;
  // usage gate: e.g. an execute that only works on a grappled / incapacitated foe
  if (a.usableWhen?.enemyHasCondition) {
    const conds = a.usableWhen.enemyHasCondition;
    const anyFoe = [...state.units.values()].some(
      (x) => x.side !== u.side && x.alive && !x.downed && conds.some((c) => x.conditions.has(c)),
    );
    if (!anyFoe) return false;
  }
  // a conditionally-gated action (e.g. "if it sang since its last turn -> raise its minions")
  if (actionBranchGateFails(state, u, a)) return false;
  return true;
}

export function spend(u: CombatantState, a: Action): void {
  if (a.limitedUse) {
    const cur = u.resources.get(a.limitedUse.resource) ?? 0;
    u.resources.set(a.limitedUse.resource, cur - a.limitedUse.amount);
  }
}

export function pick(state: CombatState, u: CombatantState, ids: string[]): Action | undefined {
  for (const id of ids) {
    const a = u.ref.actions.find((x) => x.id === id);
    if (a && actionAvailable(state, u, a)) return a;
  }
  return undefined;
}

/** the action-cost actions this combatant could take right now (excludes sub-attacks) */
function candidateActions(state: CombatState, u: CombatantState): Action[] {
  return u.ref.actions.filter((a) => (a.cost.action ?? 0) > 0 && actionAvailable(state, u, a));
}

export function chooseBest(state: CombatState, u: CombatantState): Action | undefined {
  const cands = candidateActions(state, u);
  if (!cands.length) return undefined;
  let best: Action | undefined;
  let bestScore = -Infinity;
  for (const a of cands) {
    let s = scoreAction(state, u, a).score;
    // an AoE that catches fewer than its owner wants is worth less
    // a purely-AoE action that catches fewer than its owner wants is worth less
    // (still fine on one big target — Fireball on a boss is real damage)
    const nodes = a.automation;
    const isAoe = nodes.some((n) => n.type === "target" && (n.who.who === "area" || n.who.who === "eachEnemy"));
    const hasSingle = nodes.some((n) => n.type === "target" && (n.who.who === "aiChoice" || n.who.who === "nearestEnemy" || n.who.who === "lowestHpEnemy" || n.who.who === "squishiestEnemy"));
    if (isAoe && !hasSingle && livingEnemies(state, u).length < u.ref.ai.aoeMinTargets) s *= 0.6;
    // slight bias toward Multiattack so a boss doesn't dither
    if (a.id === "multiattack" || /multiattack/i.test(a.name)) s += 4;
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best;
}

// --------------------------------------------------------------- monster turn

/** a monster that can blink away (cheap teleport) never provokes when it repositions */
function hasCheapTeleport(u: CombatantState): boolean {
  return u.ref.actions.some((a) =>
    (a.cost.legendary ?? 0) <= 1 &&
    a.automation.some((n) => n.type === "move" && (n.kind === "teleportSelf" || n.kind === "teleportSelfToMarked")),
  );
}

export function takeMonsterTurn(state: CombatState, u: CombatantState): void {
  if (isIncapacitated(u)) return;
  if (!livingEnemies(state, u).length) return;
  if (charmParalysed(state, u)) { say(state, `${u.name} is charmed and won't act`, u.id); return; }

  // a ranged-primary monster that got dragged into melee peels off to its
  // preferred range — provoking from whoever it was toe-to-toe with. Once: after
  // that it's established at range and chasing it is a wash in a zoneless model.
  if (u.ref.ai.keepDistance && u.meleeHitSinceMyTurn && !hasCheapTeleport(u) && !u.onceFired.has("withdrew")) {
    u.onceFired.add("withdrew");
    say(state, `${u.name} peels back to range`, u.id);
    provokeOpportunityAttacks(state, u);
  }
  u.meleeHitSinceMyTurn = false;
  if (!u.alive || isIncapacitated(u)) return; // an OA could have dropped or stunned it

  // recharge rolls at the start of the turn
  for (const a of u.ref.actions) {
    if (a.recharge.startsWith("roll:") && a.limitedUse) {
      const res = a.limitedUse.resource;
      if ((u.resources.get(res) ?? 0) <= 0) {
        const need = a.recharge === "roll:5-6" ? 5 : a.recharge === "roll:4-6" ? 4 : 6;
        if (state.rng.int(1, 6) >= need) u.resources.set(res, a.limitedUse.amount);
      }
    }
  }

  // round-1 opener (Frightful Presence, a mark-a-foe opener, ...)
  if (state.round === 1 && u.ref.ai.opener.length) {
    const opener = pick(state, u, u.ref.ai.opener);
    if (opener) {
      spend(u, opener);
      markEconomy(u, opener);
      runAction(state, u, opener);
      if (opener.cost.action) return; // a bonus-action opener still leaves the main action
    }
  }

  const best = chooseBest(state, u);
  if (best) {
    spend(u, best);
    markEconomy(u, best);
    runAction(state, u, best);
  }
}

function dealsDamage(u: CombatantState, id: string): boolean {
  const a = u.ref.actions.find((x) => x.id === id);
  if (!a) return false;
  const blob = JSON.stringify(a.automation);
  return blob.includes('"damage"') || blob.includes('"attack"') || blob.includes('"useAction"');
}

export function takeLegendaryActions(state: CombatState, u: CombatantState): void {
  if (!u.ref.legendaryActions || isIncapacitated(u) || !u.alive) return;
  let guard = 6;
  while (u.legendaryBudget > 0 && guard-- > 0) {
    const affordable = u.ref.legendaryActions.options.filter((o) => {
      if (o.cost > u.legendaryBudget) return false;
      const act = u.ref.actions.find((x) => x.id === o.action);
      return act ? actionAvailable(state, u, act) : false;
    });
    if (!affordable.length) break;
    // score each option / cost; fall back to anything damaging, then anything at all
    let bestO = affordable[0];
    let bestV = -Infinity;
    for (const o of affordable) {
      const act = u.ref.actions.find((x) => x.id === o.action);
      if (!act) continue;
      const v = (scoreAction(state, u, act).score + (dealsDamage(u, o.action) ? 2 : -6)) / o.cost;
      if (v > bestV) { bestV = v; bestO = o; }
    }
    const act = u.ref.actions.find((x) => x.id === bestO.action);
    if (!act) break;
    u.legendaryBudget -= bestO.cost;
    runAction(state, u, act, { asLegendary: true });
  }
}

export function takeLairAction(state: CombatState, u: CombatantState): void {
  if (!u.ref.lairActions || !u.alive || isIncapacitated(u)) return;
  const ok = u.ref.lairActions.options.filter((o) => {
    const act = u.ref.actions.find((x) => x.id === o.action);
    return act ? actionAvailable(state, u, act) : false;
  });
  const opts = ok.filter((o) => o.action !== u.lastLairActionId);
  const pool = opts.length ? opts : ok.length ? ok : u.ref.lairActions.options;
  let bestO = pool[0];
  let bestV = -Infinity;
  for (const o of pool) {
    const act = u.ref.actions.find((x) => x.id === o.action);
    const v = act ? scoreAction(state, u, act).score : 0;
    if (v > bestV) { bestV = v; bestO = o; }
  }
  const act = u.ref.actions.find((x) => x.id === bestO.action);
  if (!act) return;
  u.lastLairActionId = bestO.action;
  runAction(state, u, act);
}

// ------------------------------------------------------------------- pc turn

// A real party doesn't play like a solver — someone repositions, double-buffs,
// hesitates, picks the wrong target, or holds an action. This is the templated
// party's equivalent of the generic party's SOLO_BOSS_DISRUPTION haircut: a
// per-turn chance the PC's turn is spent on something less than optimal.
export const PARTY_FRICTION = 0.1;

export function takePcTurn(state: CombatState, u: CombatantState, level: number): void {
  if (isIncapacitated(u)) return;
  if (!livingEnemies(state, u).length) return;
  if (charmParalysed(state, u)) { say(state, `${u.name} is charmed and won't act`, u.id); return; }

  // imperfect play (templated party only; the generic party's haircut is baked in):
  // a per-turn chance the PC repositions / hesitates / Dodges instead of acting
  if (u.ref.templateId && state.rng.next() < PARTY_FRICTION) {
    u.effects = u.effects.filter((e) => e.name !== "dodging");
    u.effects.push({ name: "dodging", mods: { attacksAgainstItAdvantage: "dis" }, expiresRound: state.round + 1, sourceId: u.id });
    say(state, `${u.name} holds and repositions`, u.id);
    return;
  }

  // healer routine — Healing Word is a *bonus* action, Revivify an *action*.
  if (u.ref.actions.some((a) => a.id === "party-heal")) {
    const downed = [...state.units.values()]
      .filter((x) => x.side === "party" && x.downed && x.alive)
      .filter((x) => x.lastRevivedRound === undefined || state.round - x.lastRevivedRound > 1)
      .sort((a, b) => estimatedThreat(b) - estimatedThreat(a))[0];
    if (downed && !u.actionUsedThisTurn) {
      // Revivify / Mass Healing Word — costs the healer's ACTION (and a slot)
      const buffer = Math.round(partyHealingPerRound(level) * 0.7);
      downed.downed = false;
      downed.stable = false;
      downed.hp = Math.max(1, Math.round(downed.maxHp / 3));
      downed.tempHp = Math.max(downed.tempHp, buffer);
      downed.deathSaves = { success: 0, fail: 0 };
      downed.lastRevivedRound = state.round;
      u.actionUsedThisTurn = true;
      u.leveledSpellThisTurn = true;
      say(state, `${u.name} revives ${downed.name} (+${buffer} temp)`, u.id);
      // may still Healing-Word a second ally as a bonus, below
    }
    if (!u.bonusUsedThisTurn && !u.leveledSpellThisTurn) {
      const hurt = livingAllies(state, u)
        .filter((a) => !a.effects.some((e) => e.mods?.cannotHeal) && a.id !== u.id)
        .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      // only Healing-Word someone genuinely in danger — this consumes the bonus
      // action AND (RAW) means the main action can only be a cantrip
      if (hurt && hurt.hp < hurt.maxHp * 0.35) {
        const done = applyHealing(state, hurt, partyHealingPerRound(level));
        if (done > 0) {
          u.bonusUsedThisTurn = true;
          u.leveledSpellThisTurn = true;
          say(state, `${u.name} heals ${hurt.name} for ${done}`, u.id);
        }
      }
    }
    // fall through to the main action
  }

  // round-1 bonus-action opener (Action Surge, Hunter's Mark) — main action still follows
  if (state.round === 1) {
    const opener = pick(state, u, u.ref.ai.opener);
    if (opener && !opener.cost.action && !u.bonusUsedThisTurn) {
      spend(u, opener);
      markEconomy(u, opener);
      runAction(state, u, opener);
    } else if (opener && opener.cost.action && !u.actionUsedThisTurn) {
      spend(u, opener);
      markEconomy(u, opener);
      runAction(state, u, opener);
      return;
    }
  }

  // any-round bonus-action spell (Hex, a smite, Ensnaring Strike, ...) — the round-1
  // opener above is a curated list; this scores whatever's left every turn so a
  // one-shot smite gets re-tagged before each swing, not just round 1. Skipped while
  // already concentrating on something, so it never opportunistically clobbers a
  // more valuable ongoing spell (Spirit Guardians, Moonbeam, ...) for a lesser one.
  if (!u.bonusUsedThisTurn) {
    const bonusSpells = u.ref.actions.filter(
      (a) => (a.cost.bonus ?? 0) > 0 && a.isSpell && !(a.concentration && u.concentratingOn) && actionAvailable(state, u, a),
    );
    let bestBonus: Action | undefined;
    let bestBonusScore = 0; // require real positive value — never force a wasted cast
    for (const a of bonusSpells) {
      const s = scoreAction(state, u, a).score;
      if (s > bestBonusScore) { bestBonusScore = s; bestBonus = a; }
    }
    if (bestBonus) {
      spend(u, bestBonus);
      markEconomy(u, bestBonus);
      runAction(state, u, bestBonus);
    }
  }

  if (u.actionUsedThisTurn) return; // action already spent (revive / action opener)
  const best = chooseBest(state, u) ?? u.ref.actions.find((a) => a.id === "attack" && actionAvailable(state, u, a));
  if (best) {
    spend(u, best);
    markEconomy(u, best);
    runAction(state, u, best);
  }
}

export function isGenericPc(c: Combatant): boolean {
  return c.id.startsWith("pc-");
}
