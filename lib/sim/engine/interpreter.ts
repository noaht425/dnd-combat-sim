// Executes an automation-node tree against live combat state.

import { SIZES, type Action, type AutomationNode, type Condition, type DamageType } from "../schema";

import { applyDamage, critRangeFor, rollAttack, rollSave, type AttackResult } from "./resolve";
import { MINIONS, PC_SUMMONS } from "./minions";
import { isSpell, mayCounterspell, provokeOpportunityAttacks, reactToAttackResolved } from "./reactions";
import {
  CombatantState,
  CombatState,
  applyHealing,
  breakConcentration,
  hasCondition,
  hpSnapshot,
  humanize,
  initCombatant,
  isIncapacitated,
  livingAllies,
  livingEnemies,
  say,
} from "./state";

interface RunCtx {
  state: CombatState;
  source: CombatantState;
  scope: CombatantState[]; // the current "these are the targets" set
  last: {
    attackHit?: boolean;
    attackCrit?: boolean;
    attackAdv?: boolean;
    /** an ally of the attacker was within 5ft of the target on this attack —
     *  Sneak Attack's other prerequisite, alongside attackAdv */
    allyAdjacent?: boolean;
    /** the target was already below its hit point maximum when the attack hit (before this hit's damage) — Colossus Slayer */
    woundedAtHit?: boolean;
    /** the attack roll was at net disadvantage */
    attackDis?: boolean;
    /** Swashbuckler: within 5 ft of the target with no other creature within 5 ft of the attacker */
    soloDuel?: boolean;
    /** this attack's Sneak Attack damage has been claimed (riders like Rend Mind key off it) */
    sneakLanded?: boolean;
    /** ...and the target is the creature the rogue is currently reading (Eye for Weakness) */
    insightMarked?: boolean;
    savePassed?: boolean;
  };
  depth: number;
  /** true while we're inside a save's onFail branch that should be halved on success */
  halfMode?: boolean;
  crit?: boolean;
  /** when set, `target` nodes hit exactly these units instead of re-resolving `who` (used for per-unit aura ticks) */
  forceScope?: CombatantState[];
  /** AoE: the dice for a given damage string are rolled ONCE and shared across every target (RAW) */
  sharedRolls?: Map<string, number>;
  /** AoE: targetId -> did it save (for the play-by-play) */
  saveLog?: Map<string, boolean>;
  /** true while resolving an attack's onHit/onMiss — damage counts as "from an attack" */
  inAttack?: boolean;
  /** true while resolving a spell action — damage counts as "from a spell" */
  spell?: boolean;
  /** effect / condition names applied during this action (for concentration linkage) */
  appliedNames?: string[];
  /** battle mode only: geometry-aware target picker. Return null to fall back to
   *  the abstract `selectTargets`. Never set by the Monte-Carlo engine. */
  geoTargets?: (node: Extract<AutomationNode, { type: "target" }>, source: CombatantState) => CombatantState[] | null;
  /** battle mode only: per-target attack tweaks (cover -> +AC, long range -> disadvantage,
   *  a melee routine whose target is out of reach -> the swing simply doesn't land) */
  attackMods?: (target: CombatantState, info?: { ranged?: boolean }) => { acBonus?: number; disadvantage?: boolean; unreachable?: boolean; allyAdjacent?: boolean; soloDuel?: boolean };
  /** the action being run makes RANGED attacks (Action.ranged) */
  ranged?: boolean;
  /** running count of attack rolls this action made, so `runAction` can say
   *  "misses" / "can't reach" instead of a flat "(no effect)" */
  attackTally?: { rolled: number; hit: number; unreachable: boolean };
}

/** Options passed to `runAction`; `geo` seeds the battle-mode seams onto the root ctx. */
export interface RunActionOpts {
  asLegendary?: boolean;
  asReaction?: boolean;
  /** overrides the "(reaction) " / "(legendary) " tag in the play-by-play line */
  verb?: string;
  geo?: Pick<RunCtx, "geoTargets" | "attackMods">;
  /** a death-burst trait fires on the creature's own dying breath — `isIncapacitated`
   *  (which treats "!alive" as incapacitated) would otherwise always block it. */
  skipIncapacitatedCheck?: boolean;
  /** pins every `target` node in this action to exactly these units, bypassing
   *  `who` resolution — used for a retaliation trait that must hit whoever just
   *  attacked it, not "aiChoice"/"eachEnemy" from the trait-bearer's own AI. */
  forceScope?: CombatantState[];
}

const LOCK_CONDITIONS: Condition[] = ["stunned", "paralyzed", "incapacitated", "unconscious", "petrified"];
const CONTROL_CONDITIONS: Condition[] = ["charmed", "restrained", "transfixed", "frightened", "prone", "blinded", "marked-for-reckoning"];

function saveStakes(onFail: AutomationNode[]): "damage" | "control" | "lock" {
  for (const n of onFail) {
    if (n.type === "applyCondition" && LOCK_CONDITIONS.includes(n.condition)) return "lock";
    if (n.type === "applyEffect" && (n.mods?.speedZero)) return "lock";
  }
  for (const n of onFail) {
    if (n.type === "applyCondition" && CONTROL_CONDITIONS.includes(n.condition)) return "control";
    if (n.type === "applyEffect" && (n.mods?.noReactions || n.mods?.saveAdvantage === "dis" || n.saveEnds)) return "control";
  }
  return "damage";
}

function rollDamage(state: CombatState, amount: string, mult = 1, crit = false, rerollAtMost = 0): number {
  const cleaned = amount.replace(/\s+/g, "");
  if (/^-?\d+$/.test(cleaned)) return Number(cleaned) * mult;
  let total = 0;
  for (const term of cleaned.match(/[+-]?(\d*d\d+|\d+)/gi) ?? []) {
    const sign = term.startsWith("-") ? -1 : 1;
    const body = term.replace(/^[+-]/, "");
    const dm = body.match(/^(\d*)d(\d+)$/i);
    if (dm) {
      let n = (dm[1] ? Number(dm[1]) : 1) * mult;
      if (crit) n *= 2;
      if (rerollAtMost > 0) { // Great Weapon Fighting: each die showing a 1 or 2 is rerolled once, keeping the new roll
        for (let k = 0; k < n; k++) {
          let r = state.rng.dice(1, Number(dm[2]));
          if (r <= rerollAtMost) r = state.rng.dice(1, Number(dm[2]));
          total += sign * r;
        }
      } else total += sign * state.rng.dice(n, Number(dm[2]));
    } else {
      total += sign * Number(body);
    }
  }
  return Math.round(total);
}

