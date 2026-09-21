// The round loop. Rolls initiative, runs turns, fires lair actions on init 20 and
// legendary actions after each PC turn, ticks conditions / effects / auras, and
// stops when one side is down or maxRounds is hit.

import type { Combatant } from "../schema";
import { makeRng } from "./rng";
import { makeGenericParty } from "./party-build";
import { takeLairAction, takeLegendaryActions, takeMonsterTurn, takePcTurn } from "./ai";
import { fireEncounterStartTraits, runAutomation } from "./interpreter";
import { chooseFocusTarget } from "./score";
import { REVERTS_ON_SUMMONER_DEATH } from "./minions";
import { haloOfSpores, talismanBoost } from "./reactions";
import { isCreatureType } from "./creatureType";
import {
  CombatState,
  CombatTuning,
  CombatantState,
  applyHealing,
  beginTurn,
  hpBar,
  humanize,
  initCombatant,
  isIncapacitated,
  isExtraTurn,
  isMinion,
  livingEnemies,
  revertShape,
  rollTurnOrder,
  say,
  startTurnEconomy,
  syncExhaustion,
  turnOwner,
} from "./state";

export interface Contribution {
  id: string;
  name: string;
  side: "party" | "monster";
  dealt: number;
  taken: number;
  downedRound?: number;
  isMinion: boolean;
}

export interface CombatResult {
  winner: "party" | "monster" | "draw";
  rounds: number;
  partyHpPct: number; // fraction of party max HP still standing
  partySurvivors: number;
  monsterHpPct: number; // fraction of monster max HP left (0 if it died)
  /** per-combatant damage dealt / taken and when they dropped */
  contributions: Contribution[];
  /** round the first party member dropped to 0, and who (undefined = nobody went down) */
  firstPartyDownRound?: number;
  firstPartyDownName?: string;
  log: string[];
  /** every save attempt / attack roll this fight — for a post-fight
   *  "your low Wisdom kept getting you locked down" / "you whiffed most of
   *  your swings" style readout (see CombatState's doc comments). */
  saveLog: CombatState["saveLog"];
  attackLog: CombatState["attackLog"];
}

export interface RunOptions {
  seed?: number;
  maxRounds?: number;
  level?: number;
  partySize?: number;
  keepLog?: boolean;
  /** an explicit party (built from templates); when omitted, the generic Phase-1 party is used */
  party?: Combatant[];
  /** pre-initialised party unit states to reuse (adventuring-day mode carries HP /
   *  resources / death-save state across encounters). Overrides `party`. */
  partyStates?: CombatantState[];
  /** what-if knobs: scale monster HP, shift to-hit / DC / damage on either side */
  tuning?: CombatTuning;
  /** extra stat blocks a `summon` node can name — custom-loaded monster packs */
  summonRegistry?: Record<string, Combatant>;
}

