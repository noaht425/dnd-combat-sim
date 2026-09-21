// Live combat state. The immutable stat block lives on `.ref`; everything that
// changes during a fight lives here.

import type { Action, Combatant, Condition, DamageType, EffectMods } from "../schema";
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
  /** ends the moment the creature takes damage */
  endsOnDamage?: boolean;
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
  /** last round the summoner spent a bonus action commanding this minion (Steel Defender, Eldritch
   *  Cannon) — a commanded minion's own turn is skipped that round; an uncommanded one just Dodges */
  commandedRound?: number;
  /** Bastion of Law — a pool of d8s that reduce damage the warded creature takes, until a long rest
   *  or until the artificer creates a new ward */
  ward?: { dice: number; sourceId: string };
  /** Arcane Ward (Abjuration): the ward's hit points now and at most. It stays (at 0 once broken) until a long rest — it can't be raised again before then */
  arcaneWard?: { hp: number; maxHp: number };
  /** Wild Shape: the creature's own statistics, kept while it is in another form (the form's are in `ref`, `hp`, `maxHp` and `ac`) */
  shape?: { ref: Combatant; hp: number; maxHp: number; ac: number; form: string };
  /** Dampen Elements: the damage type resisted for the next instance of it (a reaction) */
  dampened?: DamageType;
  /** Cosmic Omen (Stars): the day's omen, rolled after a long rest */
  omen?: "weal" | "woe";
  /** Portent (Divination): the foretelling d20s rolled since the last long rest and not yet used, and the turn one was last used on */
  portentDice?: number[];
  portentTurnKey?: string;
  /** Arcane Recovery has been used today */
  arcaneRecoveryUsed?: boolean;
  lastSangRound?: number;  // last round this combatant used a "song" action
  d20SwapsLeft?: number;   // d20Replacement — uses left this round
  meleeHitSinceMyTurn?: boolean; // a melee PC has connected -> a keep-distance monster will withdraw (provoking)
  assassinateUntilRound?: number; // Ambush: while state.round <= this, hits have advantage and auto-crit
  /** Absorb Elements — resistance to one damage type until the start of the reactor's next turn */
  absorbElements?: { type: DamageType; untilRound: number };
  /** Sneak Attack is once per TURN (any creature's): which turn it was last spent on, and against whom */
  sneakSpent?: { serial: number; targets: string[] };
  /** Inquisitive's Insightful Fighting — the creature currently read, and the round the minute runs out */
  insightTargetId?: string;
  insightUntilRound?: number;
  /** levels of exhaustion (Frenzy's cost): 2 halves speed, 3 gives disadvantage on attacks and saves, 4 halves maximum HP, 5 sets speed to 0, 6 is death */
  exhaustion?: number;
  /** Rage Beyond Death: at 0 hit points but still on its feet while the rage lasts */
  zeroHpRaging?: boolean;
  /** ...and it has failed its third death save: it dies when the rage ends, if it's still at 0 */
  deathPending?: boolean;
  /** turnSerial of the last attack this creature made or damage it took (Rage ends if a turn passes with neither) */
  combatEventSerial?: number;
  /** turnSerial at the end of this creature's previous turn, or just before it began raging */
  rageCheckSerial?: number;
  /** times Relentless Rage has been used since the last rest (each adds 5 to the DC) */
  relentlessUses?: number;
  /** keys of once-per-turn riders already used, and the turn they were used on */
  onceTurn?: { serial: number; keys: string[] };
  /** has taken a turn in this combat (Assassinate: advantage against creatures that haven't) */
  hasTakenTurn?: boolean;
  /** the creature this one last made an attack roll against (Horde Breaker attacks a different one) */
  lastAttackTargetId?: string;
  /** Fancy Footwork — the creatures it has made a melee attack against this turn (no opportunity attacks from them) */
  footwork?: { serial: number; ids: string[] };
  /** Scout's Ambush Master — already tagged the first creature it hit in round 1 */
  ambushMasterUsed?: boolean;

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
  order: string[]; // combatant ids, highest initiative first (a Thief's second turn is `<id>~2`, see EXTRA_TURN)
  activeIdx: number;
  /** bumped at the start of every turn anyone takes — Sneak Attack's "once per turn" keys off it */
  turnSerial?: number;
  /** Entropic Ward: the warlock whose ward just imposed disadvantage on the attack being rolled (advantage on their next attack if it misses) */
  pendingEntropicWard?: string;
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
  /** set true the moment any reaction fires during the current top-level
   *  action's resolution (reset at the start of each top-level runAction) —
   *  unlike `inReaction`, this stays true afterward, so the action's own
   *  narration diff can tell "the source's own HP moved because a reaction
   *  retaliated against it" (already narrated by the reaction's own line)
   *  apart from "the source's own effects genuinely damaged itself"
   *  (Wild Magic Surge and the like, which has no other line to show it). */
  reactionFiredThisAction?: boolean;
  /**
   * Battle mode seam: decide whether a unit spends its reaction. Returns
   * true = take it, false = decline. May throw to unwind the stack when it
   * needs to pause the fight and ask a human. Left undefined by the
   * Monte-Carlo engine and for AI units, so the reaction code keeps its own
   * auto-heuristic in that case.
   */
  askReaction?: (p: ReactionAsk) => boolean;
  /** Battle-mode geometry seam: real feet between two units on the grid. Undefined in the
   *  Monte-Carlo engine, which has only the abstract "melee"/"ranged" zone. */
  distanceFt?: (a: CombatantState, b: CombatantState) => number;
  /** Battle-mode seam: put a freshly summoned minion on the grid next to its summoner. Undefined in
   *  the Monte-Carlo engine (no positions). */
  placeSummon?: (summoner: CombatantState, minion: CombatantState) => void;
  /** Battle-mode seam: a summoner's bonus-action command to one of its minions — the minion
   *  steps toward its target on the grid, then takes `action` with real geometry. Undefined in
   *  the Monte-Carlo engine, where the action just runs against the abstract target pool. */
  commandMinion?: (minion: CombatantState, action: Action) => void;
  /** what-if knobs for this run */
  tuning?: CombatTuning;
  /** round the first party member dropped to 0, and who */
  firstPartyDownRound?: number;
  firstPartyDownId?: string;
  /** every save attempt this fight, ability + outcome — for a post-fight
   *  "your low Wisdom kept getting you locked down" style readout. Lazily
   *  initialized by rollSave() so existing state-construction call sites
   *  don't all need updating. */
  saveLog?: { round: number; unitId: string; ability: import("../schema").Ability; passed: boolean }[];
  /** every attack roll this fight, attacker/target + outcome — for a
   *  "you whiffed most of your swings" / "your low AC got hit constantly"
   *  readout. Same lazy-init pattern as saveLog. */
  attackLog?: { round: number; attackerId: string; targetId: string; hit: boolean }[];
}

