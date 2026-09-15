// What-if sweeps: run the same fight across a range of one knob and see how the
// win rate moves. This is what turns the sim from "here's the number" into a
// tuning instrument — "the boss at +100 HP: win 0.86 -> 0.58", "party +1 to hit:
// 0.46 -> 0.61".

import type { Combatant } from "../schema";
import type { RunOptions } from "./loop";
import { monteCarlo, type MonteCarloResult } from "./montecarlo";
import type { CombatTuning } from "./state";

export type SweepDimension =
  | keyof CombatTuning // monsterHpMult, monsterToHitDelta, monsterDcDelta, monsterDamageMult, partyToHitDelta, partyDamageMult
  | "level";

export interface SweepPoint {
  value: number;
  mc: MonteCarloResult;
}

export interface SweepResult {
  dimension: SweepDimension;
  points: SweepPoint[];
}

type SweepOpts = RunOptions & { trials?: number };

/** Run `monteCarlo` once per value of `dimension`. */
export function sweep(
  monsters: Combatant[],
  base: SweepOpts,
  dimension: SweepDimension,
  values: number[],
): SweepResult {
  const points = values.map((value) => {
    const opts: SweepOpts =
      dimension === "level"
        ? { ...base, level: value }
        : { ...base, tuning: { ...base.tuning, [dimension]: value } };
    return { value, mc: monteCarlo(monsters, opts) };
  });
  return { dimension, points };
}

/**
 * A one-line-per-point summary of a sweep, e.g.
 *   monsterHpMult   0.80  win 0.71  tpk 0.22  rounds 3.4
 *   monsterHpMult   1.00  win 0.46  tpk 0.51  rounds 4.1
 */
export function formatSweep(r: SweepResult): string {
  return r.points
    .map(
      (p) =>
        `${r.dimension.padEnd(16)} ${String(p.value).padStart(5)}  ` +
        `win ${p.mc.partyWinRate.toFixed(2)}  tpk ${p.mc.tpkRate.toFixed(2)}  ` +
        `rounds ${p.mc.avgRounds.toFixed(1)}  hp%onWin ${String(p.mc.avgPartyHpPctOnWin).padStart(3)}`,
    )
    .join("\n");
}

/** Multipliers/deltas centred on the no-op value — handy defaults for a sweep. */
export const SWEEP_PRESETS: Record<SweepDimension, number[]> = {
  monsterHpMult: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
  monsterDamageMult: [0.8, 0.9, 1, 1.1, 1.25],
  monsterToHitDelta: [-3, -2, -1, 0, 1, 2],
  monsterDcDelta: [-3, -2, -1, 0, 1, 2],
  partyToHitDelta: [-2, -1, 0, 1, 2, 3],
  partyDamageMult: [0.8, 0.9, 1, 1.1, 1.25],
  level: [14, 16, 18, 20],
};
