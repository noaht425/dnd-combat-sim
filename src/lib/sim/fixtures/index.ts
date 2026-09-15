// The simulator's built-in combatants: a small SRD 5.2.1 monster set (see
// srd.ts) plus one hand-authored PC. Homebrew campaign stat blocks are NOT
// bundled — they load at runtime from a git-ignored local JSON file via the
// "Load custom monsters" picker (see fixtures/local/, loadCustomMonsters in
// ui.ts). Every fixture parses and passes validate.ts — see tests/sim-schema.

import type { Combatant } from "../schema";

import {
  SRD_MONSTERS,
  ogre,
  banditCaptain,
  gladiator,
  youngGoldDragon,
  adultRedDragon,
  tarrasque,
} from "./srd";
import { SRD_EXTRA } from "./srd-extra";
import { pcFighter15 } from "./pc-fighter-15";

export { ogre, banditCaptain, gladiator, youngGoldDragon, adultRedDragon, tarrasque, pcFighter15 };

/** Built-in enemy stat blocks shown in the picker before any custom import. */
export const MONSTER_FIXTURES: Combatant[] = [...SRD_MONSTERS, ...SRD_EXTRA];

export const PC_FIXTURES: Combatant[] = [pcFighter15];
export const ALL_FIXTURES: Combatant[] = [...MONSTER_FIXTURES, ...PC_FIXTURES];

export const FIXTURES_BY_ID: Record<string, Combatant> = Object.fromEntries(
  ALL_FIXTURES.map((c) => [c.id, c]),
);
