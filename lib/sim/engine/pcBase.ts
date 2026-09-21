// Small helpers every PC template builder shares (level -> proficiency, ability score from a modifier, an HP ramp, and
// the `pc()` constructor that fills in the boilerplate of a Combatant).

import type { Ability, Combatant } from "../schema";

export const pbFor = (lvl: number) => 2 + Math.floor((lvl - 1) / 4);
export const score = (mod: number) => 10 + mod * 2;
/** linear interpolate a stat from its value `a` at level 1 to its value `b` at
 *  level 20. IMPORTANT: `b` is the LEVEL-20 value, a constant — do NOT pass a
 *  level-dependent expression (that was a long-standing HP bug that crushed
 *  low-to-mid-level PCs to ~1/3 of their real hit points). */
export const between = (lvl: number, a: number, b: number, atA = 1, atB = 20) =>
  Math.round(a + ((b - a) * (Math.max(atA, Math.min(atB, lvl)) - atA)) / (atB - atA));

export function pc(base: {
  id: string; name: string; level: number; ac: number; hp: number;
  abilities: Combatant["abilities"]; proficientSaves: Ability[];
  saveBonusAll?: number;
  resources?: Combatant["resources"]; traits?: Combatant["traits"];
  actions: Combatant["actions"]; reactions?: Combatant["reactions"];
  specialRules?: Combatant["specialRules"];
  keepDistance?: boolean; opener?: string[]; targetPriority?: Combatant["ai"]["targetPriority"];
  /** walking speed in feet (default 30) */
  speed?: number;
  initiativeBonus?: number;
  /** bonus-action ids the AI takes before its main action / right after its Attack action */
  bonusRoutine?: string[]; bonusAfterAttack?: string[];
}): Combatant {
  return {
    id: base.id, name: base.name, kind: "pc", creatureType: "humanoid", size: "medium", level: base.level,
    templateId: base.id, ac: base.ac, maxHp: base.hp, speeds: { walk: base.speed ?? 30 },
    ...(base.initiativeBonus !== undefined ? { initiativeBonus: base.initiativeBonus } : {}),
    abilities: base.abilities, pb: pbFor(base.level), proficientSaves: base.proficientSaves,
    saveBonusAll: base.saveBonusAll ?? 0,
    resistances: [], resistancesNonmagical: [], immunities: [], vulnerabilities: [],
    conditionImmunities: [], specialRules: base.specialRules ?? [],
    resources: base.resources ?? {}, traits: base.traits ?? [],
    actions: base.actions, reactions: base.reactions ?? [],
    ai: {
      targetPriority: base.targetPriority ?? "lowestHp", aoeMinTargets: 2,
      opener: base.opener ?? [], saveLegendaryResistanceFor: [],
      keepDistance: base.keepDistance ?? false, neverRetreat: true, focusFire: true,
      ...(base.bonusRoutine ? { bonusRoutine: base.bonusRoutine } : {}),
      ...(base.bonusAfterAttack ? { bonusAfterAttack: base.bonusAfterAttack } : {}),
    },
  };
}
