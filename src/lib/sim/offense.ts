// Estimate how much damage a monster puts out per round against a modelled party.
// This walks the fixture's automation trees at the level of "attack node -> hit
// chance x average damage" and "save node -> fail chance x (full / half)". It does
// NOT run a turn loop or make tactical choices — it assumes the monster does its
// Multiattack every round, lands its recharge AoE on the expected cadence, and
// spends its legendary budget on the cheapest damaging option.

import type { Ability, Action, AutomationNode, Combatant } from "./schema";
import type { PartyProfile } from "./party";
import { avgDice, hitChance, saveFailChance } from "./math";

export interface OffenseEstimate {
  perRoundParty: number; // total damage spread across the party, sustained
  breakdown: Record<string, number>; // contribution by source
  bestSingleHit: number; // largest expected damage from one attack (glass-cannon detection)
  notes: string[];
}

/** the monster does not get a perfect turn every round — recharge misfires,
 *  repositioning, using control instead of damage, PCs out of range */
export const TACTICAL_REALISM = 0.7;

interface Ctx {
  monster: Combatant;
  party: PartyProfile;
  actionsById: Map<string, Action>;
}

// how many party members a target spec is assumed to hit
function targetCount(node: Extract<AutomationNode, { type: "target" }>, party: PartyProfile): number {
  switch (node.who.who) {
    case "self":
      return 0;
    case "eachEnemy":
      return party.size;
    case "eachAlly":
      return 0;
    case "chosenEnemies":
      return Math.min(node.who.upTo, party.size);
    case "area":
      return party.aoeCatch;
    default:
      return 1; // single-target picks
  }
}

function partySaveBonusFor(party: PartyProfile, ability: Ability): number {
  return party.saveBonus[ability];
}

/** Expected damage of a list of nodes against ONE target already selected. */
function nodeDamageVsOne(nodes: AutomationNode[], ctx: Ctx, depth = 0): number {
  if (depth > 8) return 0;
  let dmg = 0;
  for (const n of nodes) {
    switch (n.type) {
      case "damage": {
        const avg = avgDice(n.amount) ?? 0;
        dmg += n.half ? avg : avg; // caller applies the half split via save branch
        break;
      }
      case "attack": {
        const bonus = typeof n.bonus === "number" ? n.bonus : 15;
        const p = hitChance(bonus, ctx.monster.kind === "pc" ? 16 : acOfParty(), n.adv);
        dmg += p * nodeDamageVsOne(n.onHit, ctx, depth + 1);
        if (n.onMiss) dmg += (1 - p) * nodeDamageVsOne(n.onMiss, ctx, depth + 1);
        break;
      }
      case "save": {
        const sb = partySaveBonusFor(ctx.party, n.ability);
        const dc = typeof n.dc === "number" ? n.dc : 20;
        const pFail = saveFailChance(dc, sb);
        const onFail = nodeDamageVsOne(n.onFail, ctx, depth + 1);
        const onSucc = n.onSuccess ? nodeDamageVsOne(n.onSuccess, ctx, depth + 1) : 0;
        // if the fail branch has a `half` damage node, model the success as half of the fail branch
        const halfOnSave = n.onFail.some((x) => x.type === "damage") && !n.onSuccess;
        dmg += pFail * onFail + (1 - pFail) * (n.onSuccess ? onSucc : halfOnSave ? onFail * 0.5 : 0);
        break;
      }
      case "branch": {
        // phase-2 / conditional branches aren't active most of the fight
        dmg += 0.4 * nodeDamageVsOne(n.then, ctx, depth + 1);
        if (n.else) dmg += 0.6 * nodeDamageVsOne(n.else, ctx, depth + 1);
        break;
      }
      case "target": {
        // nested target — rare; treat as its own vs-one
        dmg += nodeDamageVsOne(n.effects, ctx, depth + 1);
        break;
      }
      case "useAction": {
        const sub = ctx.actionsById.get(n.action);
        if (sub) dmg += (n.times ?? 1) * actionDamageVsParty(sub, ctx).perRoundParty / Math.max(1, targetSpread(sub, ctx));
        break;
      }
      default:
        break;
    }
  }
  return dmg;
}

function targetSpread(action: Action, ctx: Ctx): number {
  for (const n of action.automation) {
    if (n.type === "target") return Math.max(1, targetCount(n, ctx.party));
  }
  return 1;
}

function acOfParty(): number {
  // an "average defender" AC the monster's attacks are resolved against
  return 18;
}

/** Expected total damage of a single action, spread across the party. */
function actionDamageVsParty(action: Action, ctx: Ctx): { perRoundParty: number } {
  let total = 0;
  for (const n of action.automation) {
    if (n.type === "target") {
      const count = targetCount(n, ctx.party);
      total += count * nodeDamageVsOne(n.effects, ctx);
    } else if (n.type === "useAction") {
      const sub = ctx.actionsById.get(n.action);
      if (sub) total += (n.times ?? 1) * actionDamageVsParty(sub, ctx).perRoundParty;
    } else if (n.type === "branch") {
      total += 0.5 * nodeDamageVsOne(n.then, ctx);
    }
    // bare damage/save nodes at the top level (no target) -> assume single target
    else if (n.type === "damage" || n.type === "save" || n.type === "attack") {
      total += nodeDamageVsOne([n], ctx);
    }
  }
  return { perRoundParty: total };
}

