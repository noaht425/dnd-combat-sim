// The three primitives every automation node bottoms out in: an attack roll, a
// saving throw, and applying damage. Each folds in conditions, active-effect
// mods, Magic Resistance, and the Legendary Resistance budget.

import type { Ability, AdvMode, Condition, DamageType } from "../schema";
import { abilityMod } from "../math";
import {
  CombatantState,
  CombatState,
  breakConcentration,
  claimOncePerTurn,
  effectiveAc,
  hasCondition,
  isIncapacitated,
  say,
} from "./state";
import {
  reactToDamageTaken,
  reactToDrop,
  reactToElementalDamage,
  deflectAttack,
  restoreBalance,
  reactToFailedSave,
  reactToIncomingAttack,
  reduceIncomingDamage,
  shadowyDodge,
  slayersCounter,
  beguilingTwist,
  spiritShield,
} from "./reactions";

function combineAdv(...parts: Array<AdvMode | undefined>): AdvMode {
  let adv = false;
  let dis = false;
  for (const p of parts) {
    if (p === "adv") adv = true;
    if (p === "dis") dis = true;
  }
  if (adv && dis) return "flat";
  if (adv) return "adv";
  if (dis) return "dis";
  return "flat";
}

function ruleActive(u: CombatantState, rule: string): boolean {
  return u.ref.specialRules.some((r) => r.rule === rule);
}

/** roll a simple "NdM" (optionally "+K") bonus-dice string, e.g. Boldness's d4 */
function rollBonusDice(state: CombatState, dice: string): number {
  const m = dice.replace(/\s+/g, "").match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!m) return 0;
  return state.rng.dice(Number(m[1]), Number(m[2])) + (m[3] ? Number(m[3]) : 0);
}

/** the lowest natural roll that crits for `u` (Champion's Improved/Superior
 *  Critical, Invincible Conqueror, etc.) — 20 if it has no such special rule. */
export function critRangeFor(u: CombatantState): number {
  const r = u.ref.specialRules.find((x) => x.rule === "critRange");
  return r && r.rule === "critRange" ? r.value : 20;
}

// ---------------------------------------------------- precognition (d20 replacement)
// Once per round it may replace a d20 rolled by a nearby creature with one of three
// pre-seen faces. We only spend it defensively: turn a party hit into a miss, or a
// party save that would succeed into a failure — whichever the current roll is.

interface Precog { owner: CombatantState; table: Record<string, number[]>; spend: () => void }

function precog(state: CombatState, roller: CombatantState): Precog | undefined {
  if (roller.side !== "party") return undefined;
  for (const u of state.units.values()) {
    if (!u.alive || (u.d20SwapsLeft ?? 0) <= 0) continue;
    const r = u.ref.specialRules.find((x) => x.rule === "d20Replacement");
    if (r && r.rule === "d20Replacement") {
      return { owner: u, table: r.table as Record<string, number[]>, spend: () => { u.d20SwapsLeft = (u.d20SwapsLeft ?? 1) - 1; } };
    }
  }
  return undefined;
}

/** replace `used` with the seeded face that best denies the roller, if one exists */
function precogSwap(state: CombatState, roller: CombatantState, used: number, wouldSucceed: boolean, scores: (face: number) => boolean): number {
  if (used === 1 || used === 20 || !wouldSucceed) return used;
  const p = precog(state, roller);
  if (!p) return used;
  const faces = p.table[String(used)] ?? [];
  // pick the seeded face that flips success -> failure (smallest margin change first is fine)
  const flip = faces.filter((f) => f !== 20 && !scores(f)).sort((a, b) => b - a)[0];
  if (flip === undefined) return used;
  p.spend();
  say(state, `${p.owner.name} rewrites the moment (${used} -> ${flip})`, p.owner.id);
  return flip;
}

// ---------------------------------------------------------------- attack rolls

export interface AttackResult {
  hit: boolean;
  crit: boolean;
  hadAdvantage: boolean;
  /** the roll was made at (net) disadvantage — Sneak Attack's no-advantage routes all refuse it */
  hadDisadvantage?: boolean;
  nat: number;
}

/** Drunkard's Luck — with disadvantage, spend ki to cancel it */
function cancelDisadvantage(state: CombatState, u: CombatantState): boolean {
  const rule = u.ref.specialRules.find((r) => r.rule === "cancelDisadvantage");
  if (!rule || rule.rule !== "cancelDisadvantage" || (u.resources.get(rule.resource) ?? 0) < rule.cost) return false;
  u.resources.set(rule.resource, (u.resources.get(rule.resource) ?? 0) - rule.cost);
  say(state, `${u.name} rides a lucky bounce (Drunkard's Luck)`, u.id);
  return true;
}

/** Tides of Chaos — spend the once-a-rest use to roll a d20 with advantage */
function spendTides(state: CombatState, u: CombatantState): boolean {
  const rule = u.ref.specialRules.find((r) => r.rule === "advantageOnce");
  if (!rule || rule.rule !== "advantageOnce" || (u.resources.get(rule.resource) ?? 0) <= 0) return false;
  u.resources.set(rule.resource, (u.resources.get(rule.resource) ?? 0) - 1);
  say(state, `${u.name} bends chaos in its favor (Tides of Chaos)`, u.id);
  return true;
}

