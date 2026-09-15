// Setup builder: turns "draconic sorcerer level 12" (or a comma-separated
// fully-specified line) into a PartyMemberSpec, and "five cultists, a bandit
// captain" into enemy id strings the engine's resolveEnemies understands.
//
// v1 scope: class + level (+ an optional name) for party members. Ability
// score / spell / feat overrides from the fully-specified tier of the spec
// aren't wired up yet — anything past class/level is currently ignored, and
// the build summary says so, rather than silently dropping it.

import type { PartyMemberSpec } from "../sim/engine/scenario";
import { findClassTemplate, type ClassAlias } from "./classTemplates";
import { findMonster } from "./monsters";
import { normalize } from "./fuzzy";

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

export interface PartyMemberParse {
  ok: boolean;
  spec?: PartyMemberSpec;
  classInfo?: ClassAlias;
  level?: number;
  levelAssumed?: boolean;
  ignoredDetail?: string;
  error?: string;
  suggestions?: ClassAlias[];
}

const DEFAULT_LEVEL = 5;

/** Parse one party member's spec text — "draconic sorcerer level 12" or the
 *  richer "sorcerer level 10, CHA 19, knows fireball" (the part after the
 *  first comma is currently noted, not applied). */
export function parsePartyMember(text: string): PartyMemberParse {
  const [head, ...rest] = text.split(",");
  const n = normalize(head);

  const levelMatch = n.match(/level\s*(\d{1,2})|\blvl\s*(\d{1,2})|\b(\d{1,2})(?:st|nd|rd|th)?\s*level\b/);
  const level = levelMatch ? Number(levelMatch[1] ?? levelMatch[2] ?? levelMatch[3]) : undefined;
  const classText = n.replace(/level\s*\d{1,2}|\blvl\s*\d{1,2}|\b\d{1,2}(?:st|nd|rd|th)?\s*level\b/g, "").trim();

  const nameMatch = head.match(/\bnamed\s+([a-z][a-z' -]*)/i) ?? head.match(/\bcalled\s+([a-z][a-z' -]*)/i);
  const name = nameMatch?.[1]?.trim();

  const { match, suggestions } = findClassTemplate(classText || n);
  if (!match) {
    return { ok: false, error: `couldn't tell what class "${head.trim()}" is`, suggestions };
  }

  const lvl = Math.max(1, Math.min(20, level ?? DEFAULT_LEVEL));
  const spec: PartyMemberSpec = { template: match.templateId, level: lvl, name: name || undefined };

  return {
    ok: true,
    spec,
    classInfo: match,
    level: lvl,
    levelAssumed: level === undefined,
    ignoredDetail: rest.length ? rest.join(",").trim() : undefined,
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
 *  two, the handful of things that matter in a fight. v1's templates are
 *  fixed builds (no per-PC ability/feat picks yet), so the summary is the
 *  template's own headline stats rather than a generated one. */
export function buildSummaryLine(p: PartyMemberParse): string {
  if (!p.ok || !p.spec || !p.classInfo) return "";
  const name = p.spec.name ? `${p.spec.name} — ` : "";
  const lvlNote = p.levelAssumed ? ` (level not given, defaulted to ${p.level})` : "";
  const ignored = p.ignoredDetail
    ? ` — heads up: "${p.ignoredDetail}" wasn't applied yet (ability score / spell / feat picks aren't wired up in this build)`
    : "";
  return `${name}${p.classInfo.subclassName} ${p.classInfo.className} ${p.level}${lvlNote}, a standard ${p.classInfo.className} build${ignored}.`;
}
