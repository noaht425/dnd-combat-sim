// The reaction system. No combatant used to spend its reaction — Shield,
// Counterspell, Uncanny Dodge, and a pile of monster reactions — recharge-a-breath-
// when-bloodied, punish-the-attacker, riposte, react-to-a-drop — all sat inert in `reactions[]`.
//
// The engine calls into here at four moments: an attack roll is about to be
// finalised (Shield / Weight of Ages), damage is about to land (Uncanny Dodge),
// damage has landed (recharge a breath when bloodied, punish the attacker, big-hit reactions), and a
// spell is being cast (Counterspell). `canTakeReactions` gates every one, so
// concussed / stunned / a "no reactions" rider now actually shuts a creature's
// reactions off. Reactions never trigger reactions (`state.inReaction`).

import type { Action, AutomationNode, DamageType } from "../schema";
import { runAction, runAutomation } from "./interpreter";
import { CombatantState, CombatState, canTakeReactions, isIncapacitated, say, type ReactionAsk } from "./state";

/** the five damage types Absorb Elements answers */
const ELEMENTAL: readonly DamageType[] = ["acid", "cold", "fire", "lightning", "thunder"];

/**
 * At a reaction decision point, hand off to the Battle-mode seam if one is
 * installed; otherwise keep the engine's own auto-heuristic (return true = fire).
 * The seam decides for itself whether `unitId` is actually player-controlled —
 * for an AI unit it just returns true so behaviour is unchanged.
 */
function decideReaction(
  state: CombatState,
  u: CombatantState,
  kind: ReactionAsk["kind"],
  prompt: string,
  takeLabel: string,
  declineLabel: string,
): boolean {
  if (!state.askReaction) return true;
  return state.askReaction({ unitId: u.id, kind, prompt, takeLabel, declineLabel });
}

type RKind =
  | "shieldAc"       // Shield — +5 AC, may turn this hit into a miss
  | "negateHit"      // Weight of Ages — the attack simply misses
  | "halveDamage"    // Uncanny Dodge — halve one attack's damage
  | "retaliateOnHit" // riposte — hit back when hit
  | "retaliateOnMiss"// riposte — hit back when a melee attack misses
  | "counterspell"   // negate an enemy spell
  | "absorbElements" // Absorb Elements — resist the triggering element until your next turn
  | "onBloodied"     // recharge + re-use a breath the first time it is bloodied
  | "onDamaged"      // punish the source of any attack/spell damage (also Hellish Rebuke)
  | "onBigHit"       // react to 30+ damage from one source
  | "onDrop"         // react to a creature hitting 0 hp
  | "unknown";

function classify(r: Action): RKind {
  const id = r.id.toLowerCase();
  const tr = (r.trigger ?? "").toLowerCase().replace(/\s+/g, "");
  if (id === "shield") return "shieldAc";
  if (id.includes("weight-of-ages") || id.includes("weightofages")) return "negateHit";
  if (id.includes("uncanny")) return "halveDamage";
  if (id.includes("counterspell")) return "counterspell";
  if (id.includes("absorb-elements") || id.includes("absorbelements") || tr.includes("tookelementaldamage")) return "absorbElements";
  if (id.includes("hellish-rebuke") || id.includes("hellishrebuke")) return "onDamaged";
  if (id.includes("riposte")) return tr.includes("missed") ? "retaliateOnMiss" : "retaliateOnHit";
  if (tr.includes("belowhalf") || tr.includes("reducedtohalf")) return "onBloodied";
  if (tr.includes("tookdamagefromattackorspell")) return "onDamaged";
  if (tr.includes("tookdamagefromonesource")) return "onBigHit";
  if (tr.includes("droppedto0") || tr.includes("dropsto0")) return "onDrop";
  return "unknown";
}

function ready(state: CombatState, u: CombatantState, r: Action): boolean {
  if (state.inReaction) return false;
  if (!u.alive || u.downed) return false;
  if (u.reactionUsed) return false;
  if (!canTakeReactions(u)) return false;
  if (r.limitedUse && (u.resources.get(r.limitedUse.resource) ?? 0) < r.limitedUse.amount) return false;
  return true;
}

function consume(u: CombatantState, r: Action): void {
  u.reactionUsed = true;
  if (r.limitedUse) {
    const cur = u.resources.get(r.limitedUse.resource) ?? 0;
    u.resources.set(r.limitedUse.resource, cur - r.limitedUse.amount);
  }
}

/** run a fire-and-forget reaction's automation with the reaction re-entry guard set */
function fire(state: CombatState, u: CombatantState, r: Action): void {
  consume(u, r);
  state.inReaction = true;
  try {
    runAction(state, u, r, { asReaction: true });
  } finally {
    state.inReaction = false;
  }
}

// ------------------------------------------------ attack about to be finalised

/**
 * Called from `rollAttack` once the die is known. The target may spend a reaction
 * to change the outcome. Returns whether the attack is negated outright; if it
 * returns `shielded`, the caller should recompute AC from `effectiveAc` (the
 * Shield effect is now active) and re-check the hit.
 */
