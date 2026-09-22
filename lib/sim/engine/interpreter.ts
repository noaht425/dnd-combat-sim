// Executes an automation-node tree against live combat state.

import { SIZES, type Action, type AutomationNode, type Condition, type DamageType } from "../schema";

import { applyDamage, critRangeFor, rollAttack, rollSave, type AttackResult } from "./resolve";
import { MINIONS, PC_SUMMONS } from "./minions";
import { addFlatBonus, maxOfDice } from "../spells/spellTransforms";
import { creatureTypeOf, crValue, isCreatureType, matchesFilter } from "./creatureType";
import { BEAST_FORMS, shapedAs } from "./beastForms";
import { heldDie, inspireDamage } from "./bardic";
import { auraBlocks } from "./paladin";
import { beguilingDefenses } from "./reactions";
import { unbreakableMajesty, instinctiveCharm, natureSanctuary, reactToDeath, isSpell, mayCounterspell, opportunist, provokeOpportunityAttacks, reactToAttackResolved, soulOfVengeance, violentAttraction } from "./reactions";
import {
  CombatantState,
  CombatState,
  claimOncePerTurn,
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
  /** the attack now resolving hit a creature under Path to the Grave: all of its damage is doubled (vulnerability) */
  doubleHit?: boolean;
  /** the spell being cast: its school and the slot level it was cast at (0 for a cantrip) */
  spellSchool?: string;
  spellLevel?: number;
  /** effect / condition names applied during this action (for concentration linkage) */
  appliedNames?: string[];
  /** battle mode only: geometry-aware target picker. Return null to fall back to
   *  the abstract `selectTargets`. Never set by the Monte-Carlo engine. */
  geoTargets?: (node: Extract<AutomationNode, { type: "target" }>, source: CombatantState) => CombatantState[] | null;
  /** battle mode only: per-target attack tweaks (cover -> +AC, long range -> disadvantage,
   *  a melee routine whose target is out of reach -> the swing simply doesn't land) */
  attackMods?: (target: CombatantState, info?: { ranged?: boolean; longRangeFt?: number }) => { acBonus?: number; disadvantage?: boolean; unreachable?: boolean; allyAdjacent?: boolean; soloDuel?: boolean };
  /** the action being run makes RANGED attacks (Action.ranged) */
  ranged?: boolean;
  /** running count of attack rolls this action made, so `runAction` can say
   *  "misses" / "can't reach" instead of a flat "(no effect)" */
  attackTally?: { rolled: number; hit: number; unreachable: boolean };
  /** false while resolving a "target" node that caught more than one creature — an area effect, which
   *  Among the Dead / Nature's Sanctuary don't apply against ("an undead needn't make the save when it
   *  includes you in an area effect"). true (or unset, at the top of an action) for a single target. */
  singleTarget?: boolean;
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
  /** the creature(s) an on-kill / trigger action is "about" — the first `target` in a branch expression (`target.has('…')`) reads it; doesn't change who any node picks */
  scope?: CombatantState[];
}

/** the conditions a Cleansing Touch is worth an action to end on a friend */
const AFFLICTIONS: Condition[] = ["paralyzed", "stunned", "charmed", "frightened", "restrained", "incapacitated", "blinded", "petrified", "poisoned", "prone"];
const LOCK_CONDITIONS: Condition[] = ["stunned", "paralyzed", "incapacitated", "unconscious", "petrified"];
const CONTROL_CONDITIONS: Condition[] = ["charmed", "restrained", "transfixed", "frightened", "prone", "blinded", "marked-for-reckoning"];

