// Heuristics the AI uses to choose actions and targets. Everything here is a
// cheap expected-value estimate against the *current* board — no dice rolled.

import type { Ability, Action, AutomationNode, Condition } from "../schema";
import { avgDice, hitChance, saveFailChance } from "../math";
import { effectiveAc, isIncapacitated, type CombatState, type CombatantState } from "./state";
import { saveModifierOf } from "./resolve";

const CONTROL_WEIGHT: Partial<Record<Condition, number>> = {
  stunned: 40, paralyzed: 45, incapacitated: 38, unconscious: 45, petrified: 50,
  restrained: 18, charmed: 30, frightened: 10, prone: 6, transfixed: 30,
  "marked-for-reckoning": 12, blinded: 12, poisoned: 6, concussed: 8, doomed: 14, grappled: 8, deafened: 2, exhaustion: 15,
};

const saveBonusGuess = (t: CombatantState, ability: Ability): number => saveModifierOf(t, ability);

/** a combatant that keeps the rest of its side alive (drives smart-target on it) */
export function isHealer(u: CombatantState): boolean {
  return u.ref.actions.some((a) => a.id === "party-heal") ||
    u.ref.traits.some((t) => t.id === "party-heal") ||
    u.ref.actions.filter((a) => /heal|cure|revivif|prayer|regenerat/i.test(a.name)).length >= 3;
}

/** rough sustained damage this combatant threatens — used to rank targets */
export function estimatedThreat(u: CombatantState): number {
  if (isIncapacitated(u)) return 0;
  const main = u.ref.actions.find((a) => a.id === "multiattack" || a.id === "attack" || /multiattack/i.test(a.name));
  let dmg = main ? 0 : u.maxHp * 0.05;
  if (main) {
    walk(main.automation, u.ref.actions, (n) => {
      if (n.type === "attack") dmg += 0.55 * subtreeAvg(n.onHit);
      if (n.type === "damage") dmg += (avgDice(n.amount) ?? 0) * (n.half ? 0.5 : 1);
      if (n.type === "save") dmg += 0.6 * subtreeAvg(n.onFail);
    });
  }
  // a healer is worth removing even though its own damage is low — undoing the
  // party's losses each round is effectively a big chunk of sustained "threat"
  if (isHealer(u)) dmg += u.maxHp * 0.3;
  // low-HP casters/strikers still matter; scale by a "still alive" factor
  return dmg * (u.hp / u.maxHp > 0.15 ? 1 : 0.6);
}

function subtreeAvg(nodes: AutomationNode[]): number {
  let d = 0;
  for (const n of nodes) {
    if (n.type === "damage") d += (avgDice(n.amount) ?? 0) * (n.half ? 0.5 : 1);
    else if (n.type === "save") d += 0.6 * subtreeAvg(n.onFail);
    else if (n.type === "branch") d += 0.5 * subtreeAvg(n.then);
  }
  return d;
}

function walk(nodes: AutomationNode[], actions: Action[], visit: (n: AutomationNode) => void, depth = 0): void {
  if (depth > 8) return;
  for (const n of nodes) {
    visit(n);
    switch (n.type) {
      case "target": walk(n.effects, actions, visit, depth + 1); break;
      case "attack": walk(n.onHit, actions, visit, depth + 1); walk(n.onMiss ?? [], actions, visit, depth + 1); break;
      case "save": walk(n.onFail, actions, visit, depth + 1); walk(n.onSuccess ?? [], actions, visit, depth + 1); break;
      case "branch": walk(n.then, actions, visit, depth + 1); walk(n.else ?? [], actions, visit, depth + 1); break;
      case "useAction": {
        const sub = actions.find((a) => a.id === n.action);
        if (sub) for (let i = 0; i < (n.times ?? 1); i++) walk(sub.automation, actions, visit, depth + 1);
        break;
      }
    }
  }
}