/** an ally of `attacker` (not the attacker) within 5 ft of `target` and able to act — the Pack Tactics condition */
function packAlly(state: CombatState, attacker: CombatantState, target: CombatantState): boolean {
  for (const a of state.units.values()) {
    if (a.id === attacker.id || a.side !== attacker.side || !a.alive || a.downed || isIncapacitated(a)) continue;
    const near = state.distanceFt ? state.distanceFt(a, target) <= 5.001 : a.zone === "melee" && target.zone === "melee";
    if (near) return true;
  }
  return false;
}

/** Wolf totem: does a raging wolf-totem barbarian on the attacker's side (not the attacker) have `target` within 5 ft, for a melee attack? */
function wolfTotemAdvantage(state: CombatState, attacker: CombatantState, target: CombatantState): boolean {
  if (attacker.zone !== "melee") return false;
  for (const b of state.units.values()) {
    if (b.id === attacker.id || b.side !== attacker.side || !b.alive || b.downed) continue;
    if (!b.ref.specialRules.some((r) => r.rule === "wolfTotem") || !b.effects.some((e) => e.name === "rage")) continue;
    const close = state.distanceFt ? state.distanceFt(b, target) <= 5.001 : b.zone === "melee" && target.zone === "melee";
    if (close) return true;
  }
  return false;
}

/** Is `attacker` held by a raging Bear-totem barbarian beside it (and not attacking that barbarian or another with the feature)? */
function bearAttunementApplies(state: CombatState, attacker: CombatantState, target: CombatantState): boolean {
  if (target.ref.specialRules.some((r) => r.rule === "bearAttunement")) return false;
  if (attacker.ref.conditionImmunities.includes("frightened") || hasCondition(attacker, "blinded") || hasCondition(attacker, "deafened")) return false; // it must see or hear the barbarian, and be frightenable
  for (const b of state.units.values()) {
    if (b.side === attacker.side || b.id === target.id || !b.alive || b.downed) continue;
    if (!b.ref.specialRules.some((r) => r.rule === "bearAttunement") || !b.effects.some((e) => e.name === "rage")) continue;
    const close = state.distanceFt ? state.distanceFt(b, attacker) <= 5.001 : b.zone === "melee" && attacker.zone === "melee";
    if (close) return true;
  }
  return false;
}

/** thin wrapper so every attack roll (whichever internal path it resolves
 *  through) lands in state.attackLog for the post-fight whiff/AC readout,
 *  without threading logging through every early return below. */
export function rollAttack(
  state: CombatState,
  attacker: CombatantState,
  target: CombatantState,
  toHit: number,
  intrinsicAdv: AdvMode | undefined,
  critRange = 20,
  extraTargetAc = 0,
): AttackResult {
  const result = rollAttackImpl(state, attacker, target, toHit, intrinsicAdv, critRange, extraTargetAc);
  attacker.combatEventSerial = state.turnSerial ?? 0; // "attacked a hostile creature" — keeps a Rage going
  (state.attackLog ??= []).push({ round: state.round, attackerId: attacker.id, targetId: target.id, hit: result.hit });
  return result;
}

