// Shared expected-value primitives for the Phase 1 attrition calculator.
// No dice are rolled here — everything is an average / probability. (Variance and
// a real turn loop come in Phase 2/3.)

import type { Ability, Combatant, DamageType } from "./schema";

// ---------------------------------------------------------------- dice averages

const DICE_RE = /^\s*-?\d*d\d+([+-]\d+)?(\s*[+-]\s*\d+d\d+)*\s*$|^\s*-?\d+\s*$/i;

/** Average of a dice string ("3d10+8", "22d6", "2d6+2d8", "10"). null if unparseable. */
export function avgDice(s: string): number | null {
  if (!DICE_RE.test(s)) return null;
  const cleaned = s.replace(/\s+/g, "");
  if (/^-?\d+$/.test(cleaned)) return Number(cleaned);
  let total = 0;
  for (const t of cleaned.match(/[+-]?(\d*d\d+|\d+)/gi) ?? []) {
    const sign = t.startsWith("-") ? -1 : 1;
    const body = t.replace(/^[+-]/, "");
    const dm = body.match(/^(\d*)d(\d+)$/i);
    if (dm) total += sign * (dm[1] ? Number(dm[1]) : 1) * ((Number(dm[2]) + 1) / 2);
    else total += sign * Number(body);
  }
  return total;
}

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

// ------------------------------------------------------------- to-hit / to-save

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** P(a single d20+bonus hits AC). Nat 1 always misses, nat 20 always hits. */
export function hitChance(attackBonus: number, ac: number, adv: "adv" | "dis" | "flat" = "flat"): number {
  const p = clamp((21 - (ac - attackBonus)) / 20, 0.05, 0.95);
  if (adv === "adv") return 1 - (1 - p) ** 2;
  if (adv === "dis") return p ** 2;
  return p;
}

/** P(a creature with `saveBonus` FAILS a DC save). `adv` here is the *saver's* advantage. */
export function saveFailChance(dc: number, saveBonus: number, adv: "adv" | "dis" | "flat" = "flat"): number {
  const p = clamp((dc - saveBonus - 1) / 20, 0.05, 0.95); // P(roll <= dc - bonus - 1)
  if (adv === "adv") return p ** 2;       // both rolls must fail
  if (adv === "dis") return 1 - (1 - p) ** 2;
  return p;
}

// --------------------------------------------------------------- combatant math

export function saveModifier(c: Combatant, ability: Ability): number {
  const base = abilityMod(c.abilities[ability]);
  const prof = c.proficientSaves.includes(ability) ? c.pb : 0;
  return base + prof + c.saveBonusAll;
}

/** Does this combatant get advantage on saves of `ability` (Magic Resistance vs magic, Unbroken Will, etc.)? */
export function saveAdvantage(c: Combatant, ability: Ability, source: "magic" | "mundane"): "adv" | "flat" {
  for (const r of c.specialRules) {
    if (r.rule === "magicResistance" && source === "magic") return "adv";
    if (r.rule === "advantageOnSaves" && r.abilities.includes(ability)) return "adv";
  }
  return "flat";
}

export function legendaryResistancePerDay(c: Combatant): number {
  const r = c.specialRules.find((x) => x.rule === "legendaryResistance");
  return r && r.rule === "legendaryResistance" ? r.perDay : 0;
}

export function flatDamageReduction(c: Combatant): number {
  const r = c.specialRules.find((x) => x.rule === "flatDamageReduction");
  return r && r.rule === "flatDamageReduction" ? r.amount : 0;
}

export function undyingReturnHp(c: Combatant): number {
  const r = c.specialRules.find((x) => x.rule === "undyingReturn");
  return r && r.rule === "undyingReturn" ? r.returnHp : 0;
}

export function hasRule(c: Combatant, rule: string): boolean {
  return c.specialRules.some((r) => r.rule === rule);
}

// --------------------------------------------------------------- damage profile

export interface IncomingDamageMix {
  /** fraction of party damage that is weapon b/p/s (mitigated by nonmagical resistance only if nonmagical) */
  weaponBps: number;
  /** fraction that is a damage type the monster might resist/immune (fire, necrotic, ...) */
  typed: number;
  /** the single most common "typed" element the party leans on */
  typedElement: DamageType;
  /** fraction of the party's attack rolls that come with advantage (faerie fire, prone, pack tactics, ...) */
  advantageShare: number;
  /** magical weapons? (true for any level ~5+ party) — defeats "nonmagical" resistance */
  magicalWeapons: boolean;
}

export const DEFAULT_MIX: IncomingDamageMix = {
  weaponBps: 0.55,
  typed: 0.45,
  typedElement: "force",
  advantageShare: 0.35,
  magicalWeapons: true,
};

/**
 * Multiplier applied to the party's raw damage output to get what actually lands
 * on this monster, from resistances / immunities / vulnerabilities / the special
 * "resist attacks made without advantage" rule. Flat reduction is handled
 * separately (it's per-hit, not a multiplier).
 */
export function damageThroughput(c: Combatant, mix: IncomingDamageMix = DEFAULT_MIX): number {
  const resistsBps =
    c.resistances.some((t) => t === "bludgeoning" || t === "piercing" || t === "slashing") ||
    (!mix.magicalWeapons && c.resistancesNonmagical.length > 0);
  const immuneTyped = c.immunities.includes(mix.typedElement);
  const resistsTyped = c.resistances.includes(mix.typedElement);
  const vulnTyped = c.vulnerabilities.includes(mix.typedElement);

  let weaponFactor = 1;
  if (resistsBps) weaponFactor *= 0.5;
  if (hasRule(c, "resistNonAdvantageAttacks")) {
    // the portion of attacks without advantage is halved
    weaponFactor *= mix.advantageShare + (1 - mix.advantageShare) * 0.5;
  }

  let typedFactor = 1;
  if (immuneTyped) typedFactor = 0;
  else if (resistsTyped) typedFactor = 0.5;
  else if (vulnTyped) typedFactor = 2;

  return mix.weaponBps * weaponFactor + mix.typed * typedFactor;
}