function saveStakes(onFail: AutomationNode[]): "damage" | "control" | "lock" {
  for (const n of onFail) {
    if (n.type === "applyCondition" && LOCK_CONDITIONS.includes(n.condition)) return "lock";
    if (n.type === "applyEffect" && (n.mods?.speedZero)) return "lock";
    if (n.type === "takeControl") return "lock";
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
function applyExtraDamageOnHit(state: CombatState, attacker: CombatantState, target: CombatantState, res: AttackResult, spell = false, doubled = false): void {
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
    if (!extra || (extra.weaponOnly && spell)) continue;
    if (e.mods?.extraDamageOncePerTurn && !claimOncePerTurn(state, attacker, `extra:${e.name}`)) continue;
    const amt = rollDamage(state, extra.amount, 1, res.crit);
    applyDamage(state, target, amt, extra.damageType, {
      hadAdvantage: res.hadAdvantage, attackerMagical: true, sourceId: attacker.id, viaAttack: true, doubled,
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
function fireOnKillTraits(state: CombatState, source: CombatantState, victim?: CombatantState): void {
  for (const trait of source.ref.traits) {
    if (trait.trigger !== "onKill" || !trait.automation.length) continue;
    runAction(state, source, {
      id: trait.id, name: trait.name, cost: {}, recharge: "none", automation: trait.automation,
    }, { asReaction: true, skipIncapacitatedCheck: true, scope: victim ? [victim] : undefined });
  }
}

/** a copy of a stat block whose weapon damage rolls all carry `bonus` (the first damage node of every attack) */
function withDamageBonus(ref: import("../schema").Combatant, bonus: number): import("../schema").Combatant {
  const bump = (nodes: AutomationNode[]): AutomationNode[] => nodes.map((n): AutomationNode => {
    if (n.type === "attack") {
      const first = n.onHit.findIndex((x) => x.type === "damage");
      return { ...n, onHit: n.onHit.map((x, i) => (i === first && x.type === "damage" ? { ...x, amount: addFlatBonus(x.amount, bonus) } : x)) };
    }
    if (n.type === "target") return { ...n, effects: bump(n.effects) };
    if (n.type === "branch") return { ...n, then: bump(n.then), else: n.else && bump(n.else) };
    return n;
  });
  return { ...ref, actions: ref.actions.map((a) => ({ ...a, automation: bump(a.automation) })) };
}

/** Grim Harvest (Necromancy): killing a creature with a spell of 1st level or higher heals twice the spell's level (three times for a necromancy spell) */
function grimHarvest(state: CombatState, source: CombatantState, slain: CombatantState, ctx: RunCtx): void {
  if (!ctx.spell || !ctx.spellLevel || !source.ref.specialRules.some((r) => r.rule === "grimHarvest")) return;
  if (isCreatureType(slain.ref, "construct", "undead")) return; // "This benefit doesn't apply to constructs or undead."
  const amount = ctx.spellLevel * (ctx.spellSchool === "necromancy" ? 3 : 2);
  const healed = applyHealing(state, source, amount);
  if (healed > 0) say(state, `${source.name} harvests ${healed} hit points (Grim Harvest)`, source.id);
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
    [/self\.shape_hurt/i, () => !!s.shape && s.hp < s.maxHp / 2],
    [/self\.shaped/i, () => !!s.shape],
    [/self\.unshaped/i, () => !s.shape],
    [/target\.int\s*>=\s*(\d+)/i, () => !!tgt && tgt.ref.abilities.int >= Number(RegExp.$1)],
    [/target\.is\('([a-z]+)'\)/i, () => !!tgt && isCreatureType(tgt.ref, RegExp.$1 as never)],
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
    [/any_?enemy\.has\('([^']+)'\)/i, () => livingEnemies(st, s).some((e) => e.effects.some((x) => x.name === RegExp.$1 && x.sourceId === s.id))],
    // Hex: the warlock is still concentrating on it, but the creature it was on is gone (a bonus action moves it to a new target)
    [/self\.hex_?needs_?target/i, () => (s.concentratingOn === "cast-hex" || s.concentratingOn === "hex-move") && !livingEnemies(st, s).some((e) => e.effects.some((x) => x.name === "hex" && x.sourceId === s.id))],
    // a warlock with nothing else to concentrate on and no creature already carrying its Hex (the spell is worth a slot again)
    [/self\.needs_?hex/i, () => livingEnemies(st, s).length > 0 && !s.concentratingOn && !livingEnemies(st, s).some((e) => e.effects.some((x) => x.name === "hex" && x.sourceId === s.id))],
    [/target\.incapacitated/i, () => !!tgt && isIncapacitated(tgt)],
    // an enemy that can give a condition — one of its actions frightens or charms (Countercharm is only worth an action against them)
    [/any_?enemy\.imposes\('([a-z|]+)'\)/i, () => { const conds = RegExp.$1.split("|"); return livingEnemies(st, s).some((e) => conds.some((c) => JSON.stringify(e.ref.actions).includes(`"condition":"${c}"`))); }],
    // an incapacitated creature of a kind (Create Thrall: "an incapacitated humanoid")
    [/any_?enemy\.incapacitated\('([a-z]+)'\)/i, () => livingEnemies(st, s).some((e) => isIncapacitated(e) && isCreatureType(e.ref, RegExp.$1 as never))],
    // Divine Smite has been used this turn (Inspiring Smite is taken after one)
    [/self\.smote_?this_?turn/i, () => s.smiteSerial !== undefined && s.smiteSerial === (st.turnSerial ?? 0)],
    // the creature is at or below half its hit points (Turn the Tide)
    [/target\.bloodied/i, () => !!tgt && tgt.hp <= tgt.maxHp / 2],
    [/target\.cr_?below\((\d+)\)/i, () => !!tgt && (crValue(tgt.ref) ?? Infinity) < Number(RegExp.$1)],
    [/party\.ally_?afflicted/i, () => livingAllies(st, s).some((a) => AFFLICTIONS.some((c) => a.conditions.has(c)))],
    // no enemy carries an effect this creature applied (the mirror of `any_enemy.has`): Unsettling Words is only worth another use on a creature it isn't already on
    [/no_?enemy\.has\('([^']+)'\)/i, () => !livingEnemies(st, s).some((e) => e.effects.some((x) => x.name === RegExp.$1 && x.sourceId === s.id))],
    // a bard with more than N uses of Bardic Inspiration left and an ally (not itself, not a summon) who isn't already carrying a die
    [/self\.can_?inspire\((\d+)\)/i, () => (s.resources.get("bardic_inspiration") ?? 0) > Number(RegExp.$1) && livingAllies(st, s).some((a) => a.id !== s.id && a.summonerId === undefined && !heldDie(a))],
    // the creature carrying the warlock's Hex or Curse is out of reach: battle mode, farther than 5 feet (Relentless Hex teleports beside it)
    [/self\.curse_?out_?of_?reach/i, () => !!st.distanceFt && livingEnemies(st, s).some((e) => e.effects.some((x) => (x.name === "hex" || x.name === "hexblades-curse") && x.sourceId === s.id) && st.distanceFt!(s, e) > 5.001)],
    // a creature carries the warlock's Hex or Hexblade's Curse (Maddening Hex needs one)
    [/self\.has_?curse/i, () => livingEnemies(st, s).some((e) => e.effects.some((x) => (x.name === "hex" || x.name === "hexblades-curse") && x.sourceId === s.id))],
    [/party\.has_?downed/i, () => [...st.units.values()].some((u) => u.side === s.side && u.alive && u.downed && u.summonerId === undefined)],
    [/party\.has_?dead/i, () => [...st.units.values()].some((u) => u.side === s.side && !u.alive && u.summonerId === undefined)],
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
  // a spell's printed restriction is applied to the pool BEFORE anything is chosen from it (Hold Person never picks a troll)
  const eligible = (u: CombatantState) => matchesFilter(u.ref, node.filter, u.effects);
  const enemies = livingEnemies(state, source).filter(eligible);
  const allies = livingAllies(state, source).filter(eligible);
  const who = node.who;
  switch (who.who) {
    case "self": return [source];
    case "eachAlly": {
      const r = who.withinFt;
      let pool = who.excludeSelf ? allies.filter((a) => a.id !== source.id) : allies;
      if (r && state.distanceFt) pool = pool.filter((a) => a.id === source.id || state.distanceFt!(source, a) <= r + 0.001);
      // "a number of willing creatures equal to your proficiency bonus": the sturdiest — those most likely to be in the fight
      if (who.limit && pool.length > who.limit) pool = pool.filter((a) => a.summonerId === undefined).sort((a, b) => b.maxHp - a.maxHp).slice(0, who.limit);
      return pool;
    }
    case "lowestHpAlly": {
      const pool = who.includeDowned ? [...state.units.values()].filter((x) => x.side === source.side && x.alive && x.summonerId === undefined && eligible(x)) : allies;
      const hurt = pool.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      return hurt ? [hurt] : node.filter ? [] : [source]; // (a filtered heal with nobody eligible heals no one, not the caster)
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
      return m && m.alive && !m.downed && eligible(m) ? [m] : enemies.slice(0, 1);
    }
    case "aiChoice": {
      if (!enemies.length) return [];
      // an attack goes to the creature the caster has marked with a rider only they cash in (Hex, Hexblade's Curse, Slayer's Prey) — they keep on it
      if (node.effects.some((e) => e.type === "attack")) {
        const mine = enemies.find((e) => e.effects.some((x) => x.sourceId === source.id && x.mods?.extraDamageWhenHitBySource));
        if (mine) return [mine];
      }
      // both sides gang up on a shared focus target (party or monster pack)
      const sharedFocus = source.side === "party" ? state.focusId
        : source.ref.ai.focusFire ? state.monsterFocusId : undefined;
      if (sharedFocus) {
        const f = state.units.get(sharedFocus);
        if (f && f.alive && !f.downed && f.side !== source.side && eligible(f)) return [f];
      }
      const p = source.ref.ai.targetPriority;
      const pool = enemies.slice();
      if (p === "lowestHp") pool.sort((a, b) => a.hp - b.hp);
      else if (p === "squishiest") pool.sort((a, b) => a.ac - b.ac || a.hp - b.hp);
      else if (p === "marked" && source.markedTargetId) {
        const m = state.units.get(source.markedTargetId);
        if (m && m.alive && !m.downed && eligible(m)) return [m];
      }
      return [pool[0]];
    }
    case "afflictedAlly": {
      const pool = allies.filter((a) => AFFLICTIONS.some((c) => a.conditions.has(c)));
      return pool.length ? [pool.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]] : [];
    }
    case "anotherEnemy": {
      const others = enemies.filter((e) => e.id !== source.lastAttackTargetId).sort((a, b) => a.ac - b.ac || a.hp - b.hp);
      return others.length ? [others[0]] : [];
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
        const picked = ctx.forceScope ?? ctx.geoTargets?.(node, source) ?? selectTargets(node, ctx);
        const targets = node.filter ? picked.filter((u) => u.id === source.id || matchesFilter(u.ref, node.filter, u.effects)) : picked; // (battle mode's own picker may not know the restriction)
        // an area / multi-target effect rolls its damage dice once and shares
        // the total across every creature caught (each still saves for its own half)
        const multi = targets.length > 1;
        const sharedRolls = multi ? new Map<string, number>() : ctx.sharedRolls;
        const saveLog = multi ? (ctx.saveLog ?? new Map<string, boolean>()) : ctx.saveLog;
        for (const t of targets) {
          runAutomation(node.effects, {
            ...ctx, scope: [t], forceScope: undefined, sharedRolls, saveLog, singleTarget: !multi,
            depth: ctx.depth + 1, last: { ...ctx.last },
          });
        }
        break;
      }

      case "attack": {
        let t = ctx.scope[0];
        if (!t) break;
        // Instinctive Charm: an attacker that fails the Wisdom save must swing at another creature instead
        const diverted = !ctx.spell ? instinctiveCharm(state, source, t) : undefined;
        if (diverted) t = diverted;
        // Nature's Sanctuary / Among the Dead: a beast, plant or (against an Undying warlock) undead attacker that
        // fails the Wisdom save attacks someone else, or misses — Among the Dead alone also covers a spell attack roll
        const hesitates = natureSanctuary(state, source, t, ctx.spell);
        if (hesitates === "miss") { if (ctx.attackTally) ctx.attackTally.rolled++; break; }
        if (hesitates) t = hesitates;
        // Unbreakable Majesty (Glamour): the first attack against the bard each turn needs a Charisma save
        const awed = unbreakableMajesty(state, source, t);
        if (awed === "miss") { if (ctx.attackTally) ctx.attackTally.rolled++; break; }
        if (awed) t = awed;
        // Cloak of Shadows: making an attack ends the invisibility
        if (source.effects.some((e) => e.mods?.endsOnAttacking)) {
          source.effects = source.effects.filter((e) => !e.mods?.endsOnAttacking);
          source.conditions.delete("invisible");
        }
        const bonus = typeof node.bonus === "number" ? node.bonus : 12;
        const tweak = ctx.attackMods?.(t, { ranged: ctx.ranged, longRangeFt: node.longRangeFt });
        if (tweak?.unreachable) {
          if (ctx.attackTally) ctx.attackTally.unreachable = true;
          break; // out of melee reach — the swing never connects
        }
        const adv = tweak?.disadvantage ? "dis" : node.adv;
        // Hexblade's Curse: "Your attack rolls against the cursed target are critical hits on a roll of 19 or 20 on the d20"
        const cursedRange = t.effects.reduce((n, e) => (e.sourceId === source.id && e.mods?.critRangeAgainstBySource ? Math.min(n, e.mods.critRangeAgainstBySource) : n), 20);
        const critRange = Math.min(node.critRange ?? 20, critRangeFor(source), cursedRange);
        const res = rollAttack(state, source, t, bonus, adv, critRange, tweak?.acBonus ?? 0);
        if (ctx.attackTally) {
          ctx.attackTally.rolled++;
          if (res.hit) ctx.attackTally.hit++;
        }
        source.lastAttackTargetId = t.id;
        const soloDuel = tweak ? tweak.soloDuel : abstractSoloDuel(state, source, t);
        const next: RunCtx = { ...ctx, scope: [t], last: { ...ctx.last, attackHit: res.hit, attackCrit: res.crit, attackAdv: res.hadAdvantage, attackDis: res.hadDisadvantage, woundedAtHit: t.hp < t.maxHp, allyAdjacent: tweak?.allyAdjacent, soloDuel, sneakLanded: false, insightMarked: false }, crit: res.crit, inAttack: true, depth: ctx.depth + 1 };
        if (source.zone === "melee" && source.ref.specialRules.some((r) => r.rule === "fancyFootwork")) {
          const serial = state.turnSerial ?? 0;
          if (!source.footwork || source.footwork.serial !== serial) source.footwork = { serial, ids: [] };
          if (!source.footwork.ids.includes(t.id)) source.footwork.ids.push(t.id);
        }
        if (res.hit) {
          const hadTempHp = t.tempHp > 0; // Armor of Agathys: "While you have these hit points, if a creature hits you with a melee attack, the creature takes ... cold damage"
          tagAmbushTarget(state, source, t);
          // Path to the Grave: "the creature has vulnerability to all of that damage, and then the curse ends"
          const grave = t.effects.find((e) => e.mods?.doubleNextHit && state.units.get(e.sourceId)?.side === source.side);
          if (grave) { next.doubleHit = true; t.effects = t.effects.filter((e) => e !== grave); }
          runAutomation(node.onHit, next);
          applyExtraDamageOnHit(state, source, t, res, !!ctx.spell, next.doubleHit);
          // Order's Wrath: "The next time one of your allies hits the cursed creature, the target also takes 2d8 psychic damage, and the curse ends"
          const wrath = t.effects.find((e) => e.mods?.extraDamageOnNextAllyHit && e.sourceId !== source.id && state.units.get(e.sourceId)?.side === source.side);
          if (wrath && t.alive) {
            t.effects = t.effects.filter((e) => e !== wrath);
            applyDamage(state, t, rollDamage(state, wrath.mods!.extraDamageOnNextAllyHit!.amount), wrath.mods!.extraDamageOnNextAllyHit!.damageType as DamageType, { sourceId: source.id, viaAttack: true, attackerMagical: true });
          }
          fireOnHitTraits(state, t, source);
          if (t.ref.specialRules.some((r) => r.rule === "multiattackDefense") && t.alive) { // +4 AC against this attacker until its next turn
            t.effects = t.effects.filter((e) => !(e.name === "multiattack-defense" && e.sourceId === source.id));
            t.effects.push({ name: "multiattack-defense", mods: { acBonusAgainstSource: 4, untilSourceNextTurn: true }, expiresRound: Infinity, sourceId: source.id });
          }
          if (!ctx.spell && t.alive) {
            infusedStrikes(state, source, t);
            opportunist(state, source, t);
            const wd = node.onHit.find((n): n is Extract<AutomationNode, { type: "damage" }> => n.type === "damage");
            violentAttraction(state, source, t, (wd?.damageType ?? "bludgeoning") as DamageType); // Graviturgy: +1d10 of the weapon's type
            inspireDamage(state, source, t, (wd?.damageType ?? "bludgeoning") as DamageType); // Combat Inspiration (Valor): the die added to the weapon damage
          }
          for (const e of [...t.effects]) { // a surge / Spiked Retribution: whoever hits the holder takes damage back
            const hb = e.mods?.hitBackDamage;
            if (!hb || !t.alive || !source.alive || (hb.meleeOnly && source.zone !== "melee") || (hb.requiresTempHp && !hadTempHp)) continue;
            applyDamage(state, source, rollDamage(state, hb.amount), hb.damageType as DamageType, { sourceId: t.id });
          }
        } else if (node.onMiss) runAutomation(node.onMiss, next);
        reactToAttackResolved(state, { attacker: source, target: t, hit: res.hit, melee: source.zone === "melee" });
        soulOfVengeance(state, source); // Oath of Vengeance, 15th
        break;
      }

      case "save": {
        let t = ctx.scope[0];
        if (!t) break;
        endInvisibilityOnStrike(source);
        // Among the Dead (Undying warlock, 1st): a single-target harmful spell forcing a save is the other half of
        // "an attack or a harmful spell" — an area save (ctx.singleTarget === false) is explicitly exempt in the text
        const hesitates = ctx.spell && ctx.singleTarget !== false ? natureSanctuary(state, source, t, true) : undefined;
        if (hesitates === "miss") break;
        if (hesitates) t = hesitates;
        const dc = typeof node.dc === "number" ? node.dc : 18;
        // the conditions this save is against (Psychic Defenses: advantage vs charmed/frightened)
        const conditions = node.onFail.flatMap((n) => (n.type === "applyCondition" ? [n.condition] : []));
        const damageTypes = node.onFail.flatMap((n) => (n.type === "damage" ? [n.damageType as DamageType] : []));
        const sr = rollSave(state, t, node.ability, dc, { magical: true, stakes: saveStakes(node.onFail), conditions, sourceId: source.id, adv: node.adv, damageTypes: ctx.spell ? damageTypes : undefined });
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
        const room = Math.max(0, t.hp) + t.tempHp; // overkill (a Quivering Palm's "reduced to 0") isn't damage dealt
        const dealt = applyDamage(state, t, amt, node.damageType as DamageType, {
          ignoreResistances: node.ignoreResistances,
          hadAdvantage: ctx.last.attackAdv,
          attackerMagical: true,
          sourceId: source.id,
          viaAttack: ctx.inAttack,
          viaSpell: ctx.spell,
          spellLevel: ctx.spellLevel,
          doubled: ctx.doubleHit,
          crit: ctx.crit,
        });
        source.damageDealt += t.downed || !t.alive ? Math.min(dealt, room) : dealt;
        if (wasUp && (!t.alive || t.downed)) {
          fireOnDeathTraits(state, t);
          if (t.side !== source.side) {
            fireOnKillTraits(state, source, t);
            grimHarvest(state, source, t, ctx);
          }
          if (!t.alive) reactToDeath(state, t); // a Spores druid's zombie, a Wildfire druid's flames
        }
        break;
      }

      case "heal": {
        const t = ctx.scope[0] ?? source;
        // Circle of Mortality (a creature at 0 hit points) / Supreme Healing: "use the highest number possible for each die"
        const mr = source.ref.specialRules.find((r) => r.rule === "maxHealing");
        // Gift of the Ever-Living Ones: whoever regains hit points with their familiar within 100 feet (the healing is theirs, whoever casts it)
        const gift = t.ref.specialRules.some((r) => r.rule === "familiarGift") &&
          [...state.units.values()].some((u) => u.alive && u.summonerId === t.id && u.ref.id.startsWith("familiar-") && (!state.distanceFt || state.distanceFt(t, u) <= 100.001));
        const maximise = gift || (!!mr && mr.rule === "maxHealing" && (mr.always || t.downed || t.hp <= 0));
        applyHealing(state, t, maximise ? maxOfDice(node.amount) : rollDamage(state, node.amount)); // draws on the per-round heal budget
        break;
      }

      case "stabilize": {
        // Spare the Dying: "a creature you touch that has 0 hit points becomes stable" — no healing, just no more death saves
        const t = ctx.scope[0] ?? source;
        if (t.downed && t.alive) { t.stable = true; say(state, `${t.name} is stabilised`, source.id); }
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
        if (!t || !t.alive) break;
        // Beguiling Defenses (Archfey, 10th): the warlock's own flat immunity to being charmed (below) would otherwise silently
        // swallow the attempt — this has to react to the ATTEMPT itself, so it's checked before that immunity ever gets a say
        if (node.condition === "charmed" && t.side !== source.side && beguilingDefenses(state, source, t)) break;
        if (t.ref.conditionImmunities.includes(node.condition)) break;
        if (t.effects.some((e) => e.mods?.immuneConditions?.includes(node.condition))) break; // Mindless Rage
        // Protection from Evil and Good: creatures of the named types can't charm or frighten the warded creature
        if ((node.condition === "charmed" || node.condition === "frightened") && t.side !== source.side) {
          const st = creatureTypeOf(source.ref);
          if (st && t.effects.some((e) => e.mods?.protectedFromTypes?.includes(st) || e.mods?.noCharmFrightFromTypes?.includes(st))) break;
        }
        // Aura of Courage / Aura of Devotion: immune to being frightened / charmed while inside the aura
        if ((node.condition === "frightened" || node.condition === "charmed") && auraBlocks(state, t, node.condition)) break;
        const expires = node.durationRounds && node.durationRounds > 0 ? state.round + node.durationRounds : Infinity;
        t.conditions.set(node.condition, {
          ...(node.endsOnDamage ? { endsOnDamage: true } : {}),
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
        if (node.oncePerTurn && !claimOncePerTurn(state, source, `move:${node.oncePerTurn}`)) break;
        if (node.kind === "teleportSelf" || node.kind === "teleportSelfToMarked") {
          source.conditions.delete("restrained");
          source.conditions.delete("grappled");
          // "within 5 feet of the target cursed by your hex" / "closest to the talisman's wearer": the creatures the caster put an effect on
          const marked = node.kind === "teleportSelfToMarked" && source.markedTargetId ? [state.units.get(source.markedTargetId)].filter((u): u is CombatantState => !!u && u.alive) : undefined;
          // (a teleport "beside" someone with nobody to go beside goes nowhere: `near` is empty, not undefined)
          const near = node.nearEffects
            ? [...state.units.values()].filter((u) => u.alive && u.id !== source.id && u.effects.some((e) => e.sourceId === source.id && node.nearEffects!.includes(e.name)))
            : node.kind === "teleportSelfToMarked" ? marked ?? [] : undefined;
          state.moveCreature?.({ kind: "teleportSelf", source, distance: node.distance ?? 30, near });
        } else if (node.kind === "withdraw" && node.provokes !== false) {
          provokeOpportunityAttacks(state, source);
        } else if (node.kind === "push" || node.kind === "pull") {
          // forced movement: "you can push the creature up to 10 feet away from you in a straight line" — the creature that was just hit
          const t = ctx.scope[0];
          if (t && t.alive && t.id !== source.id) state.moveCreature?.({ kind: node.kind, source, target: t, distance: node.distance ?? 10 });
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

      case "revive": {
        const fallen = [...state.units.values()].find((u) => u.side === source.side && !u.alive && u.summonerId === undefined);
        if (!fallen) break;
        fallen.alive = true; fallen.downed = false; fallen.stable = false;
        fallen.deathSaves = { success: 0, fail: 0 };
        fallen.hp = Math.min(fallen.maxHp, Math.max(1, rollDamage(state, node.dice)));
        say(state, `${source.name} returns ${fallen.name} to life (${fallen.hp} HP)`, source.id);
        break;
      }

      case "healPool": {
        let left = node.total;
        // Preserve Life: "Choose any creatures within 30 feet of you, and divide [the points] among them... can't restore a creature to more than half of its hit point
        // maximum" — and not undead or constructs
        const room = (a: CombatantState) => (node.capFraction ? Math.max(0, Math.floor(a.maxHp * node.capFraction) - a.hp) : a.maxHp - a.hp);
        const pool = [...state.units.values()]
          .filter((a) => a.side === source.side && a.alive && a.summonerId === undefined && matchesFilter(a.ref, node.filter, a.effects))
          .filter((a) => !node.withinFt || !state.distanceFt || a.id === source.id || state.distanceFt(source, a) <= node.withinFt + 0.001)
          .filter((a) => room(a) > 0)
          .sort((a, b) => room(b) - room(a));
        for (const a of pool) {
          if (left <= 0) break;
          left -= applyHealing(state, a, Math.min(left, room(a)));
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

      case "arcaneWard": {
        const w = source.arcaneWard;
        if (!w) {
          if ((source.resources.get("arcane_ward") ?? 0) <= 0) break;
          source.resources.set("arcane_ward", 0);
          source.arcaneWard = { hp: node.maxHp, maxHp: node.maxHp };
          say(state, `${source.name} raises an Arcane Ward (${node.maxHp} HP)`, source.id);
        } else if (w.hp < w.maxHp) {
          w.hp = Math.min(w.maxHp, w.hp + 2 * node.slotLevel);
          say(state, `${source.name}'s Arcane Ward regains ${2 * node.slotLevel} (${w.hp}/${w.maxHp})`, source.id);
        }
        break;
      }

      case "regainSlot": {
        for (let lvl = Math.min(5, node.below - 1); lvl >= 1; lvl--) {
          const cap = source.ref.resources[`slot${lvl}`]?.max;
          if (typeof cap !== "number" || cap <= 0) continue;
          const cur = source.resources.get(`slot${lvl}`) ?? 0;
          if (cur < cap) {
            source.resources.set(`slot${lvl}`, cur + 1);
            say(state, `${source.name} regains a ${lvl}${lvl === 1 ? "st" : lvl === 2 ? "nd" : lvl === 3 ? "rd" : "th"}-level slot (Expert Divination)`, source.id);
            break;
          }
        }
        break;
      }

      case "destroy": case "banish": {
        const t = ctx.scope[0];
        if (!t || !t.alive) break;
        const cr = crValue(t.ref);
        // an unrated stat block (a player character's) is out of reach of a challenge-rating limit, but not of a spell with no limit (Divine Word: crMax 99)
        if (cr === undefined ? node.crMax < 30 : cr > node.crMax) break;
        t.hp = 0;
        t.alive = false;
        t.downed = false;
        say(state, node.type === "destroy" ? `${t.name} is destroyed` : `${t.name} is banished`, source.id);
        if (node.type === "destroy") fireOnDeathTraits(state, t);
        break;
      }

      case "divineSmite": {
        // Divine Smite (Paladin, 2nd): "when you hit a creature with a melee weapon attack, you can expend one spell slot to deal radiant damage to the target, in addition to the weapon's damage. The damage is 2d8 for a
        // 1st-level spell slot, plus 1d8 for each spell level higher than 1st, to a maximum of 5d8. The damage increases by 1d8 if the target is an undead or a fiend, to a maximum of 6d8."
        const t = ctx.scope[0];
        if (!t || !t.alive || ctx.spell || ctx.ranged) break;
        const levels = [1, 2, 3, 4, 5].filter((l) => (source.resources.get(`slot${l}`) ?? 0) > 0);
        if (!levels.length) break;
        const extra = isCreatureType(t.ref, "undead", "fiend") ? 1 : 0;
        const dice = (l: number) => Math.min(5, l + 1) + extra;
        const expected = (l: number) => dice(l) * 4.5 * (ctx.crit ? 2 : 1);
        const finishers = levels.filter((l) => expected(l) >= t.hp + t.tempHp);
        const slotsLeft = levels.reduce((n, l) => n + (source.resources.get(`slot${l}`) ?? 0), 0);
        // a paladin's choice: the biggest slot on a critical hit (the dice double), the smallest that finishes the creature, otherwise the smallest — and the very last slot only for those two
        if (slotsLeft <= 1 && !ctx.crit && !finishers.length) break;
        const pick = ctx.crit ? levels[levels.length - 1] : finishers.length ? finishers[0] : levels[0];
        source.resources.set(`slot${pick}`, (source.resources.get(`slot${pick}`) ?? 0) - 1);
        source.smiteSerial = state.turnSerial ?? 0;
        say(state, `${source.name} smites with a ${pick}${pick === 1 ? "st" : pick === 2 ? "nd" : pick === 3 ? "rd" : "th"}-level slot (${dice(pick)}d8 radiant)`, source.id);
        runAutomation([{ type: "damage", amount: `${dice(pick)}d8`, damageType: "radiant" }], { ...ctx, depth: ctx.depth + 1 });
        break;
      }

      case "layOnHands": {
        // Lay on Hands (Paladin, 1st): "a pool of healing power that replenishes when you take a long rest. With that pool, you can restore a total number of hit points equal to your paladin level x 5" — "This feature has no effect on undead and constructs."
        const t = ctx.scope[0] ?? source;
        if (!t.alive || isCreatureType(t.ref, "undead", "construct")) break;
        const pool = source.resources.get("lay_on_hands") ?? 0;
        const missing = t.downed ? t.maxHp : t.maxHp - t.hp;
        if (pool <= 0 || missing <= 0) break;
        const amount = Math.min(pool, Math.max(1, missing));
        source.resources.set("lay_on_hands", pool - amount);
        const healed = applyHealing(state, t, amount);
        say(state, `${source.name} lays on hands: ${t.name} regains ${healed} (${pool - amount} left in the pool)`, source.id);
        break;
      }

      case "allyStrike": {
        // Voice of Authority: the ally uses its reaction to make one weapon attack against an enemy of the caster's choosing
        const ally = ctx.scope[0];
        if (!ally || ally.id === source.id || !ally.alive || ally.downed || ally.reactionUsed || isIncapacitated(ally) || state.inReaction) break;
        const swing = ally.ref.actions.find((a) => a.id === "attack");
        if (!swing) break;
        const foes = livingEnemies(state, ally);
        if (!foes.length) break;
        const pick = foes.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        ally.reactionUsed = true;
        state.inReaction = true;
        try {
          runAction(state, ally, swing, { asReaction: true, forceScope: [pick], skipIncapacitatedCheck: true });
        } finally {
          state.inReaction = false;
        }
        break;
      }

      case "omenRoll": {
        if (!source.omen) {
          source.omen = state.rng.next() < 0.5 ? "weal" : "woe";
          say(state, `${source.name} reads the stars: ${source.omen}`, source.id);
        }
        break;
      }

      case "wildShape": {
        const f = BEAST_FORMS[node.form];
        if (!f || source.shape) break;
        source.shape = { ref: source.ref, hp: source.hp, maxHp: source.maxHp, ac: source.ac, form: f.id };
        source.ref = shapedAs(source.ref, f, node.beastSpells === true);
        source.hp = source.maxHp = f.ref.maxHp as number;
        source.ac = f.ref.ac;
        if (f.onShape) runAutomation(f.onShape, { state, source, scope: [source], last: {}, depth: 0 });
        break;
      }

      case "takeControl": {
        const t = ctx.scope[0];
        if (!t || !t.alive || t.side === source.side) break;
        // "until you use this feature again": the last creature taken is let go
        for (const u of state.units.values()) {
          if (u.summonerId === source.id && u.effects.some((e) => e.name === "commanded" && e.sourceId === source.id)) {
            u.effects = u.effects.filter((e) => e.name !== "commanded");
            u.side = u.side === "party" ? "monster" : "party";
            u.summonerId = undefined;
            say(state, `${u.name} slips the leash`, source.id);
          }
        }
        t.side = source.side;
        t.summonerId = source.id;
        t.effects.push({ name: "commanded", expiresRound: Infinity, sourceId: source.id });
        if (state.focusId === t.id) state.focusId = undefined;
        if (state.monsterFocusId === t.id) state.monsterFocusId = undefined;
        say(state, `${t.name} turns on its old masters and obeys ${source.name}`, source.id);
        break;
      }

      case "portentRoll": {
        if (!source.portentDice) {
          source.portentDice = Array.from({ length: node.dice }, () => state.rng.d20());
          say(state, `${source.name} foretells ${source.portentDice.join(", ")} (Portent)`, source.id);
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
          // Undead Thralls: a bigger hit point maximum and a bonus to weapon damage rolls
          const made = node.damageBonus ? withDamageBonus(ref, node.damageBonus) : ref;
          const ms = initCombatant(made, source.side, suffix);
          if (node.hpBonus) { ms.maxHp += node.hpBonus; ms.hp += node.hpBonus; }
          // Mighty Summoner (Shepherd): beasts and fey summoned have 2 extra hit points per Hit Die
          if (source.ref.specialRules.some((r) => r.rule === "mightySummoner") && isCreatureType(ref, "beast", "fey")) {
            const dice = typeof ref.maxHp === "string" ? Number(/^(\d+)d/.exec(ref.maxHp)?.[1] ?? 0) : 0;
            ms.maxHp += 2 * dice; ms.hp += 2 * dice;
          }
          if (node.hp) ms.hp = Math.min(ms.maxHp, node.hp);
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
    runAutomation(action.automation, { state, source, scope: opts.scope ?? [], last: {}, depth: 0, spell, spellSchool: action.school, spellLevel: action.spellLevel, appliedNames, forceScope: opts.forceScope, ranged: action.ranged, ...geo });
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
  const shapeBefore = new Map([...state.units.values()].map((u) => [u.id, u.shape?.form ?? ""]));
  const saveLog = new Map<string, boolean>();
  const attackTally = { rolled: 0, hit: 0, unreachable: false };
  runAutomation(action.automation, { state, source, scope: opts.scope ?? [], last: {}, depth: 0, saveLog, attackTally, spell, spellSchool: action.school, spellLevel: action.spellLevel, appliedNames, forceScope: opts.forceScope, ranged: action.ranged, ...geo });
  if (action.concentration && appliedNames && appliedNames.length) {
    source.concentratingOn = action.id;
    source.concentrationEffects = [...new Set(appliedNames)];
  }

  const parts: string[] = [];
  for (const u of onlyCommands ? [] : state.units.values()) {
    // (changing shape swaps one hit point pool for another: that isn't damage or healing)
    const delta = (shapeBefore.get(u.id) ?? "") !== (u.shape?.form ?? "") ? 0 : (before.get(u.id) ?? 0) - (u.hp + u.tempHp);
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
    const formBefore = shapeBefore.get(u.id) ?? "";
    const formNow = u.shape?.form ?? "";
    if (formNow !== formBefore) {
      // a new form (or the druid's own shape again) says what it is; its hit points are a new pool, not damage
      bits.push(formNow ? `becomes ${/^[aeiou]/i.test(BEAST_FORMS[formNow]?.name ?? formNow) ? "an" : "a"} ${BEAST_FORMS[formNow]?.name ?? formNow} (${u.hp}/${u.maxHp})` : `back in their own shape (${u.hp}/${u.maxHp})`);
    }
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
