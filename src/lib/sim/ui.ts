// Browser-facing facade for the fight simulator UI. Everything here is pure TS
// (no server deps) and safe to import into a client component. The `/simulator`
// route is the only consumer.

import { MONSTER_FIXTURES } from "./fixtures";
import { MINIONS } from "./engine/minions";
import { TEMPLATE_IDS, makeTemplate, type Loadout } from "./engine/templates";
import { makeCaster } from "./spells/caster";
import { maxSlotLevel } from "./spells/slots";
import { SPELLS, spellsForClass } from "./spells/catalog";
import type { SpellClass } from "./spells/types";
import type { CasterKind } from "./spells/slots";
import { encounterBudget } from "./encounterBudget";
import {
  levelLadder,
  runScenario,
  runScenarioOnce,
  scenarioSweep,
  standardParty,
  type PartyMemberSpec,
} from "./engine/scenario";
import { runDay, dayMonteCarlo, type DayInput, type DayMonteCarlo, type DayResult, type RestKind } from "./engine/day";
import {
  parseCombatant,
  ABILITIES,
  DAMAGE_TYPES,
  SIZES,
  type Ability,
  type AutomationNode,
  type Combatant,
  type Condition,
  type DamageType,
  type Size,
} from "./schema";
import { validateCombatant } from "./validate";
import type { MonteCarloResult } from "./engine/montecarlo";
import type { CombatResult } from "./engine/loop";
import {
  runBattle,
  battleRoster,
  autoPlace,
  defaultGridSize,
  type AwaitingReaction,
  type ReactionAsk,
  type ReactionChoice,
  type RosterEntry,
  type RosterInit,
} from "./battle";
import { gridFromDef, makeGrid, tilesToString } from "./battle/grid";
import { boxOf, coneCells, feetBetweenBoxes, feetBetweenCells, hasLineOfSight, lineCells, lineTemplateCells, sphereCells } from "./battle/geometry";
import type { BattleGrid, BattleMapDef } from "./battle/grid";
import type { BattleFrame, UnitSnap } from "./battle/state";
import type { AwaitingInput, AwaitAction, AwaitUnit, BattleDecision } from "./battle/control";
import {
  applyRace,
  applyFeats,
  applyItems,
  raceKey,
  featScanText,
  itemScanText,
  RACE_OPTIONS,
  FEAT_OPTIONS,
  ITEM_OPTIONS,
  WEAPON_OPTIONS,
  applyWeapon,
  type BuildMode,
} from "./engine/pc-extras";

export type { PartyMemberSpec, MonteCarloResult, CombatResult, Loadout, Combatant, Ability, DamageType, Condition, Size, BuildMode };
export type { SpellClass };
export type { BattleFrame, UnitSnap, BattleGrid, BattleMapDef, RosterEntry, RosterInit, AwaitingInput, AwaitAction, AwaitUnit, BattleDecision };
export type { AwaitingReaction, ReactionAsk, ReactionChoice };
export { autoPlace, tilesToString };
export { standardParty, TEMPLATE_IDS, ABILITIES, DAMAGE_TYPES, SIZES };
export { applyRace, applyFeats, applyItems, applyWeapon, raceKey, RACE_OPTIONS, FEAT_OPTIONS, ITEM_OPTIONS, WEAPON_OPTIONS };

// ------------------------------------------------------------- spell picker

const CASTER_CLASS_KEYS = ["wizard", "sorcerer", "cleric", "druid", "bard", "warlock", "paladin", "ranger", "artificer"] as const;
const TEMPLATE_SPELL_CLASS: Record<string, SpellClass> = {
  // the UI's own caster templates
  "blaster-wizard": "wizard", "life-cleric": "cleric", "vengeance-paladin": "paladin",
  "hunter-ranger": "ranger", "draconic-sorcerer": "sorcerer", "moon-druid": "druid",
  "lore-bard": "bard", "warlock": "warlock",
  // an imported PC's templateId is the normalised class key ("cleric", "artificer", …)
  // — sometimes prefixed "pc-" depending on the build path
  ...Object.fromEntries(CASTER_CLASS_KEYS.flatMap((k) => [[k, k], [`pc-${k}`, k]])),
};
const REACTION_MODELLED = new Set(["shield", "counterspell", "absorb-elements", "hellish-rebuke"]);

/** the spell class of a party spec, or null if it isn't a spellcaster.
 *  Prefers `combatant.spellClass` (stamped by makeCaster), then the combatant's
 *  templateId, then the row's template id. */
export function pcSpellClass(spec: { template?: string; combatant?: Combatant }): SpellClass | null {
  const stamped = spec.combatant?.spellClass as SpellClass | undefined;
  if (stamped) return stamped;
  const id = spec.combatant?.templateId ?? spec.template;
  return id ? TEMPLATE_SPELL_CLASS[id] ?? null : null;
}

export interface SpellPick {
  id: string;
  name: string;
  level: number; // 0 = cantrip
  school: string;
  classes: string[];
  concentration: boolean;
  reaction: boolean;
  /** the sim actually resolves this spell (has a build, or a reaction hook) */
  simulated: boolean;
}

