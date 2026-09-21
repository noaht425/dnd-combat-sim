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
  { templateId: "gwm-fighter", className: "fighter", subclassName: "Champion",
    aliases: ["fighter", "champion fighter", "champion", "gwm fighter", "great weapon fighter"] },
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
    aliases: ["barbarian", "totem barbarian", "totem warrior barbarian", "path of the totem warrior", "bear totem barbarian"] },
  { templateId: "totem-wolf-barbarian", className: "barbarian", subclassName: "Path of the Totem Warrior (wolf)",
    aliases: ["wolf totem barbarian", "wolf totem warrior barbarian", "wolf totem"] },
  { templateId: "totem-elk-barbarian", className: "barbarian", subclassName: "Path of the Totem Warrior (elk)",
    aliases: ["elk totem barbarian", "elk totem warrior barbarian", "elk totem"] },
  { templateId: "totem-eagle-barbarian", className: "barbarian", subclassName: "Path of the Totem Warrior (eagle)",
    aliases: ["eagle totem barbarian", "eagle totem warrior barbarian", "eagle totem"] },
  { templateId: "berserker-barbarian", className: "barbarian", subclassName: "Path of the Berserker",
    aliases: ["berserker barbarian", "path of the berserker", "berserker"] },
  { templateId: "ancestral-guardian-barbarian", className: "barbarian", subclassName: "Path of the Ancestral Guardian",
    aliases: ["ancestral guardian barbarian", "path of the ancestral guardian", "ancestral guardian"] },
  { templateId: "storm-herald-barbarian", className: "barbarian", subclassName: "Path of the Storm Herald (sea)",
    aliases: ["storm herald barbarian", "path of the storm herald", "storm herald", "sea storm herald barbarian", "sea storm herald"] },
  { templateId: "storm-herald-desert-barbarian", className: "barbarian", subclassName: "Path of the Storm Herald (desert)",
    aliases: ["desert storm herald barbarian", "desert storm herald"] },
  { templateId: "storm-herald-tundra-barbarian", className: "barbarian", subclassName: "Path of the Storm Herald (tundra)",
    aliases: ["tundra storm herald barbarian", "tundra storm herald"] },
  { templateId: "zealot-barbarian", className: "barbarian", subclassName: "Path of the Zealot",
    aliases: ["zealot barbarian", "path of the zealot", "zealot"] },
  { templateId: "battlerager-barbarian", className: "barbarian", subclassName: "Path of the Battlerager",
    aliases: ["battlerager barbarian", "path of the battlerager", "battlerager"] },
  { templateId: "beast-barbarian", className: "barbarian", subclassName: "Path of the Beast",
    aliases: ["beast barbarian", "path of the beast barbarian", "path of the beast"] },
  { templateId: "giant-barbarian", className: "barbarian", subclassName: "Path of the Giant",
    aliases: ["giant barbarian", "path of the giant barbarian", "path of the giant"] },
  { templateId: "wild-magic-barbarian", className: "barbarian", subclassName: "Path of Wild Magic",
    aliases: ["wild magic barbarian", "path of wild magic barbarian", "path of wild magic"] },
  { templateId: "open-hand-monk", className: "monk", subclassName: "Way of the Open Hand",
    aliases: ["monk", "open hand monk", "way of the open hand monk", "way of the open hand", "open hand"] },
  { templateId: "shadow-monk", className: "monk", subclassName: "Way of Shadow",
    aliases: ["shadow monk", "way of shadow monk", "way of shadow", "way of the shadow monk"] },
  { templateId: "four-elements-monk", className: "monk", subclassName: "Way of the Four Elements",
    aliases: ["four elements monk", "way of the four elements monk", "way of the four elements", "elemental monk", "four elements"] },
  { templateId: "long-death-monk", className: "monk", subclassName: "Way of the Long Death",
    aliases: ["long death monk", "way of the long death monk", "way of the long death", "long death"] },
  { templateId: "sun-soul-monk", className: "monk", subclassName: "Way of the Sun Soul",
    aliases: ["sun soul monk", "way of the sun soul monk", "way of the sun soul", "sun soul"] },
  { templateId: "drunken-master-monk", className: "monk", subclassName: "Way of the Drunken Master",
    aliases: ["drunken master monk", "way of the drunken master monk", "way of the drunken master", "drunken master"] },
  { templateId: "kensei-monk", className: "monk", subclassName: "Way of the Kensei",
    aliases: ["kensei monk", "way of the kensei monk", "way of the kensei", "kensei"] },
  { templateId: "mercy-monk", className: "monk", subclassName: "Way of Mercy",
    aliases: ["mercy monk", "way of mercy monk", "way of mercy", "monk of mercy"] },
  { templateId: "astral-self-monk", className: "monk", subclassName: "Way of the Astral Self",
    aliases: ["astral self monk", "way of the astral self monk", "way of the astral self", "astral self"] },
  { templateId: "ascendant-dragon-monk", className: "monk", subclassName: "Way of the Ascendant Dragon",
    aliases: ["ascendant dragon monk", "way of the ascendant dragon monk", "way of the ascendant dragon", "ascendant dragon", "dragon monk"] },
  { templateId: "blaster-wizard", className: "wizard", subclassName: "School of Evocation",
    aliases: ["wizard", "blaster wizard", "evocation wizard", "evoker", "school of evocation", "school of evocation wizard"] },
  { templateId: "abjuration-wizard", className: "wizard", subclassName: "School of Abjuration",
    aliases: ["abjuration wizard", "abjurer", "school of abjuration", "school of abjuration wizard"] },
  { templateId: "conjuration-wizard", className: "wizard", subclassName: "School of Conjuration",
    aliases: ["conjuration wizard", "conjurer", "school of conjuration", "school of conjuration wizard"] },
  { templateId: "divination-wizard", className: "wizard", subclassName: "School of Divination",
    aliases: ["divination wizard", "diviner", "school of divination", "school of divination wizard"] },
  { templateId: "enchantment-wizard", className: "wizard", subclassName: "School of Enchantment",
    aliases: ["enchantment wizard", "enchanter", "school of enchantment", "school of enchantment wizard"] },
  { templateId: "illusion-wizard", className: "wizard", subclassName: "School of Illusion",
    aliases: ["illusion wizard", "illusionist", "school of illusion", "school of illusion wizard"] },
  { templateId: "necromancy-wizard", className: "wizard", subclassName: "School of Necromancy",
    aliases: ["necromancy wizard", "necromancer", "school of necromancy", "school of necromancy wizard"] },
  { templateId: "transmutation-wizard", className: "wizard", subclassName: "School of Transmutation",
    aliases: ["transmutation wizard", "transmuter", "school of transmutation", "school of transmutation wizard"] },
  { templateId: "war-magic-wizard", className: "wizard", subclassName: "War Magic",
    aliases: ["war magic wizard", "war wizard", "war mage", "war magic", "wizard of war magic"] },
  { templateId: "bladesinging-wizard", className: "wizard", subclassName: "Bladesinging",
    aliases: ["bladesinging wizard", "bladesinger wizard", "bladesinger", "bladesinging", "wizard of bladesinging"] },
  { templateId: "scribes-wizard", className: "wizard", subclassName: "Order of Scribes",
    aliases: ["order of scribes wizard", "scribes wizard", "order of scribes", "scribe wizard", "wizard of the order of scribes"] },
  { templateId: "chronurgy-wizard", className: "wizard", subclassName: "Chronurgy Magic",
    aliases: ["chronurgy wizard", "chronurgist", "chronurgy magic", "chronurgy", "wizard of chronurgy magic"] },
  { templateId: "graviturgy-wizard", className: "wizard", subclassName: "Graviturgy Magic",
    aliases: ["graviturgy wizard", "graviturgist", "graviturgy magic", "graviturgy", "wizard of graviturgy magic"] },
  { templateId: "life-cleric", className: "cleric", subclassName: "Life Domain",
    aliases: ["cleric", "life cleric", "life domain cleric", "healer cleric", "life domain", "cleric of the life domain", "cleric of life"] },
  { templateId: "arcana-cleric", className: "cleric", subclassName: "Arcana Domain",
    aliases: ["arcana cleric", "arcana domain cleric", "arcana domain", "cleric of the arcana domain", "cleric of arcana"] },
  { templateId: "death-cleric", className: "cleric", subclassName: "Death Domain",
    aliases: ["death cleric", "death domain cleric", "death domain", "cleric of the death domain", "cleric of death"] },
  { templateId: "forge-cleric", className: "cleric", subclassName: "Forge Domain",
    aliases: ["forge cleric", "forge domain cleric", "forge domain", "cleric of the forge domain", "cleric of forge"] },
  { templateId: "grave-cleric", className: "cleric", subclassName: "Grave Domain",
    aliases: ["grave cleric", "grave domain cleric", "grave domain", "cleric of the grave domain", "cleric of grave"] },
  { templateId: "knowledge-cleric", className: "cleric", subclassName: "Knowledge Domain",
    aliases: ["knowledge cleric", "knowledge domain cleric", "knowledge domain", "cleric of the knowledge domain", "cleric of knowledge"] },
  { templateId: "light-cleric", className: "cleric", subclassName: "Light Domain",
    aliases: ["light cleric", "light domain cleric", "light domain", "cleric of the light domain", "cleric of light"] },
  { templateId: "nature-cleric", className: "cleric", subclassName: "Nature Domain",
    aliases: ["nature cleric", "nature domain cleric", "nature domain", "cleric of the nature domain", "cleric of nature"] },
  { templateId: "order-cleric", className: "cleric", subclassName: "Order Domain",
    aliases: ["order cleric", "order domain cleric", "order domain", "cleric of the order domain", "cleric of order"] },
  { templateId: "peace-cleric", className: "cleric", subclassName: "Peace Domain",
    aliases: ["peace cleric", "peace domain cleric", "peace domain", "cleric of the peace domain", "cleric of peace"] },
  { templateId: "tempest-cleric", className: "cleric", subclassName: "Tempest Domain",
    aliases: ["tempest cleric", "tempest domain cleric", "tempest domain", "cleric of the tempest domain", "cleric of tempest"] },
  { templateId: "trickery-cleric", className: "cleric", subclassName: "Trickery Domain",
    aliases: ["trickery cleric", "trickery domain cleric", "trickery domain", "cleric of the trickery domain", "cleric of trickery"] },
  { templateId: "twilight-cleric", className: "cleric", subclassName: "Twilight Domain",
    aliases: ["twilight cleric", "twilight domain cleric", "twilight domain", "cleric of the twilight domain", "cleric of twilight"] },
  { templateId: "war-cleric", className: "cleric", subclassName: "War Domain",
    aliases: ["war cleric", "war domain cleric", "war domain", "cleric of the war domain", "cleric of war"] },
  { templateId: "vengeance-paladin", className: "paladin", subclassName: "Oath of Vengeance",
    aliases: ["paladin", "vengeance paladin", "oath of vengeance paladin"] },
  { templateId: "hunter-ranger", className: "ranger", subclassName: "Hunter",
    aliases: ["ranger", "hunter ranger", "hunter"] },
  { templateId: "hunter-horde-breaker-ranger", className: "ranger", subclassName: "Hunter (Horde Breaker)",
    aliases: ["horde breaker ranger", "horde breaker hunter", "hunter horde breaker"] },
  { templateId: "hunter-giant-killer-ranger", className: "ranger", subclassName: "Hunter (Giant Killer)",
    aliases: ["giant killer ranger", "giant killer hunter", "hunter giant killer"] },
  { templateId: "beastmaster-ranger", className: "ranger", subclassName: "Beast Master (Ranger's Companion)",
    aliases: ["beast master ranger", "beastmaster ranger", "beast master", "beast master conclave"] },
  { templateId: "beastmaster-land-ranger", className: "ranger", subclassName: "Beast Master (Beast of the Land)",
    aliases: ["primal companion ranger", "land beast master ranger", "beast of the land ranger", "beast master land"] },
  { templateId: "beastmaster-sea-ranger", className: "ranger", subclassName: "Beast Master (Beast of the Sea)",
    aliases: ["sea beast master ranger", "beast of the sea ranger", "beast master sea"] },
  { templateId: "beastmaster-sky-ranger", className: "ranger", subclassName: "Beast Master (Beast of the Sky)",
    aliases: ["sky beast master ranger", "beast of the sky ranger", "beast master sky"] },
  { templateId: "gloom-stalker-ranger", className: "ranger", subclassName: "Gloom Stalker",
    aliases: ["gloom stalker ranger", "gloom stalker"] },
  { templateId: "horizon-walker-ranger", className: "ranger", subclassName: "Horizon Walker",
    aliases: ["horizon walker ranger", "horizon walker"] },
  { templateId: "monster-slayer-ranger", className: "ranger", subclassName: "Monster Slayer",
    aliases: ["monster slayer ranger", "monster slayer"] },
  { templateId: "fey-wanderer-ranger", className: "ranger", subclassName: "Fey Wanderer",
    aliases: ["fey wanderer ranger", "fey wanderer"] },
  { templateId: "swarmkeeper-ranger", className: "ranger", subclassName: "Swarmkeeper",
    aliases: ["swarmkeeper ranger", "swarm keeper ranger", "swarmkeeper", "swarm keeper"] },
  { templateId: "drakewarden-ranger", className: "ranger", subclassName: "Drakewarden",
    aliases: ["drakewarden ranger", "drakewarden", "drake warden ranger", "drake warden"] },
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
    aliases: ["druid", "moon druid", "circle of the moon druid", "circle of the moon", "druid of the moon"] },
  { templateId: "arctic-land-druid", className: "druid", subclassName: "Circle of the Land (arctic)",
    aliases: ["arctic land druid", "arctic druid", "circle of the land (arctic)", "land druid (arctic)"] },
  { templateId: "coast-land-druid", className: "druid", subclassName: "Circle of the Land (coast)",
    aliases: ["coast land druid", "coast druid", "circle of the land (coast)", "land druid (coast)"] },
  { templateId: "desert-land-druid", className: "druid", subclassName: "Circle of the Land (desert)",
    aliases: ["desert land druid", "desert druid", "circle of the land (desert)", "land druid (desert)"] },
  { templateId: "forest-land-druid", className: "druid", subclassName: "Circle of the Land (forest)",
    aliases: ["forest land druid", "forest druid", "circle of the land (forest)", "land druid (forest)", "land druid", "circle of the land druid", "circle of the land"] },
  { templateId: "grassland-land-druid", className: "druid", subclassName: "Circle of the Land (grassland)",
    aliases: ["grassland land druid", "grassland druid", "circle of the land (grassland)", "land druid (grassland)"] },
  { templateId: "mountain-land-druid", className: "druid", subclassName: "Circle of the Land (mountain)",
    aliases: ["mountain land druid", "mountain druid", "circle of the land (mountain)", "land druid (mountain)"] },
  { templateId: "swamp-land-druid", className: "druid", subclassName: "Circle of the Land (swamp)",
    aliases: ["swamp land druid", "swamp druid", "circle of the land (swamp)", "land druid (swamp)"] },
  { templateId: "underdark-land-druid", className: "druid", subclassName: "Circle of the Land (underdark)",
    aliases: ["underdark land druid", "underdark druid", "circle of the land (underdark)", "land druid (underdark)"] },
  { templateId: "dreams-druid", className: "druid", subclassName: "Circle of Dreams",
    aliases: ["dreams druid", "circle of dreams druid", "circle of dreams", "druid of dreams"] },
  { templateId: "shepherd-druid", className: "druid", subclassName: "Circle of the Shepherd",
    aliases: ["shepherd druid", "circle of the shepherd druid", "circle of the shepherd", "druid of the shepherd"] },
  { templateId: "spores-druid", className: "druid", subclassName: "Circle of Spores",
    aliases: ["spores druid", "circle of spores druid", "circle of spores", "druid of spores"] },
  { templateId: "stars-druid", className: "druid", subclassName: "Circle of Stars",
    aliases: ["stars druid", "circle of stars druid", "circle of stars", "druid of stars"] },
  { templateId: "wildfire-druid", className: "druid", subclassName: "Circle of Wildfire",
    aliases: ["wildfire druid", "circle of wildfire druid", "circle of wildfire", "druid of wildfire"] },
  { templateId: "lore-bard", className: "bard", subclassName: "College of Lore",
    aliases: ["bard", "lore bard", "college of lore bard"] },
  { templateId: "archfey-warlock", className: "warlock", subclassName: "The Archfey",
    aliases: ["archfey warlock", "the archfey warlock", "archfey patron warlock"] },
  { templateId: "archfey-warlock-blade", className: "warlock", subclassName: "The Archfey (Pact of the Blade)",
    aliases: ["archfey blade warlock", "archfey warlock (blade)", "archfey pact of the blade warlock"] },
  { templateId: "celestial-warlock", className: "warlock", subclassName: "The Celestial",
    aliases: ["celestial warlock", "the celestial warlock", "celestial patron warlock"] },
  { templateId: "celestial-warlock-blade", className: "warlock", subclassName: "The Celestial (Pact of the Blade)",
    aliases: ["celestial blade warlock", "celestial warlock (blade)", "celestial pact of the blade warlock"] },
  { templateId: "fathomless-warlock", className: "warlock", subclassName: "The Fathomless",
    aliases: ["fathomless warlock", "the fathomless warlock", "fathomless patron warlock"] },
  { templateId: "fathomless-warlock-blade", className: "warlock", subclassName: "The Fathomless (Pact of the Blade)",
    aliases: ["fathomless blade warlock", "fathomless warlock (blade)", "fathomless pact of the blade warlock"] },
  { templateId: "fiend-warlock", className: "warlock", subclassName: "The Fiend",
    aliases: ["warlock", "fiend warlock", "the fiend warlock", "fiend patron warlock"] },
  { templateId: "fiend-warlock-blade", className: "warlock", subclassName: "The Fiend (Pact of the Blade)",
    aliases: ["fiend blade warlock", "fiend warlock (blade)", "fiend pact of the blade warlock"] },
  { templateId: "great-old-one-warlock", className: "warlock", subclassName: "The Great Old One",
    aliases: ["great old one warlock", "the great old one warlock", "goo warlock", "great old one patron warlock"] },
  { templateId: "great-old-one-warlock-blade", className: "warlock", subclassName: "The Great Old One (Pact of the Blade)",
    aliases: ["great old one blade warlock", "great old one warlock (blade)", "great old one pact of the blade warlock"] },
  { templateId: "hexblade-warlock", className: "warlock", subclassName: "The Hexblade",
    aliases: ["hexblade warlock", "the hexblade warlock", "hexblade patron warlock"] },
  { templateId: "hexblade-warlock-tome", className: "warlock", subclassName: "The Hexblade (Pact of the Tome)",
    aliases: ["hexblade tome warlock", "hexblade warlock (tome)", "hexblade eldritch blast warlock"] },
  { templateId: "undead-warlock", className: "warlock", subclassName: "The Undead",
    aliases: ["undead warlock", "the undead warlock", "undead patron warlock"] },
  { templateId: "undead-warlock-blade", className: "warlock", subclassName: "The Undead (Pact of the Blade)",
    aliases: ["undead blade warlock", "undead warlock (blade)", "undead pact of the blade warlock"] },
  { templateId: "undying-warlock", className: "warlock", subclassName: "The Undying",
    aliases: ["undying warlock", "the undying warlock", "undying patron warlock"] },
  { templateId: "undying-warlock-blade", className: "warlock", subclassName: "The Undying (Pact of the Blade)",
    aliases: ["undying blade warlock", "undying warlock (blade)", "undying pact of the blade warlock"] },
  { templateId: "dao-genie-warlock", className: "warlock", subclassName: "The Genie (Dao)",
    aliases: ["dao genie warlock", "genie warlock (dao)", "dao warlock", "the genie (dao) warlock"] },
  { templateId: "dao-genie-warlock-blade", className: "warlock", subclassName: "The Genie (Dao, Pact of the Blade)",
    aliases: ["dao genie blade warlock", "genie warlock (dao, blade)"] },
  { templateId: "djinni-genie-warlock", className: "warlock", subclassName: "The Genie (Djinni)",
    aliases: ["djinni genie warlock", "genie warlock (djinni)", "djinni warlock", "the genie (djinni) warlock"] },
  { templateId: "djinni-genie-warlock-blade", className: "warlock", subclassName: "The Genie (Djinni, Pact of the Blade)",
    aliases: ["djinni genie blade warlock", "genie warlock (djinni, blade)"] },
  { templateId: "efreeti-genie-warlock", className: "warlock", subclassName: "The Genie (Efreeti)",
    aliases: ["efreeti genie warlock", "genie warlock (efreeti)", "efreeti warlock", "the genie (efreeti) warlock"] },
  { templateId: "efreeti-genie-warlock-blade", className: "warlock", subclassName: "The Genie (Efreeti, Pact of the Blade)",
    aliases: ["efreeti genie blade warlock", "genie warlock (efreeti, blade)"] },
  { templateId: "marid-genie-warlock", className: "warlock", subclassName: "The Genie (Marid)",
    aliases: ["marid genie warlock", "genie warlock (marid)", "marid warlock", "the genie (marid) warlock"] },
  { templateId: "marid-genie-warlock-blade", className: "warlock", subclassName: "The Genie (Marid, Pact of the Blade)",
    aliases: ["marid genie blade warlock", "genie warlock (marid, blade)"] },
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
