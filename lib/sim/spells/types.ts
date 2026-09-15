// The spell model. A `Spell` is metadata + an optional `build(ctx)` that emits
// automation nodes for one cast at a given slot level (this is where upcasting
// lives). Pure-utility spells carry no `build` — they still occupy a prepared
// slot, the AI just never casts them.

import type { AutomationNode, Condition, DamageType, EffectMods } from "../schema";

export type SpellClass =
  | "wizard" | "sorcerer" | "cleric" | "druid" | "bard" | "warlock" | "paladin" | "ranger" | "artificer";

export type SpellSchool =
  | "abjuration" | "conjuration" | "divination" | "enchantment"
  | "evocation" | "illusion" | "necromancy" | "transmutation";

export type SpellRole = "damage" | "control" | "buff" | "heal" | "summon" | "defense" | "utility";

export interface CastCtx {
  slotLevel: number;   // slot used for this cast (>= spell.level; cantrips pass 0)
  casterLevel: number;
  spellMod: number;    // spellcasting ability modifier
  dc: number;          // 8 + pb + spellMod
  toHit: number;       // pb + spellMod
  pb: number;
}

export interface Spell {
  id: string;
  name: string;
  level: number;        // 0 = cantrip
  school: SpellSchool;
  classes: SpellClass[];
  castTime: "action" | "bonus" | "reaction";
  concentration: boolean;
  ritual?: boolean;
  role: SpellRole;
  /** highest slot level upcasting still helps at (default: spell.level). */
  maxUpcast?: number;
  build?: (ctx: CastCtx) => AutomationNode[];
}

// ------------------------------------------------- shared automation factories

type Ability = "str" | "dex" | "con" | "int" | "wis" | "cha";
type WhoSpec =
  | "aiChoice" | "eachEnemy" | "area" | "lowestHpEnemy"
  | { who: "aiChoice" | "eachEnemy" | "lowestHpEnemy" }
  | { who: "area"; shape: "sphere" | "cone" | "line" | "cube" | "emanation"; size: number }
  | { who: "chosenEnemies"; upTo: number };
const N = (n: number, d: number, plus = 0) => `${Math.max(0, Math.round(n))}d${d}${plus ? `+${plus}` : ""}`;
const area = (size = 20, shape: "sphere" | "cone" | "line" | "cube" | "emanation" = "sphere") =>
  ({ who: "area" as const, shape, size });

/** normalise the shorthand `who` used in the catalog into a schema TargetSpec */
function targetSpec(w: WhoSpec | undefined): import("../schema").TargetSpec {
  if (!w) return { who: "aiChoice" };
  if (w === "area") return { who: "area", shape: "sphere", size: 20 };
  if (typeof w === "string") return { who: w } as import("../schema").TargetSpec;
  if (w.who === "area") return w;
  return w as import("../schema").TargetSpec;
}

/** cantrip damage-die count by character level (1 / 5 / 11 / 17) */
export const cantripDice = (casterLevel: number): number =>
  casterLevel >= 17 ? 4 : casterLevel >= 11 ? 3 : casterLevel >= 5 ? 2 : 1;

/** spell attack roll -> Xd(die) on hit, +perSlot dice per slot above spell level */
export function atk(spellLevel: number, baseD: number, die: number, dtype: DamageType, perSlot = 1, rays = 1): Spell["build"] {
  return (c) => {
    const n = baseD + Math.max(0, c.slotLevel - spellLevel) * perSlot;
    const one: AutomationNode = { type: "attack", bonus: c.toHit, onHit: [{ type: "damage", amount: N(n, die), damageType: dtype }] };
    return [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: rays }, () => ({ ...one })) }];
  };
}

/** save for half; +perSlot dice per slot above spell level */
export function saveDmg(spellLevel: number, ability: Ability, baseD: number, die: number, dtype: DamageType, perSlot: number, who: WhoSpec = area()): Spell["build"] {
  return (c) => {
    const n = baseD + Math.max(0, c.slotLevel - spellLevel) * perSlot;
    return [{ type: "target", who: targetSpec(who), effects: [
      { type: "save", ability, dc: c.dc,
        onFail: [{ type: "damage", amount: N(n, die), damageType: dtype }],
        onSuccess: [{ type: "damage", amount: N(n, die), damageType: dtype, half: true }] },
    ] }];
  };
}

/** save-or-suffer a condition (optionally with rider damage / repeat saves / more targets when upcast) */
export function saveCond(
  ability: Ability,
  condition: Condition,
  durationRounds: number,
  o: { saveEnds?: boolean; who?: WhoSpec; dmg?: [number, number, DamageType]; targetsAtLevel?: number; perSlotTargets?: number; spellLevel?: number } = {},
): Spell["build"] {
  return (c) => {
    const onFail: AutomationNode[] = [];
    if (o.dmg && o.dmg[0] > 0) onFail.push({ type: "damage", amount: N(o.dmg[0], o.dmg[1]), damageType: o.dmg[2] });
    onFail.push({ type: "applyCondition", condition, durationRounds, saveEnds: o.saveEnds ? { ability, dc: c.dc, at: "endOfTurn" } : undefined });
    let who = targetSpec(o.who);
    if (o.perSlotTargets && o.targetsAtLevel && o.spellLevel !== undefined) {
      const extra = Math.max(0, c.slotLevel - o.targetsAtLevel) * o.perSlotTargets;
      who = { who: "chosenEnemies", upTo: 1 + extra };
    }
    return [{ type: "target", who, effects: [{ type: "save", ability, dc: c.dc, onFail }] }];
  };
}

/** buff / debuff effect on a target set */
export function effect(name: string, mods: EffectMods, o: { who?: "self" | "eachAlly"; durationRounds?: number; save?: [Ability]; tick?: [number, number, DamageType]; oneShot?: boolean } = {}): Spell["build"] {
  return (c) => {
    const eff: Extract<AutomationNode, { type: "applyEffect" }> = {
      type: "applyEffect", name, mods, durationRounds: o.durationRounds ?? 10,
    };
    if (o.tick) eff.tick = [{ type: "damage", amount: N(o.tick[0], o.tick[1]), damageType: o.tick[2] }];
    if (o.save) eff.saveEnds = { ability: o.save[0], dc: c.dc, at: "endOfTurn" };
    if (o.oneShot) eff.oneShot = true;
    return [{ type: "target", who: { who: o.who ?? "self" }, effects: [eff] }];
  };
}

/** healing: Xd(die)+mod, +perSlot dice per slot above spell level */
export function heal(spellLevel: number, baseD: number, die: number, perSlot: number, o: { who?: "lowestHpAlly" | "self" | "eachAlly"; addMod?: boolean; flat?: number } = {}): Spell["build"] {
  return (c) => {
    const n = baseD + Math.max(0, c.slotLevel - spellLevel) * perSlot;
    const plus = (o.flat ?? 0) + (o.addMod === false ? 0 : c.spellMod);
    return [{ type: "target", who: { who: o.who ?? "lowestHpAlly" }, effects: [{ type: "heal", amount: N(n, die, plus) }] }];
  };
}

/** summon N of a minion stat block */
export function conjure(statBlock: string, count: string, max: number): Spell["build"] {
  return () => [{ type: "summon", statBlock, count, max }];
}