function rollAttackImpl(
  state: CombatState,
  attacker: CombatantState,
  target: CombatantState,
  toHit: number,
  intrinsicAdv: AdvMode | undefined,
  critRange = 20,
  /** battle mode: cover AC bonus (+2 half / +5 three-quarters) folded into the target's AC */
  extraTargetAc = 0,
): AttackResult {
  // the attacker rolls at disadvantage while frightened / poisoned / prone /
  // restrained / blinded (all impose disadvantage on attack rolls in 5e)
  const attackerConditionDis =
    hasCondition(attacker, "frightened") || hasCondition(attacker, "poisoned") ||
    hasCondition(attacker, "prone") || hasCondition(attacker, "restrained")
      ? "dis"
      : undefined;
  const attackerBlind = hasCondition(attacker, "blinded") ? "dis" : undefined;
  // attacks AGAINST a creature have advantage while it's prone (melee only),
  // restrained, blinded, stunned, paralyzed or unconscious
  const targetGivesAdv =
    (hasCondition(target, "prone") && attacker.zone === "melee") ||
    hasCondition(target, "restrained") ||
    hasCondition(target, "blinded") ||
    hasCondition(target, "stunned") ||
    hasCondition(target, "paralyzed") ||
    hasCondition(target, "unconscious")
      ? "adv"
      : undefined;
  const targetInvisible = hasCondition(target, "invisible") ? "dis" : undefined;
  // an attacker the target can't see (invisible) attacks with advantage
  const attackerUnseen = hasCondition(attacker, "invisible") ? "adv" : undefined;

  let adv = combineAdv(intrinsicAdv, attackerConditionDis, attackerBlind, targetGivesAdv, targetInvisible, attackerUnseen);

  // target denies advantage entirely (It Has Been Seen); foresight-style effect gives attackers disadvantage
  if ((ruleActive(target, "denyAdvantageToAttackers") || target.effects.some((e) => e.mods?.denyAdvantageToAttackers)) && adv === "adv") adv = "flat";
  for (const e of target.effects) {
    if (e.mods?.attacksAgainstItAdvantage === "dis") adv = combineAdv(adv, "dis");
    // "attack rolls against that target have advantage" — only for the side that put it there (Help, Ambush Master)
    if (e.mods?.attacksAgainstItAdvantage === "adv" && (e.sourceId === target.id || state.units.get(e.sourceId)?.side === attacker.side) &&
        !(e.mods.advantageToOthersOnly && e.sourceId === attacker.id)) adv = combineAdv(adv, "adv");
  }
  // Wolf totem: a raging wolf-totem barbarian's allies have advantage on melee attacks against hostile creatures within 5 ft of it
  if (adv !== "adv" && wolfTotemAdvantage(state, attacker, target)) adv = combineAdv(adv, "adv");
  // Totemic Attunement (Bear): a hostile creature beside a raging barbarian has disadvantage on attacks against anyone else
  if (bearAttunementApplies(state, attacker, target)) adv = combineAdv(adv, "dis");
  // Panache: a companion of the rogue attacking the creature ends the hold the rogue had on it
  if (target.effects.some((e) => e.mods?.endOnAllyAttack && e.sourceId !== attacker.id && state.units.get(e.sourceId)?.side === attacker.side)) {
    target.effects = target.effects.filter((e) => !(e.mods?.endOnAllyAttack && e.sourceId !== attacker.id && state.units.get(e.sourceId)?.side === attacker.side));
  }
  // the Help action is spent by the first attack roll made against the target
  const consumes = (e: import("./state").ActiveEffect) =>
    !!e.mods?.consumeOnAttacked && state.units.get(e.sourceId)?.side === attacker.side && !(e.mods.advantageToOthersOnly && e.sourceId === attacker.id);
  if (target.effects.some(consumes)) target.effects = target.effects.filter((e) => !consumes(e));
  for (const e of attacker.effects) {
    if (e.mods?.attackAdvantage === "adv") adv = combineAdv(adv, "adv");
    if (e.mods?.attackAdvantage === "dis") adv = combineAdv(adv, "dis");
    if (e.mods?.attackBonusAll) toHit += e.mods.attackBonusAll;
    if (e.mods?.attackBonusDice) toHit += rollBonusDice(state, e.mods.attackBonusDice);
    // "disadvantage on attack rolls against targets other than you" / "against you" — the
    // effect remembers who applied it (Armorer: Thunder Gauntlets, Infiltrator's glimmer)
    if (e.mods?.disadvantageUnlessTargetingSource && e.sourceId !== target.id) adv = combineAdv(adv, "dis");
    if (e.mods?.disadvantageOnlyTargetingSource && e.sourceId === target.id) adv = combineAdv(adv, "dis");
  }
  // Assassin's Assassinate: advantage against a creature that hasn't taken a turn yet
  if (!target.hasTakenTurn && attacker.ref.specialRules.some((r) => r.rule === "assassinate")) adv = combineAdv(adv, "adv");
  // Ambush / Assassinate — advantage on round 1 vs foes that haven't acted
  const assassinating = !!attacker.assassinateUntilRound && state.round <= attacker.assassinateUntilRound;
  if (assassinating) adv = combineAdv(adv, "adv");

  // what-if to-hit knob
  if (state.tuning) {
    if (attacker.side === "monster" && state.tuning.monsterToHitDelta) toHit += state.tuning.monsterToHitDelta;
    if (attacker.side === "party" && state.tuning.partyToHitDelta) toHit += state.tuning.partyToHitDelta;
  }

  // a bodyguard companion (Steel Defender) may impose disadvantage on this roll before it's made
  if (deflectAttack(state, attacker, target, adv)) adv = combineAdv(adv, "dis");
  // Shadow Step: the next attack roll has advantage, then the effect is spent
  if (attacker.effects.some((e) => e.mods?.advantageOnNextAttack)) {
    attacker.effects = attacker.effects.filter((e) => !e.mods?.advantageOnNextAttack);
    adv = combineAdv(adv, "adv");
  }
  // Drunkard's Luck: spend ki to cancel disadvantage on the roll
  if (adv === "dis" && cancelDisadvantage(state, attacker)) adv = "flat";
  // Tides of Chaos: the first d20 roll of the fight is made with advantage (spending the use)
  if (adv !== "adv" && spendTides(state, attacker)) adv = combineAdv(adv, "adv");
  // Pack Tactics: advantage when one of the attacker's allies is within 5 ft of the target and not incapacitated
  if (adv !== "adv" && attacker.ref.specialRules.some((r) => r.rule === "packTactics") && packAlly(state, attacker, target)) adv = combineAdv(adv, "adv");
  // Shadowy Dodge: a reaction that imposes disadvantage on an attack that has no advantage
  if (shadowyDodge(state, attacker, target, adv)) adv = combineAdv(adv, "dis");
  // Restore Balance: a Clockwork Soul sorcerer cancels advantage on an enemy's roll / disadvantage on an ally's
  if (adv !== "flat" && restoreBalance(state, attacker, adv)) adv = "flat";

  let used = state.rng.d20mode(adv).used;
  const rollFloor = attacker.effects.reduce((n, e) => Math.max(n, e.mods?.d20Floor ?? 0), 0);
  if (used < rollFloor) used = rollFloor; // Trance of Order: a d20 of 9 or lower counts as a 10
  // Multiattack Defense: a bonus to AC against the creature that has already hit the target this round
  const acVs = target.effects.reduce((n, e) => n + (e.mods?.acBonusAgainstSource && e.sourceId === attacker.id ? e.mods.acBonusAgainstSource : 0), 0);
  let ac = effectiveAc(target) + extraTargetAc + acVs;
  const hits = (f: number) => f >= critRange || f + toHit >= ac;
  let face = precogSwap(state, attacker, used, used !== 1 && hits(used), hits);
  let crit = face >= critRange;
  let autoMiss = face === 1;

  // Favored by the Gods (Divine Soul) — once per rest, when the roll as-is
  // would miss, add a fixed bonus die and recheck. A crit is decided by the
  // natural die face, not the total, so this can never manufacture one —
  // only ever turns a genuine miss into a plain hit.
  if (!autoMiss && !crit && face + toHit < ac) {
    const fbg = attacker.ref.specialRules.find((r) => r.rule === "boostMissedAttack");
    if (fbg && fbg.rule === "boostMissedAttack" && (attacker.resources.get(fbg.resource) ?? 0) > 0) {
      const m = fbg.bonusDice.match(/(\d+)d(\d+)/);
      const bonus = m ? state.rng.dice(Number(m[1]), Number(m[2])) : 0;
      if (face + toHit + bonus >= ac) {
        attacker.resources.set(fbg.resource, (attacker.resources.get(fbg.resource) ?? 0) - 1);
        toHit += bonus;
        say(state, `${attacker.name} is Favored by the Gods (+${bonus})`, attacker.id);
      }
    }
  }

  // Master Duelist — once per rest, a missed attack roll is rolled again with advantage
  if (autoMiss || (!crit && face + toHit < ac)) {
    const md = attacker.ref.specialRules.find((r) => r.rule === "rerollMissWithAdvantage");
    if (md && md.rule === "rerollMissWithAdvantage" && (attacker.resources.get(md.resource) ?? 0) > 0) {
      attacker.resources.set(md.resource, (attacker.resources.get(md.resource) ?? 0) - 1);
      const again = state.rng.d20mode(adv === "dis" ? "flat" : "adv").used;
      say(state, `${attacker.name} turns the miss around with Master Duelist (${face} -> ${again})`, attacker.id);
      face = again;
      crit = face >= critRange;
      autoMiss = face === 1;
    }
  }

  // Unerring Accuracy — once a turn, a missed attack roll is rolled again
  if ((autoMiss || (!crit && face + toHit < ac)) && attacker.ref.specialRules.some((r) => r.rule === "rerollMissOncePerTurn") &&
      claimOncePerTurn(state, attacker, "unerring-accuracy")) {
    const again = state.rng.d20mode("flat").used;
    say(state, `${attacker.name} rolls the miss again (Unerring Accuracy: ${face} -> ${again})`, attacker.id);
    face = again;
    crit = face >= critRange;
    autoMiss = face === 1;
  }

  // the target may spend a reaction to change this outcome (Shield, Weight of Ages)
  if (!state.inReaction && !autoMiss) {
    const rr = reactToIncomingAttack(state, { target, hitMargin: face + toHit - ac, crit });
    if (rr.negated) return { hit: false, crit: false, hadAdvantage: adv === "adv", hadDisadvantage: adv === "dis", nat: face };
    if (rr.shielded) ac = effectiveAc(target) + extraTargetAc + acVs; // the +5 Shield effect is now active
  }

  let hit = !autoMiss && (crit || face + toHit >= ac);
  // Stroke of Luck — once per rest, a miss becomes a hit (decided after any Shield-style reaction has had its say)
  if (!hit) {
    const sol = attacker.ref.specialRules.find((r) => r.rule === "turnMissIntoHit");
    if (sol && sol.rule === "turnMissIntoHit" && (attacker.resources.get(sol.resource) ?? 0) > 0) {
      attacker.resources.set(sol.resource, (attacker.resources.get(sol.resource) ?? 0) - 1);
      hit = true;
      say(state, `${attacker.name} turns the miss into a hit with Stroke of Luck`, attacker.id);
    }
  }
  // a hit with a melee attack against a paralyzed or unconscious creature is a
  // critical hit (attacker within 5 ft)
  let finalCrit = crit;
  if (hit && attacker.zone === "melee" &&
      (hasCondition(target, "paralyzed") || hasCondition(target, "unconscious"))) {
    finalCrit = true;
  }
  if (hit && assassinating) finalCrit = true; // Assassinate: any hit on a surprised foe is a crit
  return { hit, crit: finalCrit, hadAdvantage: adv === "adv", hadDisadvantage: adv === "dis", nat: face };
}