/** smites, Ensnaring Strike, Hex, Hunter's Mark, Crusader's Mantle, Elemental Weapon, ... —
 *  anything that tags `attacker` with an `extraDamageOnHit` rider fires it here, on every
 *  attack roll `attacker` lands (spell attacks included — the schema doesn't distinguish
 *  weapon vs. spell attacks). A `oneShot` effect (a one-hit smite) is consumed immediately;
 *  if that was the caster's concentration spell, ending it here is correct — the spell's own
 *  duration is "until the triggering hit lands or 1 minute", not the full minute regardless. */
function applyExtraDamageOnHit(state: CombatState, attacker: CombatantState, target: CombatantState, res: AttackResult): void {
  // marks on the target that only the creature that applied them cashes in (Slayer's Prey, Planar Warrior)
  for (const e of [...target.effects]) {
    const mark = e.mods?.extraDamageWhenHitBySource;
    if (!mark || e.sourceId !== attacker.id || !target.alive) continue;
    if (mark.oncePerTurn && !claimOncePerTurn(state, attacker, `mark:${e.name}`)) continue;
    applyDamage(state, target, rollDamage(state, mark.amount, 1, res.crit), mark.damageType as DamageType, {
      hadAdvantage: res.hadAdvantage, attackerMagical: true, sourceId: attacker.id, viaAttack: true,
    });
  }
  for (const e of [...attacker.effects]) {
    const extra = e.mods?.extraDamageOnHit;
    if (!extra) continue;
    if (e.mods?.extraDamageOncePerTurn && !claimOncePerTurn(state, attacker, `extra:${e.name}`)) continue;
    const amt = rollDamage(state, extra.amount, 1, res.crit);
    applyDamage(state, target, amt, extra.damageType, {
      hadAdvantage: res.hadAdvantage, attackerMagical: true, sourceId: attacker.id, viaAttack: true,
    });
    if (!e.oneShot) continue;
    if (attacker.concentratingOn && attacker.concentrationEffects?.includes(e.name)) {
      breakConcentration(state, attacker, "recast"); // the spell resolved, not "broken" — no log line
    } else {
      attacker.effects = attacker.effects.filter((x) => x !== e);
    }
  }
}

/** a "pops like a balloon" / death-burst trait — fired once, the instant `dying`
 *  transitions from up to downed/dead, with `dying` itself as the automation's
 *  source (so "area"/"eachEnemy" resolve relative to where it died, hitting its
 *  actual foes, not whoever dealt the killing blow). Run through `runAction` (not
 *  a bare `runAutomation`) so it gets its own "Name — Trait -> ..." log line,
 *  same as any other triggered reaction, instead of silently mutating HP. */
function fireOnDeathTraits(state: CombatState, dying: CombatantState): void {
  for (const trait of dying.ref.traits) {
    if (trait.trigger !== "whenReducedToZero" || !trait.automation.length) continue;
    runAction(state, dying, {
      id: trait.id, name: trait.name, cost: {}, recharge: "none", automation: trait.automation,
    }, { asReaction: true, skipIncapacitatedCheck: true });
  }
}

/** a "you gain something when you land the killing blow" trait (Dark One's
 *  Blessing, and the like) — fires on `source` (the one who dealt the
 *  damage), not the victim, the moment the victim transitions from up to
 *  downed/dead. The automation targets `who: "self"` (source gains the
 *  benefit), so unlike fireOnHitTraits this needs no forceScope. Declared
 *  in the schema's trigger enum from the start but never actually
 *  dispatched anywhere until now. */
function fireOnKillTraits(state: CombatState, source: CombatantState): void {
  for (const trait of source.ref.traits) {
    if (trait.trigger !== "onKill" || !trait.automation.length) continue;
    runAction(state, source, {
      id: trait.id, name: trait.name, cost: {}, recharge: "none", automation: trait.automation,
    }, { asReaction: true, skipIncapacitatedCheck: true });
  }
}

/** a "hurts you back" trait (Corrosive Form, Corrosive Hide, ...) — fires whenever
 *  `hitTarget` is struck by a landed attack, with `hitTarget` as the source (so
 *  the retaliation is its own effect) but pinned via forceScope onto `attacker`
 *  specifically — a plain "aiChoice"/"eachEnemy" `who` would pick whatever
 *  `hitTarget`'s own AI prefers, not necessarily the creature that just hit it. */
function fireOnHitTraits(state: CombatState, hitTarget: CombatantState, attacker: CombatantState): void {
  for (const trait of hitTarget.ref.traits) {
    if (trait.trigger !== "whenHitByAttack" || !trait.automation.length) continue;
    runAction(state, hitTarget, {
      id: trait.id, name: trait.name, cost: {}, recharge: "none", automation: trait.automation,
    }, { asReaction: true, skipIncapacitatedCheck: true, forceScope: [attacker] });
  }
}

/** the first living party member holding at least one of `resource` (see `spendResource.from`) */
function partyResourceOwner(state: CombatState, viewer: CombatantState, resource: string): CombatantState | undefined {
  return livingAllies(state, viewer).find((u) => (u.resources.get(resource) ?? 0) > 0);
}

/** Fires every `encounterStart` trait once, right after initiative is rolled (an Alchemist
 *  rolling the effects of the elixirs it brewed at its last long rest). Uses the fight's own
 *  seeded dice, so replays stay deterministic. */
export function fireEncounterStartTraits(state: CombatState): void {
  for (const u of [...state.units.values()]) {
    for (const trait of u.ref.traits) {
      if (trait.trigger !== "encounterStart" || !trait.automation.length) continue;
      // straight to the automation (no "uses X" summary line) — the nodes narrate themselves
      runAutomation(trait.automation, { state, source: u, scope: [], last: {}, depth: 0 });
    }
  }
}

