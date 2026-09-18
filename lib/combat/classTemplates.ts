// Class/subclass names the setup builder recognizes, mapped to the
// PartyMemberSpec template that exists for that class+subclass combo. Most
// classes still have only one built subclass, so e.g. "draconic sorcerer"
// and "sorcerer" resolve to the same template — only the class's DEFAULT
// subclass (listed first among its siblings below) carries the bare class
// name as an alias; a second subclass (Battle Master, Beast Master, Wild
// Magic) needs its own more specific words. Add aliases here as new
// templates land in engine/templates.ts / spells/casterTemplates.ts.

import { TEMPLATE_IDS } from "../sim/engine/templates";
import { bestMatch, normalize, type Candidate } from "./fuzzy";

export interface ClassAlias {
  templateId: string;
  className: string;
  subclassName: string;
  aliases: string[];
}

export const CLASS_TEMPLATES: ClassAlias[] = [
  { templateId: "gwm-fighter", className: "fighter", subclassName: "Great Weapon Master",
    aliases: ["fighter", "gwm fighter", "great weapon fighter", "champion fighter"] },
  { templateId: "battlemaster-fighter", className: "fighter", subclassName: "Battle Master",
    aliases: ["battle master fighter", "battlemaster fighter", "battle master"] },
  { templateId: "assassin-rogue", className: "rogue", subclassName: "Assassin",
    aliases: ["rogue", "assassin", "assassin rogue"] },
  { templateId: "thief-rogue", className: "rogue", subclassName: "Thief",
    aliases: ["thief rogue", "thief"] },
  { templateId: "swashbuckler-rogue", className: "rogue", subclassName: "Swashbuckler",
    aliases: ["swashbuckler rogue", "swashbuckler"] },
  { templateId: "mastermind-rogue", className: "rogue", subclassName: "Mastermind",
    aliases: ["mastermind rogue", "mastermind"] },
  { templateId: "inquisitive-rogue", className: "rogue", subclassName: "Inquisitive",
    aliases: ["inquisitive rogue", "inquisitive"] },
  { templateId: "scout-rogue", className: "rogue", subclassName: "Scout",
    aliases: ["scout rogue", "scout"] },
  { templateId: "soulknife-rogue", className: "rogue", subclassName: "Soulknife",
    aliases: ["soulknife rogue", "soul knife rogue", "soulknife", "soul knife"] },
  { templateId: "arcane-trickster-rogue", className: "rogue", subclassName: "Arcane Trickster",
    aliases: ["arcane trickster rogue", "arcane trickster"] },
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
  { templateId: "beastmaster-ranger", className: "ranger", subclassName: "Beast Master",
    aliases: ["beast master ranger", "beastmaster ranger", "beast master"] },
  { templateId: "draconic-sorcerer", className: "sorcerer", subclassName: "Draconic Bloodline",
    aliases: ["sorcerer", "draconic sorcerer", "dragon sorcerer", "draconic bloodline sorcerer"] },
  { templateId: "wild-magic-sorcerer", className: "sorcerer", subclassName: "Wild Magic",
    aliases: ["wild magic sorcerer", "wild sorcerer", "wild magic"] },
  { templateId: "divine-soul-sorcerer", className: "sorcerer", subclassName: "Divine Soul",
    aliases: ["divine soul sorcerer", "divine soul", "divine sorcerer"] },
  { templateId: "shadow-magic-sorcerer", className: "sorcerer", subclassName: "Shadow Magic",
    aliases: ["shadow magic sorcerer", "shadow sorcerer", "shadow magic"] },
  { templateId: "storm-sorcerer", className: "sorcerer", subclassName: "Storm Sorcery",
    aliases: ["storm sorcery sorcerer", "storm sorcerer", "storm sorcery"] },
  { templateId: "aberrant-mind-sorcerer", className: "sorcerer", subclassName: "Aberrant Mind",
    aliases: ["aberrant mind sorcerer", "aberrant mind", "aberrant sorcerer"] },
  { templateId: "clockwork-soul-sorcerer", className: "sorcerer", subclassName: "Clockwork Soul",
    aliases: ["clockwork soul sorcerer", "clockwork soul", "clockwork sorcerer"] },
  { templateId: "moon-druid", className: "druid", subclassName: "Circle of the Moon",
    aliases: ["druid", "moon druid", "circle of the moon druid"] },
  { templateId: "lore-bard", className: "bard", subclassName: "College of Lore",
    aliases: ["bard", "lore bard", "college of lore bard"] },
  { templateId: "warlock", className: "warlock", subclassName: "Fiend Patron",
    aliases: ["warlock", "fiend warlock", "fiend patron warlock"] },
  { templateId: "battlesmith-artificer", className: "artificer", subclassName: "Battle Smith",
    aliases: ["artificer", "battle smith", "battlesmith artificer", "battle smith artificer"] },
  { templateId: "artillerist-artificer", className: "artificer", subclassName: "Artillerist",
    aliases: ["artillerist artificer", "artillerist"] },
  { templateId: "armorer-guardian-artificer", className: "artificer", subclassName: "Armorer (Guardian)",
    aliases: ["armorer artificer", "armorer", "guardian armorer artificer", "guardian armorer", "armorer guardian", "guardian artificer"] },
  { templateId: "armorer-infiltrator-artificer", className: "artificer", subclassName: "Armorer (Infiltrator)",
    aliases: ["infiltrator armorer artificer", "infiltrator armorer", "armorer infiltrator", "infiltrator artificer"] },
  { templateId: "alchemist-artificer", className: "artificer", subclassName: "Alchemist",
    aliases: ["alchemist artificer", "alchemist"] },
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

  // The token-overlap score divides by the QUERY's word count, so pairing a
  // real class with an unbuilt subclass we have no alias for ("soul-knife
  // rogue", "shadow monk") drags the whole phrase below the 0.6 threshold
  // even though "rogue"/"monk" itself is an exact, unambiguous word in it.
  // Fall back to a literal whole-word class-name hit so that still resolves
  // to the one subclass we DO have, instead of a bare parse failure —
  // mentionedDifferentSubclass() (setupParser.ts) then explains the swap.
  // CLASS_TEMPLATES lists each class's default subclass first among its
  // siblings (only the default's own aliases include the bare class word),
  // so `.find` naturally picks that one.
  const words = new Set(normalize(text).split(" "));
  const byBareClass = CLASS_TEMPLATES.find((c) => words.has(c.className));

  // An exact whole-word class name always outranks a fuzzy match that only
  // won on partial/phonetic credit for a DIFFERENT class — "shadow monk"
  // contains the literal word "monk", which shouldn't lose to some other
  // class's subclass alias that happens to share a word ("Shadow Magic"
  // sorcerer). Only overrides when the fuzzy winner is a different class
  // than the exact word — same-class fuzzy wins (picking the right
  // SUBCLASS, e.g. "wild magic sorcerer" over the bare-word default) still
  // go through untouched.
  if (byBareClass && r.best && r.bestScore >= 0.6 && r.best.value.className !== byBareClass.className) {
    return { match: byBareClass, suggestions: [] };
  }
  if (r.best && r.bestScore >= 0.6) return { match: r.best.value, suggestions: [] };
  if (byBareClass) return { match: byBareClass, suggestions: [] };

  const seen = new Set<string>();
  const suggestions = r.runnersUp.map((c) => c.value).filter((c) => (seen.has(c.templateId) ? false : (seen.add(c.templateId), true)));
  return { match: undefined, suggestions };
}