export function runCombat(monsters: Combatant[], opts: RunOptions = {}): CombatState {
  const level = opts.level ?? 20;
  const size = opts.partyStates ? opts.partyStates.length : opts.party ? opts.party.length : opts.partySize ?? 4;
  const rng = makeRng(opts.seed ?? 1, level, size, monsters.length);
  const pcs = opts.party ?? makeGenericParty(level, size);

  const units = new Map<string, CombatantState>();
  for (const m of monsters) units.set(m.id, initCombatant(m, "monster"));
  if (opts.partyStates) {
    // adventuring-day: reuse the carried-forward states, but wipe per-encounter
    // scratch (conditions, effects, turn economy, per-fight aggregates)
    for (const p of opts.partyStates) {
      p.conditions.clear();
      p.effects = [];
      p.tempHp = 0;
      p.concentratingOn = undefined;
      p.concentrationEffects = undefined;
      p.onceFired = new Set();
      p.markedTargetId = undefined;
      p.assassinateUntilRound = undefined;
      p.meleeHitSinceMyTurn = false;
      // per-fight scratch added by class features: nothing of a previous fight carries over
      revertShape(undefined, p); // Wild Shape lasts hours, but a fight is self-contained: the druid starts each encounter in their own shape and hit points
      p.hasTakenTurn = false; p.sneakSpent = undefined; p.onceTurn = undefined; p.insightTargetId = undefined; p.insightUntilRound = undefined;
      p.ambushMasterUsed = false; p.footwork = undefined; p.zeroHpRaging = false; p.deathPending = false;
      p.combatEventSerial = undefined; p.rageCheckSerial = undefined; p.commandedRound = undefined;
      syncExhaustion(p); // exhaustion, unlike the rest, does carry over
      p.damageDealt = 0;
      p.damageTaken = 0;
      p.downedRound = undefined;
      startTurnEconomy(p);
      units.set(p.id, p);
    }
  } else {
    for (const pc of pcs) units.set(pc.id, initCombatant(pc, "party"));
  }

  // what-if: scale monster HP (minions are added later, so this is just the originals)
  const hpMult = opts.tuning?.monsterHpMult;
  if (hpMult && hpMult > 0 && hpMult !== 1) {
    for (const u of units.values()) {
      if (u.side !== "monster") continue;
      u.maxHp = Math.max(1, Math.round(u.maxHp * hpMult));
      u.hp = u.maxHp;
    }
  }

  // an ambusher surprises the party: it acts first, and its round-1 hits crit
  for (const u of units.values()) {
    if (u.ref.specialRules.some((r) => r.rule === "ambush")) u.assassinateUntilRound = 1;
  }

  // initiative — dex-mod + d20 (+ initiativeBonus if set); monster gets ties;
  // an ambusher jumps the queue for the surprise strike; Thief's Reflexes adds a
  // second round-1 slot at initiative − 10 (rollTurnOrder)
  const order = rollTurnOrder(units.values(), rng, (u) => Math.floor((u.ref.abilities.dex - 10) / 2));

  const state: CombatState = {
    round: 0,
    order,
    activeIdx: 0,
    units,
    rng,
    log: [],
    maxRounds: opts.maxRounds ?? 25,
    ended: false,
    verbose: opts.keepLog ?? false,
    summonCounter: 0,
    tuning: opts.tuning,
    summonRegistry: opts.summonRegistry,
  };

  say(state, `Initiative: ${order.map((e) => units.get(turnOwner(e))!.name + (isExtraTurn(e) ? " (again)" : "")).join(" > ")}`);
  fireEncounterStartTraits(state); // e.g. an Alchemist rolling the elixirs it brewed at its last long rest

  while (!state.ended && state.round < state.maxRounds) {
    state.round++;
    for (const u of units.values()) {
      const precog = u.ref.specialRules.find((r) => r.rule === "d20Replacement");
      if (precog && precog.rule === "d20Replacement") u.d20SwapsLeft = precog.perRound;
    }
    state.focusId = chooseFocusTarget(state, "party"); // the party picks a target to gang up on
    state.monsterFocusId = chooseFocusTarget(state, "monster"); // the monster pack picks a PC to gang up on

    // lair actions on initiative count 20 (once per round, before the top of the order)
    for (const u of units.values()) {
      if (u.side === "monster" && u.alive && u.ref.lairActions) takeLairAction(state, u);
    }
    checkEnd(state);
    if (state.ended) break;

    for (const entry of order) {
      if (isExtraTurn(entry) && state.round !== 1) continue; // Thief's Reflexes: only the first round
      const u = units.get(turnOwner(entry))!;
      if (!u.alive || state.ended) continue;
      if (u.downed && (isExtraTurn(entry) || !rollDeathSave(state, u))) continue; // (Searing Vengeance, Defy Death: back on their feet, the turn goes on)

      startTurnEconomy(u); // action / bonus / reaction refresh at the start of your own turn
      beginTurn(state, u);
      startOfTurn(state, u);
      if (state.ended) break;

      if (isIncapacitated(u)) {
        say(state, `${u.name} loses its turn (${[...u.conditions.keys()].map(humanize).join(", ") || "incapacitated"})`, u.id);
      } else {
        // refresh legendary budget on the monster's own turn
        if (u.side === "monster") u.legendaryBudget = u.legendaryMax;
        if (u.side === "monster") takeMonsterTurn(state, u);
        else takePcTurn(state, u, level);
      }

      endOfTurn(state, u);
      checkEnd(state);
      if (state.ended) break;

      // legendary actions from any monster, after a non-monster turn
      if (u.side === "party") {
        for (const m of units.values()) {
          if (m.side === "monster" && m.alive) takeLegendaryActions(state, m);
        }
        checkEnd(state);
        if (state.ended) break;
      }
    }

    if (state.verbose && !state.ended) {
      say(state, "  " + [...units.values()].filter((u) => u.alive).map(hpBar).join("  |  "));
    }
  }

  if (!state.ended) {
    state.ended = true;
    // time-out: whoever has the higher HP fraction "wins" the model
    state.winner = partyHpFraction(state) >= monsterHpFraction(state) ? "party" : "monster";
  }
  return state;
}

// ---------------------------------------------------------------- turn phases