/** very small expression evaluator for branch.if — best-effort, defaults to true on anything unknown */
function evalExpr(expr: string, ctx: RunCtx): boolean {
  const s = ctx.source;
  const st = ctx.state;
  const tgt = ctx.scope[0];
  const checks: Array<[RegExp, () => boolean]> = [
    [/self\.hp\s*<=\s*self\.maxhp\s*\/\s*2/i, () => s.hp <= s.maxHp / 2],
    [/self\.hp\s*<=\s*(\d+)/i, () => s.hp <= Number(RegExp.$1)],
    [/round\s*>=\s*(\d+)/i, () => st.round >= Number(RegExp.$1)],
    [/self\.has\('([^']+)'\)/i, () => s.effects.some((e) => e.name === RegExp.$1) || hasCondition(s, RegExp.$1 as Condition)],
    [/self\.resource\('([^']+)'\)\s*(>=|>)\s*(\d+)/i, () => {
      const cur = s.resources.get(RegExp.$1) ?? 0;
      const n = Number(RegExp.$3);
      return RegExp.$2 === ">=" ? cur >= n : cur > n;
    }],
    // a resource held by whichever living party member owns it (an Alchemist's elixir stock,
    // read by the ally who is about to drink one)
    [/party\.resource\('([^']+)'\)\s*>\s*0/i, () => partyResourceOwner(st, s, RegExp.$1) !== undefined],
    // A caster can walk in mid-song and sustain a charm-song as a bonus action —
    // so it counts as "singing" from round 1 until it drops.
    [/self\.(is_?singing|singing)/i, () => s.alive && (st.round <= 1 || s.lastSangRound !== undefined)],
    [/self\.sang_?since_?last_?turn/i, () => s.alive && (st.round <= 1 || s.lastSangRound !== undefined)],
    [/target\.has\('([^']+)'\)/i, () => !!tgt && (tgt.effects.some((e) => e.name === RegExp.$1) || hasCondition(tgt, RegExp.$1 as Condition))],
    [/target\.hp\s*<\s*target\.maxhp/i, () => !!tgt && tgt.hp < tgt.maxHp],
    [/target\.hp\s*<=\s*(\d+)/i, () => !!tgt && tgt.hp <= Number(RegExp.$1)],
    [/target\.hp\s*<\s*(\d+)/i, () => !!tgt && tgt.hp < Number(RegExp.$1)],
    [/target\.grappledby\(self\)/i, () => !!tgt && hasCondition(tgt, "grappled")],
    [/lastsave\.passed/i, () => ctx.last.savePassed === true],
    [/lastattack\.hadadvantage/i, () => ctx.last.attackAdv === true],
    [/target\.size<=(\w+)/i, () => !!tgt && SIZES.indexOf(tgt.ref.size) <= SIZES.indexOf(RegExp.$1.toLowerCase() as (typeof SIZES)[number])],
    [/target\.wounded_?at_?hit/i, () => ctx.last.woundedAtHit === true],
    [/party\.missing_?hp\s*>=\s*(\d+)/i, () => livingAllies(st, s).reduce((n, a) => n + Math.max(0, a.maxHp - a.hp), 0) >= Number(RegExp.$1)],
    [/self\.has_?companion/i, () => [...st.units.values()].some((u) => u.summonerId === s.id && u.alive && !u.downed)],
    [/self\.no_?companion/i, () => ![...st.units.values()].some((u) => u.summonerId === s.id && u.alive && !u.downed)],
    [/enemies\s*>=\s*(\d+)/i, () => livingEnemies(st, s).length >= Number(RegExp.$1)],
    [/round\s*<=\s*(\d+)/i, () => st.round <= Number(RegExp.$1)],
    [/self\.hasnt\('([^']+)'\)/i, () => !(s.effects.some((e) => e.name === RegExp.$1) || hasCondition(s, RegExp.$1 as Condition))],
    // Path of the Beast: in this natural-weapon form, or able to rage into it this turn (so the attack can be chosen in the same
    // decision as the Rage bonus action that grows the weapon)
    [/self\.canform\('([^']+)'\)/i, () => s.effects.some((e) => e.name === `form-${RegExp.$1}`) ||
      (!s.effects.some((e) => e.name === "rage") && (s.resources.get("rage") ?? 0) > 0)],
    [/self\.bonus_?free/i, () => !s.bonusUsedThisTurn && !isIncapacitated(s)],
    [/self\.reaction_?free/i, () => !s.reactionUsed && !isIncapacitated(s)],
    [/self\.hp\s*<\s*self\.maxhp\s*\/\s*2/i, () => s.hp < s.maxHp / 2],
    [/self\.has_?ally/i, () => livingAllies(st, s).some((a) => a.id !== s.id && a.summonerId === undefined)],
    [/self\.not_?reading/i, () => !(s.insightTargetId && (s.insightUntilRound ?? 0) >= st.round && st.units.get(s.insightTargetId)?.alive)],
    [/lastattack\.sneaklanded/i, () => ctx.last.sneakLanded === true],
    [/lastattack\.insightmarked/i, () => ctx.last.insightMarked === true],
  ];
  for (const [re, fn] of checks) {
    if (re.test(expr)) {
      try { return fn(); } catch { return true; }
    }
  }
  // things we don't model yet (self.isSinging, deadCreature.*, ...) — assume they don't fire
  return false;
}

