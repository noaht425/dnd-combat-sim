// The three primitives every automation node bottoms out in: an attack roll, a
// saving throw, and applying damage. Each folds in conditions, active-effect
// mods, Magic Resistance, and the Legendary Resistance budget.

import type { Ability, AdvMode, DamageType } from "../schema";
import { abilityMod } from "../math";
import {
  CombatantState,
  CombatState,
  breakConcentration,
  effectiveAc,
  hasCondition,
  say,
} from "./state";
import {
  reactToDamageTaken,
  reactToDrop,
  reactToElementalDamage,
  reactToIncomingAttack,
  reduceIncomingDamage,
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
  nat: number;
}

export function rollAttack(
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

  let adv = combineAdv(intrinsicAdv, attackerConditionDis, attackerBlind, targetGivesAdv, targetInvisible);

  // target denies advantage entirely (It Has Been Seen); foresight-style effect gives attackers disadvantage
  if (ruleActive(target, "denyAdvantageToAttackers") && adv === "adv") adv = "flat";
  for (const e of target.effects) {
    if (e.mods?.attacksAgainstItAdvantage === "dis") adv = combineAdv(adv, "dis");
  }
  for (const e of attacker.effects) {
    if (e.mods?.attackAdvantage === "adv") adv = combineAdv(adv, "adv");
    if (e.mods?.attackAdvantage === "dis") adv = combineAdv(adv, "dis");
  }
  // Ambush / Assassinate — advantage on round 1 vs foes that haven't acted
  const assassinating = !!attacker.assassinateUntilRound && state.round <= attacker.assassinateUntilRound;
  if (assassinating) adv = combineAdv(adv, "adv");

  // what-if to-hit knob
  if (state.tuning) {
    if (attacker.side === "monster" && state.tuning.monsterToHitDelta) toHit += state.tuning.monsterToHitDelta;
    if (attacker.side === "party" && state.tuning.partyToHitDelta) toHit += state.tuning.partyToHitDelta;
  }

  const { used } = state.rng.d20mode(adv);
  let ac = effectiveAc(target) + extraTargetAc;
  const hits = (f: number) => f >= critRange || f + toHit >= ac;
  const face = precogSwap(state, attacker, used, used !== 1 && hits(used), hits);
  const crit = face >= critRange;
  const autoMiss = face === 1;

  // the target may spend a reaction to change this outcome (Shield, Weight of Ages)
  if (!state.inReaction && !autoMiss) {
    const rr = reactToIncomingAttack(state, { target, hitMargin: face + toHit - ac, crit });
    if (rr.negated) return { hit: false, crit: false, hadAdvantage: adv === "adv", nat: face };
    if (rr.shielded) ac = effectiveAc(target) + extraTargetAc; // the +5 Shield effect is now active
  }

  const hit = !autoMiss && (crit || face + toHit >= ac);
  // a hit with a melee attack against a paralyzed or unconscious creature is a
  // critical hit (attacker within 5 ft)
  let finalCrit = crit;
  if (hit && attacker.zone === "melee" &&
      (hasCondition(target, "paralyzed") || hasCondition(target, "unconscious"))) {
    finalCrit = true;
  }
  if (hit && assassinating) finalCrit = true; // Assassinate: any hit on a surprised foe is a crit
  return { hit, crit: finalCrit, hadAdvantage: adv === "adv", nat: face };
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

export function rollSave(
  state: CombatState,
  target: CombatantState,
  ability: Ability,
  dc: number,
  opts: { magical?: boolean; allowLegendaryResistance?: boolean; stakes?: SaveStakes } = {},
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
    if (e.mods?.disadvantageOnFirstD20EachRound) adv = combineAdv(adv, "dis"); // "doomed" — simplification
  }
  // restrained imposes disadvantage on Dexterity saving throws
  if (ability === "dex" && hasCondition(target, "restrained")) adv = combineAdv(adv, "dis");

  const { used } = state.rng.d20mode(adv);
  const mod = saveModifierOf(target, ability);
  const succeeds = (f: number) => f + mod >= dc; // 2014 RAW: no auto-success on a natural 20 for saves
  const face = precogSwap(state, target, used, succeeds(used), succeeds);
  const passed = succeeds(face);

  // the endurance rider — add CON to a failed save, at an escalating self-cost
  if (!passed && maybeForcedEndurance(state, target, face + mod, dc, opts.stakes ?? "damage")) {
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
  rawAmount = reduceIncomingDamage(state, target, rawAmount, opts.viaAttack ?? false);
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
    const resisted =
      ref.resistances.includes(type) ||
      absorbed ||
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
  if (target.side === "monster") {
    target.alive = false;
    say(state, `${target.name} is destroyed`, target.id);
  } else {
    target.downed = true;
    target.concentratingOn = undefined;
    say(state, `${target.name} drops to 0 HP`, target.id);
    if (state.firstPartyDownRound === undefined) {
      state.firstPartyDownRound = state.round;
      state.firstPartyDownId = target.id;
    }
  }
  reactToDrop(state, target); // "react when a creature drops" reactions
}