// ------------------------------------------------------------------ save rolls

export function saveModifierOf(u: CombatantState, ability: Ability): number {
  const base = abilityMod(u.ref.abilities[ability]);
  const prof = u.ref.proficientSaves.includes(ability) ? u.ref.pb : 0;
  let bonus = u.ref.saveBonusAll;
  for (const e of u.effects) if (e.mods?.saveBonusAll) bonus += e.mods.saveBonusAll;
  return base + prof + bonus;
}

export interface SaveResult {
  passed: boolean;
  usedLegendaryResistance: boolean;
}

export type SaveStakes = "damage" | "control" | "lock";

/** thin wrapper — see rollAttack's for why: logs to state.saveLog regardless
 *  of which internal path (auto-fail, endurance override, legendary
 *  resistance) the roll resolves through. */
export function rollSave(
  state: CombatState,
  target: CombatantState,
  ability: Ability,
  dc: number,
  opts: { magical?: boolean; allowLegendaryResistance?: boolean; stakes?: SaveStakes; conditions?: Condition[]; sourceId?: string } = {},
): SaveResult {
  // Slayer's Counter — a hit on the creature forcing the save makes the save succeed outright
  const forcer = opts.sourceId ? state.units.get(opts.sourceId) : undefined;
  if (forcer && slayersCounter(state, target, forcer)) {
    (state.saveLog ??= []).push({ round: state.round, unitId: target.id, ability, passed: true });
    return { passed: true, usedLegendaryResistance: false };
  }
  let result = rollSaveImpl(state, target, ability, dc, opts);
  // Fanatical Focus / Indomitable — fail a save while raging and you may reroll it, using the new roll (once per rage)
  if (!result.passed) {
    const ff = target.ref.specialRules.find((r) => r.rule === "rerollFailedSave");
    if (ff && ff.rule === "rerollFailedSave" && (!ff.whileEffect || target.effects.some((e) => e.name === ff.whileEffect)) && (target.resources.get(ff.resource) ?? 0) > 0) {
      target.resources.set(ff.resource, (target.resources.get(ff.resource) ?? 0) - 1);
      say(state, `${target.name} rerolls the failed save (${ff.whileEffect ? "Fanatical Focus" : "Indomitable"})`, target.id);
      result = rollSaveImpl(state, target, ability, dc, opts);
    }
  }
  (state.saveLog ??= []).push({ round: state.round, unitId: target.id, ability, passed: result.passed });
  if (result.passed) beguilingTwist(state, target, opts.conditions); // a Fey Wanderer turns a shrugged-off charm or fear on someone else
  return result;
}