/** every SRD spell, for the per-PC picker; sorted by level then name */
export function spellCatalog(): SpellPick[] {
  return SPELLS.map((s) => ({
    id: s.id,
    name: s.name,
    level: s.level,
    school: s.school,
    classes: s.classes,
    concentration: !!s.concentration,
    reaction: s.castTime === "reaction",
    simulated: !!s.build || REACTION_MODELLED.has(s.id),
  })).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

/** spell ids on a class's list */
export function classSpellIds(cls: SpellClass): string[] {
  return spellsForClass(cls).map((s) => s.id);
}

/** map a PC note's class string to the nearest sim template */
export function classToTemplate(cls: string): string {
  const c = (cls || "").toLowerCase();
  if (/barbarian/.test(c)) return "totem-barbarian";
  if (/\bbard\b/.test(c)) return "lore-bard";
  if (/cleric/.test(c)) return "life-cleric";
  if (/druid/.test(c)) return "moon-druid";
  if (/monk/.test(c)) return "open-hand-monk";
  if (/paladin/.test(c)) return "vengeance-paladin";
  if (/ranger/.test(c)) return "hunter-ranger";
  if (/rogue/.test(c)) return "assassin-rogue";
  if (/sorcerer/.test(c)) return "draconic-sorcerer";
  if (/warlock/.test(c)) return "warlock";
  if (/wizard/.test(c)) return "blaster-wizard";
  return "gwm-fighter"; // fighter, artificer, unknown → the martial default
}

/** short "+2 wpn · +1 AC" style summary for a collapsed loadout row */
export function loadoutSummary(l: Loadout | undefined): string {
  if (!l) return "";
  const bits: string[] = [];
  if (l.weaponBonus) bits.push(`+${l.weaponBonus} wpn`);
  if (l.acItem) bits.push(`+${l.acItem} AC`);
  if (l.saveItem) bits.push(`+${l.saveItem} saves`);
  if (l.resilientCon) bits.push("Res(Con)");
  if (l.toughHp) bits.push("Tough");
  return bits.join(" · ");
}

export interface MonsterOption {
  id: string;
  name: string;
  cr: string;
  kind: "boss" | "monster" | "minion";
}

// "Boss" vs "monster" is just a picker grouping: a block with legendary actions
// is a boss (a solo encounter centrepiece), everything else is a standalone
// monster. Custom-loaded blocks follow the same rule and get a "· custom" tag.
const byCrThenName = (a: MonsterOption, b: MonsterOption): number =>
  (Number(a.cr) || 0) - (Number(b.cr) || 0) || a.name.localeCompare(b.name);

function toOption(m: Combatant, custom: boolean): MonsterOption {
  return {
    id: m.id,
    name: custom ? `${m.name} · custom` : m.name,
    cr: m.cr ?? "?",
    kind: m.legendaryActions ? "boss" : "monster",
  };
}

/**
 * Everything you can drop into the enemy list: bosses, then standalone monsters,
 * then the minion pool. `custom` is the loaded-from-JSON pack (see
 * loadCustomMonsters); its entries slot into the boss / monster groups by the
 * same legendary-actions rule.
 */
export function monsterOptions(custom: Combatant[] = []): MonsterOption[] {
  const fixtures = [
    ...MONSTER_FIXTURES.map((m) => toOption(m, false)),
    ...custom.map((m) => toOption(m, true)),
  ];
  const bosses = fixtures.filter((m) => m.kind === "boss").sort(byCrThenName);
  const monsters = fixtures.filter((m) => m.kind === "monster").sort(byCrThenName);
  const minions = Object.values(MINIONS).map((m) => ({
    id: m.id,
    name: m.name,
    cr: m.cr ?? "?",
    kind: "minion" as const,
  }));
  return [...bosses, ...monsters, ...minions];
}

const BUNDLED_CR_BY_ID: Record<string, string> = Object.fromEntries(
  monsterOptions().map((m) => [m.id, m.cr]),
);

/** id → Combatant for a loaded custom pack, for enemy resolution and `summon`. */
function customById(list: Combatant[]): Record<string, Combatant> {
  return Object.fromEntries(list.map((m) => [m.id, m]));
}

// --------------------------------------------------------- custom monster I/O

export interface CustomLoadResult {
  monsters: Combatant[];
  errors: string[];
}

/**
 * Parse a user-supplied JSON blob into `Combatant`s. Accepts a bare array, a
 * `{ monsters: [...] }` object, or the extract shape `{ monsters, minions }`.
 * Bad entries are skipped and reported, not thrown.
 */
export function loadCustomMonsters(json: unknown): CustomLoadResult {
  let raw: unknown;
  try {
    raw = typeof json === "string" ? JSON.parse(json) : json;
  } catch (e) {
    return { monsters: [], errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const asObj = raw as { monsters?: unknown; minions?: unknown };
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : [
        ...(Array.isArray(asObj?.monsters) ? asObj.monsters : []),
        ...(Array.isArray(asObj?.minions) ? asObj.minions : []),
      ];
  if (!entries.length) return { monsters: [], errors: ["no monsters found — expected an array or { monsters: [...] }"] };

  const monsters: Combatant[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    try {
      const c = parseCombatant(entries[i]);
      if (seen.has(c.id)) {
        errors.push(`entry ${i + 1} ("${c.name}"): duplicate id "${c.id}" — skipped`);
        continue;
      }
      seen.add(c.id);
      monsters.push(c);
    } catch (e) {
      const name = (entries[i] as { name?: string })?.name ?? `#${i + 1}`;
      errors.push(`entry "${name}": ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  return { monsters, errors };
}

/** Serialise a custom pack back to a JSON string for download. */
export function exportCustomMonsters(list: Combatant[]): string {
  return JSON.stringify({ monsters: list }, null, 2) + "\n";
}

export interface EnemyEntry {
  id: string;
  count: number;
}

export interface SimSetup {
  party: PartyMemberSpec[];
  enemies: EnemyEntry[];
  trials: number;
  seed: number;
  /** stat blocks loaded from a user JSON file (see loadCustomMonsters) */
  customMonsters: Combatant[];
  /** hand-built battle map (grid + terrain + starting squares) — Battle mode only */
  battleMap?: BattleMapDef;
  /** unit ids the player drives in Battle mode; empty / undefined = full auto */
  battleControl?: string[];
  /** adventuring-day mode: a sequence of encounters with rests between */
  day?: { encounters: EnemyEntry[][]; rests: RestKind[] };
  /** Battle-mode reinforcement waves */
  battleWaves?: { round: number; enemies: EnemyEntry[]; edge: "top" | "bottom" | "left" | "right" }[];
}

export type { DayResult, DayMonteCarlo, RestKind };

export interface DayRun {
  seed: number;
  mc: DayMonteCarlo;
  sample: DayResult;
}

/** Monte-Carlo a full adventuring day from the setup's `day` sequence. */
export function runDayFromSetup(setup: SimSetup, seed = setup.seed): DayRun {
  const extraById = customById(setup.customMonsters);
  const encounters = (setup.day?.encounters ?? []).map((enc) => enemyList(enc));
  const rests = setup.day?.rests ?? [];
  const input: DayInput = { party: setup.party, encounters, rests, extraById, seed };
  return {
    seed,
    mc: dayMonteCarlo(input, Math.min(400, Math.max(80, setup.trials))),
    sample: runDay(input),
  };
}

export interface SimResult {
  seed: number;
  mc: MonteCarloResult;
  sample: { result: CombatResult; log: string[] };
  budget: ReturnType<typeof encounterBudget>;
}

/** Expand `{id, count}` entries into the `["id", "id x3"]` form the engine takes. */
function enemyList(enemies: EnemyEntry[]): string[] {
  return enemies.filter((e) => e.id).map((e) => (e.count > 1 ? `${e.id} x${e.count}` : e.id));
}

const crById = (setup: SimSetup): Record<string, string> => ({
  ...BUNDLED_CR_BY_ID,
  ...Object.fromEntries(setup.customMonsters.map((m) => [m.id, m.cr ?? "0"])),
});

/** Run the whole thing: Monte-Carlo distribution + one narrated fight + XP budget. */
export function runSim(setup: SimSetup): SimResult {
  const enemies = enemyList(setup.enemies);
  const extraById = customById(setup.customMonsters);
  const mc = runScenario({ party: setup.party, enemies, trials: setup.trials, seed: setup.seed, extraById });
  const sample = runScenarioOnce({ party: setup.party, enemies, seed: setup.seed, extraById });

  const cr = crById(setup);
  const crs = setup.enemies.flatMap((e) => Array.from({ length: Math.max(1, e.count) }, () => cr[e.id] ?? "0"));
  const avgLevel = Math.round(
    setup.party.reduce((s, p) => s + p.level, 0) / Math.max(1, setup.party.length),
  );
  const budget = encounterBudget(crs, avgLevel, setup.party.length);

  return { seed: setup.seed, mc, sample, budget };
}

// ------------------------------------------------------------------- battle mode

export interface BattleRun {
  frames: BattleFrame[];
  winner: "party" | "monster" | "draw";
  rounds: number;
  seed: number;
  /** initiative order (rolled once) for the header + roster sort */
  initiative: RosterInit[];
  /** set while the fight is paused for a controlled unit's decision */
  awaiting?: AwaitingInput;
  /** set while the fight is paused asking a controlled unit about a reaction */
  awaitingReaction?: AwaitingReaction;
  /** true once the fight has actually concluded */
  done: boolean;
}

/** cell keys ("x,y") an AoE template would cover, for the Battle-mode aim preview */
export function aoePreview(
  shape: string,
  from: { x: number; y: number },
  origin: { x: number; y: number },
  sizeFt: number,
  dims: { width: number; height: number },
): string[] {
  const g = makeGrid(dims.width, dims.height, "floor");
  const set =
    shape === "cone"
      ? coneCells(g, from.x, from.y, origin.x, origin.y, sizeFt)
      : shape === "line"
        ? lineTemplateCells(g, from.x, from.y, origin.x, origin.y, sizeFt)
        : sphereCells(g, origin.x, origin.y, sizeFt);
  return [...set];
}

/** PHB 5-10-5 feet between two grid cells (single source of truth for the UI ruler) */
export function cellDistanceFt(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return feetBetweenCells(a.x, a.y, b.x, b.y);
}

/** the integer cells a straight segment from A to B passes through, endpoints included */
export function rulerLine(a: { x: number; y: number }, b: { x: number; y: number }): string[] {
  return lineCells(a.x, a.y, b.x, b.y).map(([x, y]) => `${x},${y}`);
}

/** cell keys ("x,y") at least one viewer can see right now — line of sight (walls
 *  block) and within `sightFt`. Drives the Battle-mode fog-of-war overlay. */
export function visibleCells(
  dims: { width: number; height: number; tiles: string },
  viewers: Array<{ x: number; y: number; fp: number }>,
  sightFt = 60,
): string[] {
  if (!viewers.length) return [];
  const g = gridFromDef({ width: dims.width, height: dims.height, tiles: dims.tiles, placements: {} });
  const eyes = viewers.map((v) => boxOf(v.x, v.y, Math.max(1, v.fp)));
  const out: string[] = [];
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      const cell = boxOf(x, y, 1);
      for (const e of eyes) {
        if (feetBetweenBoxes(e, cell) <= sightFt && hasLineOfSight(g, e, cell)) {
          out.push(`${x},${y}`);
          break;
        }
      }
    }
  }
  return out;
}

/** the id + glyph the fight will use for each combatant, without running it —
 *  drives the map editor's token tray. */
export function rosterForSetup(setup: SimSetup): RosterEntry[] {
  return battleRoster({ party: setup.party, enemies: enemyList(setup.enemies), extraById: customById(setup.customMonsters) });
}

/** a fresh open-room map def sized to the current crowd, everyone auto-placed */
export function starterBattleMap(setup: SimSetup): BattleMapDef {
  const roster = rosterForSetup(setup);
  const { width, height } = defaultGridSize(roster.length);
  const def: BattleMapDef = { width, height, tiles: ".".repeat(width * height), placements: {} };
  def.placements = autoPlace(def, roster);
  return def;
}

/** One grid fight rendered as a frame stream, from the same setup Analyze uses.
 *  Uses `setup.battleMap` (the editor's map) when present; `overrides` wins over both. */
export function runBattleFromSetup(
  setup: SimSetup,
  overrides: {
    grid?: BattleGrid;
    placements?: Record<string, { x: number; y: number }>;
    seed?: number;
    decisions?: BattleDecision[];
    reactionChoices?: ReactionChoice[];
    reactionAuto?: string[];
  } = {},
): BattleRun {
  const enemies = enemyList(setup.enemies);
  const extraById = customById(setup.customMonsters);
  const seed = overrides.seed ?? setup.seed;
  const grid = overrides.grid ?? (setup.battleMap ? gridFromDef(setup.battleMap) : undefined);
  const placements = overrides.placements ?? setup.battleMap?.placements;
  const waves = (setup.battleWaves ?? [])
    .filter((w) => w.enemies.length && w.round >= 1)
    .map((w) => ({ round: Math.round(w.round), enemies: enemyList(w.enemies), edge: w.edge }));
  const out = runBattle({
    party: setup.party,
    enemies,
    extraById,
    grid,
    placements,
    seed,
    waves: waves.length ? waves : undefined,
    controlled: setup.battleControl,
    decisions: overrides.decisions,
    reactionChoices: overrides.reactionChoices,
    reactionAuto: overrides.reactionAuto,
  });
  return {
    frames: out.frames,
    winner: out.result.winner,
    rounds: out.result.rounds,
    seed,
    initiative: out.initiative,
    awaiting: out.awaiting,
    awaitingReaction: out.awaitingReaction,
    done: out.done,
  };
}

export function defaultSetup(): SimSetup {
  return {
    party: standardParty(16),
    enemies: [{ id: "adult-red-dragon", count: 1 }],
    trials: 250,
    seed: 1,
    customMonsters: [],
  };
}

// -------------------------------------------------------------- what-if sweep

export type SweepDim =
  | "level"
  | "monsterHpMult"
  | "monsterDamageMult"
  | "monsterToHitDelta"
  | "monsterDcDelta"
  | "partyToHitDelta"
  | "partyDamageMult";

export interface SweepDimInfo {
  id: SweepDim;
  label: string;
  values: number[];
  fmt: (v: number) => string;
}

export const SWEEP_DIMS: SweepDimInfo[] = [
  { id: "level", label: "Party level", values: [10, 12, 14, 16, 18, 20], fmt: (v) => `L${v}` },
  { id: "monsterHpMult", label: "Monster HP", values: [0.7, 0.85, 1, 1.15, 1.3, 1.5], fmt: (v) => `${v}×` },
  { id: "monsterDamageMult", label: "Monster damage", values: [0.8, 0.9, 1, 1.1, 1.25], fmt: (v) => `${v}×` },
  { id: "monsterToHitDelta", label: "Monster to-hit", values: [-3, -2, -1, 0, 1, 2], fmt: (v) => (v >= 0 ? `+${v}` : `${v}`) },
  { id: "monsterDcDelta", label: "Monster save DC", values: [-3, -2, -1, 0, 1, 2], fmt: (v) => (v >= 0 ? `+${v}` : `${v}`) },
  { id: "partyToHitDelta", label: "Party to-hit", values: [-2, -1, 0, 1, 2, 3], fmt: (v) => (v >= 0 ? `+${v}` : `${v}`) },
  { id: "partyDamageMult", label: "Party damage", values: [0.8, 0.9, 1, 1.1, 1.25], fmt: (v) => `${v}×` },
];

export interface SweepRow {
  value: number;
  label: string;
  winRate: number;
  tpkRate: number;
  avgRounds: number;
  hpPctOnWin: number;
}

export interface SweepOut {
  dimension: SweepDim;
  baselineValue: number; // the "no-op" value (1, 0, or the party's current level)
  rows: SweepRow[];
}

/** Run one what-if sweep across `dim`'s preset values, on the shared setup. */
export function runSweep(setup: SimSetup, dim: SweepDim): SweepOut {
  const info = SWEEP_DIMS.find((d) => d.id === dim)!;
  const enemies = enemyList(setup.enemies);
  const trials = setup.trials;
  const extraById = customById(setup.customMonsters);

  if (dim === "level") {
    const rows = levelLadder(
      { party: setup.party.map((p) => ({ template: p.template, name: p.name, loadout: p.loadout, race: p.race, feats: p.feats, items: p.items })), enemies, trials, seed: setup.seed, extraById },
      info.values,
    ).map((r) => ({
      value: r.level,
      label: `L${r.level}`,
      winRate: r.mc.partyWinRate,
      tpkRate: r.mc.tpkRate,
      avgRounds: r.mc.avgRounds,
      hpPctOnWin: r.mc.avgPartyHpPctOnWin,
    }));
    const cur = Math.round(setup.party.reduce((s, p) => s + p.level, 0) / Math.max(1, setup.party.length));
    return { dimension: dim, baselineValue: cur, rows };
  }

  const swept = scenarioSweep({ party: setup.party, enemies, trials, seed: setup.seed, extraById }, dim, info.values);
  return {
    dimension: dim,
    baselineValue: dim.endsWith("Mult") ? 1 : 0,
    rows: swept.points.map((p) => ({
      value: p.value,
      label: info.fmt(p.value),
      winRate: p.mc.partyWinRate,
      tpkRate: p.mc.tpkRate,
      avgRounds: p.mc.avgRounds,
      hpPctOnWin: p.mc.avgPartyHpPctOnWin,
    })),
  };
}

// ------------------------------------------------------ "make a monster" builder
//
// A simplified stat block a form can drive, and `draftToCombatant` which
// assembles it into a real `Combatant` (multiattack + per-attack actions, an
// optional save-AoE, optional legendary actions) and runs it past
// `parseCombatant` / `validateCombatant`. The output drops into
// `SimSetup.customMonsters` exactly like a JSON-loaded block.

/** DMG "monster statistics by CR" proficiency bonus. */
export function suggestedPb(cr: string): number {
  const n = Number(String(cr).includes("/") ? 0 : cr);
  if (!Number.isFinite(n)) return 2;
  if (n <= 4) return 2;
  if (n <= 8) return 3;
  if (n <= 12) return 4;
  if (n <= 16) return 5;
  if (n <= 20) return 6;
  if (n <= 24) return 7;
  if (n <= 28) return 8;
  return 9;
}

export interface BuilderAttack {
  name: string;
  toHit: number;
  dice: string; // "2d10+8"
  type: DamageType;
  count: number; // how many of this attack per turn (multiattack)
}

export interface BuilderAoe {
  name: string;
  shape: "cone" | "line" | "sphere" | "emanation";
  size: number; // feet
  ability: Ability;
  dc: number;
  dice: string;
  type: DamageType;
  recharge: "none" | "roll:5-6" | "roll:4-6";
}

/** none = no interaction; the rest map to resistances / immunities / vulnerabilities */
export type DmgDefense = "none" | "resist" | "immune" | "vuln";

export interface BuilderDraft {
  name: string;
  cr: string;
  size: Size;
  ac: number;
  hp: string; // "18d12+108" or a flat "250"
  abilities: Record<Ability, number>;
  pb: number;
  proficientSaves: Ability[];
  damage: Record<DamageType, DmgDefense>;
  conditionImmunities: Condition[];
  attacks: BuilderAttack[];
  aoe: BuilderAoe | null;
  legendary: boolean;
  legendaryBudget: number;
  /** attack names that a legendary action may spend */
  legendaryAttacks: string[];
  ai: { targetPriority: "highestThreat" | "squishiest" | "lowestHp" | "nearest"; keepDistance: boolean; neverRetreat: boolean };
}

/** condition immunities offered in the builder (the ones that matter to the sim) */
export const BUILDER_CONDITIONS: Condition[] = [
  "blinded", "charmed", "frightened", "grappled", "paralyzed", "poisoned",
  "prone", "restrained", "stunned", "exhaustion",
];

export function emptyDraft(): BuilderDraft {
  return {
    name: "",
    cr: "10",
    size: "large",
    ac: 16,
    hp: "12d10+60",
    abilities: { str: 18, dex: 12, con: 18, int: 10, wis: 12, cha: 12 },
    pb: 4,
    proficientSaves: [],
    damage: Object.fromEntries(DAMAGE_TYPES.map((d) => [d, "none"])) as Record<DamageType, DmgDefense>,
    conditionImmunities: [],
    attacks: [{ name: "Strike", toHit: 8, dice: "2d8+4", type: "slashing", count: 2 }],
    aoe: null,
    legendary: false,
    legendaryBudget: 3,
    legendaryAttacks: [],
    ai: { targetPriority: "highestThreat", keepDistance: false, neverRetreat: false },
  };
}

const slugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "monster";

export interface BuilderResult {
  combatant?: Combatant;
  error?: string;
  warnings: string[];
}

/** Assemble a draft into a real Combatant (or return the first blocking error). */
export function draftToCombatant(draft: BuilderDraft): BuilderResult {
  const name = draft.name.trim();
  if (!name) return { error: "Give the monster a name.", warnings: [] };
  const attacks = draft.attacks.filter((a) => a.name.trim() && a.dice.trim());
  if (!attacks.length && !draft.aoe) return { error: "Add at least one attack or a breath / area effect.", warnings: [] };

  const id = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;

  // per-attack actions + a multiattack when there's more than one swing
  const usedIds = new Set<string>();
  const actionFor = (a: BuilderAttack): { actionId: string; action: Combatant["actions"][number] } => {
    let aid = slugify(a.name);
    while (usedIds.has(aid)) aid += "x";
    usedIds.add(aid);
    return {
      actionId: aid,
      action: {
        id: aid,
        name: a.name.trim(),
        cost: {},
        recharge: "none",
        automation: [
          {
            type: "target",
            who: { who: "aiChoice" },
            effects: [{ type: "attack", bonus: a.toHit, onHit: [{ type: "damage", amount: a.dice.trim(), damageType: a.type }] }],
          },
        ],
      },
    };
  };
  const built = attacks.map(actionFor);
  const totalSwings = attacks.reduce((s, a) => s + Math.max(1, a.count), 0);

  const actions: Combatant["actions"] = [];
  if (totalSwings > 1) {
    actions.push({
      id: "multiattack",
      name: "Multiattack",
      cost: { action: 1 },
      recharge: "none",
      automation: built.map((b, i) => ({ type: "useAction", action: b.actionId, times: Math.max(1, attacks[i].count) })),
    });
    actions.push(...built.map((b) => b.action));
  } else if (built.length === 1) {
    actions.push({ ...built[0].action, cost: { action: 1 } });
  }

  const resources: NonNullable<Combatant["resources"]> = {};
  if (draft.aoe && draft.aoe.dice.trim()) {
    const ao = draft.aoe;
    // a recharge action needs a paired resource or the engine can't gate it
    const limitedUse = ao.recharge !== "none" ? { resource: "area", amount: 1 } : undefined;
    if (limitedUse) resources.area = { max: 1, recharge: ao.recharge };
    actions.push({
      id: "area",
      name: ao.name.trim() || "Breath",
      cost: { action: 1 },
      recharge: ao.recharge,
      ...(limitedUse ? { limitedUse } : {}),
      automation: [
        {
          type: "target",
          who: { who: "area", shape: ao.shape, size: Math.max(5, ao.size) },
          effects: [
            {
              type: "save",
              ability: ao.ability,
              dc: ao.dc,
              onFail: [{ type: "damage", amount: ao.dice.trim(), damageType: ao.type }],
              onSuccess: [{ type: "damage", amount: ao.dice.trim(), damageType: ao.type, half: true }],
            },
          ],
        },
      ],
    });
  }

  const resistances = DAMAGE_TYPES.filter((d) => draft.damage[d] === "resist");
  const immunities = DAMAGE_TYPES.filter((d) => draft.damage[d] === "immune");
  const vulnerabilities = DAMAGE_TYPES.filter((d) => draft.damage[d] === "vuln");

  const legendaryOptionIds = built
    .filter((b, i) => draft.legendaryAttacks.includes(attacks[i].name))
    .map((b) => b.actionId);

  const raw = {
    id,
    name,
    kind: "monster" as const,
    size: draft.size,
    cr: draft.cr.trim() || "10",
    ac: draft.ac,
    maxHp: draft.hp.trim() || "1",
    abilities: draft.abilities,
    pb: draft.pb,
    proficientSaves: draft.proficientSaves,
    resistances,
    immunities,
    vulnerabilities,
    conditionImmunities: draft.conditionImmunities,
    resources,
    actions,
    ai: {
      targetPriority: draft.ai.targetPriority,
      aoeMinTargets: 2,
      opener: draft.aoe ? ["area"] : [],
      saveLegendaryResistanceFor: ["stunned", "paralyzed", "banished", "controlled"],
      keepDistance: draft.ai.keepDistance,
      neverRetreat: draft.ai.neverRetreat,
      focusFire: true,
    },
    ...(draft.legendary && legendaryOptionIds.length
      ? { legendaryActions: { budget: Math.max(1, draft.legendaryBudget), options: legendaryOptionIds.map((a) => ({ action: a, cost: 1 })) } }
      : {}),
  };

  let combatant: Combatant;
  try {
    combatant = parseCombatant(raw);
  } catch (e) {
    return { error: e instanceof Error ? e.message.split("\n")[0] : String(e), warnings: [] };
  }
  const v = validateCombatant(combatant);
  return { combatant, warnings: v.ok ? v.warnings : [...v.errors, ...v.warnings] };
}

// -------------------------------------------------- paste / import a statblock
//
// `parseStatblock` turns a pasted stat block into a `BuilderDraft` for review
// in the builder. It accepts standard stat-block **markdown** (the homebrewery
// / D&D Beyond / 5e.tools "Get as Markdown" shape, which is also what an NPC
// note's "## Stat Block" body section looks like) or **5e.tools bestiary JSON**.
// It is deliberately best-effort: it fills what it can read and returns
// `warnings` for the rest, and nothing is ever fetched from a remote — the
// caller supplies the text. Pasting content you don't have the rights to reuse
// is on you.

export interface StatblockParse {
  draft?: BuilderDraft;
  warnings: string[];
  error?: string;
}

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};
const SIZE_WORD: Record<string, Size> = {
  tiny: "tiny", small: "small", medium: "medium", large: "large", huge: "huge", gargantuan: "gargantuan",
};
const dmgSet = new Set<string>(DAMAGE_TYPES);
const condSet = new Set<string>(BUILDER_CONDITIONS);

/** first `**Label** value` on its own line */
function mdField(md: string, label: string): string | null {
  const m = new RegExp(`\\*\\*${label}\\*\\*[:\\s]*([^\\n]+)`, "i").exec(md);
  return m ? m[1].replace(/\*+/g, "").trim() : null;
}

function parseAbilityBlock(md: string): { abilities: Record<Ability, number>; saves: Ability[] } {
  const abilities: Record<Ability, number> = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  const saves: Ability[] = [];
  // inline form: **STR** 27 (+8)  — or a table row of "27 (+8) | 10 (+0) | ..."
  for (const ab of ABILITIES) {
    const inline = new RegExp(`\\b${ab}\\b[^\\d-]{0,8}(\\d{1,2})\\b`, "i").exec(md);
    if (inline) abilities[ab] = Number(inline[1]);
  }
  // a "27 (+8) | 10 (+0) | 25 (+7) | 16 (+3) | 13 (+1) | 23 (+6)" row (order STR..CHA)
  const row = /(\d{1,2})\s*\([+-]\d+\)\s*\|\s*(\d{1,2})\s*\([+-]\d+\)\s*\|\s*(\d{1,2})\s*\([+-]\d+\)\s*\|\s*(\d{1,2})\s*\([+-]\d+\)\s*\|\s*(\d{1,2})\s*\([+-]\d+\)\s*\|\s*(\d{1,2})\s*\([+-]\d+\)/.exec(md);
  if (row) ABILITIES.forEach((ab, i) => (abilities[ab] = Number(row[i + 1])));
  // **Saving Throws** Dex +6, Con +13, ...
  const st = mdField(md, "Saving Throws");
  if (st) for (const ab of ABILITIES) if (new RegExp(`\\b${ab}\\b`, "i").test(st)) saves.push(ab);
  return { abilities, saves };
}

function parseDamageLine(md: string, label: string, into: Record<DamageType, DmgDefense>, kind: DmgDefense): void {
  const line = mdField(md, label);
  if (!line) return;
  for (const t of DAMAGE_TYPES) if (new RegExp(`\\b${t}\\b`, "i").test(line)) into[t] = kind;
}

/** grab each "***Name.*** body" action block from a section of markdown */
function actionBlocks(section: string): { name: string; rawName: string; body: string }[] {
  const out: { name: string; rawName: string; body: string }[] = [];
  const re = /\*{2,3}\s*([^*.\n][^*.\n]*?)\.?\s*\*{2,3}\s*([\s\S]*?)(?=\n\s*\*{2,3}\s*[^*\n]|\n\s*#{1,6}\s|\n\s*$|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) {
    const rawName = m[1].trim();
    out.push({ name: rawName.replace(/\([^)]*\)\s*$/, "").trim(), rawName, body: m[2].trim() });
  }
  return out;
}

function attackFromBody(name: string, raw: string): BuilderAttack | null {
  const body = raw.replace(/[*_]/g, " ");
  const hit = /([+-]\d+)\s*to hit/i.exec(body) || /Attack Roll:\s*([+-]\d+)/i.exec(body);
  const dmg = /(?:Hit|Damage):\s*\d+\s*\(([0-9d +-]+?)\)\s*([a-z]+)\s*damage/i.exec(body);
  if (!hit || !dmg) return null;
  const type = dmg[2].toLowerCase();
  return {
    name: name || "Attack",
    toHit: Number(hit[1]),
    dice: dmg[1].replace(/\s+/g, ""),
    type: (dmgSet.has(type) ? type : "bludgeoning") as DamageType,
    count: 1,
  };
}

function aoeFromBody(name: string, raw: string): BuilderAoe | null {
  const body = raw.replace(/[*_]/g, " ");
  const dc = /DC\s*(\d+)\s*([A-Za-z]+)\s*(?:saving throw|save)/i.exec(body);
  const dmg = /(?:taking|takes?|Hit:)\s*\d+\s*\(([0-9d +-]+?)\)\s*([a-z]+)\s*damage/i.exec(body);
  if (!dc || !dmg) return null;
  const shapeM = /(\d+)[- ]?(?:foot|ft\.?)[- ]?(cone|line|cube|cylinder|sphere|radius|emanation)/i.exec(body);
  const abil = dc[2].slice(0, 3).toLowerCase();
  const rc = /\(recharge\s*(\d)(?:\s*[–-]\s*(\d))?\)/i.exec(name + " " + body);
  const type = dmg[2].toLowerCase();
  return {
    name: name || "Breath",
    shape: (() => {
      const s = shapeM?.[2].toLowerCase();
      if (s === "line") return "line";
      if (s === "radius" || s === "sphere" || s === "cylinder" || s === "cube" || s === "emanation") return "sphere";
      return "cone";
    })(),
    size: shapeM ? Number(shapeM[1]) : 30,
    ability: (ABILITIES as readonly string[]).includes(abil) ? (abil as Ability) : "dex",
    dc: Number(dc[1]),
    dice: dmg[1].replace(/\s+/g, ""),
    type: (dmgSet.has(type) ? type : "fire") as DamageType,
    recharge: rc ? (rc[1] === "4" ? "roll:4-6" : "roll:5-6") : "none",
  };
}

function applyMultiattack(text: string, attacks: BuilderAttack[]): void {
  // "one with its bite and two with its claws" / "makes two scimitar attacks"
  const NUM = `${Object.keys(WORD_NUM).join("|")}|\\d+`;
  const toN = (s: string): number => WORD_NUM[s.toLowerCase()] ?? Number(s);
  let matchedAny = false;
  for (const a of attacks) {
    const first = a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").split(/\s+/)[0];
    // a number, then at most 4 words, then the attack's name (allow a trailing plural s)
    const m = new RegExp(`\\b(${NUM})\\b(?:\\s+\\w+){0,4}?\\s+${first}s?\\b`, "i").exec(text);
    if (m) { a.count = toN(m[1]) || a.count; matchedAny = true; }
  }
  // "makes two (melee/weapon) attacks" with no attack named and only one attack on the block
  if (!matchedAny && attacks.length === 1) {
    const m = new RegExp(`makes?\\s+(${NUM})\\s+\\w*\\s*attacks?`, "i").exec(text);
    if (m) attacks[0].count = toN(m[1]) || attacks[0].count;
  }
}

const SECTION_WORDS = /^(actions?|legendary actions?|bonus actions?|reactions?|traits?|villain actions?|lair actions?|regional effects?)$/i;

export function parseStatblockMarkdown(md: string): StatblockParse {
  const warnings: string[] = [];
  const clean = md.replace(/\r/g, "").replace(/^>\s?/gm, ""); // strip blockquote homebrewery
  const draft = emptyDraft();

  // name: the first heading or bold-only line that isn't a section label
  const lines = clean.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    const b = /^\*{2}([^*][^\n*]{1,58})\*{2}\s*$/.exec(line);
    const cand = (h?.[1] ?? b?.[1] ?? "").replace(/\*+/g, "").trim();
    if (cand && !SECTION_WORDS.test(cand) && /[A-Za-z]/.test(cand)) { draft.name = cand; break; }
    if (h || b) continue; // a section heading with no name yet — keep scanning
    break; // first content line wasn't a heading/bold — stop looking
  }

  const sizeM = /\b(tiny|small|medium|large|huge|gargantuan)\b\s+[A-Za-z]/i.exec(clean);
  if (sizeM) draft.size = SIZE_WORD[sizeM[1].toLowerCase()];

  const ac = mdField(clean, "Armor Class") || mdField(clean, "AC");
  if (ac) { const n = /\d+/.exec(ac); if (n) draft.ac = Number(n[0]); } else warnings.push("no Armor Class found");

  const hp = mdField(clean, "Hit Points") || mdField(clean, "HP");
  if (hp) {
    const dice = /\(([0-9]+d[0-9]+(?:\s*[+-]\s*[0-9]+)?)\)/.exec(hp);
    const flat = /^\s*(\d+)/.exec(hp);
    draft.hp = dice ? dice[1].replace(/\s+/g, "") : flat ? flat[1] : draft.hp;
  } else warnings.push("no Hit Points found");

  const { abilities, saves } = parseAbilityBlock(clean);
  draft.abilities = abilities;
  draft.proficientSaves = saves;

  const crM = /\*\*(?:Challenge|CR)\*\*[:\s]*([0-9/]+)/i.exec(clean);
  if (crM) draft.cr = crM[1];
  else warnings.push("no Challenge rating found — defaulted to 10");
  const pbM = /Proficiency Bonus\s*\+(\d+)/i.exec(clean);
  draft.pb = pbM ? Number(pbM[1]) : suggestedPb(draft.cr);

  parseDamageLine(clean, "Damage Resistances", draft.damage, "resist");
  parseDamageLine(clean, "Damage Immunities", draft.damage, "immune");
  parseDamageLine(clean, "Damage Vulnerabilities", draft.damage, "vuln");
  const ci = mdField(clean, "Condition Immunities");
  if (ci) draft.conditionImmunities = BUILDER_CONDITIONS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(ci));
  void condSet;

  // actions: everything from "### Actions" (or the first action-looking line) to the next "###"
  const actionsStart = /(^|\n)#{2,4}\s*Actions?\b/i.exec(clean);
  const legendaryStart = /(^|\n)#{2,4}\s*Legendary Actions?\b/i.exec(clean);
  const actionsText = actionsStart
    ? clean.slice(actionsStart.index, legendaryStart ? legendaryStart.index : undefined)
    : clean;

  const blocks = actionBlocks(actionsText);
  const attacks: BuilderAttack[] = [];
  let multiattackText = "";
  for (const b of blocks) {
    if (/^multiattack$/i.test(b.name)) { multiattackText = b.body; continue; }
    const atk = attackFromBody(b.name, b.body);
    if (atk) { attacks.push(atk); continue; }
    if (!draft.aoe) {
      const ao = aoeFromBody(b.rawName, b.body);
      if (ao) { draft.aoe = ao; continue; }
    }
  }
  if (multiattackText && attacks.length) applyMultiattack(multiattackText, attacks);
  if (attacks.length) draft.attacks = attacks;
  else if (!draft.aoe) {
    warnings.push("couldn't read any attacks — added a generic CR-scaled strike; edit it in the builder");
    draft.attacks = [genericStrike(draft.cr)];
  }

  if (legendaryStart) {
    const legText = clean.slice(legendaryStart.index);
    const budgetM = /can take (\d+) legendary/i.exec(legText) || /(\d+)\s*legendary action/i.exec(legText);
    draft.legendary = true;
    draft.legendaryBudget = budgetM ? Math.min(5, Number(budgetM[1])) : 3;
    draft.legendaryAttacks = draft.attacks.filter((a) => new RegExp(`\\b${a.name.split(/\s+/)[0]}\\b`, "i").test(legText)).map((a) => a.name);
    if (!draft.legendaryAttacks.length && draft.attacks.length) {
      draft.legendaryAttacks = [draft.attacks[0].name];
      warnings.push("legendary actions present but their names didn't match an attack — set to spend the first attack; adjust in the builder");
    }
  }

  const gotSomething = draft.attacks.length > 0 || !!draft.aoe || draft.ac !== emptyDraft().ac;
  if (!gotSomething) return { warnings, error: "couldn't read a stat block out of that text" };
  if (!draft.name) warnings.push("no name found — set one in the builder");
  return { draft, warnings };
}

function genericStrike(cr: string): BuilderAttack {
  const n = Number(String(cr).includes("/") ? 0 : cr) || 1;
  const pb = suggestedPb(cr);
  const dieCount = Math.max(1, Math.round(1 + n / 6));
  return { name: "Strike", toHit: pb + 4, dice: `${dieCount}d10+${3 + Math.floor(n / 4)}`, type: "bludgeoning", count: n >= 5 ? 2 : 1 };
}

/** 5e.tools bestiary JSON entry → draft (their `{@hit}` / `{@damage}` / `{@dc}` tags parse cleanly) */
export function parse5eToolsBestiary(obj: unknown): StatblockParse {
  const warnings: string[] = [];
  const m = obj as Record<string, unknown>;
  if (!m || typeof m !== "object" || !("name" in m)) return { warnings, error: "not a 5e.tools bestiary entry" };
  const draft = emptyDraft();
  const strip = (s: string): string =>
    s.replace(/\{@hit\s+(\d+)\}/g, "+$1")
      .replace(/\{@dc\s+(\d+)\}/g, "DC $1")
      .replace(/\{@h\}/g, "Hit: ")
      .replace(/\{@(?:atk|hom|scaledamage|scaledice)[^}]*\}/g, "")
      .replace(/\{@(?:damage|dice|spell|creature|condition|skill|action|recharge|chance|hazard)\s+([^|}]+)(?:\|[^}]*)?\}/g, "$1")
      .replace(/\{@[a-z]+\s+([^|}]+)(?:\|[^}]*)?\}/g, "$1")
      .replace(/\{@[a-z]+\}/g, "")
      .trim();

  draft.name = String(m.name ?? "");
  const sz = Array.isArray(m.size) ? String(m.size[0]) : String(m.size ?? "");
  draft.size = ({ T: "tiny", S: "small", M: "medium", L: "large", H: "huge", G: "gargantuan" } as Record<string, Size>)[sz] ?? "medium";
  const ac = Array.isArray(m.ac) ? (m.ac[0] as { ac?: number } | number) : (m.ac as number | undefined);
  draft.ac = typeof ac === "number" ? ac : Number((ac as { ac?: number })?.ac) || draft.ac;
  const hp = m.hp as { average?: number; formula?: string } | undefined;
  draft.hp = hp?.formula?.replace(/\s+/g, "") || String(hp?.average ?? draft.hp);
  for (const ab of ABILITIES) if (m[ab] != null) draft.abilities[ab] = Number(m[ab]);
  draft.cr = typeof m.cr === "object" ? String((m.cr as { cr?: string }).cr ?? "10") : String(m.cr ?? "10");
  draft.pb = suggestedPb(draft.cr);
  if (m.save && typeof m.save === "object") draft.proficientSaves = ABILITIES.filter((ab) => ab in (m.save as object));
  const dmgInto = (arr: unknown, kind: DmgDefense): void => {
    if (!Array.isArray(arr)) return;
    for (const raw of arr) {
      const s = JSON.stringify(raw).toLowerCase();
      for (const t of DAMAGE_TYPES) if (s.includes(t)) draft.damage[t] = kind;
    }
  };
  dmgInto(m.resist, "resist");
  dmgInto(m.immune, "immune");
  dmgInto(m.vulnerable, "vuln");
  if (Array.isArray(m.conditionImmune)) {
    const s = m.conditionImmune.map((x) => String(x).toLowerCase());
    draft.conditionImmunities = BUILDER_CONDITIONS.filter((c) => s.some((x) => x.includes(c)));
  }

  const acts = (Array.isArray(m.action) ? m.action : []) as { name?: string; entries?: unknown[] }[];
  const attacks: BuilderAttack[] = [];
  let multiattackText = "";
  for (const a of acts) {
    const nm = String(a.name ?? "").replace(/\([^)]*\)\s*$/, "").trim();
    const body = strip((a.entries ?? []).map((e) => (typeof e === "string" ? e : "")).join(" "));
    if (/^multiattack$/i.test(nm)) { multiattackText = body; continue; }
    const atk = attackFromBody(nm, body);
    if (atk) { attacks.push(atk); continue; }
    if (!draft.aoe) { const ao = aoeFromBody(nm, body); if (ao) draft.aoe = ao; }
  }
  if (multiattackText && attacks.length) applyMultiattack(multiattackText, attacks);
  if (attacks.length) draft.attacks = attacks;
  else if (!draft.aoe) { draft.attacks = [genericStrike(draft.cr)]; warnings.push("no attacks parsed — added a generic strike"); }

  const legN = Number((m.legendaryActions as number) ?? (Array.isArray(m.legendary) ? 3 : 0));
  if (legN > 0 && Array.isArray(m.legendary)) {
    draft.legendary = true;
    draft.legendaryBudget = Math.min(5, legN);
    const legText = JSON.stringify(m.legendary).toLowerCase();
    draft.legendaryAttacks = draft.attacks.filter((a) => legText.includes(a.name.toLowerCase().split(/\s+/)[0])).map((a) => a.name);
  }
  if (!draft.name) return { warnings, error: "entry has no name" };
  return { draft, warnings };
}

/** sniff JSON vs markdown and dispatch */
export function parseStatblock(text: string): StatblockParse {
  const t = text.trim();
  if (!t) return { warnings: [], error: "nothing to parse" };
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const obj = JSON.parse(t);
      const entry = Array.isArray(obj) ? obj[0] : (obj as { monster?: unknown[] }).monster?.[0] ?? obj;
      return parse5eToolsBestiary(entry);
    } catch (e) {
      return { warnings: [], error: `looks like JSON but didn't parse: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return parseStatblockMarkdown(t);
}

// ------------------------------------------------- turn an NPC note into a block

/**
 * Pull the "## Stat Block" (or Statblock / Stat-block) section out of a note
 * body. The section runs until the next heading of the same or higher level
 * (so its own `### Actions` / `### Legendary Actions` sub-headings stay in).
 */
export function extractStatblockSection(body: string): string | null {
  const head = /(^|\n)(#{1,6})\s*stat[\s-]?block\b[^\n]*\n/i.exec(body);
  if (!head) return null;
  const level = head[2].length;
  const rest = body.slice(head.index + head[0].length);
  const nextHead = new RegExp(`\\n#{1,${level}}\\s`).exec(rest);
  const section = (nextHead ? rest.slice(0, nextHead.index) : rest).trim();
  return section.length > 40 ? section : null;
}

export interface NpcNoteInput {
  title: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
}

/**
 * Build a custom monster from an NPC note: parse its "## Stat Block" body if it
 * has one, otherwise fall back to the note's frontmatter (ac / hp / stats / cr)
 * plus a generic CR-scaled attack so it can still fight.
 */
export function npcNoteToMonster(note: NpcNoteInput): { combatant?: Combatant; warnings: string[]; error?: string } {
  const fm = note.frontmatter ?? {};
  const section = note.body ? extractStatblockSection(note.body) : null;

  if (section) {
    const p = parseStatblockMarkdown(section);
    if (p.draft) {
      p.draft.name = note.title || p.draft.name;
      const r = draftToCombatant(p.draft);
      if (r.combatant) return { combatant: r.combatant, warnings: [...p.warnings, ...r.warnings] };
      return { warnings: p.warnings, error: r.error };
    }
  }

  // frontmatter-only fallback
  const draft = emptyDraft();
  draft.name = note.title || String(fm.name ?? "NPC");
  if (fm.ac != null) draft.ac = Number(fm.ac) || draft.ac;
  const hp = fm.maxHp ?? fm.hp;
  if (hp != null) draft.hp = String(hp);
  const stats = fm.stats as Partial<Record<Ability, unknown>> | undefined;
  if (stats) for (const ab of ABILITIES) if (stats[ab] != null) draft.abilities[ab] = Number(stats[ab]) || 10;
  if (fm.cr != null && String(fm.cr).trim()) draft.cr = String(fm.cr).trim();
  draft.pb = suggestedPb(draft.cr);
  draft.attacks = [genericStrike(draft.cr)];
  const r = draftToCombatant(draft);
  if (r.combatant) {
    return {
      combatant: r.combatant,
      warnings: [
        section ? "stat-block section didn't parse" : "no \"## Stat Block\" section in the note — used its frontmatter plus a generic CR-scaled attack",
        ...r.warnings,
      ],
    };
  }
  return { warnings: [], error: r.error ?? "couldn't build a monster from this note" };
}

// -------------------------------------------- turn a PC note into a combatant
//
// The party "import from PC notes" flow used to map a class string to the
// nearest of ~12 hand-authored templates and pass only the level. This builds
// the actual character instead: real ability scores / AC / HP / level from the
// note, class mechanics (saves, Extra Attack, spell slots, sneak dice, rage,
// ...) from 5e rules, and a best-effort scan of the linked class-reference
// note's "## Level N" sections for feature markers. Unknown class -> the old
// template path, but with the note's real stats layered on.

type ClassKey =
  | "fighter" | "barbarian" | "rogue" | "monk" | "ranger" | "paladin"
  | "wizard" | "sorcerer" | "cleric" | "druid" | "bard" | "warlock" | "artificer";

const CLASS_PATTERNS: [RegExp, ClassKey][] = [
  [/barbarian/i, "barbarian"], [/\bbard\b/i, "bard"], [/cleric/i, "cleric"],
  [/druid/i, "druid"], [/\bmonk\b/i, "monk"], [/paladin/i, "paladin"],
  [/ranger/i, "ranger"], [/rogue|assassin|thief/i, "rogue"], [/sorcerer/i, "sorcerer"],
  [/warlock/i, "warlock"], [/wizard|mage/i, "wizard"], [/artificer/i, "artificer"],
  [/fighter|knight|warrior|champion/i, "fighter"],
];

function normalizeClass(s: string): ClassKey | null {
  for (const [re, k] of CLASS_PATTERNS) if (re.test(s)) return k;
  return null;
}

const CLASS_SAVES: Record<ClassKey, Ability[]> = {
  fighter: ["str", "con"], barbarian: ["str", "con"], rogue: ["dex", "int"],
  monk: ["str", "dex"], ranger: ["str", "dex"], paladin: ["wis", "cha"],
  wizard: ["int", "wis"], sorcerer: ["con", "cha"], cleric: ["wis", "cha"],
  druid: ["int", "wis"], bard: ["dex", "cha"], warlock: ["wis", "cha"], artificer: ["con", "int"],
};

const CASTER_OF: Partial<Record<ClassKey, { kind: CasterKind; cls: SpellClass; ability: Ability }>> = {
  wizard: { kind: "full", cls: "wizard", ability: "int" },
  sorcerer: { kind: "full", cls: "sorcerer", ability: "cha" },
  cleric: { kind: "full", cls: "cleric", ability: "wis" },
  druid: { kind: "full", cls: "druid", ability: "wis" },
  bard: { kind: "full", cls: "bard", ability: "cha" },
  warlock: { kind: "warlock", cls: "warlock", ability: "cha" },
  paladin: { kind: "half", cls: "paladin", ability: "cha" },
  ranger: { kind: "half", cls: "ranger", ability: "wis" },
  artificer: { kind: "half", cls: "artificer", ability: "int" },
};

const mod = (score: number): number => Math.floor((score - 10) / 2);
const pbForLevel = (lvl: number): number => 2 + Math.floor((Math.max(1, Math.min(20, lvl)) - 1) / 4);

/** Extra Attack progression by class (weapon swings per Attack action). */
function attackCount(cls: ClassKey, level: number): number {
  if (cls === "fighter") return level >= 20 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
  if (["barbarian", "paladin", "ranger", "monk"].includes(cls)) return level >= 5 ? 2 : 1;
  return 1;
}

export interface ClassRefFeatures {
  extraAttack?: number;
  sneakDice?: number;
  maxSpellLevel?: number;
  rage?: boolean;
  actionSurge?: number;
  ki?: boolean;
  superiority?: boolean;
  divineSmite?: boolean;
  /** a bonus-action follow-up attack (Two-Weapon Fighting, Psychic Blades, …) */
  bonusAttack?: boolean;
  uncannyDodge?: boolean;
  evasion?: boolean;
  /** saving-throw proficiencies the subclass grants ("Slippery Mind" → wis) */
  extraSaves?: Ability[];
  /** Channel Divinity — a short-rest resource plus, when recognised, an effect */
  channelDivinity?: boolean;
  /** Channel Divinity burst (Light's Radiance of the Dawn): area save-for-half */
  cdBurst?: { dice: string; ability: Ability; type: DamageType; plusLevel?: boolean };
  /** Channel Divinity heal pool (Life's Preserve Life) — total HP, split among allies */
  cdHeal?: boolean;
  /** a persistent summoned ally (Beastmaster Primal Companion, Battle Smith Steel Defender, …) */
  companion?: boolean;
  /** a ranged/fragile summoned ally (Wildfire spirit, Eldritch Cannon, Homunculus Servant, …) */
  spiritSummon?: boolean;
  /** the spirit summon costs a Wild Shape use */
  spiritViaWildShape?: boolean;
  /** Battle Smith "Battle Ready" — use INT for weapon attack + damage */
  intWeapon?: boolean;
  /** Artificer infusions in play — a flat +1 (→ +2 at 10th) to weapon & AC */
  infusionBonus?: 1 | 2;
  found: string[];
}

/** Scan a class-reference note's "## Level ≤ N" sections for feature markers. */
export function parseClassRefFeatures(body: string, level: number): ClassRefFeatures {
  // sections: "## Level N <feature name>" up to the next such heading. The
  // feature name usually lives ONLY in the heading, so keep that part.
  const heads = [...body.matchAll(/^#{1,3}\s*Level\s*(\d+)\b([^\n]*)$/gim)];
  let text = "";
  for (let i = 0; i < heads.length; i++) {
    if (Number(heads[i][1]) > level) continue;
    const start = heads[i].index! + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : body.length;
    text += " " + (heads[i][2] ?? "") + " " + body.slice(start, end);
  }
  if (!heads.length) text = body; // no level headings — treat the whole note as "applies"

  const f: ClassRefFeatures = { found: [] };
  const WN: Record<string, number> = { once: 1, twice: 2, thrice: 3, one: 1, two: 2, three: 3, four: 4 };

  // Extra Attack — take the largest count phrased anywhere in the in-scope text
  let ea = 0;
  for (const m of text.matchAll(/\battack\s+(once|twice|thrice|two|three|four|\d)\s*times?\b/gi)) {
    ea = Math.max(ea, WN[m[1].toLowerCase()] ?? Number(m[1]) ?? 0);
  }
  for (const m of text.matchAll(/\b(?:make|makes)\s+(one|two|three|four|\d)\s+(?:weapon |melee |ranged )?attacks?\b/gi)) {
    ea = Math.max(ea, WN[m[1].toLowerCase()] ?? Number(m[1]) ?? 0);
  }
  for (const m of text.matchAll(/\bextra attack\s*\((\d)\)/gi)) ea = Math.max(ea, Number(m[1]) + 1);
  if (!ea && /\bextra attack\b/i.test(text)) ea = 2;
  if (ea >= 2) { f.extraAttack = ea; f.found.push(`Extra Attack (${ea})`); }
  // Sneak Attack — the ref usually quotes the level-1 "1d6" and points at the
  // table for the rest, so only treat an explicit number as authoritative when
  // it's above the by-level baseline (a homebrew buff).
  const sa = /sneak attack[^.]*?(\d+)\s*d6|(\d+)\s*d6[^.]*?sneak/i.exec(text);
  if (sa) {
    const n = Number(sa[1] ?? sa[2]);
    if (n > Math.ceil(level / 2)) { f.sneakDice = n; f.found.push(`Sneak Attack (${n}d6)`); }
  }
  if (/\bspellcasting\b|\bspell slots?\b|\bcast (?:a )?spells?\b|\bpact magic\b/i.test(text)) {
    const lv = /(\d)(?:st|nd|rd|th)[- ]?level spells?/i.exec(text);
    if (lv) { f.maxSpellLevel = Number(lv[1]); f.found.push(`Spellcasting (to ${f.maxSpellLevel}${["", "st", "nd", "rd"][f.maxSpellLevel] ?? "th"} level)`); }
    else f.found.push("Spellcasting");
  }
  if (/\brage\b/i.test(text)) { f.rage = true; f.found.push("Rage"); }
  if (/action surge/i.test(text)) {
    f.actionSurge = /action surge[^.]{0,40}(twice|two uses|2 uses)/i.test(text) ? 2 : 1;
    f.found.push("Action Surge");
  }
  if (/\bki\b|ki points?|martial arts|flurry of blows/i.test(text)) { f.ki = true; f.found.push("Ki / Martial Arts"); }
  if (/superiority dic|combat superiority|maneuvers?/i.test(text)) { f.superiority = true; f.found.push("Superiority Dice"); }
  if (/divine smite/i.test(text)) { f.divineSmite = true; f.found.push("Divine Smite"); }
  // a bonus-action extra swing BY the PC — Two-Weapon Fighting, Psychic Blades,
  // Thirsting Blade, … Reject "bonus action to command <the companion>" phrasing.
  const baHit = /(?:second|another|additional|off-hand)\s+(?:psychic\s+|shadow\s+)?(?:blade|weapon|attack)|\battack\b[^.]{0,40}\bas a bonus action\b|\bas a bonus action\b[^.]{0,40}\b(?:make|another|attack)\b|two-weapon fighting/i.exec(text);
  if (baHit && !/command|companion|defender|\bit\b to (?:take|make)|cannon|spirit|homunculus/i.test(text.slice(Math.max(0, baHit.index - 40), baHit.index + 80))) {
    f.bonusAttack = true; f.found.push("bonus-action attack");
  }
  if (/uncanny dodge/i.test(text)) { f.uncannyDodge = true; f.found.push("Uncanny Dodge"); }
  if (/\bevasion\b/i.test(text)) { f.evasion = true; f.found.push("Evasion"); }
  const saves: Ability[] = [];
  for (const m of text.matchAll(/proficiency in (\w+)(?:\s+and\s+(\w+))? saving throws?/gi)) {
    for (const g of [m[1], m[2]]) {
      const a = (g ?? "").slice(0, 3).toLowerCase();
      if ((ABILITIES as readonly string[]).includes(a) && !saves.includes(a as Ability)) saves.push(a as Ability);
    }
  }
  if (saves.length) { f.extraSaves = saves; f.found.push(`save prof: ${saves.join(", ")}`); }

  // Channel Divinity + its recognised effects
  if (/channel divinity/i.test(text)) {
    f.channelDivinity = true;
    // Radiance-of-the-Dawn shape: "radiant damage equal to 2d10 + your ... level"
    const rad = /radiant damage equal to (\d+d\d+)\s*\+\s*your(?:[^.]*?)level/i.exec(text);
    if (rad) f.cdBurst = { dice: rad[1], ability: "con", type: "radiant", plusLevel: true };
    else {
      // a generic "each hostile creature ... saving throw ... NdM <type> damage" CD
      const burst = /each (?:hostile )?creature[^.]*?\b(str|dex|con|int|wis|cha)[a-z]*\s+saving throw[^.]*?(\d+d\d+)[^.]*?\b(acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder)\b/i.exec(text);
      if (burst) f.cdBurst = { dice: burst[2], ability: burst[1].slice(0, 3).toLowerCase() as Ability, type: burst[3].toLowerCase() as DamageType };
    }
    if (/preserve life|hit points equal to (?:five times|5\s*[×x*]\s*)(?:your )?(?:cleric )?level/i.test(text)) f.cdHeal = true;
    f.found.push(`Channel Divinity${f.cdBurst ? " (burst)" : f.cdHeal ? " (Preserve Life)" : ""}`);
  }

  // a persistent summoned ally
  if (/primal companion|animal companion|\bbeast companion\b|primal beast|ranger'?s companion|\byour companion\b|exceptional training|steel defender/i.test(text)) {
    f.companion = true; f.found.push("summoned companion");
  }
  // a ranged / fragile summoned ally
  if (/wildfire spirit|eldritch cannon|homunculus servant|summon (?:your |the )?(?:primal |wildfire |fey )?spirit|bond of the summoned spirit/i.test(text)) {
    f.spiritSummon = true; f.found.push("summoned spirit");
    if (/wild shape/i.test(text)) f.spiritViaWildShape = true;
  }
  // Artificer: Battle Ready (INT for weapon attacks)
  if (/battle ready|use your intelligence modifier for (?:the )?attack/i.test(text)) { f.intWeapon = true; f.found.push("INT weapon attacks"); }
  // Artificer: infusions (Enhanced Weapon / Defense) — a flat +1, +2 at 10th
  if (/infuse (?:an? )?item|infuse items|enhanced (?:weapon|defense)|\+1 bonus to (?:attack|ac)|artificer infusions/i.test(text)) {
    f.infusionBonus = /\+2\b|bonus increases to \+2|to \+2/i.test(text) ? 2 : 1;
    f.found.push(`infusions (+${f.infusionBonus})`);
  }
  return f;
}

export interface PcNoteInput {
  title: string;
  frontmatter?: Record<string, unknown>;
  /** the PC note's own body — scanned for a "## Feats" / "## Equipment" section */
  body?: string;
  /** body of the linked class-reference note (frontmatter.classRef), if resolved */
  classRefBody?: string;
}

export interface PcBuildResult {
  spec?: { name: string; level: number; combatant: Combatant };
  warnings: string[];
  error?: string;
}

function readPc(fm: Record<string, unknown>): {
  cls: string; level: number; ac: number; hp: number; abilities: Combatant["abilities"];
} {
  const stats = (fm.stats ?? {}) as Partial<Record<Ability, unknown>>;
  const abilities = {
    str: Number(stats.str) || 10, dex: Number(stats.dex) || 10, con: Number(stats.con) || 10,
    int: Number(stats.int) || 10, wis: Number(stats.wis) || 10, cha: Number(stats.cha) || 10,
  };
  return {
    cls: String(fm.class ?? ""),
    level: Math.max(1, Math.min(20, Math.round(Number(fm.level) || 1))),
    ac: Math.max(1, Math.round(Number(fm.ac) || 0)) || 10 + mod(abilities.dex),
    hp: Math.max(1, Math.round(Number(fm.maxHp ?? fm.hp) || 0)) || 8 * (Math.round(Number(fm.level) || 1)),
    abilities,
  };
}

/** A rules-based martial PC (fighter / barbarian / rogue / monk / a weapon ranger). */
function martialPc(
  cls: ClassKey, name: string, level: number, abilities: Combatant["abilities"], ac: number, hp: number,
  cf: ClassRefFeatures,
): Combatant {
  const pb = pbForLevel(level);
  const strMod = mod(abilities.str);
  const dexMod = mod(abilities.dex);
  const usesDex = dexMod > strMod || cls === "rogue" || cls === "monk";
  const atkMod = cf.intWeapon ? mod(abilities.int) : usesDex ? dexMod : strMod;
  const toHit = pb + atkMod;
  const swings = Math.max(cf.extraAttack ?? 0, attackCount(cls, level));
  const monkDie = level >= 17 ? 10 : level >= 11 ? 8 : level >= 5 ? 6 : 4;
  const baseDie = cls === "monk" ? `1d${monkDie}` : usesDex ? "1d8" : "2d6";
  const perHit = `${baseDie}+${atkMod}`;

  const dmgType: DamageType = cls === "monk" ? "bludgeoning" : usesDex ? "piercing" : "slashing";
  const mkOnHit = (): AutomationNode[] => {
    const nodes: AutomationNode[] = [{ type: "damage", amount: perHit, damageType: dmgType }];
    if (cls === "rogue") nodes.push({ type: "damage", amount: `${Math.max(cf.sneakDice ?? 0, Math.ceil(level / 2))}d6`, damageType: dmgType });
    return nodes;
  };

  const resources: NonNullable<Combatant["resources"]> = {};
  const actions: Combatant["actions"] = [];
  const reactions: Combatant["actions"] = [];
  const opener: string[] = [];

  const nSwings = (cls === "monk" ? swings + 1 : swings) + (cf.bonusAttack ? 1 : 0);
  const attackEffects: AutomationNode[] = Array.from({ length: nSwings }, (): AutomationNode => ({
    type: "attack", bonus: toHit,
    ...(cls === "barbarian" ? { adv: "adv" as const } : {}),
    onHit: mkOnHit(),
  }));
  // monk: fold a Stunning Strike attempt into the first swing
  if (cls === "monk" || cf.ki) {
    const dc = 8 + pb + mod(abilities.wis);
    const first = attackEffects[0];
    if (first.type === "attack") {
      first.onHit.push({
        type: "branch", if: "self.resource('ki') > 0",
        then: [
          { type: "spendResource", resource: "ki", amount: 1 },
          { type: "save", ability: "con", dc, onFail: [{ type: "applyCondition", condition: "stunned", durationRounds: 1, saveEnds: { ability: "con", dc, at: "endOfTurn" } }] },
        ],
      });
    }
  }
  actions.push({
    id: "attack", name: "Attack", cost: { action: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: cls === "rogue" ? "squishiestEnemy" : "aiChoice" }, effects: attackEffects }],
  });

  if (cls === "fighter" && (cf.actionSurge ?? 1) >= 1) {
    resources.action_surge = { max: (cf.actionSurge ?? 1) + (level >= 17 ? 1 : 0), recharge: "shortRest" };
    actions.push({
      id: "action-surge", name: "Action Surge", cost: { bonus: 1 }, recharge: "none",
      limitedUse: { resource: "action_surge", amount: 1 },
      automation: [{ type: "useAction", action: "attack", times: 1 }],
    });
    opener.push("action-surge");
  }
  const specialRules: Combatant["specialRules"] = [];
  const traits: Combatant["traits"] = [];
  if (cls === "barbarian" || cf.rage) {
    resources.rage = { max: level >= 17 ? 6 : level >= 12 ? 5 : level >= 6 ? 4 : 3, recharge: "longRest" };
    actions.push({
      id: "rage", name: "Rage", cost: { bonus: 1 }, recharge: "none",
      limitedUse: { resource: "rage", amount: 1 },
      automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "rage", durationRounds: 10, mods: { damageTakenMultiplier: 0.75 } }] }],
    });
    opener.unshift("rage");
  }
  if (cls === "monk" || cf.ki) resources.ki = { max: Math.max(2, level), recharge: "shortRest" };
  if (cf.superiority) {
    resources.superiority = { max: 4 + (level >= 15 ? 1 : 0), recharge: "shortRest" };
    reactions.push({
      id: "riposte", name: "Riposte", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasMissedByMeleeAttack", limitedUse: { resource: "superiority", amount: 1 },
      automation: [{ type: "useAction", action: "attack", times: 1 }],
    });
  }
  if (cf.uncannyDodge) {
    reactions.push({
      id: "uncanny-dodge", name: "Uncanny Dodge", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasHitByAttack",
      automation: [{ type: "note", text: "halves the triggering attack's damage (engine hook)" }],
    });
  }
  if (cf.evasion) traits.push({ id: "evasion", name: "Evasion", trigger: "always", automation: [], text: "no damage on a made Dex save, half on a fail (engine hook)" });

  const saves: Ability[] = [...CLASS_SAVES[cls]];
  for (const s of cf.extraSaves ?? []) if (!saves.includes(s)) saves.push(s);
  const proficientSaves = cls === "monk" && level >= 14 ? [...ABILITIES] : saves;

  return {
    id: `pc-${cls}`, name, kind: "pc", size: "medium", level, templateId: cls,
    ac, maxHp: hp, speeds: { walk: cls === "monk" ? 40 : 30 },
    abilities, pb, proficientSaves, saveBonusAll: 0,
    resistances: [], resistancesNonmagical: cls === "barbarian" || cf.rage ? ["bludgeoning", "piercing", "slashing"] : [],
    immunities: [], vulnerabilities: [], conditionImmunities: [],
    specialRules, resources, traits, actions, reactions,
    ai: { targetPriority: cls === "rogue" ? "squishiest" : "lowestHp", aoeMinTargets: 2, opener, saveLegendaryResistanceFor: [], keepDistance: cls === "ranger" && usesDex, neverRetreat: true, focusFire: true },
  };
}

/**
 * Bolt on subclass features the class-ref scan recognised that need real
 * actions / resources / summons: Channel Divinity, a summoned companion, a
 * Wild-Shape-fuelled spirit. Called on the built combatant regardless of which
 * class path made it.
 */
function addSubclassFeatures(c: Combatant, key: ClassKey, level: number, cf: ClassRefFeatures): Combatant {
  const pb = pbForLevel(level);
  const castAb: Ability = CASTER_OF[key]?.ability ?? "wis";
  const dc = 8 + pb + mod(c.abilities[castAb]);
  const resources: NonNullable<Combatant["resources"]> = { ...c.resources };
  const actions: Combatant["actions"] = [...c.actions];
  const opener = [...c.ai.opener];

  if (cf.channelDivinity) {
    resources.channel_divinity = { max: level >= 18 ? 3 : level >= 6 ? 2 : 1, recharge: "shortRest" };
    if (cf.cdBurst) {
      const amt = cf.cdBurst.plusLevel ? `${cf.cdBurst.dice}+${level}` : cf.cdBurst.dice;
      actions.push({
        id: "channel-divinity-burst", name: "Channel Divinity: Radiant Burst",
        cost: { action: 1 }, recharge: "none", limitedUse: { resource: "channel_divinity", amount: 1 },
        automation: [{
          type: "target", who: { who: "area", shape: "emanation", size: 30 },
          effects: [{
            type: "save", ability: cf.cdBurst.ability, dc,
            onFail: [{ type: "damage", amount: amt, damageType: cf.cdBurst.type }],
            onSuccess: [{ type: "damage", amount: amt, damageType: cf.cdBurst.type, half: true }],
          }],
        }],
      });
      opener.push("channel-divinity-burst");
    } else if (cf.cdHeal) {
      actions.push({
        id: "channel-divinity-heal", name: "Channel Divinity: Preserve Life",
        cost: { action: 1 }, recharge: "none", limitedUse: { resource: "channel_divinity", amount: 1 },
        automation: [{ type: "target", who: { who: "lowestHpAlly" }, effects: [{ type: "heal", amount: String(5 * level) }] }],
      });
    }
  }

  if (cf.companion) {
    actions.push({
      id: "call-companion", name: "Call Primal Companion",
      cost: { bonus: 1 }, recharge: "none",
      automation: [{ type: "summon", statBlock: "primal-companion", count: "1", max: 1 }],
      text: "summons a bonded beast (generic stand-in stats)",
    });
    opener.unshift("call-companion");
  }
  if (cf.spiritSummon) {
    const viaWS = cf.spiritViaWildShape;
    if (viaWS && !resources.wild_shape) resources.wild_shape = { max: 2, recharge: "shortRest" };
    actions.push({
      id: "summon-spirit", name: viaWS ? "Summon Spirit" : "Deploy Construct",
      cost: { bonus: 1 }, recharge: "none",
      ...(viaWS ? { limitedUse: { resource: "wild_shape", amount: 1 } } : {}),
      automation: [{ type: "summon", statBlock: "primal-spirit", count: "1", max: 1 }],
      text: viaWS ? "expends a Wild Shape use to call a spirit ally" : "fields a construct / turret (generic stand-in stats)",
    });
    opener.unshift("summon-spirit");
  }

  return { ...c, resources, actions, ai: { ...c.ai, opener } };
}

/** Apply an artificer infusion bonus: +N to the weapon `attack` action's to-hit
 *  and its first damage die, and +N AC. Spells and saves are untouched. */
function withInfusions(c: Combatant, n: 1 | 2): Combatant {
  const actions = c.actions.map((a) => {
    if (a.id !== "attack") return a;
    return {
      ...a,
      automation: a.automation.map((node) => {
        if (node.type !== "target") return node;
        return {
          ...node,
          effects: node.effects.map((e) => {
            if (e.type !== "attack") return e;
            const [first, ...rest] = e.onHit;
            const bumpedFirst =
              first && first.type === "damage" && /^\s*\d+d\d+([+-]\d+)?\s*$/.test(first.amount)
                ? { ...first, amount: first.amount.replace(/^\s*(\d+d\d+)([+-]\d+)?\s*$/, (_m, dice, mod) => `${dice}+${(mod ? Number(mod) : 0) + n}`) }
                : first;
            return { ...e, bonus: typeof e.bonus === "number" ? e.bonus + n : e.bonus, onHit: bumpedFirst ? [bumpedFirst, ...rest] : e.onHit };
          }),
        };
      }),
    };
  });
  return { ...c, ac: c.ac + n, actions };
}

/** Layer racial traits, feats, and magic items from the note onto a built PC. */
function applyPcExtras(c: Combatant, note: PcNoteInput, fm: Record<string, unknown>, level: number): { c: Combatant; warnings: string[] } {
  const body = note.body ?? "";
  const warnings: string[] = [];
  let out = c;

  const race = applyRace(out, String(fm.race ?? ""), level);
  out = race.c;
  for (const n of race.notes) warnings.push(`race: ${n}`);

  const feats = applyFeats(out, featScanText(body, (fm as { feats?: unknown }).feats), level, "note");
  out = feats.c;
  for (const n of feats.notes) warnings.push(`feat: ${n}`);

  const itemsFm = (fm as { items?: unknown; magicItems?: unknown; equipment?: unknown });
  const items = applyItems(out, itemScanText(body, itemsFm.items ?? itemsFm.magicItems ?? itemsFm.equipment), "note");
  out = items.c;
  for (const n of items.notes) warnings.push(`item: ${n}`);

  return { c: out, warnings };
}

/** Build a Combatant that reflects this specific PC, not the nearest template. */
export function pcNoteToCombatant(note: PcNoteInput): PcBuildResult {
  const fm = note.frontmatter ?? {};
  if ((fm.type ?? "pc") !== "pc") return { warnings: [], error: "not a PC note" };
  const { cls, level, ac, hp, abilities } = readPc(fm);
  const key = normalizeClass(cls || note.title);
  const warnings: string[] = [];
  const cf = note.classRefBody
    ? parseClassRefFeatures(note.classRefBody, level)
    : { found: [] as string[] };
  if (note.classRefBody && cf.found.length) warnings.push(`class reference: ${cf.found.join(", ")}`);
  else if (note.classRefBody) warnings.push("class reference read — nothing in it changes the fight math, so this is a plain base-class build");

  if (!key) {
    // fall back to the nearest template, but overlay the note's real numbers
    const tmpl = makeTemplate(classToTemplate(cls), level, note.title);
    const overlaid: Combatant = { ...tmpl, name: note.title, level, ac, maxHp: hp, abilities, pb: pbForLevel(level) };
    warnings.push(`unrecognised class "${cls || "(none)"}" — used the ${tmpl.templateId} template with this PC's stats`);
    const ex = applyPcExtras(overlaid, note, fm, level);
    return { spec: { name: note.title, level, combatant: parseCombatant(ex.c) }, warnings: [...warnings, ...ex.warnings] };
  }

  const caster = CASTER_OF[key];
  const isPrimaryCaster = caster && ["wizard", "sorcerer", "cleric", "druid", "bard", "warlock"].includes(key);
  const FOCUS: Partial<Record<ClassKey, "blaster" | "controller" | "support" | "balanced">> = {
    wizard: "blaster", sorcerer: "blaster", warlock: "blaster",
    cleric: "support", druid: "support", bard: "controller",
  };
  let combatant: Combatant;

  if (isPrimaryCaster && caster) {
    combatant = makeCaster({
      id: `pc-${key}`, name: note.title, level,
      spellClass: caster.cls, casterKind: caster.kind, spellAbility: caster.ability,
      ac, hp, abilities, proficientSaves: CLASS_SAVES[key], focus: FOCUS[key] ?? "balanced",
    });
    combatant = { ...combatant, templateId: key };
    if (cf.maxSpellLevel && caster.kind !== "warlock") {
      const have = maxSlotLevel(caster.kind, level);
      if (cf.maxSpellLevel < have) warnings.push(`class reference caps spells at ${cf.maxSpellLevel}th level (rules give ${have}) — kept the rules value`);
    }
  } else if (key === "paladin" || key === "ranger" || key === "artificer") {
    // half-caster with a weapon: makeCaster for the spells + a martial attack action
    const martial = martialPc(key, note.title, level, abilities, ac, hp, cf);
    const c = makeCaster({
      id: `pc-${key}`, name: note.title, level,
      spellClass: caster!.cls, casterKind: caster!.kind, spellAbility: caster!.ability,
      ac, hp, abilities, proficientSaves: CLASS_SAVES[key], focus: "balanced",
      extraActions: martial.actions, extraReactions: martial.reactions,
    });
    combatant = { ...c, templateId: key, resources: { ...c.resources, ...martial.resources } };
    if (key === "paladin" && (cf.divineSmite ?? true)) {
      // Divine Smite: fold ~2d8 radiant into the weapon's first hit
      const atk = combatant.actions.find((a) => a.id === "attack");
      const eff = atk?.automation[0];
      if (eff && eff.type === "target" && eff.effects[0]?.type === "attack") {
        eff.effects[0].onHit.push({ type: "damage", amount: `${Math.min(5, 2 + Math.floor(level / 6))}d8`, damageType: "radiant" });
      }
    }
  } else {
    combatant = martialPc(key, note.title, level, abilities, ac, hp, cf);
  }

  combatant = addSubclassFeatures(combatant, key, level, cf);
  if (cf.infusionBonus) combatant = withInfusions(combatant, cf.infusionBonus);
  if (key === "artificer") warnings.push("artificer is a rounds-up half caster — slot counts are exact only from ~level 3 up");

  const ex = applyPcExtras(combatant, note, fm, level);
  combatant = ex.c;
  warnings.push(...ex.warnings);

  const v = validateCombatant(combatant);
  if (!v.ok) return { warnings, error: v.errors[0] };
  return { spec: { name: note.title, level, combatant: parseCombatant(combatant) }, warnings: [...warnings, ...v.warnings] };
}