export function startOfTurn(state: CombatState, u: CombatantState): void {
  if (u.zeroHpRaging && u.hp <= 0 && u.alive) rollDeathSave(state, u); // Rage Beyond Death still makes death saves
  haloOfSpores(state, u); // a Spores druid's reaction as a creature starts its turn beside them
  // Absorb Elements resistance lasts "until the start of your next turn"
  if (u.absorbElements && state.round >= u.absorbElements.untilRound) u.absorbElements = undefined;

  // effect ticks (DoT: Burning, charm-song, molten ground, ...)
  for (const e of [...u.effects]) {
    if (e.tick && e.tick.length) {
      runAutomation(e.tick, { state, source: u, scope: [u], last: {}, depth: 0 });
    }
    if (e.saveEnds && e.saveEnds.at === "startOfTurn") trySaveEnds(state, u, e.name);
  }
  for (const [name, c] of [...u.conditions]) {
    if (c.saveEnds && c.saveEnds.at === "startOfTurn") trySaveEndsCondition(state, u, name);
    if (state.round > c.expiresRound) u.conditions.delete(name);
  }

  // grapple escape — a grappled creature may use its turn's action to try to
  // break free (Athletics/Acrobatics vs the grappler's escape DC)
  const grap = u.conditions.get("grappled");
  if (grap && u.alive && !u.downed && !isIncapacitated(u)) {
    const grappler = grap.sourceId ? state.units.get(grap.sourceId) : undefined;
    const escapeDc = grappler ? 8 + grappler.ref.pb + Math.floor((grappler.ref.abilities.str - 10) / 2) : 14;
    const best = Math.max(
      Math.floor((u.ref.abilities.str - 10) / 2),
      Math.floor((u.ref.abilities.dex - 10) / 2),
    );
    const escapeRoll = state.rng.d20() + best + Math.floor(u.ref.pb / 2);
    if (escapeRoll >= escapeDc || talismanBoost(state, u, escapeRoll, escapeDc, "talisman_checks")) { // (an ability check: the amulet's d4)
      u.conditions.delete("grappled");
      u.effects = u.effects.filter((e) => !(/grip|grasp|jaws|grapple|hold/i.test(e.name) && e.sourceId === grap.sourceId));
      say(state, `${u.name} breaks free of the grapple`, u.id);
    }
  }

  // auras: an aura is short-range, so only the ~front-line members are in it.
  // We approximate by only ticking the aura on the acting unit if it's among the
  // `meleeCount` most-wounded enemies of the aura's owner (a proxy for "in melee").
  for (const other of state.units.values()) {
    if (!other.alive || other.id === u.id || other.side === u.side) continue;
    const auraTrait = other.ref.traits.find((t) => t.aura);
    if (!auraTrait?.aura) continue;
    const enemies = [...state.units.values()]
      .filter((x) => x.side !== other.side && x.alive && !x.downed)
      .sort((a, b) => a.hp - b.hp);
    const inAura = enemies.slice(0, Math.max(1, Math.round(enemies.length / 2)));
    if (!inAura.some((x) => x.id === u.id)) continue;
    runAutomation(auraTrait.aura.automation, { state, source: other, scope: [u], forceScope: [u], last: {}, depth: 0 });
  }
}

export function endOfTurn(state: CombatState, u: CombatantState): void {
  // Guardian Spirit (Shepherd, 10th): a beast or fey the druid summoned regains half the druid's level in hit points as its turn ends, while a totem stands
  if (u.summonerId !== undefined && u.alive && u.hp > 0 && isCreatureType(u.ref, "beast", "fey")) {
    const druid = state.units.get(u.summonerId);
    if (druid?.alive && druid.ref.specialRules.some((r) => r.rule === "guardianSpirit") && druid.effects.some((e) => e.name.startsWith("spirit-"))) {
      const healed = applyHealing(state, u, Math.floor((druid.ref.level ?? 1) / 2));
      if (healed > 0) say(state, `${u.name} is mended by the guardian spirit (+${healed})`, u.id);
    }
  }
  // Rage ends early if your turn ends and you haven't attacked a hostile creature or taken damage since your last
  // turn (Persistent Rage, 15th, drops that condition)
  if (u.effects.some((e) => e.name === "rage")) {
    const serial = state.turnSerial ?? 0;
    const persistent = u.ref.specialRules.some((r) => r.rule === "persistentRage");
    if (!persistent && (u.combatEventSerial ?? -1) <= (u.rageCheckSerial ?? -1)) {
      u.effects = u.effects.filter((e) => e.name !== "rage");
      say(state, `${u.name}'s rage fades (nothing to fight)`, u.id);
    }
    u.rageCheckSerial = serial;
  }
  for (const e of [...u.effects]) {
    if (e.saveEnds && e.saveEnds.at === "endOfTurn") trySaveEnds(state, u, e.name);
    if (state.round > e.expiresRound) u.effects = u.effects.filter((x) => x !== e);
  }
  for (const [name, c] of [...u.conditions]) {
    if (c.saveEnds && c.saveEnds.at === "endOfTurn") trySaveEndsCondition(state, u, name);
    if (state.round >= c.expiresRound && c.expiresRound !== Infinity) u.conditions.delete(name);
  }
  // Rage Beyond Death: the rage is over — if it was holding off death you die now (still at 0 HP); otherwise you go down as normal
  if (u.zeroHpRaging && !u.effects.some((e) => e.name === "rage")) {
    u.zeroHpRaging = false;
    if (u.hp <= 0) {
      if (u.deathPending) { u.alive = false; say(state, `${u.name} dies as the rage ends`, u.id); }
      else { u.downed = true; say(state, `${u.name} drops as the rage ends`, u.id); }
    }
    u.deathPending = false;
  }
}

