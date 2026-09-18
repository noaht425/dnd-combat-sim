// Class/subclass names the setup builder recognizes, mapped to the one
// PartyMemberSpec template that currently exists for that class. There's
// exactly one subclass per class today, so "draconic sorcerer" and "sorcerer"
// resolve to the same template — the subclass word is accepted (and steers
// theming text) without yet changing the build. Add aliases here as new
// templates land in engine/templates.ts / spells/casterTemplates.ts.

import { TEMPLATE_IDS } from "../sim/engine/templates";
import { bestMatch, type Candidate } from "./fuzzy";

export interface ClassAlias {
  templateId: string;
  className: string;
  subclassName: string;
  aliases: string[];
}

export const CLASS_TEMPLATES: ClassAlias[] = [
  { templateId: "gwm-fighter", className: "fighter", subclassName: "Great Weapon Master",
    aliases: ["fighter", "gwm fighter", "battlemaster fighter", "great weapon fighter", "champion fighter"] },
  { templateId: "assassin-rogue", className: "rogue", subclassName: "Assassin",
    aliases: ["rogue", "assassin", "assassin rogue", "thief"] },
  { templateId: "totem-barbarian", className: "barbarian", subclassName: "Path of the Totem Warrior",
    aliases: ["barbarian", "totem barbarian", "totem warrior barbarian", "berserker barbarian"] },
  { templateId: "open-hand-monk", className: "monk", subclassName: "Way of the Open Hand",
    aliases: ["monk", "open hand monk", "way of the open hand monk"] },
  { templateId: "blaster-wizard", className: "wizard", subclassName: "Evocation",
    aliases: ["wizard", "blaster wizard", "evocation wizard", "evoker"] },
  { templateId: "life-cleric", className: "cleric", subclassName: "Life Domain",
    aliases: ["cleric", "life cleric", "life domain cleric", "healer cleric"] },
  { templateId: "vengeance-paladin", className: "paladin", subclassName: "Oath of Vengeance",
    aliases: ["paladin", "vengeance paladin", "oath of vengeance paladin"] },
  { templateId: "hunter-ranger", className: "ranger", subclassName: "Hunter",
    aliases: ["ranger", "hunter ranger", "hunter"] },
  { templateId: "draconic-sorcerer", className: "sorcerer", subclassName: "Draconic Bloodline",
    aliases: ["sorcerer", "draconic sorcerer", "dragon sorcerer", "draconic bloodline sorcerer"] },
  { templateId: "wild-magic-sorcerer", className: "sorcerer", subclassName: "Wild Magic",
    aliases: ["wild magic sorcerer", "wild sorcerer", "wild magic"] },
  { templateId: "moon-druid", className: "druid", subclassName: "Circle of the Moon",
    aliases: ["druid", "moon druid", "circle of the moon druid"] },
  { templateId: "lore-bard", className: "bard", subclassName: "College of Lore",
    aliases: ["bard", "lore bard", "college of lore bard"] },
  { templateId: "warlock", className: "warlock", subclassName: "Fiend Patron",
    aliases: ["warlock", "fiend warlock", "fiend patron warlock"] },
  { templateId: "battlesmith-artificer", className: "artificer", subclassName: "Battle Smith",
    aliases: ["artificer", "battle smith", "battlesmith artificer", "battle smith artificer"] },
];

// sanity check: every templateId here must exist in the engine's builder table
for (const c of CLASS_TEMPLATES) {
  if (!TEMPLATE_IDS.includes(c.templateId)) {
    throw new Error(`classTemplates.ts references unknown template "${c.templateId}"`);
  }
}

export function classAliasFor(templateId: string): ClassAlias | undefined {
  return CLASS_TEMPLATES.find((c) => c.templateId === templateId);
}

const CANDIDATES: Candidate<ClassAlias>[] = CLASS_TEMPLATES.flatMap((c) =>
  c.aliases.map((a) => ({ key: a, label: a, value: c })),
);

export interface ClassMatch {
  match?: ClassAlias;
  suggestions: ClassAlias[];
}

export function findClassTemplate(text: string): ClassMatch {
  const r = bestMatch(text, CANDIDATES);
  if (r.best && r.bestScore >= 0.6) return { match: r.best.value, suggestions: [] };
  const seen = new Set<string>();
  const suggestions = r.runnersUp.map((c) => c.value).filter((c) => (seen.has(c.templateId) ? false : (seen.add(c.templateId), true)));
  return { match: undefined, suggestions };
}
