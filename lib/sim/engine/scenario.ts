// Build a real party from a list of template specs, and run a scenario
// ("test PCs a, b, c, d at level 15 vs a boss; now bump b and c a level").

import type { Combatant } from "../schema";
import { FIXTURES_BY_ID } from "../fixtures";
import { MINIONS } from "./minions";
import { applyLoadout, makeTemplate, type Loadout } from "./templates";
import { applyRace, applyFeats, applyItems, applyWeapon } from "./pc-extras";
import { applyPickedSpells } from "../spells/pick";
import { runCombat, summarise, type CombatResult, type RunOptions } from "./loop";
import { monteCarlo, type MonteCarloResult } from "./montecarlo";
import { sweep, type SweepDimension, type SweepResult } from "./sweep";

export interface PartyMemberSpec {
  template: string; // a TEMPLATE_ID
  name?: string;
  level: number;
  loadout?: Loadout; // feats / magic items (numeric knobs)
  /** a fully-built PC (e.g. imported from a PC note) — used as-is; `template` is ignored */
  combatant?: Combatant;
  /** picker overlays applied on top of `combatant`/`template` in "picker" mode */
  race?: string;
  feats?: string[];
  items?: string[];
  /** explicit spell ids (cantrips + leveled + reaction spells); replaces the auto list */
  spells?: string[];
  /** a specific weapon name (from WEAPON_OPTIONS) — rebuilds the base attack routine */
  weapon?: string;
}

const isPaladin = (p: Combatant): boolean => p.templateId === "vengeance-paladin" || p.templateId === "paladin";

/** Turn specs into schema-valid combatants, with unique ids and the paladin aura shared. */
export function buildParty(specs: PartyMemberSpec[]): Combatant[] {
  const party = specs.map((s, i) => {
    let c = s.combatant
      ? { ...s.combatant, name: s.name ?? s.combatant.name, id: `pc-${i + 1}-${s.combatant.templateId ?? "pc"}` }
      : { ...makeTemplate(s.template, s.level, s.name), id: `pc-${i + 1}-${s.template}` };
    if (s.loadout) c = { ...applyLoadout(c, s.loadout), id: c.id, name: c.name };
    // per-PC picker overlays: race traits, feats, magic items
    if (s.race) c = applyRace(c, s.race, s.level).c;
    if (s.weapon) c = applyWeapon(c, s.weapon, s.level).c;
    if (s.spells?.length) c = applyPickedSpells(c, s.spells, s.level).c;
    if (s.feats?.length) c = applyFeats(c, s.feats.join("\n"), s.level, "picker").c;
    if (s.items?.length) c = applyItems(c, s.items.join("\n"), "picker").c;
    return c;
  });

  // Aura of Protection: a paladin extends its +CHA save bonus to every ally.
  const auraBonus = Math.max(0, ...party.map((p) => (isPaladin(p) ? p.saveBonusAll : 0)));
  if (auraBonus > 0) {
    for (const p of party) {
      if (!isPaladin(p)) p.saveBonusAll = Math.max(p.saveBonusAll, auraBonus);
    }
  }
  return party;
}

export interface ScenarioInput {
  party: PartyMemberSpec[];
  /** monster fixture id(s) */
  enemies: string[];
  trials?: number;
  seed?: number;
  maxRounds?: number;
  /** extra stat blocks (custom-loaded packs) resolvable as enemy ids and by `summon` nodes */
  extraById?: Record<string, Combatant>;
}

/**
 * Resolve an enemy list into combatants. Each entry is a fixture id or a minion
 * id, optionally with a count: "chain-devil x3", "wolf x4". Repeats get
 * unique ids / names so the engine and the log can tell them apart.
 */
export function resolveEnemies(ids: string[], extraById?: Record<string, Combatant>): Combatant[] {
  const parsed = ids.map((raw) => {
    const m = /^(.+?)\s*[x*]\s*(\d+)$/.exec(raw.trim());
    return { id: (m ? m[1] : raw).trim(), count: m ? Math.max(1, Number(m[2])) : 1 };
  });
  // how many of each id in total (across every entry) — decides whether to suffix
  const totals = new Map<string, number>();
  for (const p of parsed) totals.set(p.id, (totals.get(p.id) ?? 0) + p.count);

  const out: Combatant[] = [];
  const seen = new Map<string, number>();
  for (const { id, count } of parsed) {
    const base = extraById?.[id] ?? FIXTURES_BY_ID[id] ?? MINIONS[id];
    if (!base) throw new Error(`unknown monster "${id}"`);
    const suffix = (totals.get(id) ?? 1) > 1;
    for (let i = 0; i < count; i++) {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      out.push(suffix ? { ...base, id: `${base.id}-${n}`, name: `${base.name} ${n}` } : base);
    }
  }
  return out;
}