function rollSaveImpl(
  state: CombatState,
  target: CombatantState,
  ability: Ability,
  dc: number,
  opts: { magical?: boolean; allowLegendaryResistance?: boolean; stakes?: SaveStakes; conditions?: Condition[]; sourceId?: string } = {},
): SaveResult {
  const magical = opts.magical ?? true;

  // what-if: raising a monster's save DCs makes the party's saves harder
  if (state.tuning?.monsterDcDelta && target.side === "party") dc += state.tuning.monsterDcDelta;

  // auto-fail: stunned / paralyzed / unconscious auto-fail STR and DEX saves
  if ((ability === "str" || ability === "dex") &&
      (hasCondition(target, "stunned") || hasCondition(target, "paralyzed") || hasCondition(target, "unconscious"))) {
    return maybeLegendary(state, target, false, opts);
  }

  let adv: AdvMode = "flat";
  if (magical && ruleActive(target, "magicResistance")) adv = "adv";
  const advOnSaves = target.ref.specialRules.find((r) => r.rule === "advantageOnSaves");
  if (advOnSaves && advOnSaves.rule === "advantageOnSaves" && advOnSaves.abilities.includes(ability)) adv = "adv";
  for (const e of target.effects) {
    if (e.mods?.saveAdvantage === "adv") adv = combineAdv(adv, "adv");
    if (e.mods?.saveAdvantage === "dis") adv = combineAdv(adv, "dis");
    if (e.mods?.saveAdvantageOn?.includes(ability)) adv = combineAdv(adv, "adv"); // Rage: Strength saves
    if (e.mods?.saveDisadvantageAgainstSource && opts.sourceId && e.sourceId === opts.sourceId) adv = combineAdv(adv, "dis"); // the Hound of Ill Omen's mark
    if (e.mods?.disadvantageOnFirstD20EachRound) adv = combineAdv(adv, "dis"); // "doomed" — simplification
  }
  // restrained imposes disadvantage on Dexterity saving throws
  if (ability === "dex" && hasCondition(target, "restrained")) adv = combineAdv(adv, "dis");
  // advantage on saves against effects that would impose certain conditions (Psychic Defenses)
  const advVs = target.ref.specialRules.find((r) => r.rule === "advantageOnSavesAgainst");
  if (advVs && advVs.rule === "advantageOnSavesAgainst" && opts.conditions?.some((c) => advVs.conditions.includes(c))) {
    adv = combineAdv(adv, "adv");
  }
  if (adv === "dis" && cancelDisadvantage(state, target)) adv = "flat";
  if (adv !== "adv" && spendTides(state, target)) adv = combineAdv(adv, "adv");
  if (adv !== "flat" && restoreBalance(state, target, adv)) adv = "flat";

  let used = state.rng.d20mode(adv).used;
  const floor = target.effects.reduce((n, e) => Math.max(n, e.mods?.d20Floor ?? 0), 0);
  if (used < floor) used = floor; // Trance of Order
  let mod = saveModifierOf(target, ability);
  for (const e of target.effects) if (e.mods?.saveBonusDice) mod += rollBonusDice(state, e.mods.saveBonusDice);
  // Supernatural Defense: +1d6 on saves against effects from the creature designated as your prey
  if (opts.sourceId && target.ref.specialRules.some((r) => r.rule === "supernaturalDefense") &&
      state.units.get(opts.sourceId)?.effects.some((e) => e.name === "slayers-prey" && e.sourceId === target.id)) mod += state.rng.dice(1, 6);
  const succeeds = (f: number) => f + mod >= dc; // 2014 RAW: no auto-success on a natural 20 for saves
  const face = precogSwap(state, target, used, succeeds(used), succeeds);
  const passed = succeeds(face);

  // the endurance rider — add CON to a failed save, at an escalating self-cost
  if (!passed && maybeForcedEndurance(state, target, face + mod, dc, opts.stakes ?? "damage")) {
    return { passed: true, usedLegendaryResistance: false };
  }
  // an ally artificer's Flash of Genius (+INT) may turn this failure into a success
  if (!passed && reactToFailedSave(state, target, face + mod, dc)) {
    return { passed: true, usedLegendaryResistance: false };
  }
  return maybeLegendary(state, target, passed, opts);
}

