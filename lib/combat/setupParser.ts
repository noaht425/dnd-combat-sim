// Setup builder: turns "draconic sorcerer level 12" (or a comma-separated
// fully-specified line) into a PartyMemberSpec, and "five cultists, a bandit
// captain" into enemy id strings the engine's resolveEnemies understands.
//
// Class + level + name always apply. Race / feats / magic items / (for
// casters) specific spells from the fully-specified tier now apply too, via
// detailParser.ts — buildParty() already had appliers for all of these
// waiting on PartyMemberSpec fields nothing was ever populating. Raw ability-
// score overrides ("CHA 19") are seen but not applied — see detailParser.ts's
// header comment for why — and stay reported rather than silently dropped.

import { buildParty, type PartyMemberSpec } from "../sim/engine/scenario";
import { abilityMod } from "../sim/math";
import { findClassTemplate, type ClassAlias } from "./classTemplates";
import { findMonster } from "./monsters";
import { parseDetails, type DetailParse } from "./detailParser";
import { normalize, similarity } from "./fuzzy";

// There's exactly one built-in subclass per class (see classTemplates.ts's
// header) — if the player named a different one, say so instead of silently
// building the wrong subclass with no indication beyond the summary line's
// subclass name. Compares only the text left over after the bare class name
// against the subclass we actually used, since e.g. "circle of the land"
// vs "circle of the moon" still scores ~0.8 on whole-phrase similarity
// (they share 3 of 4 words) — high enough to hide a real mismatch.
function mentionedDifferentSubclass(classText: string, match: ClassAlias): string | undefined {
  const typed = normalize(classText);
  const bareClass = normalize(match.className);
  if (!typed || typed === bareClass) return undefined;
  const extra = typed.replace(new RegExp(`\\b${bareClass}\\b`), "").replace(/\s+/g, " ").trim();
  if (!extra) return undefined;
  if (similarity(extra, normalize(match.subclassName)) >= 0.9) return undefined;
  return `only ${match.subclassName} ${match.className} is built right now — used that instead`;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// levels don't take "a"/"an" ("level a" is nonsensical) — a separate map so
// the level regex below can't accidentally match on those.
const LEVEL_WORDS: Record<string, number> = Object.fromEntries(Object.entries(NUMBER_WORDS).filter(([k]) => k !== "a" && k !== "an"));
// dictation renders small numbers as words ("level five"), not digits
// ("level 5") — voice input hit this a lot, so both forms have to match.
const LEVEL_NUM = `(?:\\d{1,2}|${Object.keys(LEVEL_WORDS).join("|")})`;
const levelValue = (raw: string): number => (/^\d+$/.test(raw) ? Number(raw) : LEVEL_WORDS[raw]);

export interface PartyMemberParse {
  ok: boolean;
  spec?: PartyMemberSpec;
  classInfo?: ClassAlias;
  level?: number;
  levelAssumed?: boolean;
  /** race/feats/items/spells that WERE recognized and applied — for the build summary */
  details?: DetailParse;
  /** text that didn't parse as anything (unrecognized segments + seen-but-unapplied ability scores) */
  ignoredDetail?: string;
  /** set when the player named a subclass other than the one built-in template
   *  for this class — there's exactly one per class today (classTemplates.ts) */
  subclassNote?: string;
  error?: string;
  suggestions?: ClassAlias[];
}

const DEFAULT_LEVEL = 5;

/** Parse one party member's spec text — "draconic sorcerer level 12" or the
 *  richer "sorcerer level 10, CHA 19, Resilient (Con), knows fireball". */
export function parsePartyMember(text: string): PartyMemberParse {
  const [head, ...rest] = text.split(",");
  const n = normalize(head);

  const levelMatch = n.match(new RegExp(`\\blevel\\s*(${LEVEL_NUM})\\b|\\blvl\\s*(${LEVEL_NUM})\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*level\\b`));
  const level = levelMatch ? levelValue(levelMatch[1] ?? levelMatch[2] ?? levelMatch[3]) : undefined;
  const classText = n
    .replace(new RegExp(`\\blevel\\s*${LEVEL_NUM}\\b|\\blvl\\s*${LEVEL_NUM}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s*level\\b`, "g"), "")
    .trim();

  const nameMatch = head.match(/\bnamed\s+([a-z][a-z' -]*)/i) ?? head.match(/\bcalled\s+([a-z][a-z' -]*)/i);
  const name = nameMatch?.[1]?.trim();

  const { match, suggestions } = findClassTemplate(classText || n);
  if (!match) {
    return { ok: false, error: `couldn't tell what class "${head.trim()}" is`, suggestions };
  }

  const lvl = Math.max(1, Math.min(20, level ?? DEFAULT_LEVEL));
  const restText = rest.join(",").trim();
  const details = restText ? parseDetails(restText, match.className) : undefined;

  const spec: PartyMemberSpec = {
    template: match.templateId,
    level: lvl,
    name: name || undefined,
    race: details?.race,
    feats: details?.feats.length ? details.feats : undefined,
    items: details?.items.length ? details.items : undefined,
    spells: details?.spells.length ? details.spells : undefined,
  };

  const subclassNote = mentionedDifferentSubclass(classText, match);
  const ignoredParts = [
    ...(details?.unrecognized ?? []),
    ...(details?.abilityNotes.map((a) => `${a} (ability score overrides aren't wired up yet)`) ?? []),
  ];

  return {
    ok: true,
    spec,
    classInfo: match,
    level: lvl,
    levelAssumed: level === undefined,
    details,
    ignoredDetail: ignoredParts.length ? ignoredParts.join("; ") : undefined,
    subclassNote,
  };
}

export interface EnemyParse {
  ok: boolean;
  entries: string[]; // "id" or "id xN", ready for resolveEnemies
  names: string[]; // display names, for the summary line
  unknown: { text: string; suggestions: string[] }[];
}

/** Split "five cultists, a bandit captain and two orcs" into count+name
 *  chunks, then fuzzy-resolve each name against the fixture/minion set. */
export function parseEnemies(text: string): EnemyParse {
  const chunks = text
    .split(/,| and /i)
    .map((s) => s.trim())
    .filter(Boolean);

  const entries: string[] = [];
  const names: string[] = [];
  const unknown: { text: string; suggestions: string[] }[] = [];

  for (const chunk of chunks) {
    const n = normalize(chunk);
    const m = n.match(/^(\d+|[a-z]+)\s+(.*)$/);
    let count = 1;
    let namePart = n;
    if (m) {
      const num = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
      if (num !== undefined) {
        count = num;
        namePart = m[2];
      }
    }
    // crude singular fold for a trailing "s" plural ("goblins" -> "goblin")
    // when the count word signals a plural, so the fuzzy matcher sees the
    // fixture's singular display name.
    const query = count > 1 && namePart.endsWith("s") ? namePart.slice(0, -1) : namePart;
    const { monster, suggestions } = findMonster(query) ;
    if (!monster) {
      unknown.push({ text: chunk, suggestions: suggestions.map((s) => s.name) });
      continue;
    }
    entries.push(count > 1 ? `${monster.id} x${count}` : monster.id);
    names.push(count > 1 ? `${count}x ${monster.name}` : monster.name);
  }

  return { ok: unknown.length === 0 && entries.length > 0, entries, names, unknown };
}

/** The spoken-friendly build summary from spec §1.3 — key scores, a feat or
 *  two, the handful of spells/abilities that'll actually matter. Builds the
 *  real Combatant (cheap — one PC) so AC/HP/casting-stat are the character's
 *  actual numbers, not just "a standard X build". */
export function buildSummaryLine(p: PartyMemberParse): string {
  if (!p.ok || !p.spec || !p.classInfo) return "";
  const name = p.spec.name ? `${p.spec.name} — ` : "";
  const lvlNote = p.levelAssumed ? ` (level not given, defaulted to ${p.level})` : "";

  const built = buildParty([p.spec])[0];
  const stats: string[] = [`AC ${built.ac}`, `${built.maxHp} HP`];
  if (built.spellAbility) {
    const abbr = built.spellAbility.toUpperCase();
    stats.push(`${abbr} ${built.abilities[built.spellAbility]} (+${abilityMod(built.abilities[built.spellAbility])} to spells)`);
  }

  const d = p.details;
  const highlights: string[] = [];
  if (d?.race) highlights.push(d.race);
  if (d?.feats.length) highlights.push(...d.feats);
  if (d?.items.length) highlights.push(...d.items);
  if (d?.spellNames.length) highlights.push(`knows ${d.spellNames.join(", ")}`);
  const highlightNote = highlights.length ? ` — ${highlights.join(", ")}` : ", a standard build";

  const ignored = p.ignoredDetail ? ` (heads up: "${p.ignoredDetail}" wasn't applied)` : "";
  const subclass = p.subclassNote ? ` (heads up: ${p.subclassNote})` : "";

  return `${name}${p.classInfo.subclassName} ${p.classInfo.className} ${p.level}${lvlNote} · ${stats.join(", ")}${highlightNote}.${subclass}${ignored}`;
}