/** the enemy `side` should gang up on: lowest effective HP, tie-break by threat */
export function chooseFocusTarget(state: CombatState, side: "party" | "monster"): string | undefined {
  const foes = [...state.units.values()].filter((u) => u.side !== side && u.alive && !u.downed);
  if (!foes.length) return undefined;
  foes.sort((a, b) => (a.hp - b.hp) || (estimatedThreat(b) - estimatedThreat(a)));
  // if someone is nearly dead, finish them; else hit the biggest threat that's already hurt
  const almostDead = foes.find((f) => f.hp <= f.maxHp * 0.2);
  if (almostDead) return almostDead.id;
  const byThreat = [...foes].sort((a, b) => estimatedThreat(b) - estimatedThreat(a));
  return byThreat[0].id;
}

interface ActionValue {
  score: number;
  damage: number;
  control: number;
  heal: number;
}

/** cheap expected value of running `action` from `actor` on the current board */
export function scoreAction(state: CombatState, actor: CombatantState, action: Action): ActionValue {
  const enemies = [...state.units.values()].filter((u) => u.side !== actor.side && u.alive && !u.downed);
  const allies = [...state.units.values()].filter((u) => u.side === actor.side && u.alive);
  if (!enemies.length) return { score: 0, damage: 0, control: 0, heal: 0 };

  const focusId = actor.side === "monster"
    ? state.monsterFocusId ?? chooseFocusTarget(state, "monster")
    : state.focusId;
  const focus = state.units.get(focusId ?? enemies[0].id) ?? enemies[0];
  const incoming = enemies.reduce((s, e) => s + estimatedThreat(e), 0); // sustained enemy damage/round

  let damage = 0;
  let control = 0;
  let heal = 0;

  const forEachTarget = (who: string, upTo: number, cb: (t: CombatantState) => void) => {
    if (who === "self") return cb(actor);
    if (who === "eachAlly") return allies.forEach(cb);
    if (who === "lowestHpAlly") return cb([...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] ?? actor);
    if (who === "eachEnemy") return enemies.forEach(cb);
    if (who === "area" || who === "chosenEnemies") return enemies.slice(0, Math.min(upTo || 3, enemies.length)).forEach(cb);
    if (who === "lowestHpEnemy") return cb([...enemies].sort((a, b) => a.hp - b.hp)[0]);
    return cb(focus); // aiChoice / nearest / marked / squishiest
  };

  const scoreSubtree = (nodes: AutomationNode[], t: CombatantState, pMul = 1) => {
    for (const n of nodes) {
      if (n.type === "damage") {
        const raw = (avgDice(n.amount) ?? 0) * (n.half ? 0.5 : 1);
        const eff = t.ref.immunities.includes(n.damageType) ? 0 : t.ref.resistances.includes(n.damageType) ? raw * 0.5 : raw;
        damage += pMul * eff;
      } else if (n.type === "attack") {
        const bonus = typeof n.bonus === "number" ? n.bonus : 10;
        const p = hitChance(bonus, effectiveAc(t), n.adv);
        scoreSubtree(n.onHit, t, pMul * p);
      } else if (n.type === "save") {
        const pFail = saveFailChance(typeof n.dc === "number" ? n.dc : 18, saveBonusGuess(t, n.ability));
        scoreSubtree(n.onFail, t, pMul * pFail);
        if (n.onSuccess) scoreSubtree(n.onSuccess, t, pMul * (1 - pFail));
        else if (n.onFail.some((x) => x.type === "damage")) scoreSubtree(n.onFail, t, pMul * (1 - pFail) * 0.5);
      } else if (n.type === "applyCondition") {
        if (t.side !== actor.side && !t.ref.conditionImmunities.includes(n.condition)) {
          // probability it lands: fold in the wrapping save if any (handled above via pMul)
          control += pMul * (CONTROL_WEIGHT[n.condition] ?? 8) * (n.durationRounds && n.durationRounds > 0 ? Math.min(3, n.durationRounds) : 2) / 2;
        }
      } else if (n.type === "applyEffect") {
        if (t.side !== actor.side && (n.mods?.speedZero || n.mods?.noReactions || n.mods?.saveAdvantage === "dis")) control += pMul * 10;
        const tick = n.tick?.find((x) => x.type === "damage");
        if (tick && tick.type === "damage") damage += pMul * (avgDice(tick.amount) ?? 0) * 1.5; // a few ticks
        if (n.mods?.extraDamageOnHit) {
          // a smite/hex/mark-style rider: credit its expected future payoff so the AI
          // will actually spend the slot/bonus action on it — one likely hit for a
          // one-shot smite, several hits over the buff's life for a lasting mark/aura
          const perHit = avgDice(n.mods.extraDamageOnHit.amount) ?? 0;
          damage += pMul * perHit * (n.oneShot ? 0.7 : 2.5);
        }
      } else if (n.type === "heal") {
        const amt = avgDice(n.amount) ?? 0;
        const missing = Math.max(0, t.maxHp - t.hp);
        // healing only matters to the degree the target is actually in danger:
        // topping off someone at 80% is near-worthless; a dying ally is urgent.
        const frac = t.hp / Math.max(1, t.maxHp);
        let urgency = t.downed ? 1.4 : frac < 0.3 ? 1 : frac < 0.5 ? 0.4 : 0.1;
        // losing the DPR race: if the enemies out-damage what this heal restores,
        // it's mostly delaying — worth less. `incoming` = total enemy threat/round.
        if (incoming > 0) urgency *= Math.max(0.4, Math.min(1, (amt * Math.max(1, allies.length)) / (incoming * 1.4)));
        heal += pMul * Math.min(amt, missing) * urgency;
      } else if (n.type === "tempHp") {
        heal += pMul * (avgDice(n.amount) ?? 0) * 0.7;
      } else if (n.type === "branch") {
        scoreSubtree(n.then, t, pMul * 0.6);
        if (n.else) scoreSubtree(n.else, t, pMul * 0.4);
      } else if (n.type === "target") {
        forEachTarget(n.who.who, "upTo" in n.who ? n.who.upTo : 3, (t2) => scoreSubtree(n.effects, t2, pMul));
      } else if (n.type === "useAction") {
        const sub = actor.ref.actions.find((a) => a.id === n.action);
        if (sub) for (let i = 0; i < (n.times ?? 1); i++) scoreSubtree(sub.automation, t, pMul);
      } else if (n.type === "summon") {
        // action-economy value of raising bodies — count ~ avg of the dice, capped
        const count = Math.max(1, Math.round(avgDice(n.count) ?? 1));
        control += pMul * Math.min(60, 14 * count);
      }
    }
  };

  scoreSubtree(action.automation, focus);

  // finisher bonus: if the expected damage would drop the focus target
  const finisher = actor.side !== focus.side && damage >= focus.hp ? 25 : 0;

  // resource penalty: nudge the AI to save its 1/day powers and its top spell slots
  const limited = action.limitedUse;
  let resPenalty = 0;
  if (limited) {
    const ref = actor.ref.resources?.[limited.resource];
    const max = ref && ref.max !== "unbounded" ? ref.max : 99;
    resPenalty = max <= 1 ? 20 : max <= 2 ? 8 : 0;
    // spell slots: the higher the slot, the more it should hurt to spend it —
    // and hurt less against a big target or once the fight has run a few rounds
    const slotM = /^slot([1-9])$/.exec(limited.resource) ?? /^arcanum([6-9])$/.exec(limited.resource);
    if (slotM) {
      const lvl = Number(slotM[1]);
      // spending a big slot hurts less when it's actually landing on a fat target
      const beef = damage > 0 ? Math.min(1, focus.hp / 350) : 0;
      const late = Math.min(1, (state.round - 1) / 5);  // scale down as the fight drags
      resPenalty += lvl * lvl * 1.0 * (1 - 0.45 * beef) * (1 - 0.4 * late);
    } else if (limited.resource === "pactSlot") {
      resPenalty += 12; // warlocks have 2-4 slots total — never spend one lightly
    }
  }

  const score = damage + control * 1.0 + heal * 1.1 + finisher - resPenalty;
  return { score, damage, control, heal };
}