export function reactToIncomingAttack(
  state: CombatState,
  p: { target: CombatantState; hitMargin: number; crit: boolean },
): { negated: boolean; shielded: boolean } {
  const t = p.target;
  if (state.inReaction || !t.alive || t.downed) return { negated: false, shielded: false };
  const wouldHit = p.crit || p.hitMargin >= 0;
  if (!wouldHit) return { negated: false, shielded: false };

  for (const r of t.ref.reactions) {
    if (!ready(state, t, r)) continue;
    const k = classify(r);
    if (k === "negateHit" && (p.crit || t.hp <= t.maxHp / 3)) {
      consume(t, r);
      say(state, `${t.name} unmakes the blow (${r.name})`, t.id);
      return { negated: true, shielded: false };
    }
    if (k === "shieldAc" && !p.crit && p.hitMargin < 5) {
      const ok = decideReaction(
        state,
        t,
        "shield",
        `An attack hits ${t.name} by ${p.hitMargin} — Shield (+5 AC until your next turn) turns it into a miss.`,
        "Cast Shield",
        "Take the hit",
      );
      if (!ok) continue;
      fire(state, t, r); // applies the +5 "shield" effect
      say(state, `${t.name} casts Shield`, t.id);
      return { negated: false, shielded: true };
    }
  }
  return { negated: false, shielded: false };
}

// --------------------------------------------------- damage about to be applied

/** Uncanny Dodge — halve a single attack's damage. Returns the (possibly reduced) amount. */
export function reduceIncomingDamage(
  state: CombatState,
  target: CombatantState,
  amount: number,
  viaAttack: boolean,
): number {
  if (state.inReaction || !viaAttack || amount < 15) return amount;
  for (const r of target.ref.reactions) {
    if (classify(r) !== "halveDamage" || !ready(state, target, r)) continue;
    const ok = decideReaction(
      state,
      target,
      "uncannyDodge",
      `${target.name} is about to take ${amount} damage from an attack — Uncanny Dodge halves it to ${Math.floor(amount / 2)}.`,
      "Uncanny Dodge",
      "Take it full",
    );
    if (!ok) return amount;
    consume(target, r);
    say(state, `${target.name} rolls with it (Uncanny Dodge)`, target.id);
    return Math.floor(amount / 2);
  }
  return amount;
}

/**
 * Absorb Elements — a reaction to taking acid/cold/fire/lightning/thunder damage.
 * Sets `target.absorbElements` so `applyDamage`'s resistance block halves the
 * triggering instance *and* any further hits of that type until the reactor's
 * next turn. The "first melee hit next turn deals +1d6" rider is not modelled.
 */
export function reactToElementalDamage(
  state: CombatState,
  target: CombatantState,
  amount: number,
  type: DamageType,
): void {
  if (state.inReaction || !target.alive || target.downed) return;
  if (!ELEMENTAL.includes(type) || target.absorbElements?.type === type) return;
  for (const r of target.ref.reactions) {
    if (classify(r) !== "absorbElements" || !ready(state, target, r)) continue;
    const ok = decideReaction(
      state,
      target,
      "absorbElements",
      `${target.name} is taking ${amount} ${type} damage — Absorb Elements halves it and resists ${type} until your next turn.`,
      "Absorb Elements",
      "Take it full",
    );
    if (!ok) return;
    consume(target, r);
    target.absorbElements = { type, untilRound: state.round + 1 };
    say(state, `${target.name} casts Absorb Elements (resist ${type})`, target.id);
    return;
  }
}

// --------------------------------------------------------- attack hit or missed

/** Riposte — hit back when hit, or when a melee attack misses. */
export function reactToAttackResolved(
  state: CombatState,
  p: { attacker: CombatantState; target: CombatantState; hit: boolean; melee: boolean },
): void {
  const t = p.target;
  if (state.inReaction || !t.alive || t.downed || !p.attacker.alive) return;
  for (const r of t.ref.reactions) {
    if (!ready(state, t, r)) continue;
    const k = classify(r);
    const wants =
      (k === "retaliateOnHit" && p.hit) || (k === "retaliateOnMiss" && !p.hit && p.melee);
    if (!wants) continue;
    const ok = decideReaction(
      state,
      t,
      "riposte",
      `${p.attacker.name} ${p.hit ? "hit" : "missed"} ${t.name} — ${r.name} spends a superiority die to strike back.`,
      r.name,
      "Hold reaction",
    );
    if (!ok) return;
    fire(state, t, r);
    return;
  }
}

// ------------------------------------------------------------- damage has landed

/**
 * Called at the end of `applyDamage`. Fires the damaged creature's own
 * post-damage reactions (recharge-a-breath-when-bloodied, punish-the-attacker, big-hit reactions).
 */
