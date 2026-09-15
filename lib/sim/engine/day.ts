// Adventuring-day mode: run a sequence of encounters with resources / HP / death
// saves carried forward, applying a short or long rest between them. Single-fight
// win rates over-value nova; a day sim shows where the party actually runs dry.

import type { Combatant } from "../schema";
import { abilityMod } from "../math";
import { runCombat, summarise } from "./loop";
import { buildParty, resolveEnemies, type PartyMemberSpec } from "./scenario";
import { initCombatant, type CombatantState } from "./state";

export type RestKind = "none" | "short" | "long";

export interface DayInput {
  party: PartyMemberSpec[];
  /** each entry is an enemy list ("id" / "id x3" strings) */
  encounters: string[][];
  /** the rest taken AFTER encounter i (only indices 0 .. n-2 matter) */
  rests: RestKind[];
  seed?: number;
  extraById?: Record<string, Combatant>;
  maxRounds?: number;
}

export interface DayEncounterResult {
  fought: boolean; // false once the day has already ended
  winner: "party" | "monster" | "draw";
  rounds: number;
  /** party HP as a fraction of its max, right after this fight */
  partyHpPctAfter: number;
  survivors: number;
  rest: RestKind;
}

export interface DayResult {
  survivedDay: boolean; // won every encounter that was fought, and fought them all
  encountersCleared: number;
  encounters: DayEncounterResult[];
  /** rough "gas left in the tank" — current / max over every limited resource */
  resourcesLeftPct: number;
}

const HIT_DIE: Record<string, number> = {
  "totem-barbarian": 12, barbarian: 12,
  "gwm-fighter": 10, fighter: 10, "vengeance-paladin": 10, paladin: 10, "hunter-ranger": 10, ranger: 10, artificer: 8,
  "blaster-wizard": 6, wizard: 6, "draconic-sorcerer": 6, sorcerer: 6,
};
const hitDieOf = (c: Combatant): number => HIT_DIE[c.templateId ?? ""] ?? 8;

function partyHpFraction(states: CombatantState[]): number {
  let cur = 0;
  let max = 0;
  for (const s of states) {
    cur += Math.max(0, s.hp);
    max += s.maxHp;
  }
  return max ? cur / max : 0;
}

function resourcesLeftFraction(states: CombatantState[]): number {
  let cur = 0;
  let max = 0;
  for (const s of states) {
    for (const [name, r] of Object.entries(s.ref.resources ?? {})) {
      if (r.max === "unbounded") continue;
      const m = r.max as number;
      if (m <= 0) continue;
      max += m;
      cur += Math.min(m, s.resources.get(name) ?? 0);
    }
  }
  return max ? cur / max : 1;
}

/** apply a rest to the carried-forward party states */
function applyRest(states: CombatantState[], kind: RestKind, hitDice: Map<string, number>, level: number): void {
  for (const s of states) {
    if (kind === "long") {
      s.hp = s.maxHp;
      s.alive = true;
      s.downed = false;
      s.stable = false;
      s.deathSaves = { success: 0, fail: 0 };
      s.tempHp = 0;
      for (const [name, r] of Object.entries(s.ref.resources ?? {})) {
        s.resources.set(name, r.max === "unbounded" ? 999 : (r.start ?? (r.max as number)));
      }
      hitDice.set(s.id, level);
      continue;
    }

    if (kind === "none") {
      if (s.downed && s.alive) s.stable = true; // a party stabilises its fallen between fights
      continue;
    }

    // short rest
    for (const [name, r] of Object.entries(s.ref.resources ?? {})) {
      if (r.recharge === "shortRest" && r.max !== "unbounded") s.resources.set(name, r.max as number);
    }
    if (!s.alive) continue;
    const conMod = abilityMod(s.ref.abilities.con);
    const perDie = hitDieOf(s.ref) / 2 + 0.5 + conMod;
    if (s.downed) {
      // first aid + a spell: back on your feet at ~30% (costs a couple of dice)
      s.downed = false;
      s.stable = false;
      s.deathSaves = { success: 0, fail: 0 };
      s.hp = Math.max(1, Math.round(s.maxHp * 0.3));
      hitDice.set(s.id, Math.max(0, (hitDice.get(s.id) ?? level) - 2));
      continue;
    }
    const want = Math.ceil(level / 2);
    const have = hitDice.get(s.id) ?? level;
    const spend = Math.min(want, have, Math.ceil((s.maxHp - s.hp) / Math.max(1, perDie)));
    if (spend > 0) {
      s.hp = Math.min(s.maxHp, s.hp + Math.round(spend * perDie));
      hitDice.set(s.id, have - spend);
    }
  }
}