function selectTargets(node: Extract<AutomationNode, { type: "target" }>, ctx: RunCtx): CombatantState[] {
  const { state, source } = ctx;
  const enemies = livingEnemies(state, source);
  const allies = livingAllies(state, source);
  const who = node.who;
  switch (who.who) {
    case "self": return [source];
    case "eachAlly": {
      const r = who.withinFt;
      const pool = who.excludeSelf ? allies.filter((a) => a.id !== source.id) : allies;
      if (!r || !state.distanceFt) return pool;
      return pool.filter((a) => a.id === source.id || state.distanceFt!(source, a) <= r + 0.001);
    }
    case "lowestHpAlly": {
      const hurt = allies.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      return hurt ? [hurt] : [source];
    }
    case "eachEnemy": {
      if (who.withinFt && state.distanceFt) {
        return enemies.filter((e) => state.distanceFt!(source, e) <= who.withinFt! + 0.001);
      }
      // The party ganging a solo hits it regardless of position. A monster's
      // burst / aura / presence realistically only catches the front line — a
      // real party spreads out against a solo caster. Same abstraction as `area`.
      if (source.side === "party" || enemies.length <= 2) return enemies;
      const n = Math.max(2, Math.round(enemies.length / 2));
      return enemies.slice().sort((a, b) => a.hp - b.hp).slice(0, n);
    }
    case "nearestEnemy": return enemies.length ? [enemies[0]] : [];
    case "lowestHpEnemy": return enemies.length ? [enemies.slice().sort((a, b) => a.hp - b.hp)[0]] : [];
    case "squishiestEnemy": {
      const sorted = enemies.slice().sort((a, b) => a.ac - b.ac || a.hp - b.hp);
      if (who.preferFresh && source.sneakSpent && source.sneakSpent.serial === (state.turnSerial ?? 0)) {
        const fresh = sorted.find((e) => !source.sneakSpent!.targets.includes(e.id));
        if (fresh) return [fresh];
      }
      return sorted.slice(0, 1);
    }
    case "marked": {
      const m = source.markedTargetId ? state.units.get(source.markedTargetId) : undefined;
      return m && m.alive && !m.downed ? [m] : enemies.slice(0, 1);
    }
    case "aiChoice": {
      if (!enemies.length) return [];
      // both sides gang up on a shared focus target (party or monster pack)
      const sharedFocus = source.side === "party" ? state.focusId
        : source.ref.ai.focusFire ? state.monsterFocusId : undefined;
      if (sharedFocus) {
        const f = state.units.get(sharedFocus);
        if (f && f.alive && !f.downed && f.side !== source.side) return [f];
      }
      const p = source.ref.ai.targetPriority;
      const pool = enemies.slice();
      if (p === "lowestHp") pool.sort((a, b) => a.hp - b.hp);
      else if (p === "squishiest") pool.sort((a, b) => a.ac - b.ac || a.hp - b.hp);
      else if (p === "marked" && source.markedTargetId) {
        const m = state.units.get(source.markedTargetId);
        if (m && m.alive && !m.downed) return [m];
      }
      return [pool[0]];
    }
    case "enemyRank": {
      const pool = enemies.slice().sort((a, b) => a.ac - b.ac || a.hp - b.hp);
      return pool.length ? [pool[Math.min(who.rank, pool.length - 1)]] : [];
    }
    case "chosenEnemies": {
      let pool = enemies.slice().sort((a, b) => a.hp - b.hp);
      if (who.withinFt && state.distanceFt) pool = pool.filter((e) => state.distanceFt!(source, e) <= who.withinFt! + 0.001);
      return pool.slice(0, Math.min(who.upTo, pool.length));
    }
    case "area": {
      // abstract: an AoE catches whoever is bunched up — a random ~2.5 of the
      // enemies, re-rolled per cast so the backline isn't permanently safe
      const n = Math.max(1, Math.min(enemies.length, Math.round(enemies.length >= 3 ? 2.5 : enemies.length)));
      const shuffled = enemies.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = state.rng.int(0, i);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled.slice(0, n);
    }
    default:
      return enemies.slice(0, 1);
  }
}

/** Psychic Veil and the like: invisibility ends the moment you deal damage to a creature or force a saving throw */
function endInvisibilityOnStrike(u: CombatantState): void {
  if (!u.effects.some((e) => e.mods?.endsOnDealingDamage)) return;
  u.effects = u.effects.filter((e) => !e.mods?.endsOnDealingDamage);
  u.conditions.delete("invisible");
}

/** a rider that lands at most once per turn under `key` (Divine Fury, a bite's healing, Call the Hunt's d6) */
function claimOncePerTurn(state: CombatState, u: CombatantState, key: string): boolean {
  const serial = state.turnSerial ?? 0;
  if (!u.onceTurn || u.onceTurn.serial !== serial) u.onceTurn = { serial, keys: [] };
  if (u.onceTurn.keys.includes(key)) return false;
  u.onceTurn.keys.push(key);
  return true;
}

/** Infused Strikes: a drake within 30 ft of the attacker adds its essence's damage to a weapon hit, spending its reaction */
function infusedStrikes(state: CombatState, attacker: CombatantState, target: CombatantState): void {
  if (state.inReaction) return;
  for (const d of state.units.values()) {
    if (d.id === attacker.id || d.side !== attacker.side || !d.alive || d.downed || d.reactionUsed || isIncapacitated(d)) continue;
    const rule = d.ref.specialRules.find((r) => r.rule === "infusedStrikes");
    if (!rule || rule.rule !== "infusedStrikes") continue;
    if (state.distanceFt && state.distanceFt(d, attacker) > 30.001) continue;
    d.reactionUsed = true;
    say(state, `${d.name} infuses ${attacker.name}'s strike`, d.id);
    applyDamage(state, target, rollDamage(state, rule.dice), rule.damageType as DamageType, { sourceId: d.id, viaAttack: true, attackerMagical: true });
    return;
  }
}

/** Monte-Carlo has no grid, only the abstract melee / ranged zones: "nobody else within 5 ft of me" reads as
 *  "the attacker and its target are the only creatures in the melee zone". */
function abstractSoloDuel(state: CombatState, attacker: CombatantState, target: CombatantState): boolean {
  if (attacker.zone !== "melee") return false;
  for (const x of state.units.values()) {
    if (x.alive && x.id !== attacker.id && x.id !== target.id && x.zone === "melee") return false;
  }
  return true;
}

/**
 * Can this hit carry Sneak Attack? Once per turn (any creature's turn), and the hit needs one of:
 *   - advantage on the roll (and no disadvantage cancelling it),
 *   - an ally of the attacker within 5 ft of the target,
 *   - Swashbuckler's Rakish Audacity (`soloSneak`): a solo duel, no disadvantage,
 *   - Inquisitive's Insightful Fighting: the target is the one currently read, no disadvantage.
 * Scout's Sudden Strike (`suddenStrike`) allows a second Sneak Attack in a turn, on a different target.
 * On success the budget is spent and `last.sneakLanded` (+ `insightMarked`) are set for the riders.
 */