/** Endurance rider: +CON mod to a save it just failed; +1 Endurance point held and NdX force per point held. */
function maybeForcedEndurance(
  state: CombatState,
  target: CombatantState,
  rollTotal: number,
  dc: number,
  stakes: SaveStakes,
): boolean {
  if (!target.ref.resources.endurance) return false; // opt-in: a block that declares an `endurance` pool
  if (stakes === "damage") return false; // only worth the pain to shrug off control / a fight-ender
  const conMod = abilityMod(target.ref.abilities.con);
  if (rollTotal + conMod < dc) return false; // even +CON doesn't get there
  const held = (target.resources.get("endurance") ?? 0) + 1;
  if (held > 6) return false; // by here the self-damage (6d6+) is worse than eating the effect
  target.resources.set("endurance", held);
  const unleashed = target.effects.some((e) => e.name === "unleashed");
  const selfHarm = state.rng.dice(held, unleashed ? 12 : 6);
  say(state, `${target.name} spends Endurance (+${conMod} save; ${held} held, takes ${selfHarm} force)`, target.id);
  applyDamage(state, target, selfHarm, "force", { ignoreResistances: true });
  return true;
}

function maybeLegendary(
  state: CombatState,
  target: CombatantState,
  passed: boolean,
  opts: { allowLegendaryResistance?: boolean; stakes?: SaveStakes },
): SaveResult {
  if (passed || opts.allowLegendaryResistance === false) return { passed, usedLegendaryResistance: false };
  const budget = target.resources.get("__legendaryResistance") ?? 0;
  if (budget <= 0) return { passed, usedLegendaryResistance: false };

  // burn LR on a fight-ender always; on lesser control only while we still have a
  // couple banked (don't spend the last LR to shrug off a frighten)
  const stakes = opts.stakes ?? "damage";
  const worth = stakes === "lock" || (stakes === "control" && budget >= 2);
  if (worth) {
    target.resources.set("__legendaryResistance", budget - 1);
    say(state, `${target.name} uses Legendary Resistance`, target.id);
    return { passed: true, usedLegendaryResistance: true };
  }
  return { passed, usedLegendaryResistance: false };
}

// -------------------------------------------------------------- applying damage