export function reactToDamageTaken(
  state: CombatState,
  p: {
    target: CombatantState;
    amount: number;
    crossedHalf: boolean;
    viaAttackOrSpell: boolean;
    /** the damage came from some other creature (attack, spell, breath, aura, …) */
    fromCreature?: boolean;
  },
): void {
  const t = p.target;
  if (state.inReaction || !t.alive || t.downed) return;

  for (const r of t.ref.reactions) {
    if (!ready(state, t, r)) continue;
    const k = classify(r);
    if (k === "onBloodied" && p.crossedHalf && !t.onceFired.has("bloodied-reaction")) {
      t.onceFired.add("bloodied-reaction");
      fire(state, t, r);
      return;
    }
    const rebukeR = r.id.toLowerCase().includes("hellish");
    if (k === "onDamaged" && (p.viaAttackOrSpell || (rebukeR && p.fromCreature))) {
      const rebuke = rebukeR;
      const ok = decideReaction(
        state,
        t,
        "retaliate",
        rebuke
          ? `${t.name} was hit for ${p.amount} — Hellish Rebuke answers the attacker with 2d10 fire (Dex save for half).`
          : `${t.name} was hit for ${p.amount} — ${r.name} strikes back at the attacker.`,
        rebuke ? "Hellish Rebuke" : r.name,
        "Hold reaction",
      );
      if (!ok) continue;
      fire(state, t, r);
      return;
    }
    if (k === "onBigHit" && p.amount >= 30) {
      fire(state, t, r);
      return;
    }
  }
}

// ------------------------------------------------------- a creature dropped to 0

export function reactToDrop(state: CombatState, dropped: CombatantState): void {
  if (state.inReaction) return;
  for (const u of state.units.values()) {
    if (u.id === dropped.id) continue;
    for (const r of u.ref.reactions) {
      if (classify(r) === "onDrop" && ready(state, u, r)) {
        fire(state, u, r);
        return;
      }
    }
  }
}

// ----------------------------------------------------------- opportunity attacks

/** the first single attack node inside a combatant's basic attack / multiattack */
function basicSwing(u: CombatantState): AutomationNode | undefined {
  const act = u.ref.actions.find((a) => a.id === "attack") ?? u.ref.actions.find((a) => a.id === "multiattack");
  if (!act) return undefined;
  let found: AutomationNode | undefined;
  const walk = (nodes: AutomationNode[]) => {
    for (const n of nodes) {
      if (found) return;
      if (n.type === "attack") { found = n; return; }
      if (n.type === "target") walk(n.effects);
      if (n.type === "useAction") {
        const sub = u.ref.actions.find((a) => a.id === n.action);
        if (sub) walk(sub.automation);
      }
    }
  };
  walk(act.automation);
  return found;
}

/**
 * `mover` is stepping away from melee. Up to `cap` living enemies in the melee
 * zone that still have their reaction (and aren't concussed / stunned) get one
 * opportunity attack. Teleporting away never triggers this.
 */
export function provokeOpportunityAttacks(state: CombatState, mover: CombatantState, cap = 2): void {
  if (state.inReaction) return;
  const takers = [...state.units.values()]
    .filter((u) => u.side !== mover.side && u.alive && !u.downed && u.zone === "melee" && !isIncapacitated(u))
    .filter((u) => !u.reactionUsed && canTakeReactions(u) && basicSwing(u))
    .slice(0, cap);
  for (const u of takers) {
    const swing = basicSwing(u)!;
    u.reactionUsed = true;
    state.inReaction = true;
    try {
      say(state, `${u.name} takes an opportunity attack at ${mover.name}`, u.id);
      runAutomation([swing], { state, source: u, scope: [mover], last: {}, depth: 0, inAttack: true });
    } finally {
      state.inReaction = false;
    }
  }
}

// ---------------------------------------------------------- a spell is being cast

export const isSpell = (a: Action): boolean =>
  a.isSpell === true || !!a.limitedUse?.resource?.match(/^slot[1-9]$/);

/** returns true if a PC spends a reaction to Counterspell `action` cast by `caster` */
export function mayCounterspell(state: CombatState, caster: CombatantState, action: Action): boolean {
  if (state.inReaction || !isSpell(action)) return false;
  // worth a slot only against control / heavy save-or-suck, not a cantrip
  const blob = JSON.stringify(action.automation);
  const worthCountering = blob.includes('"applyCondition"') || blob.includes('"applyEffect"') ||
    /"amount":"(1[0-9]|[2-9][0-9])d/.test(blob); // ~10d+ dice
  if (!worthCountering) return false;

  for (const u of state.units.values()) {
    if (u.side === caster.side) continue;
    for (const r of u.ref.reactions) {
      if (classify(r) !== "counterspell" || !ready(state, u, r)) continue;
      const ok = decideReaction(
        state,
        u,
        "counterspell",
        `${caster.name} is casting ${action.name} — Counterspell stops it before it lands.`,
        "Counterspell it",
        "Let it resolve",
      );
      if (!ok) continue;
      consume(u, r);
      say(state, `${u.name} counterspells ${caster.name}'s ${action.name}`, u.id);
      return true;
    }
  }
  return false;
}