function trySaveEnds(state: CombatState, u: CombatantState, effectName: string): void {
  const e = u.effects.find((x) => x.name === effectName);
  if (!e?.saveEnds) return;
  const roll = state.rng.d20() + Math.floor((u.ref.abilities[e.saveEnds.ability] - 10) / 2) + (u.ref.proficientSaves.includes(e.saveEnds.ability) ? u.ref.pb : 0);
  if (roll >= e.saveEnds.dc) {
    u.effects = u.effects.filter((x) => x !== e);
    say(state, `${u.name} shakes off ${effectName}`, u.id);
  }
}

function trySaveEndsCondition(state: CombatState, u: CombatantState, name: string): void {
  const c = u.conditions.get(name as never);
  if (!c?.saveEnds) return;
  // a real party helps its own out of a lockdown — Bless, aura, Calm Emotions,
  // "an ally uses its action". Modelled as a flat bump on repeat saves for the
  // party against the worst control conditions.
  const support = u.side === "party" && ["charmed", "incapacitated", "frightened", "stunned", "paralyzed"].includes(name) ? 4 : 0;
  const roll = state.rng.d20() + Math.floor((u.ref.abilities[c.saveEnds.ability] - 10) / 2) + (u.ref.proficientSaves.includes(c.saveEnds.ability) ? u.ref.pb : 0) + u.ref.saveBonusAll + support;
  if (roll >= c.saveEnds.dc) {
    u.conditions.delete(name as never);
    // charm-style effects apply "charmed" + "incapacitated" together (Beguiling
    // Rot, a charm-song) — one save frees you from both.
    if ((name === "charmed" || name === "incapacitated")) {
      const sib = name === "charmed" ? "incapacitated" : "charmed";
      const s = u.conditions.get(sib as never);
      if (s && s.sourceId === c.sourceId) u.conditions.delete(sib as never);
    }
    say(state, `${u.name} shakes off ${name}`, u.id);
  }
}