function claimSneakAttack(ctx: RunCtx, target: CombatantState): boolean {
  const { state, source, last } = ctx;
  const serial = state.turnSerial ?? 0;
  if (!source.sneakSpent || source.sneakSpent.serial !== serial) source.sneakSpent = { serial, targets: [] };
  const spent = source.sneakSpent;
  const rules = source.ref.specialRules;
  if (spent.targets.length > 0) {
    const second = rules.some((r) => r.rule === "suddenStrike") && spent.targets.length < 2 && !spent.targets.includes(target.id);
    if (!second) return false;
  }
  const reading = source.insightTargetId === target.id && (source.insightUntilRound ?? 0) >= state.round;
  const ok =
    last.attackAdv ||
    (!last.attackDis && (last.allyAdjacent || reading || (last.soloDuel && rules.some((r) => r.rule === "soloSneak"))));
  if (!ok) return false;
  spent.targets.push(target.id);
  last.sneakLanded = true;
  last.insightMarked = reading;
  return true;
}

/** Scout's Ambush Master: the first creature it hits in round 1 is easier for the whole party to hit until
 *  the start of the scout's next turn. */
function tagAmbushTarget(state: CombatState, attacker: CombatantState, target: CombatantState): void {
  if (state.round !== 1 || attacker.ambushMasterUsed) return;
  if (!attacker.ref.specialRules.some((r) => r.rule === "ambushMaster")) return;
  attacker.ambushMasterUsed = true;
  target.effects = target.effects.filter((e) => e.name !== "ambush-master");
  target.effects.push({
    name: "ambush-master", mods: { attacksAgainstItAdvantage: "adv", untilSourceNextTurn: true },
    expiresRound: Infinity, sourceId: attacker.id,
  });
  say(state, `${attacker.name} marks ${target.name} — attacks against it have advantage until ${attacker.name}'s next turn`, attacker.id);
}

