// The creature type of each bundled monster, keyed by fixture id. The stat blocks are the 2014-era SRD ones (5.1: a goblin is 2d6 hit points, a
// kobold 2d6-2, a gnoll 5d8 — the 2024 versions are "Warrior"s with different numbers), so the types are the 2014 ones too: goblins, hobgoblins,
// bugbears, kobolds, gnolls and orcs are humanoids here (the 2024 book makes them fey, dragon and fiend). Source: Open5e's `srd-2014` creature list
// for every SRD creature; the Orc War Chief is a Monster Manual creature outside the SRD (humanoid).

import type { CreatureType } from "../schema";

export const SRD_TYPES: Record<string, CreatureType> = {
  ogre: "giant", troll: "giant", "hill-giant": "giant", "frost-giant": "giant", "fire-giant": "giant",
  "bandit-captain": "humanoid", gladiator: "humanoid", goblin: "humanoid", hobgoblin: "humanoid", kobold: "humanoid", orc: "humanoid",
  bugbear: "humanoid", gnoll: "humanoid", berserker: "humanoid", veteran: "humanoid", knight: "humanoid", mage: "humanoid", priest: "humanoid",
  "orc-war-chief": "humanoid",
  "young-gold-dragon": "dragon", "adult-red-dragon": "dragon", "young-white-dragon": "dragon", "young-blue-dragon": "dragon", wyvern: "dragon",
  tarrasque: "monstrosity", owlbear: "monstrosity",
  ghoul: "undead", ghast: "undead", wight: "undead", wraith: "undead",
  "dire-wolf": "beast", "giant-spider": "beast",
};