/** the question `state.askReaction` is handed at a reaction decision point */
export interface ReactionAsk {
  unitId: string;
  kind: "shield" | "counterspell" | "riposte" | "uncannyDodge" | "absorbElements" | "retaliate" | "cuttingWords" | "deflectAttack" | "flashOfGenius" | "spiritShield" | "tailSwipe";
  /** one human sentence describing the trigger and what the reaction would do */
  prompt: string;
  /** button label for spending the reaction / for declining it */
  takeLabel: string;
  declineLabel: string;
}

/** a rider that lands at most once per turn under `key` (Divine Fury, a bite's healing, Call the Hunt's d6, Unerring Accuracy) */
export function claimOncePerTurn(state: CombatState, u: CombatantState, key: string): boolean {
  const serial = state.turnSerial ?? 0;
  if (!u.onceTurn || u.onceTurn.serial !== serial) u.onceTurn = { serial, keys: [] };
  if (u.onceTurn.keys.includes(key)) return false;
  u.onceTurn.keys.push(key);
  return true;
}

/** Put (or refresh) the penalties of a creature's exhaustion levels as a standing effect. */
export function syncExhaustion(u: CombatantState): void {
  u.effects = u.effects.filter((e) => e.name !== "exhaustion");
  const n = u.exhaustion ?? 0;
  if (n < 2) return;
  const walk = u.ref.speeds?.walk ?? 30;
  u.effects.push({
    name: "exhaustion", expiresRound: Infinity, sourceId: u.id,
    mods: {
      speedBonusFt: n >= 5 ? -walk : -Math.floor(walk / 2),
      ...(n >= 3 ? { attackAdvantage: "dis" as const, saveAdvantage: "dis" as const } : {}),
    },
  });
}

/**
 * Back to the creature's own shape: "When you revert to your normal form, you return to the number of hit points you had before you transformed."
 * Damage left over from the blow that broke the form is the caller's to carry over. Returns whether it was shaped.
 */
