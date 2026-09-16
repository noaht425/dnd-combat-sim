// The "fully specified" tier of spec §1.1 — everything past class+level in a
// party member's line: race, feats, magic items, and (for casters) specific
// spells. The engine already has appliers for all of this (buildParty already
// calls applyRace/applyFeats/applyItems/applyPickedSpells when a
// PartyMemberSpec carries these fields) — this module is purely the natural-
// language -> canonical-option-string layer on top, reusing the same
// fuzzy-match infrastructure as the class/monster parsers.
//
// Raw ability-score overrides ("CHA 19") are deliberately NOT applied here —
// the template builders bake attack/DC numbers in at construction time from a
// fixed per-level formula, not read live from `.abilities`, so a post-hoc
// score patch wouldn't actually change anything downstream. Flagged as a
// follow-up (would need the templates themselves to accept an override),
// not silently dropped: `abilityNotes` carries what was seen.

import { RACE_OPTIONS, FEAT_OPTIONS, ITEM_OPTIONS } from "../sim/engine/pc-extras";
import { SPELLS, spellsForClass } from "../sim/spells/catalog";
import type { SpellClass } from "../sim/spells/types";
import { bestMatch, normalize, type Candidate } from "./fuzzy";

export interface DetailParse {
  race?: string;
  feats: string[];
  items: string[];
  spells: string[]; // ids, ready for PartyMemberSpec.spells
  spellNames: string[]; // display names, for the summary line
  abilityNotes: string[]; // "CHA 19" style mentions seen but not applied
  unrecognized: string[];
}

const SPELL_CLASSES = new Set<SpellClass>(["wizard", "sorcerer", "cleric", "druid", "bard", "warlock", "paladin", "ranger", "artificer"]);

const ABILITY_RE = /\b(str|dex|con|int|wis|cha|strength|dexterity|constitution|intelligence|wisdom|charisma)\s*(\d{1,2})\b/gi;

// leading connector words that don't carry meaning on their own
// ("knows fireball" -> "fireball")
const LEADING_FILLER = /^(knows?|casts?|has|with|carrying|wielding|a|an|the)\s+/i;

const raceCandidates: Candidate<string>[] = RACE_OPTIONS.map((r) => ({ key: r, label: r, value: r }));
const featCandidates: Candidate<string>[] = FEAT_OPTIONS.map((f) => ({ key: f, label: f, value: f }));
const itemCandidates: Candidate<string>[] = ITEM_OPTIONS.map((i) => ({ key: i, label: i, value: i }));

const MATCH_THRESHOLD = 0.55;

/** `classKey` (e.g. "sorcerer") scopes spell matching to that class's list —
 *  omit for a non-caster class, where spell mentions won't be recognized. */
export function parseDetails(text: string, classKey?: string): DetailParse {
  const abilityNotes: string[] = [];
  const stripped = text.replace(ABILITY_RE, (m) => {
    abilityNotes.push(normalize(m));
    return "";
  });

  const segments = stripped
    .split(/,|;|\band\b/i)
    .map((s) => s.trim().replace(LEADING_FILLER, "").trim())
    .filter(Boolean);

  const spellPool = classKey && SPELL_CLASSES.has(classKey as SpellClass) ? spellsForClass(classKey as SpellClass) : [];
  const spellCandidates: Candidate<{ id: string; name: string }>[] = spellPool.map((s) => ({ key: s.name, label: s.name, value: { id: s.id, name: s.name } }));

  let race: string | undefined;
  const feats: string[] = [];
  const items: string[] = [];
  const spellIds: string[] = [];
  const spellNames: string[] = [];
  const unrecognized: string[] = [];

  for (const seg of segments) {
    const r = bestMatch(seg, raceCandidates);
    const f = bestMatch(seg, featCandidates);
    const i = bestMatch(seg, itemCandidates);
    const sp = spellCandidates.length ? bestMatch(seg, spellCandidates) : undefined;

    const options = [
      { kind: "race" as const, score: r.bestScore, value: r.best?.value },
      { kind: "feat" as const, score: f.bestScore, value: f.best?.value },
      { kind: "item" as const, score: i.bestScore, value: i.best?.value },
      ...(sp ? [{ kind: "spell" as const, score: sp.bestScore, value: sp.best?.value }] : []),
    ].sort((a, b) => b.score - a.score);

    const top = options[0];
    if (!top?.value || top.score < MATCH_THRESHOLD) {
      unrecognized.push(seg);
      continue;
    }
    if (top.kind === "race" && !race) race = top.value as string;
    else if (top.kind === "feat") {
      const v = top.value as string;
      if (!feats.includes(v)) feats.push(v);
    } else if (top.kind === "item") {
      const v = top.value as string;
      if (!items.includes(v)) items.push(v);
    } else if (top.kind === "spell") {
      const v = top.value as { id: string; name: string };
      if (!spellIds.includes(v.id)) {
        spellIds.push(v.id);
        spellNames.push(v.name);
      }
    } else {
      unrecognized.push(seg);
    }
  }

  return { race, feats, items, spells: spellIds, spellNames, abilityNotes, unrecognized };
}

// re-exported for a picker UI later, same pattern as classTemplates/monsters
export { RACE_OPTIONS, FEAT_OPTIONS, ITEM_OPTIONS };
export const SPELL_LIST = SPELLS;