/** One narrated fight. */
export function runScenarioOnce(s: ScenarioInput): { result: CombatResult; log: string[] } {
  const party = buildParty(s.party);
  const state = runCombat(resolveEnemies(s.enemies, s.extraById), {
    seed: s.seed ?? 1, maxRounds: s.maxRounds, party, keepLog: true, summonRegistry: s.extraById,
  });
  const r = summarise(state, true);
  return { result: r, log: r.log };
}

/** The full distribution. */
export function runScenario(s: ScenarioInput): MonteCarloResult {
  const party = buildParty(s.party);
  const opts: RunOptions & { trials?: number } = {
    seed: s.seed ?? 1, trials: s.trials ?? 400, maxRounds: s.maxRounds, party, summonRegistry: s.extraById,
  };
  return monteCarlo(resolveEnemies(s.enemies, s.extraById), opts);
}

/** Convenience: same 4 templates at one level. */
export function standardParty(level: number): PartyMemberSpec[] {
  return [
    { template: "vengeance-paladin", name: "Ada", level },
    { template: "gwm-fighter", name: "Bront", level },
    { template: "blaster-wizard", name: "Cyra", level },
    { template: "life-cleric", name: "Dax", level },
  ];
}

// ------------------------------------------------------------- what-if sweeps

/** Run a knob sweep for a templated-party scenario. */
export function scenarioSweep(
  s: ScenarioInput,
  dimension: SweepDimension,
  values: number[],
): SweepResult {
  const party = buildParty(s.party);
  return sweep(resolveEnemies(s.enemies, s.extraById), { seed: s.seed ?? 1, trials: s.trials ?? 300, party, summonRegistry: s.extraById }, dimension, values);
}

export interface LadderRow {
  level: number;
  mc: MonteCarloResult;
}

/** The same party composition at each of `levels`, vs the same enemies. */
export function levelLadder(
  base: Omit<ScenarioInput, "party"> & { party: Omit<PartyMemberSpec, "level">[] },
  levels: number[],
): LadderRow[] {
  return levels.map((level) => {
    const party = base.party.map((p) => ({ ...p, level }));
    return { level, mc: runScenario({ ...base, party }) };
  });
}

export interface RosterRow {
  enemy: string;
  mc: MonteCarloResult;
}

/** One party vs each monster in `monsterIds` — a difficulty table. */
export function rosterCheck(party: PartyMemberSpec[], monsterIds: string[], trials = 300): RosterRow[] {
  return monsterIds.map((enemy) => ({
    enemy,
    mc: runScenario({ party, enemies: [enemy], trials }),
  }));
}

/** Plain-text read of one narrated fight: outcome + who carried it + who fell first. */
export function damageReport(r: CombatResult): string {
  const party = r.contributions.filter((c) => c.side === "party").sort((a, b) => b.dealt - a.dealt);
  // group the monster side by display name so a swarm of identical minions collapses to one line
  const byName = new Map<string, { dealt: number; minion: boolean; n: number }>();
  for (const c of r.contributions) {
    if (c.side !== "monster") continue;
    const key = c.name.replace(/\s*#?\d+$/, "").trim() || c.name;
    const e = byName.get(key) ?? { dealt: 0, minion: c.isMinion, n: 0 };
    e.dealt += c.dealt;
    e.n += 1;
    byName.set(key, e);
  }
  const monster = [...byName.entries()].sort((a, b) => b[1].dealt - a[1].dealt);
  const partyTotal = party.reduce((s, c) => s + c.dealt, 0) || 1;

  const lines: string[] = [];
  lines.push(`${r.winner.toUpperCase()} in ${r.rounds} rounds — party at ${Math.round(r.partyHpPct * 100)}% HP, ${r.partySurvivors} standing`);
  if (r.firstPartyDownRound !== undefined) lines.push(`first casualty: ${r.firstPartyDownName} (round ${r.firstPartyDownRound})`);
  lines.push("party output:");
  for (const c of party) lines.push(`  ${c.name.padEnd(16)} ${String(c.dealt).padStart(5)}  (${Math.round((c.dealt / partyTotal) * 100)}%)${c.downedRound ? `  — down R${c.downedRound}` : ""}`);
  lines.push("enemy output:");
  for (const [name, e] of monster) {
    if (e.dealt === 0 && e.minion) continue; // skip minions that never landed a hit
    lines.push(`  ${`${name}${e.n > 1 ? ` ×${e.n}` : ""}`.padEnd(16)} ${String(e.dealt).padStart(5)}${e.minion ? "  (minions)" : ""}`);
  }
  return lines.join("\n");
}
