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
import { applyDamage, rollSave } from "./resolve";
import { isCreatureType } from "./creatureType";
import { applyHealing, CombatantState, CombatState, canTakeReactions, claimOncePerTurn, isIncapacitated, livingAllies, livingEnemies, say, syncExhaustion, type ActiveEffect, type ReactionAsk } from "./state";
import { inspireAc } from "./bardic";

/** the five damage types Absorb Elements answers */
const ELEMENTAL: readonly DamageType[] = ["acid", "cold", "fire", "lightning", "thunder"];

/** Bardic Inspiration die average by character level (d6 / d8 / d10 / d12) */
/** the faces of the Bardic Inspiration die at this bard level: d6, d8 from 5th, d10 from 10th, d12 from 15th */
export function bardicDieSides(level: number): number {
  return level >= 15 ? 12 : level >= 10 ? 10 : level >= 5 ? 8 : 6;
}

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
  | "armorOfHexes"  // Armor of Hexes — the Hexblade's cursed target hits: a d6, and a 4 or higher turns it into a miss
  | "mistyEscape"    // Misty Escape — hurt, turn invisible and slip away
  | "guardianCoil"   // Guardian Coil — shave 1d8 off damage near the tentacle
  | "infectious"    // Infectious Inspiration — a die that worked hands another to a friend
  | "divineAllegiance" // Oath of the Crown — take an ally's damage in full, no reduction possible
  | "interception"  // the Interception fighting style — soak 1d10 + PB off a nearby ally's damage
  | "gloriousDefense" // Oath of Glory — armor class up by the die, and a swing back on a miss
  | "vigilantRebuke" // Oath of the Watchers — force damage back at whoever forced a save an ally just beat
  | "soulOfVengeance" // Oath of Vengeance, 15th — a melee attack when the vowed enemy attacks
  | "rebukeTheViolent" // Oath of Redemption — an attacker within range of the paladin takes radiant damage back for hurting someone
  | "talismanRebuke" // Rebuke of the Talisman — the amulet's wearer is hit: psychic damage to the attacker, and it is pushed away
  | "chainResist"    // Investment of the Chain Master — the familiar takes damage: resistance to it
  | "deflectAttack"  // Steel Defender — impose disadvantage on an attack against its summoner / another ally
  | "protectAllyAttackRoll" // Cutting Words — spend Bardic Inspiration to subtract from an attack roll made against an ally
  | "deflectMissiles" // Monk — reduce a ranged weapon attack's damage
  | "deflectEnergy"  // Astral Self — reduce elemental damage
  | "opportunist"    // Way of Shadow — a reaction attack when a creature near you is hit
  | "redirectAttack" // Drunken Master — a miss lands on another creature instead
  | "giantKiller"    // Hunter's Giant Killer — attack a Large or larger creature right after its attack, hit or miss
  | "parry"          // Battle Master — spend a superiority die to reduce melee damage
  | "shadowyDodge"   // Gloom Stalker — impose disadvantage on an attack against you (before the roll)
  | "nemesis"        // Monster Slayer's Magic-User's Nemesis — a Wisdom save or the spell fails
  | "tailSwipe"      // Path of the Beast's tail — a d8 bonus to AC against one attack
  | "arcaneDeflection" // War Magic — +2 AC against one attack that hit / +4 to a failed save, at the price of cantrips only for a turn
  | "illusorySelf"   // Illusion — an attack against you simply misses
  | "chronalShift"   // Chronurgy — force a creature to reroll an attack roll or saving throw
  | "convergentFuture" // Chronurgy — a d20 roll is treated as the least it could have been (or one below the least) to succeed, at a level of exhaustion
  | "songOfDefense"  // Bladesinging — spend a spell slot to cut damage by 5 per slot level
  | "violentAttraction" // Graviturgy — add 1d10 to a weapon hit made by a creature near you
  | "projectedWard"  // Abjuration — your Arcane Ward soaks damage someone else takes
  | "instinctiveCharm" // Enchantment — an attacker that fails a Wisdom save must attack another creature
  | "cosmicOmen"     // Stars — a d6 added to (Weal) or taken from (Woe) a creature's d20 roll
  | "haloOfSpores"   // Spores — necrotic damage to a creature that moves near you or starts its turn there
  | "fungalInfestation" // Spores — a Small or Medium beast or humanoid that dies near you rises as a zombie
  | "cauterizingFlames" // Wildfire — spectral flames where a creature dies heal or burn whoever steps in
  | "wardingFlare"    // Light — disadvantage on an attack against you (or, later, an ally), before the roll
  | "sentinel"        // Grave — a critical hit against you or an ally becomes a normal hit
  | "dampenElements" // Nature — resistance for one instance of elemental damage to a creature within 30 ft
  | "warGodsBlessing" // War — +10 to an ally's attack roll
  | "unknown";

