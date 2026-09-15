// Assemble a spellcasting PC Combatant from a class + level + focus (or an
// explicit prepared list), wiring real slot resources, upcast spell actions,
// cantrips, and reaction spells.

import type { Ability, Combatant } from "../schema";
import { abilityMod } from "../math";
import type { CasterKind } from "./slots";
import { slotResources } from "./slots";
import { autoPrepare, resolveSpells, type CasterFocus, type PreparedSet } from "./prepare";
import { spellActions, spellReaction, type CasterCtx } from "./cast";
import type { SpellClass } from "./types";

export interface CasterSpec {
  id: string;
  name: string;
  level: number;
  spellClass: SpellClass;
  casterKind: CasterKind;
  spellAbility: Ability;
  ac: number;
  hp: number;
  abilities: Combatant["abilities"];
  proficientSaves: Ability[];
  saveBonusAll?: number;
  focus?: CasterFocus;
  /** explicit spell ids; when omitted, auto-picked from the class list for `focus` */
  prepared?: string[];
  cantrips?: string[];
  /** non-spell actions (weapon attack, Channel Divinity, Metamagic, Rage, ...) */
  extraActions?: Combatant["actions"];
  extraReactions?: Combatant["reactions"];
  extraTraits?: Combatant["traits"];
  keepDistance?: boolean;
  opener?: string[];
  targetPriority?: Combatant["ai"]["targetPriority"];
}

const pbFor = (lvl: number) => 2 + Math.floor((Math.max(1, Math.min(20, lvl)) - 1) / 4);

export function makeCaster(spec: CasterSpec): Combatant {
  const pb = pbFor(spec.level);
  const mod = abilityMod(spec.abilities[spec.spellAbility]);
  const cc: CasterCtx = { kind: spec.casterKind, level: spec.level, pb, spellMod: mod };

  const set: PreparedSet = spec.prepared
    ? { cantrips: spec.cantrips ?? [], spells: spec.prepared }
    : autoPrepare(spec.spellClass, spec.casterKind, spec.level, mod, spec.focus ?? "balanced");

  const spells = resolveSpells([...set.cantrips, ...set.spells]);

  const actions: Combatant["actions"] = [];
  const reactions: Combatant["reactions"] = [...(spec.extraReactions ?? [])];

  for (const sp of spells) {
    if (sp.castTime === "reaction") {
      const r = spellReaction(sp, cc);
      if (r) reactions.push(r);
      continue;
    }
    actions.push(...spellActions(sp, cc));
  }
  actions.push(...(spec.extraActions ?? []));

  // pick an opener: the caller's, else the highest-value control/buff cantrip-or-spell
  const opener = spec.opener ?? pickOpener(actions);

  return {
    id: spec.id, name: spec.name, kind: "pc", size: "medium", level: spec.level,
    templateId: spec.id,
    ac: spec.ac, maxHp: spec.hp, speeds: { walk: 30 },
    abilities: spec.abilities, pb, proficientSaves: spec.proficientSaves,
    saveBonusAll: spec.saveBonusAll ?? 0,
    spellClass: spec.spellClass, casterKind: spec.casterKind, spellAbility: spec.spellAbility,
    resistances: [], resistancesNonmagical: [], immunities: [], vulnerabilities: [],
    conditionImmunities: [], specialRules: [],
    resources: slotResources(spec.casterKind, spec.level),
    traits: spec.extraTraits ?? [],
    actions,
    reactions,
    ai: {
      targetPriority: spec.targetPriority ?? "lowestHp",
      aoeMinTargets: 2,
      opener,
      saveLegendaryResistanceFor: [],
      keepDistance: spec.keepDistance ?? true,
      neverRetreat: true,
      focusFire: true,
    },
  };
}

function pickOpener(actions: Combatant["actions"]): string[] {
  // prefer a control spell cast at its base level, else a buff, else nothing
  const control = actions.find((a) => a.isSpell && /hold|hypnotic|slow|web|fear|banish/i.test(a.name) && !/\(\d/.test(a.name));
  if (control) return [control.id];
  const buff = actions.find((a) => a.isSpell && /bless|haste|spirit guardians|hunter's mark|hex/i.test(a.name) && !/\(\d/.test(a.name));
  return buff ? [buff.id] : [];
}