export function applyDamage(
  state: CombatState,
  target: CombatantState,
  rawAmount: number,
  type: DamageType,
  opts: {
    ignoreResistances?: boolean;
    hadAdvantage?: boolean;
    attackerMagical?: boolean;
    sourceId?: string;
    viaAttack?: boolean;
    viaSpell?: boolean;
    /** the damage came from a critical hit (Strength of the Grave can't save against one) */
    crit?: boolean;
  } = {},
): number {
  if (rawAmount <= 0 || !target.alive) return 0;

  // minionGuard — a blow meant for the summoner lands on one of its minions instead
  const guard = target.ref.specialRules.find((r) => r.rule === "minionGuard");
  if (guard && guard.rule === "minionGuard" && !target.downed) {
    const shields = [...state.units.values()].filter((u) => u.alive && u.summonerId === target.id);
    if (shields.length && state.rng.next() < guard.chance) {
      const shield = shields.sort((a, b) => a.hp - b.hp)[0];
      say(state, `a ${shield.ref.name} throws itself in front of ${target.name}`, shield.id);
      return applyDamage(state, shield, rawAmount, type, opts);
    }
  }

  if (target.zeroHpRaging && target.hp <= 0) {
    // Rage Beyond Death: still at 0 HP and on its feet — a hit is a failed death save, but a third failure only kills when the rage ends
    if (rawAmount >= target.maxHp) { target.alive = false; say(state, `${target.name} is killed outright`, target.id); return 0; }
    target.deathSaves.fail += 1;
    if (target.deathSaves.fail >= 3 && !target.deathPending) { target.deathPending = true; say(state, `${target.name} can't die until the rage ends`, target.id); }
    return 0;
  }

  if (target.downed) {
    // a downed PC that takes a hit fails a death save (two on a crit ~ big hit)
    target.deathSaves.fail += rawAmount >= target.maxHp ? 2 : 1;
    if (target.deathSaves.fail >= 3) {
      target.alive = false;
      say(state, `${target.name} dies`, target.id);
    }
    return 0;
  }

  // Uncanny Dodge — the target spends a reaction to halve an attack's damage
  const src = opts.sourceId ? state.units.get(opts.sourceId) : undefined;
  const meleeHit = !!opts.viaAttack && src?.zone === "melee";
  // a ranged WEAPON attack: an attack that isn't a spell, made from beyond arm's reach
  const rangedWeapon = !!opts.viaAttack && !opts.viaSpell && !!src && (state.distanceFt ? state.distanceFt(src, target) > 5.001 : src.zone !== "melee");
  rawAmount = reduceIncomingDamage(state, target, rawAmount, opts.viaAttack ?? false, meleeHit, { ranged: rangedWeapon, type });
  // Spirit Shield — a raging Ancestral Guardian nearby soaks some of it
  rawAmount = spiritShield(state, target, rawAmount, opts.sourceId);
  if (rawAmount <= 0) return 0;
  // Absorb Elements — a reaction to elemental damage; sets a temp resistance the
  // block below honours (so the triggering hit is halved too)
  reactToElementalDamage(state, target, rawAmount, type);

  const hpBefore = target.hp;
  let dmg = rawAmount;
  const ref = target.ref;

  // what-if damage knobs
  if (state.tuning) {
    const srcSide = opts.sourceId ? state.units.get(opts.sourceId)?.side : undefined;
    if (srcSide === "monster" && state.tuning.monsterDamageMult) dmg *= state.tuning.monsterDamageMult;
    if (srcSide === "party" && state.tuning.partyDamageMult) dmg *= state.tuning.partyDamageMult;
  }

  if (ref.immunities.includes(type)) return 0;

  if (!opts.ignoreResistances) {
    const bps = ["bludgeoning", "piercing", "slashing"].includes(type);
    // RAW order: flat modifiers first, THEN resistance, THEN vulnerability.
    const flat = ref.specialRules.find((r) => r.rule === "flatDamageReduction");
    if (flat && flat.rule === "flatDamageReduction") dmg = Math.max(0, dmg - flat.amount);

    // resistance is applied at most once even from multiple sources
    const absorbed =
      target.absorbElements?.type === type && state.round < target.absorbElements.untilRound;
    const heldBack = !!opts.viaAttack && !!opts.sourceId &&
      !!state.units.get(opts.sourceId)?.effects.some((e) => e.mods?.halveDamageToOthers && e.sourceId !== target.id); // Ancestral Protectors
    const resisted =
      ref.resistances.includes(type) ||
      absorbed ||
      heldBack ||
      target.effects.some((e) => e.mods?.resistTypes?.includes(type)) || // Rage, a totem spirit, a storm's resistance

      (bps && !opts.attackerMagical && ref.resistancesNonmagical.includes(type)) ||
      (bps && !opts.hadAdvantage && ref.specialRules.some((r) => r.rule === "resistNonAdvantageAttacks"));
    if (resisted) dmg = Math.floor(dmg * 0.5);
    if (ref.vulnerabilities.includes(type)) dmg *= 2;

    // active-effect multipliers (a "takes extra damage" debuff; a "deals extra damage" buff)
    for (const e of target.effects) {
      if (e.mods?.damageTakenMultiplier !== undefined) dmg *= e.mods.damageTakenMultiplier;
    }
  }

  dmg = Math.max(0, Math.floor(dmg));
  if (dmg === 0) return 0;
  target.combatEventSerial = state.turnSerial ?? 0; // "taken damage" — keeps a Rage going

  // Bastion of Law — the warded creature expends d8s from its ward, rolling each and reducing the
  // damage by the total (used one at a time until the damage is gone or the ward runs dry)
  if (target.ward && target.ward.dice > 0) {
    let soaked = 0;
    let spent = 0;
    while (target.ward.dice > 0 && dmg - soaked > 0) {
      soaked += state.rng.dice(1, 8);
      target.ward.dice--;
      spent++;
    }
    dmg = Math.max(0, dmg - soaked);
    say(state, `${target.name}'s ward absorbs ${soaked} (${spent} d8${spent === 1 ? "" : "s"})`, target.id);
    if (dmg === 0) return 0;
  }

  // temp HP soaks first
  if (target.tempHp > 0) {
    const soak = Math.min(target.tempHp, dmg);
    target.tempHp -= soak;
    dmg -= soak;
  }
  target.hp -= dmg;
  target.damageTaken += dmg;

  // a melee PC connecting on a keep-distance monster -> it will withdraw (and provoke) on its turn
  if (opts.viaAttack && target.side === "monster") {
    const src = opts.sourceId ? state.units.get(opts.sourceId) : undefined;
    if (src && src.side === "party" && src.zone === "melee") target.meleeHitSinceMyTurn = true;
  }

  // acMeltOnHit — a physical strike shaves the target's AC, stacking, to a floor
  if (["bludgeoning", "piercing", "slashing"].includes(type) && opts.sourceId) {
    const melt = state.units.get(opts.sourceId)?.ref.specialRules.find((r) => r.rule === "acMeltOnHit");
    if (melt && melt.rule === "acMeltOnHit") {
      const floor = Math.min(0, melt.min - target.ac); // most-negative acBonus permitted
      let e = target.effects.find((x) => x.name === "ac-melt");
      if (!e) {
        e = { name: "ac-melt", mods: { acBonus: 0 }, expiresRound: Infinity, sourceId: opts.sourceId };
        target.effects.push(e);
      }
      if (e.mods) e.mods.acBonus = Math.max(floor, (e.mods.acBonus ?? 0) - melt.amount);
      say(state, `${target.name}'s armour corrodes (AC ${effectiveAc(target)})`, target.id);
    }
  }

  // the concussed rider — a thunder hit strips reactions until the target's next turn
  if (type === "thunder" && opts.sourceId) {
    const cc = state.units.get(opts.sourceId)?.ref.specialRules.find((r) => r.rule === "noReactionsAfter");
    if (cc && cc.rule === "noReactionsAfter" && cc.damageType === "thunder" && !target.conditions.has("concussed")) {
      target.conditions.set("concussed", { expiresRound: state.round + 1, sourceId: opts.sourceId });
    }
  }

  // concentration check — a failed CON save ends the ongoing spell (and its effects)
  if (target.concentratingOn && dmg > 0) {
    const dc = Math.max(10, Math.floor(dmg / 2));
    const s = rollSave(state, target, "con", dc, { magical: false, stakes: "damage", allowLegendaryResistance: false });
    if (!s.passed) breakConcentration(state, target, "damage");
  }

  // Strength of the Grave (Shadow Magic) — a Charisma save (DC 5 + the damage taken) to drop to 1 HP
  // instead of 0; not against radiant damage or a critical hit; only a success spends the use
  if (target.hp <= 0) {
    const sd = target.ref.specialRules.find((r) => r.rule === "surviveDrop");
    if (sd && sd.rule === "surviveDrop" && (target.resources.get(sd.resource) ?? 0) > 0 &&
        !sd.excludeTypes.includes(type) && !(sd.excludeCrit && opts.crit)) {
      const s = rollSave(state, target, sd.ability, sd.baseDc + dmg, { magical: false, allowLegendaryResistance: false });
      if (s.passed) {
        target.resources.set(sd.resource, (target.resources.get(sd.resource) ?? 0) - 1);
        target.hp = 1;
        say(state, `${target.name} clings to life (Strength of the Grave, 1 HP)`, target.id);
        return dmg;
      }
    }
  }

  // Mastery of Death — dropping to 0, spend 1 ki (no action) to stay at 1 hit point
  if (target.hp <= 0) {
    const mod = target.ref.specialRules.find((r) => r.rule === "spendToSurvive");
    if (mod && mod.rule === "spendToSurvive" && (target.resources.get(mod.resource) ?? 0) > 0) {
      target.resources.set(mod.resource, (target.resources.get(mod.resource) ?? 0) - 1);
      target.hp = 1;
      say(state, `${target.name} refuses to fall (Mastery of Death, 1 HP)`, target.id);
      return dmg;
    }
  }

  // Relentless Rage — dropping to 0 while raging: a Constitution save (DC 10, +5 per use since the last rest) to stay at 1 HP
  if (target.hp <= 0 && target.effects.some((e) => e.name === "rage") && target.ref.specialRules.some((r) => r.rule === "relentlessRage") &&
      -target.hp < target.maxHp) { // damage that leaves you at -maxHp or worse kills outright
    const uses = target.relentlessUses ?? 0;
    const s = rollSave(state, target, "con", 10 + 5 * uses, { magical: false, allowLegendaryResistance: false });
    target.relentlessUses = uses + 1;
    if (s.passed) {
      target.hp = 1;
      say(state, `${target.name}'s rage keeps them on their feet (Relentless Rage, 1 HP)`, target.id);
      return dmg;
    }
  }

  if (target.hp <= 0) {
    handleDropToZero(state, target);
  } else {
    // post-damage reactions: recharge-a-breath-when-bloodied, punish-the-attacker, big-hit
    const crossedHalf = hpBefore > target.maxHp / 2 && target.hp <= target.maxHp / 2;
    reactToDamageTaken(state, {
      target, amount: dmg, crossedHalf,
      viaAttackOrSpell: !!(opts.viaAttack || opts.viaSpell),
      fromCreature: !!opts.sourceId && opts.sourceId !== target.id,
    });
  }
  return dmg;
}

