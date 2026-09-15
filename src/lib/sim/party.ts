// A parametric "generic party of N adventurers at level L", used by the Phase 1
// calculator as the thing a monster is measured against. These are deliberately
// rough, middle-of-the-road numbers — a competent but not hyper-optimised party
// with one healer. Swap in a real party (built from templates / the vault) later.

import type { Ability } from "./schema";
import { hitChance } from "./math";

export interface PartyProfile {
  label: string;
  level: number;
  size: number;

  // offense
  attackBonus: number; // party-average to-hit
  /** total party damage per round vs a target of the given AC (sustained, not nova) */
  dprVsAC: (ac: number) => number;
  saveSpellsPerRound: number; // save-or-lose control attempts (forcecage/banish/feeblemind/hold)
  saveSpellDC: number;

  // defense
  totalHp: number;
  healingPerRound: number;
  /** party-average saving-throw bonus for each ability */
  saveBonus: Record<Ability, number>;

  // geometry (abstract)
  aoeCatch: number; // avg PCs caught by a ~40-ft-radius / cone AoE
  meleeCount: number; // PCs within reach of the monster's melee / auras
}

// per-PC white-room sustained DPR and HP by level (interpolated between anchors).
// The DPR figure is then cut by two haircuts below: DISRUPTION (a solo boss's
// control suite eats party actions) and EXECUTION (missed turns, dropped
// concentration, movement). Net level-20 x4 lands around ~120-135/round.
const DPR_BY_LEVEL: Record<number, number> = { 1: 7, 5: 15, 8: 24, 11: 36, 14: 46, 17: 55, 20: 63 };
const HP_BY_LEVEL: Record<number, number> = { 1: 11, 5: 38, 8: 60, 11: 84, 14: 108, 17: 130, 20: 156 };

/** a solo boss's frightful presence / stuns / control cost the party ~this fraction of its output */
export const SOLO_BOSS_DISRUPTION = 0.62;
/** missed turns, movement, dropped concentration, sub-optimal focus */
export const EXECUTION_EFFICIENCY = 0.9;

function interp(table: Record<number, number>, level: number): number {
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (level <= keys[0]) return table[keys[0]];
  if (level >= keys[keys.length - 1]) return table[keys[keys.length - 1]];
  let lo = keys[0];
  let hi = keys[keys.length - 1];
  for (const k of keys) {
    if (k <= level) lo = k;
    if (k >= level) { hi = k; break; }
  }
  if (lo === hi) return table[lo];
  const t = (level - lo) / (hi - lo);
  return table[lo] + t * (table[hi] - table[lo]);
}

function partyPb(level: number): number {
  return Math.floor((level - 1) / 4) + 2;
}

export function genericParty(level: number, size = 4): PartyProfile {
  const pb = partyPb(level);
  const perPcDpr = interp(DPR_BY_LEVEL, level);
  const perPcHp = interp(HP_BY_LEVEL, level);
  const attackBonus = pb + 4; // ~+5 stat, most attackers near their cap
  // the per-PC DPR anchors assume ~65% hit vs an on-tier AC; rescale by real hit chance
  const baselineHit = 0.65;

  const saveBonus: Record<Ability, number> = {
    // "good" saves for the martials, "good" for the casters — party average lands mid
    str: pb + 1,
    dex: pb + 2,
    con: pb + 3,
    int: pb - 1,
    wis: pb + 2,
    cha: pb + 1,
  };

  const saveSpellsPerRound = level >= 17 ? 1.5 : level >= 11 ? 1 : level >= 6 ? 0.5 : 0.15;

  return {
    label: `${size} PCs at level ${level}`,
    level,
    size,
    attackBonus,
    dprVsAC: (ac: number) => {
      const factor = hitChance(attackBonus, ac) / baselineHit;
      return perPcDpr * size * factor * SOLO_BOSS_DISRUPTION * EXECUTION_EFFICIENCY;
    },
    saveSpellsPerRound,
    saveSpellDC: 8 + pb + 5,
    totalHp: Math.round(perPcHp * size),
    healingPerRound: Math.round(level * 1.6), // one dedicated-ish healer
    saveBonus,
    aoeCatch: Math.min(size, 2.5),
    meleeCount: Math.max(1, Math.round(size / 2)),
  };
}