export function runAutomation(nodes: AutomationNode[], ctx: RunCtx): void {
  if (ctx.depth > 12) return;
  const { state, source } = ctx;

  for (const node of nodes) {
    const once = (node as { oncePerTurn?: string }).oncePerTurn;
    if (once && !claimOncePerTurn(state, source, once)) continue;
    switch (node.type) {
      case "note":
        break;

      case "target": {
        const targets = ctx.forceScope ?? ctx.geoTargets?.(node, source) ?? selectTargets(node, ctx);
        // an area / multi-target effect rolls its damage dice once and shares
        // the total across every creature caught (each still saves for its own half)
        const multi = targets.length > 1;
        const sharedRolls = multi ? new Map<string, number>() : ctx.sharedRolls;
        const saveLog = multi ? (ctx.saveLog ?? new Map<string, boolean>()) : ctx.saveLog;
        for (const t of targets) {
          runAutomation(node.effects, {
            ...ctx, scope: [t], forceScope: undefined, sharedRolls, saveLog,
            depth: ctx.depth + 1, last: { ...ctx.last },
          });
        }
        break;
      }

      case "attack": {
        const t = ctx.scope[0];
        if (!t) break;
        const bonus = typeof node.bonus === "number" ? node.bonus : 12;
        const tweak = ctx.attackMods?.(t, { ranged: ctx.ranged });
        if (tweak?.unreachable) {
          if (ctx.attackTally) ctx.attackTally.unreachable = true;
          break; // out of melee reach — the swing never connects
        }
        const adv = tweak?.disadvantage ? "dis" : node.adv;
        const critRange = Math.min(node.critRange ?? 20, critRangeFor(source));
        const res = rollAttack(state, source, t, bonus, adv, critRange, tweak?.acBonus ?? 0);
        if (ctx.attackTally) {
          ctx.attackTally.rolled++;
          if (res.hit) ctx.attackTally.hit++;
        }
        const soloDuel = tweak ? tweak.soloDuel : abstractSoloDuel(state, source, t);
        const next: RunCtx = { ...ctx, last: { ...ctx.last, attackHit: res.hit, attackCrit: res.crit, attackAdv: res.hadAdvantage, attackDis: res.hadDisadvantage, woundedAtHit: t.hp < t.maxHp, allyAdjacent: tweak?.allyAdjacent, soloDuel, sneakLanded: false, insightMarked: false }, crit: res.crit, inAttack: true, depth: ctx.depth + 1 };
        if (source.zone === "melee" && source.ref.specialRules.some((r) => r.rule === "fancyFootwork")) {
          const serial = state.turnSerial ?? 0;
          if (!source.footwork || source.footwork.serial !== serial) source.footwork = { serial, ids: [] };
          if (!source.footwork.ids.includes(t.id)) source.footwork.ids.push(t.id);
        }
        if (res.hit) {
          tagAmbushTarget(state, source, t);
          runAutomation(node.onHit, next);
          applyExtraDamageOnHit(state, source, t, res);
          fireOnHitTraits(state, t, source);
          if (t.ref.specialRules.some((r) => r.rule === "multiattackDefense") && t.alive) { // +4 AC against this attacker until its next turn
            t.effects = t.effects.filter((e) => !(e.name === "multiattack-defense" && e.sourceId === source.id));
            t.effects.push({ name: "multiattack-defense", mods: { acBonusAgainstSource: 4, untilSourceNextTurn: true }, expiresRound: Infinity, sourceId: source.id });
          }
          if (!ctx.spell && t.alive) infusedStrikes(state, source, t);
          for (const e of [...t.effects]) { // a surge / Spiked Retribution: whoever hits the holder takes damage back
            const hb = e.mods?.hitBackDamage;
            if (!hb || !t.alive || !source.alive || (hb.meleeOnly && source.zone !== "melee")) continue;
            applyDamage(state, source, rollDamage(state, hb.amount), hb.damageType as DamageType, { sourceId: t.id });
          }
        } else if (node.onMiss) runAutomation(node.onMiss, next);
        reactToAttackResolved(state, { attacker: source, target: t, hit: res.hit, melee: source.zone === "melee" });
        break;
      }

      case "save": {
        const t = ctx.scope[0];
        if (!t) break;
        endInvisibilityOnStrike(source);
        const dc = typeof node.dc === "number" ? node.dc : 18;
        // the conditions this save is against (Psychic Defenses: advantage vs charmed/frightened)
        const conditions = node.onFail.flatMap((n) => (n.type === "applyCondition" ? [n.condition] : []));
        const sr = rollSave(state, t, node.ability, dc, { magical: true, stakes: saveStakes(node.onFail), conditions, sourceId: source.id });
        if (ctx.saveLog) ctx.saveLog.set(t.id, sr.passed);
        const next: RunCtx = { ...ctx, last: { ...ctx.last, savePassed: sr.passed }, depth: ctx.depth + 1 };
        if (!sr.passed) {
          runAutomation(node.onFail, next);
        } else if (node.onSuccess) {
          runAutomation(node.onSuccess, next);
        } else {
          // No explicit success branch. RAW default for a "save for half" effect is
          // half the *damage* and none of the rider (conditions/effects), so run only
          // the damage nodes, halved — never the applyCondition / applyEffect nodes.
          const halfDamage = node.onFail.filter((n) => n.type === "damage");
          if (halfDamage.length) runAutomation(halfDamage, { ...next, halfMode: true });
        }
        break;
      }

      case "damage": {
        const t = ctx.scope[0];
        if (!t) break;
        endInvisibilityOnStrike(source);
        if (node.requiresSneakAttack && !claimSneakAttack(ctx, t)) break;
        let amt: number;
        if (ctx.sharedRolls) {
          // AoE: roll this damage string once, reuse for every target (RAW)
          const key = `${node.amount}::${node.damageType}::${node.diceMultiplier ?? 1}`;
          amt = ctx.sharedRolls.get(key) ?? rollDamage(state, node.amount, node.diceMultiplier ?? 1, false);
          ctx.sharedRolls.set(key, amt);
        } else {
          const gwf = node.weaponDice && source.ref.specialRules.some((r) => r.rule === "greatWeaponFighting") ? 2 : 0;
          amt = rollDamage(state, node.amount, node.diceMultiplier ?? 1, ctx.crit ?? false, gwf);
          // Brutal Critical: extra weapon dice on a melee crit (the weapon's own die size, not doubled again)
          const bc = node.weaponDice && ctx.crit ? source.ref.specialRules.find((r) => r.rule === "brutalCritical") : undefined;
          const die = bc ? node.amount.match(/\d*d(\d+)/) : null;
          if (bc && bc.rule === "brutalCritical" && die) amt += state.rng.dice(bc.dice, Number(die[1]));
        }
        if (ctx.halfMode || node.half) amt = Math.floor(amt / 2);
        const wasUp = t.alive && !t.downed;
        const dealt = applyDamage(state, t, amt, node.damageType as DamageType, {
          ignoreResistances: node.ignoreResistances,
          hadAdvantage: ctx.last.attackAdv,
          attackerMagical: true,
          sourceId: source.id,
          viaAttack: ctx.inAttack,
          viaSpell: ctx.spell,
          crit: ctx.crit,
        });
        source.damageDealt += dealt;
        if (wasUp && (!t.alive || t.downed)) {
          fireOnDeathTraits(state, t);
          if (t.side !== source.side) fireOnKillTraits(state, source);
        }
        break;
      }

      case "heal": {
        const t = ctx.scope[0] ?? source;
        applyHealing(state, t, rollDamage(state, node.amount)); // draws on the per-round heal budget
        break;
      }

      case "tempHp": {
        const t = ctx.scope[0] ?? source;
        let temp = rollDamage(state, node.amount);
        if (node.perAlly) { // Call the Hunt: so many temporary HP for each companion who joins in
          const near = livingAllies(state, source).filter((a) => a.id !== source.id && a.summonerId === undefined &&
            (!state.distanceFt || state.distanceFt(source, a) <= 30.001)).length;
          temp = node.perAlly.each * Math.min(node.perAlly.max, near);
        }
        t.tempHp = Math.max(t.tempHp, temp);
        break;
      }

      case "applyCondition": {
        const t = ctx.scope[0];
        if (!t || t.ref.conditionImmunities.includes(node.condition) || !t.alive) break;
        if (t.effects.some((e) => e.mods?.immuneConditions?.includes(node.condition))) break; // Mindless Rage
        const expires = node.durationRounds && node.durationRounds > 0 ? state.round + node.durationRounds : Infinity;
        t.conditions.set(node.condition, {
          expiresRound: node.durationRounds === -1 ? Infinity : expires,
          saveEnds: node.saveEnds ? { ability: node.saveEnds.ability, dc: typeof node.saveEnds.dc === "number" ? node.saveEnds.dc : 18, at: node.saveEnds.at } : undefined,
          sourceId: source.id,
        });
        ctx.appliedNames?.push(node.condition);
        // being locked down ends your concentration
        if (t.concentratingOn && LOCK_CONDITIONS.includes(node.condition)) breakConcentration(state, t, "incapacitated");
        break;
      }

      case "applyEffect": {
        const t = ctx.scope[0] ?? source;
        if (!t.alive) break;
        t.effects = t.effects.filter((e) => e.name !== node.name);
        if (node.name === "rage") { t.rageCheckSerial = (state.turnSerial ?? 0) - 1; t.combatEventSerial = undefined; } // a rage begins; this turn's attacks keep it going
        t.effects.push({
          name: node.name,
          mods: node.mods,
          tick: node.tick,
          saveEnds: node.saveEnds ? { ability: node.saveEnds.ability, dc: typeof node.saveEnds.dc === "number" ? node.saveEnds.dc : 18, at: node.saveEnds.at } : undefined,
          expiresRound: node.durationRounds && node.durationRounds > 0 ? state.round + node.durationRounds : Infinity,
          sourceId: source.id,
          oneShot: node.oneShot,
        });
        ctx.appliedNames?.push(node.name);
        break;
      }

      case "removeEffect": {
        const t = ctx.scope[0] ?? source;
        t.effects = t.effects.filter((e) => e.name !== node.name);
        t.conditions.delete(node.name as Condition);
        if (node.name === "restrained") { t.conditions.delete("restrained"); t.conditions.delete("grappled"); }
        break;
      }

      case "move": {
        if (node.kind === "teleportSelf" || node.kind === "teleportSelfToMarked") {
          source.conditions.delete("restrained");
          source.conditions.delete("grappled");
        } else if (node.kind === "withdraw" && node.provokes !== false) {
          provokeOpportunityAttacks(state, source);
        }
        break;
      }

      case "mark": {
        const t = livingEnemies(state, source).sort((a, b) => a.ac - b.ac || a.hp - b.hp)[0];
        if (t) source.markedTargetId = t.id;
        break;
      }

      case "branch": {
        const go = evalExpr(node.if, ctx);
        runAutomation(go ? node.then : node.else ?? [], { ...ctx, depth: ctx.depth + 1 });
        break;
      }

      case "spendResource": {
        // gaining (negative amount) always lands on the caster; spending from the party pool draws
        // from whichever living ally holds the resource
        const gaining = (node.amount ?? 1) < 0;
        const holder = node.from === "party" && !gaining ? partyResourceOwner(state, source, node.resource) : source;
        if (!holder) break;
        const cur = holder.resources.get(node.resource) ?? 0;
        let next = Math.max(0, cur - (node.amount ?? 1));
        // gaining never overfills the pool
        const cap = holder.ref.resources[node.resource]?.max;
        if (gaining && typeof cap === "number") next = Math.min(cap, next);
        holder.resources.set(node.resource, next);
        break;
      }

      case "ward": {
        const t = ctx.scope[0] ?? source;
        for (const u of state.units.values()) if (u.ward?.sourceId === source.id) u.ward = undefined; // "until you use this feature again"
        t.ward = { dice: node.dice, sourceId: source.id };
        break;
      }

      case "healPool": {
        let left = node.total;
        const pool = livingAllies(state, source)
          .filter((a) => !node.withinFt || !state.distanceFt || a.id === source.id || state.distanceFt(source, a) <= node.withinFt + 0.001)
          .sort((a, b) => (b.maxHp - b.hp) - (a.maxHp - a.hp));
        for (const a of pool) {
          if (left <= 0) break;
          left -= applyHealing(state, a, Math.min(left, a.maxHp - a.hp));
        }
        break;
      }

      case "spendReaction":
        source.reactionUsed = true;
        break;

      case "spendBonusAction":
        source.bonusUsedThisTurn = true;
        break;

      case "contest": {
        const t = ctx.scope[0];
        if (!t || !t.alive || t.downed) break;
        const mine = state.rng.d20() + node.bonus;
        const theirs = state.rng.d20() + Math.floor((t.ref.abilities[node.theirs] - 10) / 2);
        if (mine > theirs) runAutomation(node.onSuccess, { ...ctx, depth: ctx.depth + 1, last: { ...ctx.last } });
        else say(state, `${source.name} can't win over ${t.name} (${mine} vs ${theirs})`, source.id);
        break;
      }

      case "insightfulFighting": {
        const t = ctx.scope[0];
        if (!t || !t.alive || t.downed) break;
        if (source.insightTargetId === t.id && (source.insightUntilRound ?? 0) >= state.round) break; // already reading them
        if (isIncapacitated(t)) break; // "a creature you can see that isn't incapacitated"
        const mine = state.rng.d20() + node.bonus;
        const theirs = state.rng.d20() + Math.floor((t.ref.abilities.cha - 10) / 2); // Charisma (Deception)
        if (mine > theirs) { // a tie leaves things as they were
          source.insightTargetId = t.id;
          source.insightUntilRound = state.round + 10; // 1 minute
          say(state, `${source.name} reads ${t.name}'s tactics (${mine} vs ${theirs}) — Sneak Attack no longer needs advantage against it`, source.id);
        } else {
          say(state, `${t.name} gives ${source.name} nothing to read (${mine} vs ${theirs})`, source.id);
        }
        break;
      }

      case "restoreSlot": {
        for (let lvl = 1; lvl <= 9; lvl++) {
          const cap = source.ref.resources[`slot${lvl}`]?.max;
          if (typeof cap !== "number" || cap <= 0) continue;
          const cur = source.resources.get(`slot${lvl}`) ?? 0;
          if (cur < cap) { source.resources.set(`slot${lvl}`, cur + 1); break; }
        }
        break;
      }

      case "commandSummon": {
        let commanded = 0;
        for (const m of [...state.units.values()]) {
          if (node.limit !== undefined && commanded >= node.limit) break;
          if (!m.alive || m.summonerId !== source.id) continue;
          const act = findAction(m.ref.actions, node.action);
          if (!act) continue;
          // "if you are within 60 feet of it" — real feet in battle mode; no distances in Monte-Carlo
          if (node.rangeFt !== undefined && state.distanceFt && state.distanceFt(source, m) > node.rangeFt + 0.001) continue;
          if (act.limitedUse) {
            const left = m.resources.get(act.limitedUse.resource) ?? 0;
            if (left < act.limitedUse.amount) continue;
            m.resources.set(act.limitedUse.resource, left - act.limitedUse.amount);
          }
          m.commandedRound = state.round;
          commanded++;
          if (state.commandMinion) state.commandMinion(m, act);
          else runAction(state, m, act, { asReaction: true, verb: "(commanded) " });
        }
        break;
      }

      case "rechargeRoll": {
        // treat as "regain it" — the caller only issues this when it wants the power back
        source.resources.set(node.resource, 1);
        break;
      }

      case "useAction": {
        const sub = findAction(source.ref.actions, node.action);
        if (sub) for (let i = 0; i < (node.times ?? 1); i++) {
          runAutomation(sub.automation, { ...ctx, scope: [], depth: ctx.depth + 1, last: {}, crit: false, halfMode: false });
        }
        break;
      }

      case "summon": {
        const ref = state.summonRegistry?.[node.statBlock] ?? MINIONS[node.statBlock] ?? PC_SUMMONS[node.statBlock];
        if (!ref) { say(state, `${source.name} would summon ${node.statBlock} (no stat block)`, source.id); break; }
        const rolled = Math.max(0, Math.round(rollDamage(state, node.count)));
        const existing = [...state.units.values()].filter(
          (u) => u.alive && u.summonerId === source.id && u.ref.id === node.statBlock,
        ).length;
        const room = node.max === undefined ? rolled : Math.max(0, node.max - existing);
        const n = Math.min(rolled, room);
        for (let i = 0; i < n; i++) {
          const suffix = `#${state.summonCounter++}`;
          const ms = initCombatant(ref, source.side, suffix);
          ms.name = `${ref.name} ${existing + i + 1}`;
          ms.summonerId = source.id;
          if (node.tempHp) ms.tempHp = Math.max(0, Math.round(rollDamage(state, node.tempHp)));
          state.units.set(ms.id, ms);
          state.order.push(ms.id); // acts at the tail of the round order
          state.placeSummon?.(source, ms); // battle mode: put it on the grid next to the summoner
        }
        if (n > 0) say(state, `${source.name} raises ${n}× ${ref.name}`, source.id);
        break;
      }

      case "randomEffect": {
        const total = node.options.reduce((sum, o) => sum + o.weight, 0);
        let roll = state.rng.next() * total;
        const chosen = node.options.find((o) => (roll -= o.weight) < 0) ?? node.options.at(-1)!;
        if (chosen.note) say(state, `${source.name} — ${chosen.note}`, source.id);
        runAutomation(chosen.then, { ...ctx, depth: ctx.depth + 1 });
        break;
      }

      default:
        break;
    }
  }
}