/** Makes the death saving throw for a creature at 0 hit points. Returns whether it is back on its feet and may take its turn (Searing Vengeance, Defy Death). */
export function rollDeathSave(state: CombatState, u: CombatantState): boolean {
  if (u.stable) return false; // stabilised: unconscious at 0 HP, no more death saves until healed

  // Searing Vengeance (Celestial, 14th): "when you would make a death saving throw at the start of your turn, you can instead spring back to your feet with a burst of radiant
  // energy": half your maximum hit points, and 2d8 + Charisma radiant to each creature of your choice within 30 feet, which is blinded until the end of the current turn
  const sv = u.ref.specialRules.find((x) => x.rule === "searingVengeance");
  if (sv && sv.rule === "searingVengeance" && u.alive && (u.resources.get(sv.resource) ?? 0) > 0) {
    u.resources.set(sv.resource, (u.resources.get(sv.resource) ?? 0) - 1);
    u.downed = false; u.stable = false; u.zeroHpRaging = false; u.deathPending = false;
    u.deathSaves = { success: 0, fail: 0 };
    u.hp = Math.max(1, Math.floor(u.maxHp / 2));
    const mod = Math.floor(((u.ref.abilities[u.ref.spellAbility ?? "cha"] ?? 10) - 10) / 2);
    say(state, `${u.name} springs back to their feet in a burst of radiance (Searing Vengeance, ${u.hp} HP)`, u.id);
    runAutomation([{ type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [
      { type: "damage", amount: `2d8+${mod}`, damageType: "radiant" }, { type: "applyCondition", condition: "blinded", durationRounds: 1 },
    ] }], { state, source: u, scope: [], last: {}, depth: 0 });
    return true;
  }

  const r = state.rng.d20();
  // Defy Death (Undying, 6th): "When you succeed on a death saving throw ... you can regain hit points equal to 1d8 + your Constitution modifier (minimum of 1 hit point)"
  const dd = u.ref.specialRules.find((x) => x.rule === "defyDeath");
  if (r >= 10 && dd && dd.rule === "defyDeath" && u.alive && (u.resources.get(dd.resource) ?? 0) > 0) {
    u.resources.set(dd.resource, (u.resources.get(dd.resource) ?? 0) - 1);
    const heal = Math.max(1, state.rng.dice(1, 8) + Math.floor(((u.ref.abilities.con ?? 10) - 10) / 2));
    u.downed = false; u.stable = false; u.zeroHpRaging = false; u.deathPending = false;
    u.deathSaves = { success: 0, fail: 0 };
    u.hp = heal;
    say(state, `${u.name} defies death and rises with ${heal} HP (Defy Death)`, u.id);
    return true;
  }
  if (r === 20) { u.downed = false; u.stable = false; u.zeroHpRaging = false; u.deathPending = false; u.hp = 1; u.deathSaves = { success: 0, fail: 0 }; say(state, `${u.name} rallies (1 HP)`, u.id); return false; }
  if (r >= 10) u.deathSaves.success++;
  else u.deathSaves.fail += r === 1 ? 2 : 1;
  if (u.deathSaves.success >= 3) { u.stable = true; say(state, `${u.name} stabilises (still unconscious)`, u.id); }
  if (u.deathSaves.fail >= 3) {
    if (u.zeroHpRaging) { // Rage Beyond Death: the rage holds off the dying
      if (!u.deathPending) say(state, `${u.name} can't die until the rage ends`, u.id);
      u.deathPending = true;
    } else { u.alive = false; say(state, `${u.name} dies`, u.id); }
  }
  return false;
}

// -------------------------------------------------------------------- end check

/** Flagged summoned minions wink out the instant their summoner dies. */
function cullRevertedMinions(state: CombatState): void {
  for (const m of state.units.values()) {
    if (!m.alive || !isMinion(m)) continue;
    if (!REVERTS_ON_SUMMONER_DEATH.has(m.ref.id)) continue;
    const summoner = m.summonerId ? state.units.get(m.summonerId) : undefined;
    if (!summoner || !summoner.alive) {
      m.alive = false;
      say(state, `${m.name} collapses — its binding is broken`, m.id);
    }
  }
}

export function checkEnd(state: CombatState): void {
  cullRevertedMinions(state);
  const monstersUp = [...state.units.values()].some((u) => u.side === "monster" && u.alive);
  const partyUp = [...state.units.values()].some((u) => u.side === "party" && u.alive && !u.downed);
  if (!monstersUp) { state.ended = true; state.winner = "party"; }
  else if (!partyUp) { state.ended = true; state.winner = "monster"; }
}

function partyHpFraction(state: CombatState): number {
  let cur = 0;
  let max = 0;
  for (const u of state.units.values()) if (u.side === "party") { cur += Math.max(0, u.hp); max += u.maxHp; }
  return max ? cur / max : 0;
}

function monsterHpFraction(state: CombatState): number {
  let cur = 0;
  let max = 0;
  // the original monster(s) only — summoned minions don't count toward "boss HP left"
  for (const u of state.units.values()) if (u.side === "monster" && !isMinion(u)) { cur += Math.max(0, u.hp); max += u.maxHp; }
  return max ? cur / max : 0;
}

export function summarise(state: CombatState, keepLog = false): CombatResult {
  const survivors = [...state.units.values()].filter((u) => u.side === "party" && u.alive && !u.downed).length;
  const contributions: Contribution[] = [...state.units.values()].map((u) => ({
    id: u.id,
    name: u.name,
    side: u.side,
    dealt: Math.round(u.damageDealt),
    taken: Math.round(u.damageTaken),
    downedRound: u.downedRound,
    isMinion: isMinion(u),
  }));
  return {
    winner: state.winner ?? "draw",
    rounds: state.round,
    partyHpPct: Math.round(partyHpFraction(state) * 100) / 100,
    partySurvivors: survivors,
    monsterHpPct: Math.round(monsterHpFraction(state) * 100) / 100,
    contributions,
    firstPartyDownRound: state.firstPartyDownRound,
    firstPartyDownName: state.firstPartyDownId ? state.units.get(state.firstPartyDownId)?.name : undefined,
    log: keepLog ? state.log.map((l) => `R${l.round}: ${l.text}`) : [],
    saveLog: state.saveLog,
    attackLog: state.attackLog,
  };
}

export { livingEnemies };