function classify(r: Action): RKind {
  const id = r.id.toLowerCase();
  const tr = (r.trigger ?? "").toLowerCase().replace(/\s+/g, "");
  if (id === "shield") return "shieldAc";
  if (id.includes("weight-of-ages") || id.includes("weightofages")) return "negateHit";
  if (id.includes("uncanny") || id.includes("spectral-defense") || id.includes("swarming-dispersal") || id.includes("reflexive-resistance")) return "halveDamage";
  if (id.includes("shadowy-dodge")) return "shadowyDodge";
  if (id === "parry") return "parry";
  if (id === "deflect-missiles") return "deflectMissiles";
  if (id === "deflect-energy") return "deflectEnergy";
  if (id === "opportunist") return "opportunist";
  if (id === "redirect-attack") return "redirectAttack";
  if (id === "sun-shield") return "retaliateOnMeleeHit";
  if (id.includes("giant-killer")) return "giantKiller";
  if (id.includes("magic-users-nemesis")) return "nemesis";
  if (id.includes("counterspell")) return "counterspell";
  if (id.includes("absorb-elements") || id.includes("absorbelements") || tr.includes("tookelementaldamage")) return "absorbElements";
  if (id.includes("hellish-rebuke") || id.includes("hellishrebuke")) return "onDamaged";
  if (id.includes("riposte")) return tr.includes("missed") ? "retaliateOnMiss" : "retaliateOnHit";
  if (id.includes("storms-fury") || id.includes("retaliation")) return "retaliateOnMeleeHit";
  if (id.includes("raging-storm")) return "retaliateOnMeleeHit";
  if (id.includes("tail-swipe")) return "tailSwipe";
  if (id === "arcane-deflection") return "arcaneDeflection";
  if (id === "illusory-self") return "illusorySelf";
  if (id === "chronal-shift") return "chronalShift";
  if (id === "convergent-future") return "convergentFuture";
  if (id === "song-of-defense") return "songOfDefense";
  if (id === "violent-attraction") return "violentAttraction";
  if (id === "projected-ward") return "projectedWard";
  if (id === "instinctive-charm") return "instinctiveCharm";
  if (id === "cosmic-omen") return "cosmicOmen";
  if (id === "halo-of-spores") return "haloOfSpores";
  if (id === "fungal-infestation") return "fungalInfestation";
  if (id === "cauterizing-flames") return "cauterizingFlames";
  if (id === "warding-flare" || id === "improved-flare") return "wardingFlare";
  if (id === "sentinel-at-deaths-door") return "sentinel";
  if (id === "entropic-ward") return "wardingFlare";
  if (id === "armor-of-hexes") return "armorOfHexes";
  if (id === "misty-escape") return "mistyEscape";
  if (id === "guardian-coil") return "guardianCoil";
  if (id === "rebuke-of-the-talisman") return "talismanRebuke";
  if (id === "infectious-inspiration") return "infectious";
  if (id === "divine-allegiance") return "divineAllegiance";
  if (id === "interception") return "interception";
  if (id === "glorious-defense") return "gloriousDefense";
  if (id === "vigilant-rebuke") return "vigilantRebuke";
  if (id === "soul-of-vengeance") return "soulOfVengeance";
  if (id === "aura-of-the-guardian") return "divineAllegiance"; // the same mechanic as Divine Allegiance: take an ally's damage in full
  if (id === "rebuke-the-violent") return "rebukeTheViolent";
  if (id === "chain-master-resistance") return "chainResist";
  if (id === "dampen-elements") return "dampenElements";
  if (id === "war-gods-blessing") return "warGodsBlessing";
  if (id === "wrath-of-the-storm") return "retaliateOnMeleeHit";
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

/** a reaction spell whose effect is an engine hook (Counterspell, Absorb Elements) still feeds an Arcane Ward when it is cast */
function feedWard(state: CombatState, u: CombatantState, r: Action): void {
  const nodes = r.automation.filter((n) => n.type === "arcaneWard");
  if (nodes.length) runAutomation(nodes, { state, source: u, scope: [u], last: {}, depth: 0 });
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
export function reactToFailedSave(
  state: CombatState, target: CombatantState, rollTotal: number, dc: number,
  mod = 0, stakes: "damage" | "control" | "lock" = "damage",
): boolean {
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

  // Cosmic Omen — Weal (Stars): a d6 added to the save of a creature within 30 ft
  {
    const c = omenReactor(state, target, target.side, "weal");
    if (c && dc - rollTotal <= 5 && dc > rollTotal) {
      const ok = decideReaction(state, c.u, "flashOfGenius", `${target.name} fails a saving throw (${rollTotal} vs DC ${dc}) — ${c.u.name}'s Weal adds a d6.`, "Cosmic Omen", "Let it fail");
      if (ok) {
        consume(c.u, c.r);
        const d = state.rng.dice(1, 6);
        say(state, `${c.u.name}'s omen is Weal: +${d} for ${target.name}`, c.u.id);
        if (rollTotal + d >= dc) return true;
      }
    }
  }

  // Arcane Deflection (War Magic): +4 to a save you just failed, at the price of cantrips only for a turn — worth it for control, not for damage
  if (stakes !== "damage") {
    const ad = target.ref.reactions.find((x) => classify(x) === "arcaneDeflection");
    if (ad && ready(state, target, ad) && rollTotal + 4 >= dc) {
      const ok = decideReaction(state, target, "flashOfGenius", `${target.name} fails a saving throw (${rollTotal} vs DC ${dc}) — Arcane Deflection adds +4.`, "Arcane Deflection", "Let it fail");
      if (ok) {
        fire(state, target, ad);
        say(state, `${target.name} deflects the effect (+4)`, target.id);
        return true;
      }
    }
  }

  // Chronal Shift (Chronurgy): a creature within 30 ft makes the roll again — the new roll stands, but a failure can't get worse
  if (stakes !== "damage") {
    for (const a of livingAllies(state, target)) {
      const r = a.ref.reactions.find((x) => classify(x) === "chronalShift");
      if (!r || !ready(state, a, r)) continue;
      if (a.id !== target.id && state.distanceFt && state.distanceFt(a, target) > 30.001) continue;
      if ((21 - (dc - mod)) / 20 < 0.3) continue; // hardly worth it
      const ok = decideReaction(state, a, "flashOfGenius", `${target.name} fails a saving throw (${rollTotal} vs DC ${dc}) — ${a.name}'s Chronal Shift makes it roll again.`, "Chronal Shift", "Let it fail");
      if (!ok) continue;
      consume(a, r);
      const again = state.rng.d20();
      say(state, `${a.name} shifts time for ${target.name} (rerolls ${again}${mod >= 0 ? "+" : ""}${mod})`, a.id);
      return again + mod >= dc;
    }
  }

  // Convergent Future (Chronurgy, 14th): treat the roll as the least that would have succeeded — a level of exhaustion, kept for a save that would take the creature out of the fight
  if (stakes === "lock") {
    for (const a of livingAllies(state, target)) {
      const r = a.ref.reactions.find((x) => classify(x) === "convergentFuture");
      if (!r || !ready(state, a, r) || (a.exhaustion ?? 0) >= 2) continue;
      if (state.distanceFt && a.id !== target.id && state.distanceFt(a, target) > 60.001) continue;
      const ok = decideReaction(state, a, "flashOfGenius", `${target.name} fails a saving throw that would take it out of the fight — ${a.name}'s Convergent Future turns it into a success (a level of exhaustion).`, "Convergent Future", "Let it fail");
      if (!ok) continue;
      consume(a, r);
      a.exhaustion = (a.exhaustion ?? 0) + 1;
      syncExhaustion(a);
      say(state, `${a.name} bends the future for ${target.name} (exhaustion ${a.exhaustion})`, a.id);
      return true;
    }
  }
  return false;
}

/**
 * Chronal Shift / Convergent Future turned on an ENEMY's saving throw: after a creature within 30 ft makes a saving throw against one of your
 * side's control effects and succeeds, force it to roll again ("reroll"), or (Convergent Future, for an effect that would take it out of the
 * fight) treat the roll as one below the minimum needed ("fail"). A save it already passed can't get better, so the reroll is free upside.
 */
export function enemySaveDisrupt(state: CombatState, saver: CombatantState, stakes: "damage" | "control" | "lock"): "reroll" | "fail" | undefined {
  if (state.inReaction || stakes === "damage") return undefined;
  for (const w of state.units.values()) {
    if (w.side === saver.side || !w.alive || w.downed) continue;
    const cs = w.ref.reactions.find((x) => classify(x) === "chronalShift");
    if (cs && ready(state, w, cs) && (!state.distanceFt || state.distanceFt(w, saver) <= 30.001)) {
      const ok = decideReaction(state, w, "flashOfGenius", `${saver.name} shrugged off ${w.name}'s spell — Chronal Shift makes it roll again.`, "Chronal Shift", "Let it stand");
      if (!ok) continue;
      consume(w, cs);
      say(state, `${w.name} shifts time — ${saver.name} must roll again`, w.id);
      return "reroll";
    }
    const cf = w.ref.reactions.find((x) => classify(x) === "convergentFuture");
    if (stakes === "lock" && cf && ready(state, w, cf) && (w.exhaustion ?? 0) < 2 && (!state.distanceFt || state.distanceFt(w, saver) <= 60.001)) {
      const ok = decideReaction(state, w, "flashOfGenius", `${saver.name} shrugged off ${w.name}'s spell — Convergent Future can turn that into a failure (a level of exhaustion).`, "Convergent Future", "Let it stand");
      if (!ok) continue;
      consume(w, cf);
      w.exhaustion = (w.exhaustion ?? 0) + 1;
      syncExhaustion(w);
      say(state, `${w.name} bends the future — ${saver.name} fails after all (exhaustion ${w.exhaustion})`, w.id);
      return "fail";
    }
  }
  return undefined;
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
  p: { target: CombatantState; attacker?: CombatantState; hitMargin: number; crit: boolean; face?: number; toHit?: number; ac?: number; critRange?: number },
): { negated: boolean; shielded: boolean; face?: number; crit?: boolean } {
  const t = p.target;
  if (state.inReaction || !t.alive || t.downed) return { negated: false, shielded: false };
  const wouldHit = p.crit || p.hitMargin >= 0;
  if (!wouldHit) return { negated: false, shielded: false };
  // Sentinel at Death's Door: a critical hit becomes a normal one (and the hit itself may still be answered below)
  if (p.crit && sentinelAtDeathsDoor(state, t)) return { negated: false, shielded: false, crit: false };
  // Combat Inspiration (Valor): a held Bardic Inspiration die added to armor class as a reaction
  if (!p.crit && inspireAc(state, t, p.hitMargin)) return { negated: true, shielded: false };
  // Glorious Defense (Glory, 15th): another paladin's Charisma modifier added to the defender's armor class
  if (!p.crit && gloriousDefense(state, t, p.hitMargin, p.attacker)) return { negated: true, shielded: false };

  for (const r of t.ref.reactions) {
    if (!ready(state, t, r)) continue;
    const k = classify(r);
    // Armor of Hexes (Hexblade, 10th): "When the target cursed by your Hexblade's Curse hits you with an attack roll, you can use your reaction to roll a d6. On a 4 or higher, the attack instead misses you."
    if (k === "armorOfHexes" && p.attacker && p.attacker.effects.some((e) => e.name === "hexblades-curse" && e.sourceId === t.id)) {
      const ok = decideReaction(state, t, "deflectAttack", `${p.attacker.name}, cursed by you, is about to hit ${t.name} — Armor of Hexes: a d6, and a 4 or higher makes it miss.`, "Armor of Hexes", "Take the hit");
      if (!ok) continue;
      consume(t, r);
      const d = state.rng.dice(1, 6);
      if (d >= 4) { say(state, `${t.name}'s hex turns the blow aside (Armor of Hexes, rolled ${d})`, t.id); return { negated: true, shielded: false }; }
      say(state, `${t.name}'s Armor of Hexes fails to turn the blow (rolled ${d})`, t.id);
      continue;
    }
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
    if (k === "illusorySelf" && (p.crit || t.hp <= t.maxHp * 0.75)) {
      const ok = decideReaction(state, t, "shield", `An attack is about to hit ${t.name} — an illusory double takes it instead.`, "Illusory Self", "Take the hit");
      if (!ok) continue;
      consume(t, r);
      say(state, `${t.name}'s illusory double takes the blow (Illusory Self)`, t.id);
      return { negated: true, shielded: false };
    }
    if (k === "arcaneDeflection" && !p.crit && p.hitMargin < 2 && t.hp < t.maxHp * 0.7) {
      const ok = decideReaction(state, t, "shield", `An attack hits ${t.name} by ${p.hitMargin} — Arcane Deflection (+2 AC) turns it into a miss, but no more than cantrips until the end of the next turn.`, "Arcane Deflection", "Take the hit");
      if (!ok) continue;
      fire(state, t, r); // the cantrips-only lockout
      t.effects.push({ name: "arcane-deflection", mods: { acBonus: 2 }, expiresRound: state.round + 1, sourceId: t.id });
      say(state, `${t.name} deflects the blow (+2 AC)`, t.id);
      return { negated: false, shielded: true };
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

  // Cosmic Omen — Woe (Stars): a d6 taken off an attack that only just hits
  if (!p.crit && p.hitMargin <= 5 && p.hitMargin >= 0) {
    const c = omenReactor(state, t, t.side, "woe");
    if (c && ready(state, c.u, c.r)) {
      const ok = decideReaction(state, c.u, "shield", `An attack hits ${t.name} by ${p.hitMargin} — ${c.u.name}'s Woe subtracts a d6 from the roll.`, "Cosmic Omen", "Take the hit");
      if (ok) {
        consume(c.u, c.r);
        const d = state.rng.dice(1, 6);
        say(state, `${c.u.name}'s omen is Woe: -${d} from the attack`, c.u.id);
        if (d > p.hitMargin) return { negated: true, shielded: false };
      }
    }
  }

  // Chronal Shift (Chronurgy): a creature within 30 ft rolls the attack again — the new roll stands, so it can only be worth it when the hit is
  // close, a crit, or the target is hurt. Convergent Future (14th) simply decides it misses, at a level of exhaustion, for a crit or a near-dead target.
  if (p.face !== undefined && p.toHit !== undefined && p.ac !== undefined) {
    const crange = p.critRange ?? 20;
    for (const a of livingAllies(state, t)) {
      const cs = a.ref.reactions.find((x) => classify(x) === "chronalShift");
      if (cs && ready(state, a, cs) && (p.crit || p.hitMargin <= 6 || t.hp < t.maxHp * 0.4) &&
          (a.id === t.id || !state.distanceFt || state.distanceFt(a, t) <= 30.001)) {
        const ok = decideReaction(state, a, "shield", `An attack hits ${t.name} (rolled ${p.face}) — ${a.name}'s Chronal Shift makes it roll again.`, "Chronal Shift", "Take the hit");
        if (!ok) continue;
        consume(a, cs);
        const nf = state.rng.d20();
        const hit2 = nf !== 1 && (nf >= crange || nf + p.toHit >= p.ac);
        say(state, `${a.name} shifts time — the attack is rerolled (${p.face} -> ${nf})${hit2 ? "" : ", and misses"}`, a.id);
        return { negated: !hit2, shielded: false, face: nf };
      }
      const cf = a.ref.reactions.find((x) => classify(x) === "convergentFuture");
      if (cf && ready(state, a, cf) && (a.exhaustion ?? 0) < 2 && (p.crit || t.hp < t.maxHp * 0.35) &&
          (a.id === t.id || !state.distanceFt || state.distanceFt(a, t) <= 60.001)) {
        const ok = decideReaction(state, a, "shield", `An attack that could finish ${t.name} hits — ${a.name}'s Convergent Future turns it into a miss (a level of exhaustion).`, "Convergent Future", "Take the hit");
        if (!ok) continue;
        consume(a, cf);
        a.exhaustion = (a.exhaustion ?? 0) + 1;
        syncExhaustion(a);
        say(state, `${a.name} bends the future — the attack misses (exhaustion ${a.exhaustion})`, a.id);
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
  extra: { ranged?: boolean; type?: DamageType } = {},
): number {
  if (state.inReaction || amount < 8) return amount;
  for (const r of target.ref.reactions) {
    // Deflect Missiles / Deflect Energy: 1d10 + a bonus off a ranged weapon attack / an elemental hit
    const kind = classify(r);
    if ((kind === "deflectMissiles" && extra.ranged) || (kind === "deflectEnergy" && extra.type && ["acid", "cold", "fire", "force", "lightning", "thunder"].includes(extra.type))) {
      if (!ready(state, target, r)) continue;
      const rule = target.ref.specialRules.find((x) => x.rule === (kind === "deflectMissiles" ? "deflectMissiles" : "deflectEnergy"));
      if (!rule || (rule.rule !== "deflectMissiles" && rule.rule !== "deflectEnergy")) continue;
      const ok = decideReaction(state, target, "uncannyDodge",
        `${target.name} is about to take ${amount} damage — ${r.name} reduces it by 1d10 + ${rule.bonus}.`, r.name, "Take it full");
      if (!ok) return amount;
      consume(target, r);
      const cut = state.rng.dice(1, 10) + rule.bonus;
      say(state, `${target.name} uses ${r.name} (-${Math.min(amount, cut)})`, target.id);
      return Math.max(0, amount - cut);
    }
    // Song of Defense (Bladesinging, 10th): while the Bladesong is up, a reaction and a spell slot cut the damage by five times the slot's level
    if (kind === "songOfDefense") {
      if (!ready(state, target, r) || !target.effects.some((e) => e.name === "bladesong")) continue;
      let slot = 0; // the smallest slot that soaks all of it, else the biggest there is
      for (let lvl = 1; lvl <= 9; lvl++) {
        if ((target.resources.get(`slot${lvl}`) ?? 0) <= 0) continue;
        slot = lvl;
        if (5 * lvl >= amount) break;
      }
      if (!slot || slot * 5 < 8) continue;
      const ok = decideReaction(state, target, "uncannyDodge",
        `${target.name} is about to take ${amount} damage — Song of Defense spends a ${slot}${slot === 1 ? "st" : slot === 2 ? "nd" : slot === 3 ? "rd" : "th"}-level slot to cut it by ${5 * slot}.`, r.name, "Take it full");
      if (!ok) return amount;
      consume(target, r);
      target.resources.set(`slot${slot}`, (target.resources.get(`slot${slot}`) ?? 0) - 1);
      say(state, `${target.name} sings a Song of Defense (-${Math.min(amount, 5 * slot)})`, target.id);
      return Math.max(0, amount - 5 * slot);
    }
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
  dampenElements(state, target, type);
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
    feedWard(state, target, r);
    return;
  }
}

// --------------------------------------------------------- attack hit or missed

/** Riposte — hit back when hit, or when a melee attack misses. */
/**
 * Opportunist (Way of Shadow, 17th): whenever a creature within 5 ft of you is hit by an attack made by a creature other than you, your
 * reaction makes a melee attack against that creature. Used against enemies (an ally's hit on a creature beside you).
 */
export function opportunist(state: CombatState, attacker: CombatantState, target: CombatantState): void {
  if (state.inReaction || !target.alive) return;
  for (const m of state.units.values()) {
    if (m.id === attacker.id || m.id === target.id || m.side === target.side || !m.alive || m.downed || isIncapacitated(m)) continue;
    const r = m.ref.reactions.find((x) => classify(x) === "opportunist");
    if (!r || !ready(state, m, r)) continue;
    const near = state.distanceFt ? state.distanceFt(m, target) <= 5.001 : m.zone === "melee" && target.zone === "melee";
    if (!near) continue;
    const ok = decideReaction(state, m, "riposte", `${attacker.name} hit ${target.name} — Opportunist lets ${m.name} strike it.`, r.name, "Hold reaction");
    if (!ok) continue;
    fire(state, m, r, target);
    return;
  }
}

export function reactToAttackResolved(
  state: CombatState,
  p: { attacker: CombatantState; target: CombatantState; hit: boolean; melee: boolean },
): void {
  const t = p.target;
  if (state.inReaction || !t.alive || t.downed || !p.attacker.alive) return;
  if (p.hit) rebukeOfTheTalisman(state, p.attacker, t);
  for (const r of t.ref.reactions) {
    if (!ready(state, t, r)) continue;
    const k = classify(r);
    // Redirect Attack (Drunken Master): a melee attack that missed you hits another creature beside you instead
    if (k === "redirectAttack" && !p.hit && p.melee) {
      const swing = basicSwing(p.attacker);
      const others = livingEnemies(state, t).length ? [...state.units.values()].filter((x) => x.side === p.attacker.side && x.id !== p.attacker.id && x.alive && !x.downed &&
        (state.distanceFt ? state.distanceFt(t, x) <= 5.001 : x.zone === "melee")) : [];
      if (swing && swing.type === "attack" && others.length) {
        const ok = decideReaction(state, t, "riposte", `${p.attacker.name} missed ${t.name} — ${r.name} can make that attack hit ${others[0].name}.`, r.name, "Hold reaction");
        if (!ok) return;
        consume(t, r);
        say(state, `${t.name} redirects the blow onto ${others[0].name}`, t.id);
        state.inReaction = true;
        try { runAutomation(swing.onHit, { state, source: p.attacker, scope: [others[0]], last: {}, depth: 0, inAttack: true }); } finally { state.inReaction = false; }
        return;
      }
      continue;
    }
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
    // Misty Escape (Archfey, 6th): "When you take damage, you can use your reaction to turn invisible and teleport up to 60 feet to an unoccupied space you can see"
    if (k === "mistyEscape" && p.fromCreature && p.amount > 0) {
      const ok = decideReaction(state, t, "retaliate", `${t.name} was hit for ${p.amount} — Misty Escape turns them invisible and whisks them 60 feet away.`, "Misty Escape", "Stay put");
      if (!ok) continue;
      consume(t, r);
      t.conditions.set("invisible", { expiresRound: state.round + 1, sourceId: t.id }); // until the start of their next turn (or until they attack or cast)
      t.conditions.delete("grappled");
      t.conditions.delete("restrained");
      t.zone = "ranged";
      say(state, `${t.name} vanishes in a swirl of mist (Misty Escape)`, t.id);
      state.moveCreature?.({ kind: "teleportSelf", source: t, distance: 60, escape: true }); // battle mode: really to the far side of the fight
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

/**
 * Instinctive Charm (Enchantment, 6th): "when a creature you can see within 30 feet of you makes an attack roll against you, you can use your
 * reaction to divert the attack, provided that another creature is within the attack's range. The attacker must make a Wisdom saving throw
 * against your wizard spell save DC. On a failed save, the attacker must target the creature that is closest to it, not including you or itself.
 * ... You can't use this feature on the same attacker again until you finish a long rest." Called before the attack roll; returns the creature
 * the attack goes to instead, if the save fails. (Monte-Carlo has no distances, so the "closest" creature is one in the attacker's own zone.)
 */
export function instinctiveCharm(state: CombatState, attacker: CombatantState, target: CombatantState): CombatantState | undefined {
  if (state.inReaction || attacker.side === target.side) return undefined;
  const r = target.ref.reactions.find((x) => classify(x) === "instinctiveCharm");
  if (!r || !ready(state, target, r)) return undefined;
  if (attacker.ref.conditionImmunities.includes("charmed")) return undefined;
  if (attacker.effects.some((e) => e.name === "charm-diverted" && e.sourceId === target.id)) return undefined; // once per attacker until a long rest
  const others = [...state.units.values()].filter((u) => u.alive && !u.downed && u.id !== attacker.id && u.id !== target.id);
  if (!others.length) return undefined;
  let pick: CombatantState;
  if (state.distanceFt) {
    pick = others.sort((a, b) => state.distanceFt!(attacker, a) - state.distanceFt!(attacker, b))[0];
  } else {
    const near = others.filter((u) => u.zone === attacker.zone);
    const pool = near.length ? near : others;
    pick = pool[state.rng.int(0, pool.length - 1)];
  }
  const ok = decideReaction(state, target, "deflectAttack", `${attacker.name} is attacking ${target.name} — Instinctive Charm can turn it on ${pick.name} (Wisdom save).`, "Instinctive Charm", "Take the attack");
  if (!ok) return undefined;
  consume(target, r);
  attacker.effects.push({ name: "charm-diverted", expiresRound: Infinity, sourceId: target.id });
  const dc = 8 + target.ref.pb + Math.floor((target.ref.abilities[target.ref.spellAbility ?? "int"] - 10) / 2);
  const save = rollSave(state, attacker, "wis", dc, { magical: true, stakes: "control", conditions: ["charmed"], sourceId: target.id });
  if (save.passed) return undefined;
  say(state, `${attacker.name} is turned on ${pick.name} instead of ${target.name} (Instinctive Charm)`, target.id);
  return pick;
}

/**
 * Spirit Totem — Hawk Spirit (Shepherd): "When a creature makes an attack roll against a target in the spirit's aura, you can use your reaction to grant
 * advantage to that attack roll." Called before the attack roll; returns whether the attacker gets advantage. (The aura is taken to cover the druid's side.)
 */
export function hawkSpirit(state: CombatState, attacker: CombatantState, target: CombatantState): boolean {
  if (state.inReaction || attacker.side === target.side) return false;
  for (const u of state.units.values()) {
    if (u.side !== attacker.side || !u.alive || u.downed || u.reactionUsed || !canTakeReactions(u)) continue;
    if (!u.effects.some((e) => e.name === "spirit-hawk")) continue;
    if (state.distanceFt && state.distanceFt(u, target) > 30.001) continue;
    u.reactionUsed = true;
    say(state, `${u.name}'s hawk spirit lends ${attacker.name} its sight (advantage)`, u.id);
    return true;
  }
  return false;
}

/** the creature on `side` who has a Cosmic Omen reaction ready and an omen of `omen`, within 30 ft of `near` */
function omenReactor(state: CombatState, near: CombatantState, side: CombatantState["side"], omen: "weal" | "woe"): { u: CombatantState; r: Action } | undefined {
  for (const u of state.units.values()) {
    if (u.side !== side || u.omen !== omen || !u.alive || u.downed) continue;
    const r = u.ref.reactions.find((x) => classify(x) === "cosmicOmen");
    if (!r || !ready(state, u, r)) continue;
    if (state.distanceFt && u.id !== near.id && state.distanceFt(u, near) > 30.001) continue;
    return { u, r };
  }
  return undefined;
}

/**
 * Cosmic Omen — Weal (Stars, 6th): "...you can use your reaction to roll a d6 and add the number rolled to the total" of a d20 roll made by a creature within 30
 * feet. `deficit` is how far the roller's total fell short; returns whether the d6 makes up the difference.
 */
export function cosmicWeal(state: CombatState, roller: CombatantState, deficit: number): boolean {
  if (state.inReaction || deficit > 5 || deficit <= 0) return false;
  const c = omenReactor(state, roller, roller.side, "weal");
  if (!c) return false;
  consume(c.u, c.r);
  const d = state.rng.dice(1, 6);
  say(state, `${c.u.name}'s omen is Weal: +${d} for ${roller.name}`, c.u.id);
  return d >= deficit;
}

/**
 * Cosmic Omen — Woe: "...roll a d6 and subtract the number rolled from the total." `surplus` is how far the enemy's total cleared the number it needed;
 * returns whether the d6 takes it below (so the attack misses, or the save fails).
 */
export function cosmicWoe(state: CombatState, roller: CombatantState, surplus: number): boolean {
  if (state.inReaction || surplus >= 6 || surplus < 0) return false;
  const c = omenReactor(state, roller, roller.side === "party" ? "monster" : "party", "woe");
  if (!c) return false;
  consume(c.u, c.r);
  const d = state.rng.dice(1, 6);
  say(state, `${c.u.name}'s omen is Woe: -${d} from ${roller.name}`, c.u.id);
  return d > surplus;
}

/**
 * Halo of Spores (Spores, 2nd): "When a creature you can see moves into a space within 10 feet of you or starts its turn there, you can use your reaction to
 * deal 1d4 necrotic damage to that creature unless it succeeds on a Constitution saving throw against your spell save DC." Called as a hostile creature's
 * turn begins. (Creatures moving up to the druid mid-turn aren't watched for.)
 */
export function haloOfSpores(state: CombatState, mover: CombatantState): void {
  if (state.inReaction || !mover.alive || mover.downed) return;
  for (const u of state.units.values()) {
    if (u.side === mover.side || !u.alive || u.downed) continue;
    const r = u.ref.reactions.find((x) => classify(x) === "haloOfSpores");
    if (!r || !ready(state, u, r)) continue;
    const near = state.distanceFt ? state.distanceFt(u, mover) <= 10.001 : u.zone === "melee" && mover.zone === "melee";
    if (!near) continue;
    fire(state, u, r, mover);
    return;
  }
}

/**
 * Death reactions: a Small or Medium beast or humanoid dying within 10 ft of a Spores druid rises as a zombie with 1 hit point (Fungal Infestation, a use of
 * a Wisdom-modifier pool), and a Wildfire druid's Cauterizing Flames heal the most hurt ally for 2d10 + Wisdom (a use of a proficiency-bonus pool; the flames
 * on the page wait for someone to step into them, taken here as an ally being healed at once). Called when a creature dies.
 */
export function reactToDeath(state: CombatState, slain: CombatantState): void {
  if (state.inReaction) return;
  keeperOfSouls(state, slain);
  for (const u of state.units.values()) {
    if (!u.alive || u.downed || u.id === slain.id) continue;
    for (const r of u.ref.reactions) {
      const k = classify(r);
      if (k !== "fungalInfestation" && k !== "cauterizingFlames") continue;
      if (!ready(state, u, r)) continue;
      const range = k === "fungalInfestation" ? 10 : 30;
      if (state.distanceFt ? state.distanceFt(u, slain) > range + 0.001 : false) continue;
      if (k === "fungalInfestation" && (!isCreatureType(slain.ref, "beast", "humanoid") || !["small", "medium", "tiny"].includes(slain.ref.size))) continue;
      if (k === "cauterizingFlames" && !livingAllies(state, u).some((a) => a.hp < a.maxHp * 0.6)) continue;
      const ok = decideReaction(state, u, "riposte", `${slain.name} dies near ${u.name} — ${r.name}.`, r.name, "Let it lie");
      if (!ok) continue;
      fire(state, u, r);
      return;
    }
  }
}

/**
 * Warding Flare (Light, 1st): "When you are attacked by a creature within 30 feet of you that you can see, you can use your reaction to impose disadvantage on the
 * attack roll, causing light to flare before the attacker... An attacker that can't be blinded is immune." Improved Flare (6th): the same when a creature attacks
 * someone other than you. Called before the attack roll; returns whether disadvantage is imposed.
 */
export function wardingFlare(state: CombatState, attacker: CombatantState, target: CombatantState, adv: "adv" | "dis" | "flat"): boolean {
  if (state.inReaction || adv === "dis" || attacker.side === target.side) return false;
  for (const u of state.units.values()) {
    if (u.side !== target.side || !u.alive || u.downed) continue;
    for (const r of u.ref.reactions) {
      if (classify(r) !== "wardingFlare" || !ready(state, u, r)) continue;
      const entropic = r.id === "entropic-ward"; // Great Old One, 6th: "When a creature makes an attack roll against you" (no range), and it needn't be blindable
      if (u.id !== target.id && r.id !== "improved-flare") continue; // before the 6th level only the flare's owner is protected
      if (!entropic && attacker.ref.conditionImmunities.includes("blinded")) continue;
      if (!entropic && state.distanceFt && state.distanceFt(u, attacker) > 30.001) continue;
      const ok = entropic
        ? decideReaction(state, u, "deflectAttack", `${attacker.name} is attacking ${target.name} — Entropic Ward imposes disadvantage, and a miss gives you advantage on your next attack against it.`, "Entropic Ward", "Take the attack")
        : decideReaction(state, u, "deflectAttack", `${attacker.name} is attacking ${target.name} — Warding Flare imposes disadvantage on the roll.`, "Warding Flare", "Take the attack");
      if (!ok) continue;
      consume(u, r);
      if (entropic) { state.pendingEntropicWard = u.id; say(state, `${u.name} bends the attack aside (Entropic Ward, disadvantage)`, u.id); }
      else say(state, `${u.name}'s flare dazzles ${attacker.name} (disadvantage)`, u.id);
      return true;
    }
  }
  return false;
}

/**
 * Sentinel at Death's Door (Grave, 6th): "As a reaction when you or an ally that you can see within 30 feet of you suffers a critical hit, you can turn that attack
 * into a normal hit. Any effects triggered by a critical hit are canceled." Returns whether the crit is turned aside.
 */
export function sentinelAtDeathsDoor(state: CombatState, target: CombatantState): boolean {
  if (state.inReaction) return false;
  for (const u of state.units.values()) {
    if (u.side !== target.side || !u.alive || u.downed) continue;
    const r = u.ref.reactions.find((x) => classify(x) === "sentinel");
    if (!r || !ready(state, u, r)) continue;
    if (u.id !== target.id && state.distanceFt && state.distanceFt(u, target) > 30.001) continue;
    consume(u, r);
    say(state, `${u.name} turns the critical hit into a normal one (Sentinel at Death's Door)`, u.id);
    return true;
  }
  return false;
}

/**
 * War God's Blessing (War, 6th): "When a creature within 30 feet of you makes an attack roll, you can use your reaction to grant that creature a +10 bonus to the
 * roll, using your Channel Divinity" (a use of it is the reaction's cost). `deficit` is how far the roll fell short; returns whether +10 turns it into a hit.
 */
export function warGodsBlessing(state: CombatState, roller: CombatantState, deficit: number): boolean {
  if (state.inReaction || deficit <= 0 || deficit > 10) return false;
  for (const u of state.units.values()) {
    if (u.side !== roller.side || u.id === roller.id || !u.alive || u.downed) continue;
    const r = u.ref.reactions.find((x) => classify(x) === "warGodsBlessing");
    if (!r || !ready(state, u, r)) continue;
    if (state.distanceFt && state.distanceFt(u, roller) > 30.001) continue;
    consume(u, r);
    say(state, `${u.name} blesses ${roller.name}'s blow (+10)`, u.id);
    return true;
  }
  return false;
}

/**
 * Protective Bond (Peace, 6th): "When a creature affected by your Emboldening Bond feature is about to take damage, a second bonded creature within 30 feet of the
 * first can use its reaction to teleport to an unoccupied space within 5 feet of the first creature. The second creature then takes all the damage instead." Expansive
 * Bond (17th): 60 feet, and the protector has resistance to that damage. Returns the creature that takes the damage instead, if any.
 */
export function protectiveBond(state: CombatState, target: CombatantState): { protector: CombatantState; resists: boolean } | undefined {
  if (state.inReaction) return undefined;
  const bond = target.effects.find((e) => e.name === "emboldening-bond");
  if (!bond) return undefined;
  let best: CombatantState | undefined;
  let resists = false;
  for (const u of state.units.values()) {
    if (u.id === target.id || u.side !== target.side || !u.alive || u.downed || u.reactionUsed || !canTakeReactions(u)) continue;
    const e = u.effects.find((x) => x.name === "emboldening-bond" && x.sourceId === bond.sourceId && x.mods?.protectiveBondFt);
    if (!e || (state.distanceFt && state.distanceFt(u, target) > e.mods!.protectiveBondFt! + 0.001)) continue;
    if (!best || u.hp > best.hp) { best = u; resists = !!e.mods!.protectiveBondResists; }
  }
  if (!best) return undefined;
  best.reactionUsed = true;
  say(state, `${best.name} leaps in front of ${target.name} (Protective Bond)`, best.id);
  return { protector: best, resists };
}

/**
 * Dampen Elements (Nature, 6th): "When you or a creature within 30 feet of you takes acid, cold, fire, lightning, or thunder damage, you can use your reaction to
 * grant the creature resistance to that instance of the damage." Sets the one-shot resistance the damage code honours.
 */
export function dampenElements(state: CombatState, target: CombatantState, type: DamageType): void {
  if (state.inReaction || !ELEMENTAL.includes(type) || target.dampened) return;
  for (const u of state.units.values()) {
    if (u.side !== target.side || !u.alive || u.downed) continue;
    const r = u.ref.reactions.find((x) => classify(x) === "dampenElements");
    if (!r || !ready(state, u, r)) continue;
    if (u.id !== target.id && state.distanceFt && state.distanceFt(u, target) > 30.001) continue;
    consume(u, r);
    target.dampened = type;
    say(state, `${u.name} dampens the ${type} (resistance to that damage)`, u.id);
    return;
  }
}

/**
 * Keeper of Souls (Grave, 17th): "When an enemy that you can see dies within 30 feet of you, you or one ally of your choice that is within 30 feet of you regains hit
 * points equal to the enemy's number of Hit Dice... Once you use it, you can't do so again until the start of your next turn."
 */
export function keeperOfSouls(state: CombatState, slain: CombatantState): void {
  for (const u of state.units.values()) {
    if (u.side === slain.side || !u.alive || u.downed || isIncapacitated(u) || !u.ref.specialRules.some((r) => r.rule === "keeperOfSouls")) continue;
    if (u.effects.some((e) => e.name === "keeper-used")) continue;
    if (state.distanceFt && state.distanceFt(u, slain) > 30.001) continue;
    const dice = typeof slain.ref.maxHp === "string" ? Number(/^(\d+)d/.exec(slain.ref.maxHp)?.[1] ?? 0) : 0;
    const amount = dice || Math.max(1, Math.round(slain.maxHp / 5)); // a stat block with a fixed hit point total: its average Hit Die is about 5
    const hurt = [u, ...livingAllies(state, u)].filter((a) => a.hp < a.maxHp).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    if (!hurt) continue;
    u.effects.push({ name: "keeper-used", expiresRound: Infinity, sourceId: u.id, mods: { untilSourceNextTurn: true } });
    const healed = applyHealing(state, hurt, amount);
    if (healed > 0) say(state, `${u.name} gathers ${slain.name}'s soul: ${hurt.name} regains ${healed} (Keeper of Souls)`, u.id);
    return;
  }
}

/**
 * Nature's Sanctuary (Circle of the Land, 14th): "When a beast or plant creature attacks you, that creature must make a Wisdom saving throw against your druid
 * spell save DC. On a failed save, the creature must choose a different target, or the attack automatically misses. On a successful save, the creature is
 * immune to this effect for 24 hours." Called before the attack roll. Returns the creature it turns on instead, "miss" if there is no one else, or undefined
 * if the attack goes ahead.
 */
export function natureSanctuary(state: CombatState, attacker: CombatantState, target: CombatantState): CombatantState | "miss" | undefined {
  if (state.inReaction || attacker.side === target.side) return undefined;
  const rule = target.ref.specialRules.find((r) => r.rule === "natureSanctuary");
  if (!rule || rule.rule !== "natureSanctuary") return undefined;
  const feature = rule.types ? "Among the Dead" : "Nature's Sanctuary"; // the Undying warlock's version is for undead
  if (!isCreatureType(attacker.ref, ...(rule.types ?? ["beast", "plant"]))) return undefined;
  if (attacker.effects.some((e) => e.name === "sanctuary-immune" && e.sourceId === target.id)) return undefined;
  const dc = 8 + target.ref.pb + Math.floor((target.ref.abilities[target.ref.spellAbility ?? "wis"] - 10) / 2);
  const save = rollSave(state, attacker, "wis", dc, { magical: true, stakes: "control", sourceId: target.id });
  if (save.passed) {
    attacker.effects.push({ name: "sanctuary-immune", expiresRound: Infinity, sourceId: target.id }); // "immune to this effect for 24 hours"
    return undefined;
  }
  // "must choose a different target": someone else it could reach — the nearest other creature, or one in its own zone
  const others = [...state.units.values()].filter((u) => u.alive && !u.downed && u.side === target.side && u.id !== target.id && u.id !== attacker.id);
  if (!others.length) { say(state, `${attacker.name} hesitates and its attack misses ${target.name} (${feature})`, target.id); return "miss"; }
  const pick = state.distanceFt ? others.sort((a, b) => state.distanceFt!(attacker, a) - state.distanceFt!(attacker, b))[0]
    : others[state.rng.int(0, others.length - 1)];
  say(state, `${attacker.name} hesitates and turns on ${pick.name} instead (${feature})`, target.id);
  return pick;
}

/**
 * Rebuke of the Talisman (Pact of the Talisman invocation): "When the wearer of your talisman is hit by an attacker you can see within 30 feet of you, you can use your reaction to cause
 * the attacker to take psychic damage equal to your proficiency bonus, and you can push the attacker up to 10 feet away from the talisman's wearer." The reaction is the warlock's, not the wearer's.
 */
function rebukeOfTheTalisman(state: CombatState, attacker: CombatantState, wearer: CombatantState): void {
  const amulet = wearer.effects.find((e) => e.name === "talisman");
  if (!amulet) return;
  const w = state.units.get(amulet.sourceId);
  if (!w || !w.alive || w.downed || w.side !== wearer.side) return;
  const r = w.ref.reactions.find((x) => classify(x) === "talismanRebuke");
  if (!r || !ready(state, w, r)) return;
  if (state.distanceFt && state.distanceFt(w, attacker) > 30.001) return;
  const ok = decideReaction(state, w, "retaliate", `${attacker.name} hit ${wearer.name}, who wears your talisman — Rebuke of the Talisman deals ${w.ref.pb} psychic damage and pushes it away.`, "Rebuke of the Talisman", "Hold reaction");
  if (!ok) return;
  consume(w, r);
  say(state, `${w.name}'s talisman lashes out at ${attacker.name} (Rebuke of the Talisman)`, w.id);
  applyDamage(state, attacker, w.ref.pb, "psychic", { sourceId: w.id, attackerMagical: true });
  if (attacker.alive) state.moveCreature?.({ kind: "push", source: wearer, target: attacker, distance: 10 });
}

/**
 * The amulet's d4 (Pact of the Talisman, and Protection of the Talisman): "When the wearer fails an ability check [a saving throw, for Protection], they can add a d4 to the roll, potentially turning
 * the roll into a success." Uses come from the warlock's own pool (proficiency bonus times, back on a long rest). Spent on a failure the die can turn: at most 4 short.
 */
export function talismanBoost(state: CombatState, wearer: CombatantState, rollTotal: number, dc: number, resource: "talisman_checks" | "protection_of_the_talisman"): boolean {
  const amulet = wearer.effects.find((e) => e.name === "talisman");
  const w = amulet ? state.units.get(amulet.sourceId) : undefined;
  if (!w || !w.alive || (w.resources.get(resource) ?? 0) <= 0) return false;
  const shortfall = dc - rollTotal;
  if (shortfall <= 0 || shortfall > 4) return false;
  w.resources.set(resource, (w.resources.get(resource) ?? 0) - 1);
  const d = state.rng.dice(1, 4);
  say(state, `${wearer.name}'s talisman adds a d4 (+${d}${d >= shortfall ? "" : ", not enough"})`, wearer.id);
  return d >= shortfall;
}

/**
 * Investment of the Chain Master (Pact of the Chain invocation): "When the familiar takes damage, you can use your reaction to grant it resistance against that damage."
 * Returns the damage that still lands.
 */
export function chainMasterResistance(state: CombatState, familiar: CombatantState, amount: number): number {
  if (state.inReaction || familiar.summonerId === undefined || !familiar.ref.id.startsWith("familiar-") || amount < 2) return amount;
  const w = state.units.get(familiar.summonerId);
  const r = w?.ref.reactions.find((x) => classify(x) === "chainResist");
  if (!w || !r || !ready(state, w, r)) return amount;
  consume(w, r);
  const kept = Math.floor(amount / 2);
  say(state, `${w.name} shields ${familiar.name} (resistance, ${amount - kept} less)`, w.id);
  return kept;
}

/**
 * Divine Allegiance (Crown, 7th): "When a creature within 5 feet of you takes damage, you can use your reaction to cause yourself to suffer that damage instead of the creature. This feature doesn't
 * transfer any other effects that the damage might have, and it doesn't prevent damage to yourself from any source but this feature." Returns the amount the paladin has taken instead, or 0.
 */
export function divineAllegiance(state: CombatState, target: CombatantState, amount: number): CombatantState | undefined {
  if (state.inReaction || amount <= 0) return undefined;
  for (const p of livingAllies(state, target)) {
    if (p.id === target.id || p.reactionUsed || !canTakeReactions(p) || isIncapacitated(p)) continue;
    const r = p.ref.reactions.find((x) => classify(x) === "divineAllegiance");
    if (!r || !ready(state, p, r)) continue;
    if (state.distanceFt && state.distanceFt(p, target) > 5.001) continue;
    const ok = decideReaction(state, p, "spiritShield", `${target.name} is about to take ${amount} damage — ${p.name}'s Divine Allegiance can take it instead.`, "Take the damage", "Let it land");
    if (!ok) continue;
    p.reactionUsed = true;
    say(state, `${p.name} steps in and takes ${target.name}'s blow (Divine Allegiance)`, p.id);
    return p;
  }
  return undefined;
}

/**
 * The Interception fighting style: "When a creature you can see hits a target, other than you, within 5 feet of you with an attack, you can use your reaction to reduce the damage the target takes
 * by 1d10 + your proficiency bonus... You must be wielding a shield or a simple or martial weapon to use this reaction." Returns the damage that still lands.
 */
export function interceptionReduce(state: CombatState, target: CombatantState, amount: number): number {
  if (state.inReaction || amount < 4) return amount;
  for (const p of livingAllies(state, target)) {
    if (p.id === target.id || p.reactionUsed || !canTakeReactions(p) || isIncapacitated(p)) continue;
    const r = p.ref.reactions.find((x) => classify(x) === "interception");
    if (!r || !ready(state, p, r)) continue;
    if (state.distanceFt && state.distanceFt(p, target) > 5.001) continue;
    const ok = decideReaction(state, p, "spiritShield", `${target.name} is about to take ${amount} damage — ${p.name}'s Interception can soak some of it.`, "Use Interception", "Let it land");
    if (!ok) continue;
    p.reactionUsed = true;
    const cut = Math.min(amount, state.rng.dice(1, 10) + p.ref.pb);
    say(state, `${p.name} steps between them (Interception, ${cut} less)`, p.id);
    return amount - cut;
  }
  return amount;
}

/**
 * Glorious Defense (Glory, 15th): "When a creature you can see hits you or another creature within 10 feet of you with an attack, you can use your reaction to add your Charisma modifier (minimum of +1)
 * to the defender's AC against that attack, potentially causing it to miss. If the attack misses, you can then make one weapon attack against the creature that made the attack." Charisma-modifier uses.
 */
export function gloriousDefense(state: CombatState, target: CombatantState, hitMargin: number, attacker?: CombatantState): boolean {
  if (state.inReaction) return false;
  for (const p of livingAllies(state, target)) {
    if (!p.reactionUsed && canTakeReactions(p) && !isIncapacitated(p)) {
      const r = p.ref.reactions.find((x) => classify(x) === "gloriousDefense");
      if (!r || !ready(state, p, r)) continue;
      if (state.distanceFt && p.id !== target.id && state.distanceFt(p, target) > 10.001) continue;
      const bonus = Math.max(1, p.ref.pb === 6 ? 5 : 4);
      if (hitMargin >= bonus) continue;
      const ok = decideReaction(state, p, "spiritShield", `An attack hits ${target.name} by ${hitMargin} — ${p.name}'s Glorious Defense (+${bonus} AC) can turn it into a miss.`, "Use Glorious Defense", "Take the hit");
      if (!ok) continue;
      consume(p, r);
      say(state, `${p.name} turns the blow aside (Glorious Defense)`, p.id);
      // "If the attack misses, you can then make one weapon attack against the creature that made the attack"
      const swing = attacker && (state.distanceFt ? state.distanceFt(p, attacker) <= 5.001 : attacker.zone === "melee") ? basicSwing(p) : undefined;
      if (attacker && swing && swing.type === "attack") {
        state.inReaction = true;
        try { runAutomation(swing.onHit, { state, source: p, scope: [attacker], last: {}, depth: 0, inAttack: true }); } finally { state.inReaction = false; }
      }
      return true;
    }
  }
  return false;
}

/**
 * Vigilant Rebuke (Watchers, 15th): "When you or a creature within 30 feet of you succeeds on an Intelligence, Wisdom, or Charisma saving throw, you can use your reaction to deal 2d8 + your Charisma
 * modifier force damage to the creature that forced the saving throw."
 */
export function vigilantRebuke(state: CombatState, target: CombatantState, forcerId: string | undefined): void {
  if (state.inReaction || !forcerId) return;
  const forcer = state.units.get(forcerId);
  if (!forcer || !forcer.alive || forcer.side === target.side) return;
  for (const p of livingAllies(state, target)) {
    if (p.reactionUsed || !canTakeReactions(p) || isIncapacitated(p)) continue;
    const r = p.ref.reactions.find((x) => classify(x) === "vigilantRebuke");
    if (!r || !ready(state, p, r)) continue;
    if (state.distanceFt && p.id !== target.id && state.distanceFt(p, target) > 30.001) continue;
    consume(p, r);
    const cha = Math.max(0, p.ref.pb === 6 ? 5 : 4);
    say(state, `${p.name} rebukes ${forcer.name} for the attempt (Vigilant Rebuke)`, p.id);
    state.inReaction = true;
    try { applyDamage(state, forcer, state.rng.dice(2, 8) + cha, "force", { sourceId: p.id, attackerMagical: true }); } finally { state.inReaction = false; }
    return;
  }
}

/**
 * Soul of Vengeance (Vengeance, 15th): "Whenever a creature affected by your Vow of Enmity makes an attack, you can use your reaction to make a melee weapon attack against that creature if you are
 * within range." Fires when the vowed enemy takes an action, if it's in the paladin's melee reach.
 */
export function soulOfVengeance(state: CombatState, attacker: CombatantState): void {
  if (state.inReaction) return;
  for (const p of state.units.values()) {
    if (!p.alive || p.downed || p.reactionUsed || !canTakeReactions(p) || isIncapacitated(p) || p.side === attacker.side) continue;
    if (!attacker.effects.some((e) => e.name === "vow-of-enmity" && e.sourceId === p.id)) continue;
    const r = p.ref.reactions.find((x) => classify(x) === "soulOfVengeance");
    if (!r || !ready(state, p, r)) continue;
    const swing = basicSwing(p);
    if (!swing || swing.type !== "attack") continue;
    if (state.distanceFt && state.distanceFt(p, attacker) > 5.001) continue;
    consume(p, r);
    say(state, `${p.name} lunges at ${attacker.name}, sworn to vengeance (Soul of Vengeance)`, p.id);
    state.inReaction = true;
    try { runAutomation(swing.onHit, { state, source: p, scope: [attacker], last: {}, depth: 0, inAttack: true }); } finally { state.inReaction = false; }
    return;
  }
}

/**
 * Rebuke the Violent (Redemption, 3rd): "When a creature you can see within 30 feet of you hits another creature with an attack, you can use your reaction to force the attacker to make a Wisdom
 * saving throw. On a failed save, the attacker takes radiant damage equal to the damage it just dealt. On a successful save, it takes half as much damage." `dealt` is the damage that landed.
 */
export function rebukeTheViolent(state: CombatState, attacker: CombatantState, dealt: number): void {
  if (state.inReaction || dealt <= 0) return;
  for (const p of state.units.values()) {
    if (!p.alive || p.downed || p.reactionUsed || !canTakeReactions(p) || isIncapacitated(p) || p.side === attacker.side) continue;
    const r = p.ref.reactions.find((x) => classify(x) === "rebukeTheViolent");
    if (!r || !ready(state, p, r)) continue;
    if (state.distanceFt && state.distanceFt(p, attacker) > 30.001) continue;
    const ok = decideReaction(state, p, "retaliate", `${attacker.name} hit for ${dealt} — ${p.name}'s Rebuke the Violent forces a Wisdom save, or it takes that much radiant damage back.`, "Use Rebuke the Violent", "Let it go");
    if (!ok) continue;
    consume(p, r);
    const dc = 8 + p.ref.pb + Math.max(0, p.ref.pb === 6 ? 5 : 4);
    say(state, `${p.name} rebukes ${attacker.name} for the violence (Rebuke the Violent)`, p.id);
    state.inReaction = true;
    try {
      const save = rollSave(state, attacker, "wis", dc, { magical: true, stakes: "damage", sourceId: p.id });
      applyDamage(state, attacker, save.passed ? Math.floor(dealt / 2) : dealt, "radiant", { sourceId: p.id, attackerMagical: true });
    } finally { state.inReaction = false; }
    return;
  }
}

/**
 * Infectious Inspiration (Eloquence, 14th): "When a creature within 60 feet of you adds one of your Bardic Inspiration dice to its ability check, attack roll, or saving throw and the roll succeeds, you can
 * use your reaction to encourage a different creature (other than yourself) that can hear you within 60 feet, giving it a Bardic Inspiration die without expending any of your Bardic Inspiration uses."
 */
export function infectiousInspiration(state: CombatState, holder: CombatantState, used: ActiveEffect): void {
  if (state.inReaction) return;
  const bard = state.units.get(used.sourceId);
  if (!bard || !bard.alive || bard.downed || bard.id === holder.id) return;
  const r = bard.ref.reactions.find((x) => classify(x) === "infectious");
  if (!r || !ready(state, bard, r)) return;
  if (state.distanceFt && state.distanceFt(bard, holder) > 60.001) return;
  const friend = livingAllies(state, bard).find((a) => a.id !== holder.id && a.id !== bard.id && a.summonerId === undefined && !a.effects.some((x) => x.mods?.inspirationDie) &&
    (!state.distanceFt || state.distanceFt(bard, a) <= 60.001));
  if (!friend) return;
  consume(bard, r);
  friend.effects.push({ name: "bardic-inspiration", expiresRound: used.expiresRound, sourceId: bard.id, mods: { ...used.mods } });
  say(state, `${bard.name}'s inspiration is infectious: ${friend.name} takes up a die (Infectious Inspiration)`, bard.id);
}

/**
 * Cutting Words, against a damage roll (Lore, 3rd): "you can use your reaction to diminish the result of an attack roll, ability check, or damage roll ... roll a Bardic Inspiration die and subtract it".
 * (The attack-roll use is handled with the other ally reactions above.) Returns the damage that still lands.
 */
export function cuttingWordsDamage(state: CombatState, target: CombatantState, amount: number, sourceId: string | undefined): number {
  const src = sourceId ? state.units.get(sourceId) : undefined;
  if (state.inReaction || !src || src.side === target.side) return amount;
  for (const ally of livingAllies(state, target)) {
    const r = ally.ref.reactions.find((x) => x.id === "cutting-words");
    if (!r || !ready(state, ally, r)) continue;
    if (state.distanceFt && state.distanceFt(ally, src) > 60.001) continue;
    if (amount < bardicDieAverage(ally.ref.level ?? 1) * 2.2) continue; // only a big blow is worth the die
    const ok = decideReaction(state, ally, "cuttingWords", `${src.name} is about to deal ${amount} to ${target.name} — ${ally.name}'s Cutting Words can subtract a die from the damage.`, "Use Cutting Words", "Let it land");
    if (!ok) continue;
    consume(ally, r);
    const cut = Math.min(amount, state.rng.dice(1, bardicDieSides(ally.ref.level ?? 1)));
    say(state, `${ally.name}'s Cutting Words take ${cut} off the blow`, ally.id);
    return amount - cut;
  }
  return amount;
}

/**
 * Unbreakable Majesty (Glamour, 14th): "the first time on a turn that a creature attacks you, that creature must make a Charisma saving throw against your spell save DC. On a failed save, the creature
 * can't attack you on this turn, and it must choose a new target for its attack or the attack is wasted. On a successful save, the creature can attack you on this turn, but it has disadvantage on any
 * saving throw it makes against your spells on your next turn." Returns the creature it turns on instead, "miss" if there is no one else, or undefined if the attack goes ahead.
 */
export function unbreakableMajesty(state: CombatState, attacker: CombatantState, target: CombatantState): CombatantState | "miss" | undefined {
  if (state.inReaction || attacker.side === target.side) return undefined;
  const m = target.effects.find((e) => e.name === "unbreakable-majesty");
  if (!m || isIncapacitated(target)) return undefined;
  const barred = attacker.effects.some((e) => e.name === "majesty-barred" && e.sourceId === target.id && e.expiresRound >= state.round);
  if (!barred) {
    if (!claimOncePerTurn(state, attacker, `majesty:${target.id}`)) return undefined; // it has already tried, and passed
    const save = rollSave(state, attacker, "cha", m.mods?.inspirationDc ?? 13, { magical: true, stakes: "control", sourceId: target.id });
    if (save.passed) {
      attacker.effects.push({ name: "majesty-shaken", expiresRound: state.round + 1, sourceId: target.id, mods: { saveDisadvantageAgainstSource: true } });
      return undefined;
    }
    attacker.effects.push({ name: "majesty-barred", expiresRound: state.round, sourceId: target.id });
  }
  const others = [...state.units.values()].filter((u) => u.alive && !u.downed && u.side === target.side && u.id !== target.id && u.id !== attacker.id);
  if (!others.length) { say(state, `${attacker.name} can't bring itself to strike ${target.name} (Unbreakable Majesty)`, target.id); return "miss"; }
  const pick = state.distanceFt ? others.sort((a, b) => state.distanceFt!(attacker, a) - state.distanceFt!(attacker, b))[0] : others[state.rng.int(0, others.length - 1)];
  say(state, `${attacker.name} turns on ${pick.name} instead (Unbreakable Majesty)`, target.id);
  return pick;
}

/**
 * Guardian Coil (Fathomless, 6th): "When you or a creature you can see within 10 feet of your tentacle takes damage, you can use your reaction to reduce that damage by 1d8"
 * (2d8 from the 10th level). Only while the tentacle is out. Returns the damage that still lands.
 */
export function guardianCoil(state: CombatState, target: CombatantState, amount: number): number {
  if (state.inReaction || amount < 2) return amount;
  for (const u of state.units.values()) {
    if (u.side !== target.side || !u.alive || u.downed) continue;
    const r = u.ref.reactions.find((x) => classify(x) === "guardianCoil");
    if (!r || !ready(state, u, r) || !u.effects.some((e) => e.name === "tentacle")) continue;
    if (u.id !== target.id && state.distanceFt && state.distanceFt(u, target) > 40.001) continue; // the tentacle is kept near the fight: within 30 feet of its owner, then 10 feet more
    consume(u, r);
    const cut = Math.min(amount, state.rng.dice((u.ref.level ?? 1) >= 10 ? 2 : 1, 8));
    say(state, `${u.name}'s tentacle coils around ${target.name}, cutting ${cut} from the blow (Guardian Coil)`, u.id);
    return amount - cut;
  }
  return amount;
}

/**
 * Projected Ward (Abjuration, 6th): "when a creature that you can see within 30 feet of you takes damage, you can use your reaction to cause
 * your Arcane Ward to absorb that damage." The ward takes what it can hold; the rest lands. Returns the damage that still gets through.
 */
export function projectedWard(state: CombatState, target: CombatantState, amount: number): number {
  if (state.inReaction || amount < 6) return amount;
  for (const w of livingAllies(state, target)) {
    if (w.id === target.id || !w.arcaneWard || w.arcaneWard.hp <= 0) continue;
    const r = w.ref.reactions.find((x) => classify(x) === "projectedWard");
    if (!r || !ready(state, w, r)) continue;
    if (state.distanceFt && state.distanceFt(w, target) > 30.001) continue;
    const ok = decideReaction(state, w, "spiritShield", `${target.name} is about to take ${amount} damage — ${w.name}'s Projected Ward can soak it.`, "Projected Ward", "Let it land");
    if (!ok) continue;
    consume(w, r);
    const soaked = Math.min(w.arcaneWard.hp, amount);
    w.arcaneWard.hp -= soaked;
    say(state, `${w.name}'s ward soaks ${soaked} meant for ${target.name} (${w.arcaneWard.hp}/${w.arcaneWard.maxHp})`, w.id);
    return amount - soaked;
  }
  return amount;
}

/**
 * Violent Attraction (Graviturgy, 10th): when a creature within 60 ft of you hits with a weapon attack, your reaction adds 1d10 damage of the
 * weapon's type (uses equal to your Intelligence modifier, per long rest).
 */
export function violentAttraction(state: CombatState, attacker: CombatantState, target: CombatantState, type: DamageType): void {
  if (state.inReaction || !target.alive) return;
  for (const w of livingAllies(state, attacker)) {
    const r = w.ref.reactions.find((x) => classify(x) === "violentAttraction");
    if (!r || !ready(state, w, r)) continue;
    if (state.distanceFt && state.distanceFt(w, attacker) > 60.001) continue;
    const ok = decideReaction(state, w, "riposte", `${attacker.name} hit ${target.name} — ${w.name}'s Violent Attraction adds 1d10.`, "Violent Attraction", "Hold reaction");
    if (!ok) continue;
    consume(w, r);
    const extra = state.rng.dice(1, 10);
    say(state, `${w.name} pulls the blow in harder (+${extra} ${type})`, w.id);
    state.inReaction = true;
    try {
      applyDamage(state, target, extra, type, { sourceId: attacker.id, viaAttack: true });
    } finally {
      state.inReaction = false;
    }
    return;
  }
}

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
      feedWard(state, u, r);
      // Power Surge (War Magic): ending a spell with Counterspell steals a surge
      const sg = u.ref.specialRules.find((x) => x.rule === "surgeOnCounter");
      if (sg && sg.rule === "surgeOnCounter") {
        const cap = u.ref.resources[sg.resource]?.max;
        const cur = u.resources.get(sg.resource) ?? 0;
        if (typeof cap === "number" && cur < cap) {
          u.resources.set(sg.resource, cur + 1);
          say(state, `${u.name} steals a power surge`, u.id);
        }
      }
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
