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

import type { Action, AutomationNode, Condition, DamageType } from "../schema";
import { actionBranchGateFails, runAction, runAutomation } from "./interpreter";
import { rollSave } from "./resolve";
import { CombatantState, CombatState, canTakeReactions, isIncapacitated, livingAllies, livingEnemies, say, type ReactionAsk } from "./state";

/** the five damage types Absorb Elements answers */
const ELEMENTAL: readonly DamageType[] = ["acid", "cold", "fire", "lightning", "thunder"];

/** Bardic Inspiration die average by character level (d6 / d8 / d10 / d12) */
function bardicDieAverage(level: number): number {
  if (level >= 15) return 6.5;
  if (level >= 10) return 5.5;
  if (level >= 5) return 4.5;
  return 3.5;
}

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
  | "retaliateOnMeleeHit" // Storm's Fury — lightning back at whoever hit you with a MELEE attack
  | "counterspell"   // negate an enemy spell
  | "absorbElements" // Absorb Elements — resist the triggering element until your next turn
  | "onBloodied"     // recharge + re-use a breath the first time it is bloodied
  | "onDamaged"      // punish the source of any attack/spell damage (also Hellish Rebuke)
  | "onBigHit"       // react to 30+ damage from one source
  | "onDrop"         // react to a creature hitting 0 hp
  | "deflectAttack"  // Steel Defender — impose disadvantage on an attack against its summoner / another ally
  | "protectAllyAttackRoll" // Cutting Words — spend Bardic Inspiration to subtract from an attack roll made against an ally
  | "giantKiller"    // Hunter's Giant Killer — attack a Large or larger creature right after its attack, hit or miss
  | "parry"          // Battle Master — spend a superiority die to reduce melee damage
  | "shadowyDodge"   // Gloom Stalker — impose disadvantage on an attack against you (before the roll)
  | "nemesis"        // Monster Slayer's Magic-User's Nemesis — a Wisdom save or the spell fails
  | "tailSwipe"      // Path of the Beast's tail — a d8 bonus to AC against one attack
  | "unknown";

