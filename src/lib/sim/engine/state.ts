// Live combat state. The immutable stat block lives on `.ref`; everything that
// changes during a fight lives here.

import type { Combatant, Condition, DamageType, EffectMods } from "../schema";
import type { Rng } from "./rng";

export interface ActiveEffect {
  name: string;
  mods?: EffectMods;
  tick?: import("../schema").AutomationNode[];
  saveEnds?: { ability: import("../schema").Ability; dc: number; at: "endOfTurn" | "startOfTurn" };
  /** round number at which it drops off; Infinity = until removed / save ends */
  expiresRound: number;
  sourceId: string;
  /** removed the moment its extraDamageOnHit lands on an attack */
  oneShot?: boolean;
}

export interface ConditionInstance {
  expiresRound: number; // Infinity = until removed / save ends
  saveEnds?: { ability: import("../schema").Ability; dc: number; at: "endOfTurn" | "startOfTurn" };
  sourceId: string;
}

export interface CombatantState {
  id: string;
  ref: Combatant;
  side: "party" | "monster";
  name: string;

  hp: number;
  tempHp: number;
  maxHp: number;

  ac: number; // base; effect acBonus applied on read
  conditions: Map<Condition, ConditionInstance>;
  effects: ActiveEffect[];
  resources: Map<string, number>;

  legendaryBudget: number;
  legendaryMax: number;
  lastLairActionId?: string;

  concentratingOn?: string;          // action id of the concentration spell currently up
  concentrationEffects?: string[];   // effect / condition names it created (removed when concentration breaks)
  // action economy — all reset at the START OF THIS COMBATANT'S OWN TURN
  actionUsedThisTurn: boolean;
  bonusUsedThisTurn: boolean;
  reactionUsed: boolean;             // your reaction refreshes at the start of your turn (not the round)
  leveledSpellThisTurn: boolean;     // cast a non-cantrip spell this turn -> only a cantrip allowed after
  onceFired: Set<string>; // trait.once ids, "undyingReturn", "bloodied"
  markedTargetId?: string;
  summonerId?: string;     // set on spawned minions -> the combatant that summoned them
  lastSangRound?: number;  // last round this combatant used a "song" action
  d20SwapsLeft?: number;   // d20Replacement — uses left this round
  meleeHitSinceMyTurn?: boolean; // a melee PC has connected -> a keep-distance monster will withdraw (provoking)
  assassinateUntilRound?: number; // Ambush: while state.round <= this, hits have advantage and auto-crit
  /** Absorb Elements — resistance to one damage type until the start of the reactor's next turn */
  absorbElements?: { type: DamageType; untilRound: number };

  zone: "melee" | "ranged";
  alive: boolean;
  downed: boolean;  // PC at 0 HP and unconscious
  stable: boolean;  // downed but no longer rolling death saves (3 successes / Spare the Dying)
  deathSaves: { success: number; fail: number };
  lastRevivedRound?: number; // healer AI: don't burn every turn re-reviving into an execute

  // per-fight aggregates for reporting
  damageDealt: number;
  damageTaken: number;
  downedRound?: number; // round this combatant first hit 0 HP (party: downed; monster: destroyed)
}

/** Optional knobs for a what-if run: scale HP, shift to-hit / save DCs / damage. */
export interface CombatTuning {
  monsterHpMult?: number;
  monsterToHitDelta?: number;
  monsterDcDelta?: number;
  monsterDamageMult?: number;
  partyToHitDelta?: number;
  partyDamageMult?: number;
}

export interface LogEntry {
  round: number;
  actorId?: string;
  text: string;
}