export function revertShape(state: CombatState | undefined, u: CombatantState): boolean {
  if (!u.shape) return false;
  const own = u.shape;
  u.ref = own.ref;
  u.hp = own.hp;
  u.maxHp = own.maxHp;
  u.ac = own.ac;
  u.shape = undefined;
  u.effects = u.effects.filter((e) => e.name !== "fire-form");
  if (state) say(state, `${u.name} returns to their own shape`, u.id);
  return true;
}

/** Reset a combatant's per-turn action economy at the start of its own turn. */
export function startTurnEconomy(u: CombatantState): void {
  u.actionUsedThisTurn = false;
  u.bonusUsedThisTurn = false;
  u.reactionUsed = false;
  u.leveledSpellThisTurn = false;
}

/** Mark the start of someone's turn: Sneak Attack's once-per-turn budget resets, and anything that lasts
 *  "until the start of your next turn" and was put out by this creature ends (Help, Ambush Master). */
export function beginTurn(state: CombatState, u: CombatantState): void {
  state.turnSerial = (state.turnSerial ?? 0) + 1;
  const firstTurn = !u.hasTakenTurn;
  u.hasTakenTurn = true;
  for (const other of state.units.values()) {
    if (!other.effects.some((e) => e.sourceId === u.id && e.mods?.untilSourceNextTurn)) continue;
    other.effects = other.effects.filter((e) => !(e.sourceId === u.id && e.mods?.untilSourceNextTurn));
  }
  // Dread Ambusher: extra speed on the first turn of the combat, until the start of the next one
  const ft = firstTurn ? u.ref.specialRules.find((r) => r.rule === "firstTurnSpeed") : undefined;
  if (ft && ft.rule === "firstTurnSpeed") {
    u.effects.push({ name: "dread-ambusher-speed", mods: { speedBonusFt: ft.ft, untilSourceNextTurn: true }, expiresRound: Infinity, sourceId: u.id });
  }
}

/** suffix on an initiative-order entry that is a creature's SECOND turn of round 1 (Thief's Reflexes) */
export const EXTRA_TURN = "~2";
export const isExtraTurn = (entry: string): boolean => entry.endsWith(EXTRA_TURN);
export const turnOwner = (entry: string): string => (isExtraTurn(entry) ? entry.slice(0, -EXTRA_TURN.length) : entry);

/**
 * Roll initiative for everyone and return the turn order (ids, highest first; monsters win ties).
 * Scout's Ambush Master rolls with advantage; Thief's Reflexes adds a second entry at initiative − 10
 * that only ever runs in round 1 — and not at all if the party is surprised, which here means a monster
 * has the `ambush` rule.
 */
export function rollTurnOrder(units: Iterable<CombatantState>, rng: Rng, dexMod: (u: CombatantState) => number): string[] {
  const all = [...units];
  const partySurprised = all.some((u) => u.side === "monster" && u.ref.specialRules.some((r) => r.rule === "ambush"));
  const entries: { id: string; init: number; side: CombatantState["side"] }[] = [];
  for (const u of all) {
    const adv = u.ref.specialRules.some((r) => r.rule === "initiativeAdvantage");
    const roll = adv ? rng.d20mode("adv").used : rng.d20();
    const init = roll + (u.ref.initiativeBonus ?? dexMod(u)) + (u.assassinateUntilRound ? 100 : 0);
    entries.push({ id: u.id, init, side: u.side });
    if (u.side === "party" && !partySurprised && u.ref.specialRules.some((r) => r.rule === "extraFirstRoundTurn")) {
      entries.push({ id: u.id + EXTRA_TURN, init: init - 10, side: u.side });
    }
  }
  return entries.sort((a, b) => b.init - a.init || (a.side === "monster" ? -1 : 1)).map((x) => x.id);
}

/** Apply healing to `target` (respecting a `cannotHeal` rider). Returns HP restored. */
export function applyHealing(state: CombatState, target: CombatantState, raw: number): number {
  if (raw <= 0 || !target.alive) return 0;
  if (target.effects.some((e) => e.mods?.cannotHeal)) return 0;
  const applied = Math.min(Math.round(raw), Math.max(0, target.maxHp - target.hp));
  target.hp += applied;
  if (target.hp > 0) { target.zeroHpRaging = false; target.deathPending = false; if (!target.downed) target.deathSaves = { success: 0, fail: 0 }; }
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

/** condition/effect ids are catalog slugs ("spike-growth", "marked-for-reckoning") —
 *  turn them into narration-friendly text instead of printing the raw slug. */
export function humanize(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
  // Durable Magic: +2 AC while concentrating on a spell
  if (u.concentratingOn) for (const r of u.ref.specialRules) if (r.rule === "durableMagic") ac += r.bonus;
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
