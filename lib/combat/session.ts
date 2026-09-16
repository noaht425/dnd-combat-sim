// The whole fight's state, as one small JSON value. This IS spec §2.6's
// save/resume file — export this object to a .json file, re-import it, and
// the fight resumes exactly where it left off (the battle engine replays
// `decisions` / `reactionChoices` deterministically from `seed`).

import type { BattleSetup } from "../sim/battle";
import type { PartyMemberSpec } from "../sim/engine/scenario";

export interface SetupDraft {
  phase: "setup";
  party: PartyMemberSpec[];
  enemyEntries: string[];
  enemyNames: string[];
  seed: number;
}

export interface FightingSession {
  phase: "fighting" | "done";
  setup: BattleSetup;
  /** how many frames have already been narrated to the client */
  frameCursor: number;
}

export type FightSession = SetupDraft | FightingSession;

export function newSession(): SetupDraft {
  return { phase: "setup", party: [], enemyEntries: [], enemyNames: [], seed: Math.floor(Math.random() * 1_000_000) };
}

/** ids buildParty will assign, by array position — needed to fill BattleSetup.controlled. */
export function partyMemberIds(party: PartyMemberSpec[]): string[] {
  return party.map((s, i) => `pc-${i + 1}-${s.template}`);
}

/** Direct index-based removal for the setup picker's remove buttons — no
 *  need to round-trip through text parsing for something this unambiguous. */
export function removePartyMember(d: SetupDraft, index: number): SetupDraft {
  return { ...d, party: d.party.filter((_, i) => i !== index) };
}

export function removeEnemy(d: SetupDraft, index: number): SetupDraft {
  return { ...d, enemyEntries: d.enemyEntries.filter((_, i) => i !== index), enemyNames: d.enemyNames.filter((_, i) => i !== index) };
}