export function findAction(actions: Action[], id: string): Action | undefined {
  return actions.find((a) => a.id === id);
}

/** Run a whole named action from a fresh scope, with a play-by-play summary line. */
/** Does `action` bottom out in a single top-level `branch` that currently evaluates false? */
export function actionBranchGateFails(state: CombatState, source: CombatantState, action: Action): boolean {
  if (action.automation.length !== 1) return false;
  const only = action.automation[0];
  if (only.type !== "branch" || only.else) return false;
  return !evalExpr(only.if, { state, source, scope: [], last: {}, depth: 0 });
}

export function runAction(
  state: CombatState,
  source: CombatantState,
  action: Action,
  opts: RunActionOpts = {},
): void {
  if (isIncapacitated(source) && !opts.skipIncapacitatedCheck) return;
  if (!opts.asReaction) state.reactionFiredThisAction = false;
  const geo = opts.geo ?? {};

  // track "is it singing?" for summon gates (a song-driven raise-minions ability)
  if (/\b(song|sing)\b/i.test(action.name)) source.lastSangRound = state.round;

  // a spell can be Counterspelled by the other side before it resolves
  const spell = isSpell(action);
  if (spell && !opts.asReaction && mayCounterspell(state, source, action)) return;

  // casting a new concentration spell drops whatever the caster was concentrating on
  if (action.concentration && source.concentratingOn) breakConcentration(state, source, "recast");
  const appliedNames: string[] | undefined = action.concentration ? [] : undefined;

  if (!state.verbose) {
    runAutomation(action.automation, { state, source, scope: [], last: {}, depth: 0, spell, appliedNames, forceScope: opts.forceScope, ranged: action.ranged, ...geo });
    if (action.concentration && appliedNames && appliedNames.length) {
      source.concentratingOn = action.id;
      source.concentrationEffects = [...new Set(appliedNames)];
    }
    return;
  }

  // a pure "command your companion" action: the companion's own line narrates what it did, so this
  // one doesn't repeat the same HP changes
  const onlyCommands = action.automation.length > 0 && action.automation.every((n) => n.type === "commandSummon");
  const before = hpSnapshot(state);
  const condsBefore = new Map([...state.units.values()].map((u) => [u.id, new Set(u.conditions.keys())]));
  const fxBefore = new Map([...state.units.values()].map((u) => [u.id, new Set(u.effects.map((e) => e.name))]));
  const saveLog = new Map<string, boolean>();
  const attackTally = { rolled: 0, hit: 0, unreachable: false };
  runAutomation(action.automation, { state, source, scope: [], last: {}, depth: 0, saveLog, attackTally, spell, appliedNames, forceScope: opts.forceScope, ranged: action.ranged, ...geo });
  if (action.concentration && appliedNames && appliedNames.length) {
    source.concentratingOn = action.id;
    source.concentrationEffects = [...new Set(appliedNames)];
  }

  const parts: string[] = [];
  for (const u of onlyCommands ? [] : state.units.values()) {
    const delta = (before.get(u.id) ?? 0) - (u.hp + u.tempHp);
    // an ally *losing* HP during my action is always reaction / aura
    // collateral (a triggered breath, a damaging aura) — that reaction logs
    // its own line, so don't double-count it here. The source's own HP loss
    // is only the same story if a reaction actually fired this action
    // (Riposte striking back at me, already narrated separately) — some
    // effects (Wild Magic Surge) genuinely damage the source as their own
    // direct effect, with no other line that would show it, so that case
    // stays visible. Healing still shows either way.
    if (u.side === source.side && delta > 0 && (u.id !== source.id || state.reactionFiredThisAction)) continue;
    const newConds = [...u.conditions.keys()].filter((c) => !condsBefore.get(u.id)?.has(c));
    const newFx = u.effects.map((e) => e.name).filter((n) => !fxBefore.get(u.id)?.has(n));
    const bits: string[] = [];
    if (saveLog.has(u.id)) bits.push(saveLog.get(u.id) ? "save" : "FAIL");
    if (delta > 0) bits.push(`-${delta} (${Math.max(0, u.hp)}/${u.maxHp})`);
    else if (delta < 0) bits.push(`+${-delta} (${u.hp}/${u.maxHp})`);
    if (u.downed && (before.get(u.id) ?? 1) > 0) bits.push("DOWN");
    if (newConds.length) bits.push(newConds.map(humanize).join(","));
    if (newFx.length) bits.push(newFx.map(humanize).join(","));
    if (bits.length) parts.push(`${u.name} ${bits.join(" ")}`);
  }
  const verb = opts.verb ?? (opts.asLegendary ? "(legendary) " : opts.asReaction ? "(reaction) " : "");
  const tail = parts.length
    ? " -> " + parts.join("; ")
    : onlyCommands
      ? ""
      : attackTally.unreachable && attackTally.rolled === 0
      ? " (can't reach)"
      : attackTally.rolled > 0
        ? attackTally.rolled === 1 ? " (misses)" : " (all miss)"
        : " (no effect)";
  say(state, `${source.name} ${verb}uses ${action.name}${tail}`, source.id);
}
