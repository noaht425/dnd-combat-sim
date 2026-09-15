// Run a fight many times over different seeds and aggregate. This is the payoff
// of the whole engine: a real win-rate distribution instead of a point estimate,
// plus a damage-attribution read (who carried the fight, who drops first).

import type { Combatant } from "../schema";
import { runCombat, summarise, type RunOptions } from "./loop";

export interface ActorDamage {
  name: string;
  avgDealt: number;
  pctOfSide: number; // share of that side's total output
}

export interface MonteCarloResult {
  trials: number;
  vsParty: string;
  partyWinRate: number;
  tpkRate: number; // party wiped (0 survivors)
  avgRounds: number;
  roundsP10: number;
  roundsP50: number;
  roundsP90: number;
  avgPartyHpPctOnWin: number; // how bruised the party is when it wins
  avgSurvivorsOnWin: number;
  /** party output, biggest contributor first */
  partyDamage: ActorDamage[];
  /** monster + minion output, biggest first */
  monsterDamage: ActorDamage[];
  /** median round the first PC drops (null if the party usually takes no casualties) */
  firstDownRoundP50: number | null;
  /** fraction of fights where a PC dropped at all */
  anyDownRate: number;
  /** the PC most often first to fall, and how often (0-1) */
  firstToFall?: { name: string; rate: number };
}

export function monteCarlo(monsters: Combatant[], opts: RunOptions & { trials?: number } = {}): MonteCarloResult {
  const trials = opts.trials ?? 500;
  const level = opts.level ?? 20;
  const size = opts.party ? opts.party.length : opts.partySize ?? 4;
  const partyLabel = opts.party
    ? `${size} PCs (${[...new Set(opts.party.map((p) => p.templateId ?? "pc"))].join(", ")})`
    : `${size} PCs at level ${level}`;

  let wins = 0;
  let tpks = 0;
  const rounds: number[] = [];
  let hpSum = 0;
  let survSum = 0;

  const dealtBy = new Map<string, { side: "party" | "monster"; total: number }>();
  const firstDownRounds: number[] = [];
  const firstFall = new Map<string, number>();
  let anyDown = 0;

  for (let i = 0; i < trials; i++) {
    const state = runCombat(monsters, { ...opts, seed: (opts.seed ?? 1) * 100003 + i });
    const r = summarise(state);
    rounds.push(r.rounds);
    if (r.winner === "party") {
      wins++;
      hpSum += r.partyHpPct;
      survSum += r.partySurvivors;
    }
    if (r.partySurvivors === 0) tpks++;

    for (const c of r.contributions) {
      if (c.dealt <= 0) continue;
      // collapse a swarm of identical minions ("Zombie 3" -> "Zombie")
      const key = c.isMinion ? c.name.replace(/\s*#?\d+$/, "").trim() || c.name : c.name;
      const e = dealtBy.get(key) ?? { side: c.side, total: 0 };
      e.total += c.dealt;
      dealtBy.set(key, e);
    }
    if (r.firstPartyDownRound !== undefined) {
      anyDown++;
      firstDownRounds.push(r.firstPartyDownRound);
      if (r.firstPartyDownName) firstFall.set(r.firstPartyDownName, (firstFall.get(r.firstPartyDownName) ?? 0) + 1);
    }
  }

  rounds.sort((a, b) => a - b);
  const pct = (xs: number[], q: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] : null);

  const sideDamage = (side: "party" | "monster"): ActorDamage[] => {
    const rows = [...dealtBy.entries()].filter(([, v]) => v.side === side);
    const sideTotal = rows.reduce((s, [, v]) => s + v.total, 0) || 1;
    return rows
      .map(([name, v]) => ({
        name,
        avgDealt: Math.round(v.total / trials),
        pctOfSide: Math.round((v.total / sideTotal) * 100) / 100,
      }))
      .sort((a, b) => b.avgDealt - a.avgDealt);
  };

  firstDownRounds.sort((a, b) => a - b);
  const topFall = [...firstFall.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    trials,
    vsParty: partyLabel,
    partyWinRate: Math.round((wins / trials) * 100) / 100,
    tpkRate: Math.round((tpks / trials) * 100) / 100,
    avgRounds: Math.round((rounds.reduce((s, x) => s + x, 0) / trials) * 10) / 10,
    roundsP10: pct(rounds, 0.1) ?? 0,
    roundsP50: pct(rounds, 0.5) ?? 0,
    roundsP90: pct(rounds, 0.9) ?? 0,
    avgPartyHpPctOnWin: wins ? Math.round((hpSum / wins) * 100) : 0,
    avgSurvivorsOnWin: wins ? Math.round((survSum / wins) * 10) / 10 : 0,
    partyDamage: sideDamage("party"),
    monsterDamage: sideDamage("monster"),
    firstDownRoundP50: pct(firstDownRounds, 0.5),
    anyDownRate: Math.round((anyDown / trials) * 100) / 100,
    firstToFall: topFall ? { name: topFall[0], rate: Math.round((topFall[1] / trials) * 100) / 100 } : undefined,
  };
}