export interface CombatState {
  round: number;
  order: string[]; // combatant ids, highest initiative first
  activeIdx: number;
  units: Map<string, CombatantState>;
  rng: Rng;
  log: LogEntry[];
  maxRounds: number;
  ended: boolean;
  winner?: "party" | "monster" | "draw";
  /** when true the engine records a full play-by-play (Monte-Carlo leaves it off for speed) */
  verbose: boolean;
  /** the enemy the party is ganging up on this round (set at round start) */
  focusId?: string;
  /** the PC the monster pack is ganging up on this round */
  monsterFocusId?: string;
  /** monotonic counter for unique spawned-minion ids */
  summonCounter: number;
  /** extra stat blocks a `summon` node can name — custom-loaded monster packs */
  summonRegistry?: Record<string, Combatant>;
  /** set while a reaction is resolving, so reactions don't trigger reactions */
  inReaction?: boolean;
  /**
   * Battle mode seam: decide whether a unit spends its reaction. Returns
   * true = take it, false = decline. May throw to unwind the stack when it
   * needs to pause the fight and ask a human. Left undefined by the
   * Monte-Carlo engine and for AI units, so the reaction code keeps its own
   * auto-heuristic in that case.
   */
  askReaction?: (p: ReactionAsk) => boolean;
  /** what-if knobs for this run */
  tuning?: CombatTuning;
  /** round the first party member dropped to 0, and who */
  firstPartyDownRound?: number;
  firstPartyDownId?: string;
}

/** the question `state.askReaction` is handed at a reaction decision point */
export interface ReactionAsk {
  unitId: string;
  kind: "shield" | "counterspell" | "riposte" | "uncannyDodge" | "absorbElements" | "retaliate";
  /** one human sentence describing the trigger and what the reaction would do */
  prompt: string;
  /** button label for spending the reaction / for declining it */
  takeLabel: string;
  declineLabel: string;
}

/** Reset a combatant's per-turn action economy at the start of its own turn. */
export function startTurnEconomy(u: CombatantState): void {
  u.actionUsedThisTurn = false;
  u.bonusUsedThisTurn = false;
  u.reactionUsed = false;
  u.leveledSpellThisTurn = false;
}

/** Apply healing to `target` (respecting a `cannotHeal` rider). Returns HP restored. */
export function applyHealing(state: CombatState, target: CombatantState, raw: number): number {
  if (raw <= 0 || !target.alive) return 0;
  if (target.effects.some((e) => e.mods?.cannotHeal)) return 0;
  const applied = Math.min(Math.round(raw), Math.max(0, target.maxHp - target.hp));
  target.hp += applied;
  // healing a downed / stable creature above 0 brings it back to consciousness
  if (target.hp > 0 && (target.downed || target.stable)) {
    target.downed = false;
    target.stable = false;
    target.deathSaves = { success: 0, fail: 0 };
    say(state, `${target.name} is back on its feet (${target.hp} HP)`, target.id);
  }
  return applied;
}

/** a spawned minion (vs. an original combatant) */
export function isMinion(u: CombatantState): boolean {
  return u.summonerId !== undefined;
}

/** The caster stops concentrating: strip the effects / conditions its spell put out. */
export function breakConcentration(
  state: CombatState,
  caster: CombatantState,
  why: "damage" | "recast" | "incapacitated",
): void {
  const names = new Set(caster.concentrationEffects ?? []);
  const label = caster.concentratingOn;
  caster.concentratingOn = undefined;
  caster.concentrationEffects = undefined;
  if (!names.size) return;
  for (const u of state.units.values()) {
    u.effects = u.effects.filter((e) => !(names.has(e.name) && e.sourceId === caster.id));
    for (const [cond, inst] of [...u.conditions]) {
      if (names.has(cond) && inst.sourceId === caster.id) u.conditions.delete(cond);
    }
  }
  if (why !== "recast") say(state, `${caster.name} loses concentration${label ? ` on ${label}` : ""}`, caster.id);
}

/** true if any active effect on `u` sets the given boolean effect-mod */
export function hasEffectFlag(u: CombatantState, flag: "cannotHeal" | "noReactions" | "speedZero"): boolean {
  return u.effects.some((e) => e.mods?.[flag] === true);
}

export function say(state: CombatState, text: string, actorId?: string): void {
  if (state.verbose) state.log.push({ round: state.round, actorId, text });
}

/** {id -> hp} snapshot, for diffing what an action did */
export function hpSnapshot(state: CombatState): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of state.units.values()) m.set(u.id, u.hp + u.tempHp);
  return m;
}