export function estimateOffense(monster: Combatant, party: PartyProfile): OffenseEstimate {
  const actionsById = new Map<string, Action>();
  for (const a of [...monster.actions, ...monster.reactions]) actionsById.set(a.id, a);
  const ctx: Ctx = { monster, party, actionsById };
  const breakdown: Record<string, number> = {};
  const notes: string[] = [];

  // 1 — the turn action: Multiattack if present, else the best single damaging action
  const multiattack = monster.actions.find((a) => a.id === "multiattack" || /multiattack/i.test(a.name));
  if (multiattack) {
    breakdown["multiattack"] = actionDamageVsParty(multiattack, ctx).perRoundParty;
  } else {
    let best = 0;
    for (const a of monster.actions) {
      if (a.cost.action && a.recharge === "none" && !a.limitedUse) {
        best = Math.max(best, actionDamageVsParty(a, ctx).perRoundParty);
      }
    }
    breakdown["main action"] = best;
  }

  // 2 — recharge AoE (breath), amortised: fires ~1/3 of rounds, +1 guaranteed if there's a bloodied-breath trait
  for (const a of monster.actions) {
    if (a.recharge.startsWith("roll:")) {
      const per = actionDamageVsParty(a, ctx).perRoundParty;
      const cadence = a.recharge === "roll:5-6" ? 1 / 3 : a.recharge === "roll:4-6" ? 1 / 2 : 1 / 6;
      const bloodied = monster.traits.some((t) => /bloodied breath/i.test(t.name)) || monster.reactions.some((r) => /bloodied breath/i.test(r.name));
      breakdown[a.name] = per * (cadence + (bloodied ? 0.15 : 0));
    }
  }

  // 3 — legendary actions: bosses realistically land ~2 legendary points of
  // damage per round; the rest go to movement / control / reactions
  if (monster.legendaryActions) {
    const budget = monster.legendaryActions.budget;
    let bestPerPoint = 0;
    for (const opt of monster.legendaryActions.options) {
      const act = actionsById.get(opt.action);
      if (!act) continue;
      bestPerPoint = Math.max(bestPerPoint, actionDamageVsParty(act, ctx).perRoundParty / Math.max(1, opt.cost));
    }
    breakdown["legendary actions"] = bestPerPoint * Math.min(budget, 2);
  }

  // 4 — auras (per-round tick x melee count)
  for (const t of monster.traits) {
    if (t.aura) {
      const per = nodeDamageVsOne(t.aura.automation.flatMap((n) => (n.type === "target" ? n.effects : [n])), ctx);
      if (per > 0) breakdown[`${t.name} (aura)`] = per * party.meleeCount;
    }
  }

  // 5 — lair actions: 1/round, average damaging option
  if (monster.lairActions) {
    let sum = 0;
    let count = 0;
    for (const opt of monster.lairActions.options) {
      const act = actionsById.get(opt.action);
      if (!act) continue;
      sum += actionDamageVsParty(act, ctx).perRoundParty;
      count++;
    }
    if (count) breakdown["lair actions"] = sum / count;
  }

  // 6 — 1/day nuke (Maelstrom / Dissolve / Grave Gale / Deathknell), amortised over ~5 rounds
  for (const a of monster.actions) {
    if (a.limitedUse && !a.recharge.startsWith("roll:") && /1\/day|1\/Day/i.test(a.text ?? "")) {
      breakdown[a.name] = actionDamageVsParty(a, ctx).perRoundParty / 5;
    }
  }

  // largest single expected hit — for glass-cannon detection (a creature whose
  // sustained DPR is low but who one-shots a PC on a good hit)
  let bestSingleHit = 0;
  for (const a of monster.actions) {
    walkForBestHit(a.automation, ctx, (v) => (bestSingleHit = Math.max(bestSingleHit, v)));
  }

  const rawTotal = Object.values(breakdown).reduce((s, x) => s + x, 0);
  const perRoundParty = rawTotal * TACTICAL_REALISM;
  for (const k of Object.keys(breakdown)) breakdown[k] = breakdown[k] * TACTICAL_REALISM;

  if (monster.specialRules.some((r) => r.rule === "d20Replacement")) notes.push("d20-replacement table adds ~1 forced miss/save-fail per round (not in the number)");
  return { perRoundParty, breakdown, bestSingleHit, notes };
}

function walkForBestHit(nodes: AutomationNode[], ctx: Ctx, report: (v: number) => void, depth = 0): void {
  if (depth > 6) return;
  for (const n of nodes) {
    if (n.type === "attack") {
      report(nodeDamageVsOne(n.onHit, ctx));
      walkForBestHit(n.onHit, ctx, report, depth + 1);
    } else if (n.type === "target") walkForBestHit(n.effects, ctx, report, depth + 1);
    else if (n.type === "save") { walkForBestHit(n.onFail, ctx, report, depth + 1); }
    else if (n.type === "branch") { walkForBestHit(n.then, ctx, report, depth + 1); walkForBestHit(n.else ?? [], ctx, report, depth + 1); }
    else if (n.type === "useAction") {
      const sub = ctx.actionsById.get(n.action);
      if (sub) walkForBestHit(sub.automation, ctx, report, depth + 1);
    }
  }
}