function classify(r: Action): RKind {
  const id = r.id.toLowerCase();
  const tr = (r.trigger ?? "").toLowerCase().replace(/\s+/g, "");
  if (id === "shield") return "shieldAc";
  if (id.includes("weight-of-ages") || id.includes("weightofages")) return "negateHit";
  if (id.includes("uncanny") || id.includes("spectral-defense") || id.includes("swarming-dispersal") || id.includes("reflexive-resistance")) return "halveDamage";
  if (id.includes("shadowy-dodge")) return "shadowyDodge";
  if (id === "parry") return "parry";
  if (id.includes("giant-killer")) return "giantKiller";
  if (id.includes("magic-users-nemesis")) return "nemesis";
  if (id.includes("counterspell")) return "counterspell";
  if (id.includes("absorb-elements") || id.includes("absorbelements") || tr.includes("tookelementaldamage")) return "absorbElements";
  if (id.includes("hellish-rebuke") || id.includes("hellishrebuke")) return "onDamaged";
  if (id.includes("riposte")) return tr.includes("missed") ? "retaliateOnMiss" : "retaliateOnHit";
  if (id.includes("storms-fury") || id.includes("retaliation")) return "retaliateOnMeleeHit";
  if (id.includes("raging-storm")) return "retaliateOnMeleeHit";
  if (id.includes("tail-swipe")) return "tailSwipe";
  if (id.includes("deflect-attack")) return "deflectAttack";
  if (id.includes("cutting-words") || id.includes("cuttingwords") || id.includes("bend-luck")) return "protectAllyAttackRoll";
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
  if (actionBranchGateFails(state, u, r)) return false; // a reaction gated on a condition (only while raging, only in tail form)
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
function fire(state: CombatState, u: CombatantState, r: Action, forceTarget?: CombatantState): void {
  consume(u, r);
  state.inReaction = true;
  state.reactionFiredThisAction = true;
  try {
    runAction(state, u, r, { asReaction: true, forceScope: forceTarget ? [forceTarget] : undefined });
  } finally {
    state.inReaction = false;
  }
}

// ---------------------------------------------- before an attack roll is made

/**
 * Deflect Attack (Steel Defender): "imposes disadvantage on the attack roll of one creature it can
 * see that is within 5 feet of it, provided the attack roll is against a creature other than the
 * defender." Called from `rollAttackImpl` BEFORE the d20 is rolled, since it changes how the roll
 * is made. `adv` is the roll's state so far — disadvantage already there means the reaction would
 * be wasted. Returns whether disadvantage should be imposed. Range is real feet in battle mode
 * (`state.distanceFt`); the Monte-Carlo engine has no distances, so it falls back to "both are in
 * the melee zone".
 */
export function deflectAttack(
  state: CombatState,
  attacker: CombatantState,
  target: CombatantState,
  adv: "adv" | "dis" | "flat",
): boolean {
  if (state.inReaction || adv === "dis") return false;
  for (const d of livingAllies(state, target)) {
    if (d.id === target.id) continue; // "against a creature other than the defender"
    for (const r of d.ref.reactions) {
      if (classify(r) !== "deflectAttack" || !ready(state, d, r)) continue;
      const near = state.distanceFt
        ? state.distanceFt(d, attacker) <= 5.001
        : d.zone === "melee" && attacker.zone === "melee";
      if (!near) continue;
      const ok = decideReaction(
        state,
        d,
        "deflectAttack",
        `${attacker.name} is attacking ${target.name} — ${d.name}'s Deflect Attack imposes disadvantage on the roll.`,
        "Deflect Attack",
        "Let it through",
      );
      if (!ok) continue;
      // retaliation (Improved Defender, 15th level) lives in the reaction's own automation and is
      // pinned onto the attacker; below 15th level that automation is just a note
      fire(state, d, r, attacker);
      say(state, `${d.name} deflects the attack`, d.id);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------- a saving throw failed

/**
 * Something that adds to a saving throw the moment it fails, if that is enough to turn it around:
 *   - Favored by the Gods (Divine Soul) / Dark One's Own Luck (Fiend): a die added to your OWN save;
 *     no reaction; the use is spent only if it works.
 *   - Flash of Genius (Artificer, 7th level): "When you or another creature you can see within 30
 *     feet of you makes an ability check or a saving throw, you can use your reaction to add your
 *     Intelligence modifier to the roll."
 * Saving throws only — the sim rolls no ability checks. Range is real feet in battle mode; the
 * Monte-Carlo engine has no distances, so anyone on the side counts as within range.
 */
export function reactToFailedSave(state: CombatState, target: CombatantState, rollTotal: number, dc: number): boolean {
  if (state.inReaction) return false;

  const boost = target.ref.specialRules.find((r) => r.rule === "boostFailedSave");
  if (boost && boost.rule === "boostFailedSave" && (target.resources.get(boost.resource) ?? 0) > 0) {
    const m = boost.bonusDice.match(/(\d+)d(\d+)/);
    const bonus = m ? state.rng.dice(Number(m[1]), Number(m[2])) : 0;
    if (rollTotal + bonus >= dc) {
      target.resources.set(boost.resource, (target.resources.get(boost.resource) ?? 0) - 1);
      say(state, `${target.name} turns the save around (+${bonus})`, target.id);
      return true;
    }
  }

  // Bend Luck (Wild Magic Sorcerer): 2 sorcery points and a reaction for a d4 bonus to another creature's failed save
  if (dc - rollTotal <= 4) {
    for (const a of livingAllies(state, target)) {
      if (a.id === target.id) continue;
      const r = a.ref.reactions.find((x) => x.id === "bend-luck");
      if (!r || !ready(state, a, r)) continue;
      if (state.distanceFt && state.distanceFt(a, target) > 60.001) continue;
      const ok = decideReaction(state, a, "flashOfGenius", `${target.name} fails a saving throw (${rollTotal} vs DC ${dc}) — ${a.name}'s Bend Luck can add a d4.`, "Bend Luck", "Let it fail");
      if (!ok) continue;
      consume(a, r);
      const bonus = state.rng.dice(1, 4);
      say(state, `${a.name} bends luck for ${target.name} (+${bonus})`, a.id);
      if (rollTotal + bonus >= dc) return true;
    }
  }

  for (const a of livingAllies(state, target)) {
    const rule = a.ref.specialRules.find((r) => r.rule === "flashOfGenius");
    if (!rule || rule.rule !== "flashOfGenius") continue;
    if (a.reactionUsed || !canTakeReactions(a) || (a.resources.get(rule.resource) ?? 0) <= 0) continue;
    if (rollTotal + rule.bonus < dc) continue; // wouldn't turn it around
    if (a.id !== target.id && state.distanceFt && state.distanceFt(a, target) > rule.rangeFt + 0.001) continue;
    const ok = decideReaction(
      state,
      a,
      "flashOfGenius",
      `${target.name} fails a saving throw (${rollTotal} vs DC ${dc}) — ${a.name}'s Flash of Genius adds +${rule.bonus} and turns it into a success.`,
      "Flash of Genius",
      "Let it fail",
    );
    if (!ok) continue;
    a.reactionUsed = true;
    a.resources.set(rule.resource, (a.resources.get(rule.resource) ?? 0) - 1);
    say(state, `${a.name} uses Flash of Genius (+${rule.bonus}) for ${target.name}`, a.id);
    return true;
  }
  return false;
}

/**
 * Restore Balance (Clockwork Soul, 1st level): "When a creature you can see within 60 feet of you is
 * about to roll a d20 with advantage or disadvantage, you can use your reaction to prevent the roll
 * from being affected by advantage and disadvantage." Spent to deny an enemy's advantage or an ally's
 * disadvantage. Returns true if the roll should be made flat.
 */
export function restoreBalance(state: CombatState, roller: CombatantState, adv: "adv" | "dis" | "flat"): boolean {
  if (state.inReaction || adv === "flat") return false;
  for (const u of state.units.values()) {
    const rule = u.ref.specialRules.find((r) => r.rule === "restoreBalance");
    if (!rule || rule.rule !== "restoreBalance") continue;
    if (!u.alive || u.downed || u.reactionUsed || !canTakeReactions(u) || (u.resources.get(rule.resource) ?? 0) <= 0) continue;
    // worth it only when it helps the reactor's side: deny a foe advantage, or an ally disadvantage
    const helps = (roller.side !== u.side && adv === "adv") || (roller.side === u.side && adv === "dis");
    if (!helps) continue;
    if (u.id !== roller.id && state.distanceFt && state.distanceFt(u, roller) > rule.rangeFt + 0.001) continue;
    u.reactionUsed = true;
    u.resources.set(rule.resource, (u.resources.get(rule.resource) ?? 0) - 1);
    say(state, `${u.name} uses Restore Balance on ${roller.name}'s roll`, u.id);
    return true;
  }
  return false;
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
    if (k === "tailSwipe" && !p.crit && p.hitMargin < 8) {
      const ok = decideReaction(
        state, t, "tailSwipe",
        `An attack hits ${t.name} by ${p.hitMargin} — swiping the tail adds a d8 to AC and may turn it into a miss.`,
        "Swipe the tail", "Take the hit",
      );
      if (!ok) continue;
      consume(t, r);
      const bonus = state.rng.dice(1, 8);
      say(state, `${t.name} swipes their tail (+${bonus} AC)`, t.id);
      return { negated: bonus > p.hitMargin, shielded: false }; // the attack now needs to beat AC + the die
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

  // Cutting Words (College of Lore) — unlike every other reaction here, the
  // reactor isn't the target: any conscious ally within earshot can spend
  // Bardic Inspiration to subtract its die from the roll. A crit is decided
  // by the natural 20, not the total, so it can't be talked into a miss.
  if (!p.crit) {
    for (const ally of livingAllies(state, t)) {
      if (ally.id === t.id) continue;
      for (const r of ally.ref.reactions) {
        if (classify(r) !== "protectAllyAttackRoll" || !ready(state, ally, r)) continue;
        if (p.hitMargin >= (r.id.includes("bend-luck") ? 2.5 : bardicDieAverage(ally.ref.level ?? 1))) continue;
        const ok = decideReaction(
          state,
          ally,
          "cuttingWords",
          `An attack hits ${t.name} by ${p.hitMargin} — ${ally.name}'s ${r.name} (subtract a die from the roll) can turn it into a miss.`,
          `Use ${r.name}`,
          "Take the hit",
        );
        if (!ok) continue;
        fire(state, ally, r);
        say(state, `${ally.name} undercuts the blow with ${r.name}`, ally.id);
        return { negated: true, shielded: false };
      }
    }
  }
  return { negated: false, shielded: false };
}

// --------------------------------------------------- damage about to be applied

/**
 * Slayer's Counter (Monster Slayer, 15th): when the creature you designated with Slayer's Prey forces you to make a saving throw,
 * your reaction makes one weapon attack against it immediately before the save; if it hits, the save succeeds automatically.
 */
export function slayersCounter(state: CombatState, target: CombatantState, source: CombatantState): boolean {
  if (state.inReaction || source.side === target.side) return false;
  const r = target.ref.reactions.find((x) => x.id === "slayers-counter");
  if (!r || !ready(state, target, r)) return false;
  if (!source.effects.some((e) => e.name === "slayers-prey" && e.sourceId === target.id)) return false;
  const ok = decideReaction(
    state, target, "riposte",
    `${source.name} is forcing ${target.name} to make a saving throw — Slayer's Counter attacks it first; a hit means the save succeeds.`,
    "Counterattack", "Just make the save",
  );
  if (!ok) return false;
  const before = state.attackLog?.length ?? 0;
  fire(state, target, r, source);
  const won = (state.attackLog ?? []).slice(before).some((a) => a.attackerId === target.id && a.hit);
  if (won) say(state, `${target.name}'s counterattack lands — the save succeeds`, target.id);
  return won;
}

/**
 * Beguiling Twist (Fey Wanderer, 7th): when you or a creature you can see within 120 ft succeeds on a saving throw against being
 * charmed or frightened, your reaction forces a DIFFERENT creature you can see within 120 ft to make a Wisdom save against your
 * spell save DC or be charmed or frightened by you (your choice — frightened here) for a minute, repeating the save each turn.
 */
export function beguilingTwist(state: CombatState, saver: CombatantState, conditions?: Condition[]): void {
  if (state.inReaction || !conditions?.some((c) => c === "charmed" || c === "frightened")) return;
  for (const f of state.units.values()) {
    if (!f.alive || f.downed) continue;
    const r = f.ref.reactions.find((x) => x.id === "beguiling-twist");
    if (!r || !ready(state, f, r)) continue;
    if (state.distanceFt && state.distanceFt(f, saver) > 120.001) continue;
    const victims = livingEnemies(state, f).filter((e) => e.id !== saver.id && !e.ref.conditionImmunities.includes("frightened") &&
      (!state.distanceFt || state.distanceFt(f, e) <= 120.001));
    if (!victims.length) continue;
    const v = victims.sort((a, b) => a.ref.abilities.wis - b.ref.abilities.wis)[0]; // the one likeliest to fail
    const ok = decideReaction(
      state, f, "riposte",
      `${saver.name} shrugged off a fear or charm — ${f.name}'s Beguiling Twist can turn it on ${v.name}.`,
      "Beguiling Twist", "Let it go",
    );
    if (!ok) continue;
    consume(f, r);
    const dc = 8 + f.ref.pb + Math.floor((f.ref.abilities.wis - 10) / 2);
    const save = rollSave(state, v, "wis", dc, { magical: true, allowLegendaryResistance: true });
    if (!save.passed) {
      v.conditions.set("frightened", { expiresRound: state.round + 10, sourceId: f.id, saveEnds: { ability: "wis", dc, at: "endOfTurn" } });
      say(state, `${v.name} is frightened by ${f.name}'s Beguiling Twist`, f.id);
    }
    return;
  }
}

/** Shadowy Dodge (Gloom Stalker, 15th): whenever a creature makes an attack roll against you and doesn't have advantage, your reaction
 *  imposes disadvantage on it — decided before the roll. Returns whether disadvantage applies. */
export function shadowyDodge(state: CombatState, attacker: CombatantState, target: CombatantState, adv: "adv" | "dis" | "flat"): boolean {
  if (state.inReaction || adv !== "flat") return false;
  for (const r of target.ref.reactions) {
    if (classify(r) !== "shadowyDodge" || !ready(state, target, r)) continue;
    const ok = decideReaction(
      state, target, "deflectAttack",
      `${attacker.name} is attacking ${target.name} — Shadowy Dodge imposes disadvantage on the roll.`,
      "Shadowy Dodge", "Take the attack",
    );
    if (!ok) return false;
    consume(target, r);
    say(state, `${target.name} slips into shadow (Shadowy Dodge)`, target.id);
    return true;
  }
  return false;
}

/**
 * Spirit Shield (Path of the Ancestral Guardian): while raging, use your reaction to reduce damage another creature
 * you can see within 30 ft is about to take by 2d6 (3d6 at 10th, 4d6 at 14th). Vengeful Ancestors (14th) sends the
 * prevented amount back at the attacker as force damage. Returns the (possibly reduced) amount.
 */
export function spiritShield(state: CombatState, target: CombatantState, amount: number, sourceId?: string): number {
  if (state.inReaction || amount < 5) return amount;
  for (const b of livingAllies(state, target)) {
    if (b.id === target.id || b.reactionUsed || !canTakeReactions(b) || isIncapacitated(b)) continue;
    const rule = b.ref.specialRules.find((r) => r.rule === "spiritShield");
    if (!rule || rule.rule !== "spiritShield" || !b.effects.some((e) => e.name === "rage")) continue;
    if (state.distanceFt && state.distanceFt(b, target) > 30.001) continue;
    const ok = decideReaction(
      state, b, "spiritShield",
      `${target.name} is about to take ${amount} damage — ${b.name}'s Spirit Shield (${rule.dice}) can soak some of it.`,
      "Use Spirit Shield", "Let it land",
    );
    if (!ok) continue;
    b.reactionUsed = true;
    const m = rule.dice.match(/(\d+)d(\d+)/);
    const soaked = Math.min(amount, m ? state.rng.dice(Number(m[1]), Number(m[2])) : 0);
    say(state, `${b.name}'s ancestral spirits soak ${soaked} damage meant for ${target.name}`, b.id);
    const src = sourceId ? state.units.get(sourceId) : undefined;
    if (rule.vengeful && src && src.alive && src.side !== b.side && soaked > 0) {
      state.inReaction = true;
      try {
        runAutomation([{ type: "damage", amount: String(soaked), damageType: "force" }], { state, source: b, scope: [src], last: {}, depth: 0 });
      } finally {
        state.inReaction = false;
      }
    }
    return amount - soaked;
  }
  return amount;
}

/** Uncanny Dodge — halve a single attack's damage. Returns the (possibly reduced) amount. */
export function reduceIncomingDamage(
  state: CombatState,
  target: CombatantState,
  amount: number,
  viaAttack: boolean,
  melee = false,
): number {
  if (state.inReaction || amount < 8) return amount;
  for (const r of target.ref.reactions) {
    // Parry: a superiority die + Dex off a melee attack's damage
    if (classify(r) === "parry" && melee && ready(state, target, r)) {
      const rule = target.ref.specialRules.find((x) => x.rule === "parry");
      if (rule && rule.rule === "parry") {
        const m = rule.dice.match(/(\d+)d(\d+)/);
        const ok = decideReaction(
          state, target, "uncannyDodge",
          `${target.name} is about to take ${amount} damage from a melee attack — Parry reduces it by ${rule.dice} + ${rule.bonus}.`,
          "Parry", "Take it full",
        );
        if (!ok) return amount;
        consume(target, r);
        const cut = (m ? state.rng.dice(Number(m[1]), Number(m[2])) : 0) + rule.bonus;
        say(state, `${target.name} parries (-${Math.min(amount, cut)})`, target.id);
        return Math.max(0, amount - cut);
      }
    }
    if (amount < 15) continue;
    if (classify(r) !== "halveDamage" || !ready(state, target, r)) continue;
    // Uncanny Dodge and Spectral Defense answer an attack; Swarming Dispersal and Reflexive Resistance answer any damage
    if (!viaAttack && !/swarming|reflexive/.test(r.id)) continue;
    const ok = decideReaction(
      state,
      target,
      "uncannyDodge",
      `${target.name} is about to take ${amount} damage — ${r.name} halves it to ${Math.floor(amount / 2)}.`,
      r.name,
      "Take it full",
    );
    if (!ok) return amount;
    consume(target, r);
    say(state, `${target.name} rolls with it (${r.name})`, target.id);
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
      (k === "retaliateOnHit" && p.hit) ||
      (k === "retaliateOnMiss" && !p.hit && p.melee) ||
      (k === "retaliateOnMeleeHit" && p.hit && p.melee) ||
      (k === "giantKiller" && p.melee && ["large", "huge", "gargantuan"].includes(p.attacker.ref.size));
    if (!wants) continue;
    const ok = decideReaction(
      state,
      t,
      "riposte",
      `${p.attacker.name} ${p.hit ? "hit" : "missed"} ${t.name} — ${r.name} lets ${t.name} strike back.`,
      r.name,
      "Hold reaction",
    );
    if (!ok) return;
    fire(state, t, r, p.attacker);
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
  if (mover.effects.some((e) => e.mods?.noOpportunityAttacks)) return; // Disengage
  const takers = [...state.units.values()]
    .filter((u) => u.side !== mover.side && u.alive && !u.downed && u.zone === "melee" && !isIncapacitated(u))
    .filter((u) => !u.reactionUsed && canTakeReactions(u) && basicSwing(u))
    // Fancy Footwork: a creature the mover made a melee attack against this turn can't take the swing
    .filter((u) => !(mover.footwork && mover.footwork.serial === (state.turnSerial ?? 0) && mover.footwork.ids.includes(u.id)))
    .slice(0, cap);
  for (const u of takers) {
    const swing = basicSwing(u)!;
    u.reactionUsed = true;
    state.inReaction = true;
    try {
      say(state, `${u.name} takes an opportunity attack at ${mover.name}`, u.id);
      // an eagle totem's rage: opportunity attacks against you are made with disadvantage
      const hampered = mover.effects.some((e) => e.mods?.disadvantageOnOpportunityAttacks);
      const oa = hampered && swing.type === "attack" ? { ...swing, adv: "dis" as const } : swing;
      runAutomation([oa], { state, source: u, scope: [mover], last: {}, depth: 0, inAttack: true });
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
  // Magic-User's Nemesis (Monster Slayer, 11th): a creature casting a spell within 60 ft must succeed on a Wisdom save against
  // the slayer's spell save DC or the spell fails
  for (const u of state.units.values()) {
    if (u.side === caster.side) continue;
    for (const r of u.ref.reactions) {
      if (classify(r) !== "nemesis" || !ready(state, u, r)) continue;
      if (state.distanceFt && state.distanceFt(u, caster) > 60.001) continue;
      const ok = decideReaction(
        state, u, "counterspell",
        `${caster.name} is casting ${action.name} — Magic-User's Nemesis can foil it (Wisdom save).`,
        "Foil the spell", "Let it resolve",
      );
      if (!ok) continue;
      consume(u, r);
      const dc = 8 + u.ref.pb + Math.floor((u.ref.abilities.wis - 10) / 2);
      const save = rollSave(state, caster, "wis", dc, { magical: false, allowLegendaryResistance: true });
      if (!save.passed) {
        say(state, `${u.name} foils ${caster.name}'s ${action.name} (Magic-User's Nemesis)`, u.id);
        return true;
      }
      say(state, `${caster.name} shrugs off Magic-User's Nemesis`, caster.id);
      return false;
    }
  }
  return false;
}