export function hpBar(u: CombatantState): string {
  const pct = Math.max(0, Math.round((u.hp / u.maxHp) * 100));
  const state = !u.alive ? "dead" : u.downed ? "DOWN" : `${Math.max(0, u.hp)}/${u.maxHp}`;
  const conds = [...u.conditions.keys()];
  return `${u.name} ${state} (${pct}%)${conds.length ? " [" + conds.join(",") + "]" : ""}`;
}

export function avgToNumber(hp: number | string): number {
  if (typeof hp === "number") return hp;
  const s = hp.replace(/\s+/g, "");
  if (/^-?\d+$/.test(s)) return Number(s);
  let total = 0;
  for (const t of s.match(/[+-]?(\d*d\d+|\d+)/gi) ?? []) {
    const sign = t.startsWith("-") ? -1 : 1;
    const body = t.replace(/^[+-]/, "");
    const dm = body.match(/^(\d*)d(\d+)$/i);
    if (dm) total += sign * (dm[1] ? Number(dm[1]) : 1) * ((Number(dm[2]) + 1) / 2);
    else total += sign * Number(body);
  }
  return Math.round(total);
}

export function initCombatant(ref: Combatant, side: "party" | "monster", idSuffix = ""): CombatantState {
  const maxHp = avgToNumber(ref.maxHp);
  const resources = new Map<string, number>();
  for (const [name, r] of Object.entries(ref.resources ?? {})) {
    const max = r.max === "unbounded" ? 999 : r.max;
    resources.set(name, r.start ?? max);
  }
  const lr = ref.specialRules.find((x) => x.rule === "legendaryResistance");
  if (lr && lr.rule === "legendaryResistance") resources.set("__legendaryResistance", lr.perDay);
  const precog = ref.specialRules.find((x) => x.rule === "d20Replacement");

  return {
    id: ref.id + idSuffix,
    ref,
    side,
    name: ref.name + idSuffix,
    hp: maxHp,
    tempHp: 0,
    maxHp,
    ac: ref.ac,
    conditions: new Map(),
    effects: [],
    resources,
    legendaryBudget: 0, // earned at the start of its first turn
    legendaryMax: ref.legendaryActions?.budget ?? 0,
    actionUsedThisTurn: false,
    bonusUsedThisTurn: false,
    reactionUsed: false,
    leveledSpellThisTurn: false,
    onceFired: new Set(),
    d20SwapsLeft: precog && precog.rule === "d20Replacement" ? precog.perRound : undefined,
    zone: (ref.ai.keepDistance ? "ranged" : "melee"),
    alive: true,
    downed: false,
    stable: false,
    deathSaves: { success: 0, fail: 0 },
    damageDealt: 0,
    damageTaken: 0,
  };
}

// -------- reads that fold in active effects --------

export function effectiveAc(u: CombatantState): number {
  let ac = u.ac;
  for (const e of u.effects) if (e.mods?.acBonus) ac += e.mods.acBonus;
  return ac;
}

export function hasCondition(u: CombatantState, c: Condition): boolean {
  return u.conditions.has(c);
}

export function isIncapacitated(u: CombatantState): boolean {
  return (
    u.conditions.has("incapacitated") ||
    u.conditions.has("stunned") ||
    u.conditions.has("paralyzed") ||
    u.conditions.has("unconscious") ||
    u.conditions.has("petrified") ||
    u.downed ||
    !u.alive
  );
}

export function canTakeReactions(u: CombatantState): boolean {
  if (isIncapacitated(u)) return false;
  if (u.conditions.has("concussed") || u.conditions.has("transfixed")) return false;
  for (const e of u.effects) if (e.mods?.noReactions) return false;
  return true;
}

export function livingEnemies(state: CombatState, u: CombatantState): CombatantState[] {
  return [...state.units.values()].filter((x) => x.side !== u.side && x.alive && !x.downed);
}

export function livingAllies(state: CombatState, u: CombatantState): CombatantState[] {
  return [...state.units.values()].filter((x) => x.side === u.side && x.alive && !x.downed);
}