const alivePartyLeft = (states: CombatantState[]): boolean => states.some((s) => s.alive && !s.downed);

export function runDay(input: DayInput): DayResult {
  const pcs = buildParty(input.party);
  const states = pcs.map((pc) => initCombatant(pc, "party"));
  const level = Math.round(input.party.reduce((s, p) => s + p.level, 0) / Math.max(1, input.party.length));
  const hitDice = new Map<string, number>(states.map((s) => [s.id, level]));
  const seed = input.seed ?? 1;

  const out: DayEncounterResult[] = [];
  let cleared = 0;

  for (let i = 0; i < input.encounters.length; i++) {
    const rest = input.rests[i] ?? "none";
    if (!alivePartyLeft(states)) {
      out.push({ fought: false, winner: "monster", rounds: 0, partyHpPctAfter: 0, survivors: 0, rest });
      continue;
    }
    const monsters = resolveEnemies(input.encounters[i], input.extraById);
    const state = runCombat(monsters, {
      seed: seed * 100003 + i * 977,
      level,
      maxRounds: input.maxRounds,
      partyStates: states,
      summonRegistry: input.extraById,
    });
    const r = summarise(state);
    const survivors = states.filter((s) => s.alive && !s.downed).length;
    out.push({
      fought: true,
      winner: r.winner,
      rounds: r.rounds,
      partyHpPctAfter: partyHpFraction(states),
      survivors,
      rest,
    });
    if (r.winner === "party") cleared++;
    else break; // the party lost — the day is over

    if (i < input.encounters.length - 1) applyRest(states, rest, hitDice, level);
  }

  const foughtAll = out.filter((e) => e.fought).length === input.encounters.length;
  const wonAll = out.every((e) => !e.fought || e.winner === "party");
  return {
    survivedDay: foughtAll && wonAll,
    encountersCleared: cleared,
    encounters: out,
    resourcesLeftPct: resourcesLeftFraction(states),
  };
}

export interface DayMonteCarlo {
  trials: number;
  dayWinRate: number; // survived every encounter
  encountersClearedAvg: number;
  perEncounter: { winRate: number; hpPctAfterAvg: number; foughtRate: number; roundsAvg: number }[];
  /** the encounter (1-indexed) the party most often fails to clear; null if they usually finish */
  wallEncounter: number | null;
  resourcesLeftPctAvg: number;
}

export function dayMonteCarlo(input: DayInput, trials = 200): DayMonteCarlo {
  const n = input.encounters.length;
  const per = Array.from({ length: n }, () => ({ wins: 0, hp: 0, fought: 0, rounds: 0 }));
  let dayWins = 0;
  let clearedSum = 0;
  let resLeft = 0;

  for (let t = 0; t < trials; t++) {
    const day = runDay({ ...input, seed: (input.seed ?? 1) * 7919 + t });
    if (day.survivedDay) dayWins++;
    clearedSum += day.encountersCleared;
    resLeft += day.resourcesLeftPct;
    day.encounters.forEach((e, i) => {
      if (!e.fought) return;
      per[i].fought++;
      per[i].rounds += e.rounds;
      if (e.winner === "party") per[i].wins++;
      per[i].hp += e.partyHpPctAfter;
    });
  }

  const perEncounter = per.map((p) => ({
    winRate: p.fought ? p.wins / p.fought : 0,
    hpPctAfterAvg: p.fought ? p.hp / p.fought : 0,
    foughtRate: p.fought / trials,
    roundsAvg: p.fought ? p.rounds / p.fought : 0,
  }));
  // the first encounter with a materially sub-1 clear rate
  let wall: number | null = null;
  for (let i = 0; i < n; i++) {
    if (perEncounter[i].foughtRate > 0.05 && perEncounter[i].winRate < 0.9) {
      wall = i + 1;
      break;
    }
  }

  return {
    trials,
    dayWinRate: dayWins / trials,
    encountersClearedAvg: clearedSum / trials,
    perEncounter,
    wallEncounter: wall,
    resourcesLeftPctAvg: resLeft / trials,
  };
}