function handleDropToZero(state: CombatState, target: CombatantState): void {
  if (!target.alive || target.downed) return;
  // Rage Beyond Death: raging, 0 hit points doesn't knock you unconscious
  if (target.side === "party" && target.summonerId === undefined && target.effects.some((e) => e.name === "rage") &&
      target.ref.specialRules.some((r) => r.rule === "rageBeyondDeath")) {
    target.hp = 0;
    target.zeroHpRaging = true;
    target.deathSaves = { success: 0, fail: 0 };
    say(state, `${target.name} fights on at 0 HP (Rage Beyond Death)`, target.id);
    return;
  }
  // Undying return (Undying Grudge / Unrelenting Storm)
  const ur = target.ref.specialRules.find((r) => r.rule === "undyingReturn");
  if (ur && ur.rule === "undyingReturn" && !target.onceFired.has("undyingReturn")) {
    target.onceFired.add("undyingReturn");
    target.hp = ur.returnHp;
    target.conditions.clear();
    say(state, `${target.name} refuses to die (returns at ${ur.returnHp} HP)`, target.id);
    return;
  }
  target.hp = 0;
  if (target.downedRound === undefined) target.downedRound = state.round;
  // a summoned companion on the party's side (Steel Defender, Eldritch Cannon, a conjured beast)
  // is destroyed at 0 HP like a monster — it doesn't make death saves like a player character
  if (target.side === "monster" || target.summonerId !== undefined) {
    target.alive = false;
    say(state, `${target.name} is destroyed`, target.id);
  } else {
    target.downed = true;
    target.effects = target.effects.filter((e) => e.name !== "rage"); // knocked unconscious: the rage ends
    target.concentratingOn = undefined;
    say(state, `${target.name} drops to 0 HP`, target.id);
    if (state.firstPartyDownRound === undefined) {
      state.firstPartyDownRound = state.round;
      state.firstPartyDownId = target.id;
    }
  }
  reactToDrop(state, target); // "react when a creature drops" reactions
}
