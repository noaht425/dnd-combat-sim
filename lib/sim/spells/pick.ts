// Per-PC spell selection. `makeCaster` stamps `spellClass` / `casterKind` /
// `spellAbility` onto a built caster; this overlay rebuilds that PC's spell
// actions from an explicit id list (the ⚙ picker's checkboxes), replacing the
// auto-prepared set. Non-spell actions (weapon attack, Rage, Action Surge,
// Channel Divinity …) are untouched.

import type { Ability, Combatant } from "../schema";
import { abilityMod } from "../math";
import { SPELLS_BY_ID } from "./catalog";
import { spellActions, spellReaction, type CasterCtx } from "./cast";
import type { CasterKind } from "./slots";

const pbFor = (lvl: number): number => 2 + Math.floor((Math.max(1, Math.min(20, lvl)) - 1) / 4);

// class key -> caster kind + spellcasting ability
const CASTER_META: Record<string, { kind: CasterKind; ability: Ability }> = {
  wizard: { kind: "full", ability: "int" }, sorcerer: { kind: "full", ability: "cha" },
  cleric: { kind: "full", ability: "wis" }, druid: { kind: "full", ability: "wis" },
  bard: { kind: "full", ability: "cha" }, warlock: { kind: "warlock", ability: "cha" },
  paladin: { kind: "half", ability: "cha" }, ranger: { kind: "half", ability: "wis" },
  artificer: { kind: "half", ability: "int" },
};
// the UI's caster templateIds -> class key
const TEMPLATE_KEY: Record<string, string> = {
  "blaster-wizard": "wizard", "life-cleric": "cleric", "vengeance-paladin": "paladin",
  "hunter-ranger": "ranger", "draconic-sorcerer": "sorcerer", "moon-druid": "druid", "lore-bard": "bard",
};

/** kind + casting ability for a built PC — prefers the stamped fields, then the
 *  spellClass / templateId (so a PC built before makeCaster stamped these, e.g.
 *  one restored from an old saved setup, still works). */
function casterMeta(c: Combatant): { kind: CasterKind; ability: Ability } | null {
  if (c.casterKind && c.spellAbility) return { kind: c.casterKind as CasterKind, ability: c.spellAbility as Ability };
  const raw = (c.spellClass ?? c.templateId ?? "").replace(/^pc-/, "");
  const key = CASTER_META[raw] ? raw : TEMPLATE_KEY[raw] ?? raw;
  return CASTER_META[key] ?? null;
}

/** Replace `c`'s spell list with exactly the spells in `ids` (cantrips + leveled
 *  + reaction spells). No-op when `ids` is empty (keeps the auto-prepared list). */
export function applyPickedSpells(c: Combatant, ids: string[], level: number): { c: Combatant; notes: string[] } {
  const notes: string[] = [];
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return { c, notes };
  const meta = casterMeta(c);
  if (!meta) return { c, notes: ["spell picks ignored — this PC isn't a spellcaster"] };

  const cc: CasterCtx = {
    kind: meta.kind,
    level,
    pb: pbFor(level),
    spellMod: abilityMod(c.abilities[meta.ability]),
  };

  // keep everything that isn't a spell-derived action (the warlock's Eldritch
  // Blast keeps id "attack", so preserve that even though it's flagged isSpell)
  const keptActions = c.actions.filter((a) => !a.isSpell || a.id === "attack");
  const keptReactions = c.reactions.filter((a) => !a.isSpell);

  const newActions: Combatant["actions"] = [];
  const newReactions: Combatant["reactions"] = [];
  const skipped: string[] = [];
  for (const id of uniq) {
    const sp = SPELLS_BY_ID[id];
    if (!sp) { skipped.push(id); continue; }
    if (sp.castTime === "reaction") {
      const r = spellReaction(sp, cc);
      if (r) newReactions.push(r);
      else skipped.push(sp.name);
      continue;
    }
    if (!sp.build) { skipped.push(sp.name); continue; }
    const acts = spellActions(sp, cc);
    if (acts.length) newActions.push(...acts);
    else skipped.push(sp.name);
  }
  if (skipped.length) {
    notes.push(`picked but not simulated (utility / out of slot range): ${skipped.join(", ")}`);
  }

  const actions = [...keptActions, ...newActions];
  const reactions = [...keptReactions, ...newReactions];
  const opener = c.ai.opener.filter((oid) => actions.some((a) => a.id === oid));
  return { c: { ...c, actions, reactions, ai: { ...c.ai, opener } }, notes };
}
