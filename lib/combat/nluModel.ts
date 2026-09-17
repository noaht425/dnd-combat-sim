// A small locally-trained tagger that replaces regex clause-splitting as the
// segmentation front end for interpretTurnCommand (spec §4 / the "brain"
// discussed in-session): for each normalized token, predicts one of
// O / ACTION / TARGET / MOVE / DIR. Everything downstream (candidate
// matching, clarify questions, AoE origin) is untouched — this only decides
// *which words* are the action reference vs the target reference.
//
// Trained offline (tools/nlu/train.py) on synthetic examples generated from
// this game's own catalog + injected typos, entirely local — no LLM, no
// network call, ~180KB of committed weights. See tools/nlu/README.md.
//
// The feature hashing here MUST match tools/nlu/features.py bucket-for-bucket
// (verified: identical FNV-1a output for the same strings) — the weights
// were trained against that exact bucket assignment, so any drift here
// silently turns the model into noise.

import weightsData from "./nluWeights.json";
import { SPELLS } from "../sim/spells/catalog";
import { MONSTER_FIXTURES } from "../sim/fixtures";
import { TEMPLATE_IDS, makeTemplate } from "../sim/engine/templates";

export type Tag = "O" | "ACTION" | "TARGET" | "MOVE" | "DIR";

const TAGS = weightsData.tags as Tag[];
const DIM = weightsData.dim;
// [DIM][numTags] — flattened once into a typed array for fast lookup
const W = new Float32Array(DIM * TAGS.length);
for (let f = 0; f < DIM; f++) for (let t = 0; t < TAGS.length; t++) W[f * TAGS.length + t] = weightsData.W[f][t];
const B = Float32Array.from(weightsData.b);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bucket(feature: string): number {
  return fnv1a(feature) % DIM;
}

const MOVE_VERB_WORDS = new Set(
  [
    "move", "approach", "advance", "charge", "go", "walk", "run", "flee",
    "retreat", "withdraw", "back away", "fall back", "close the distance",
    "close in", "reposition",
  ].flatMap((phrase) => phrase.split(" ")),
);
const DIR_WORDS = new Set(["back", "away", "toward", "towards"]);
const CONNECTIVES = new Set(["then", "and"]);
const PREPS = new Set(["at", "on", "against", "toward", "towards", "the", "from"]);

/** words that appear in any real spell/monster/PC-action name in the current
 *  catalog — computed once from the game's own live data (not a shipped
 *  vocab snapshot) so it never goes stale as the catalog grows. */
let entityWordsCache: Set<string> | undefined;
function entityWords(): Set<string> {
  if (entityWordsCache) return entityWordsCache;
  const words = new Set<string>();
  const addName = (name: string) => {
    for (const w of name.toLowerCase().split(/\s+/)) {
      const clean = w.replace(/[^a-z0-9]/g, "");
      if (clean) words.add(clean);
    }
  };
  for (const sp of SPELLS) addName(sp.name);
  for (const m of MONSTER_FIXTURES) {
    addName(m.name);
    for (const a of m.actions) addName(a.name);
  }
  for (const id of TEMPLATE_IDS) {
    for (const lvl of [3, 9, 15]) {
      const c = makeTemplate(id, lvl);
      for (const a of c.actions) addName(a.name);
      for (const r of c.reactions ?? []) addName(r.name);
    }
  }
  entityWordsCache = words;
  return words;
}

function tokenFeatures(tokens: string[], i: number): number[] {
  const tok = tokens[i];
  const prev = i > 0 ? tokens[i - 1] : "<bos>";
  const next = i + 1 < tokens.length ? tokens[i + 1] : "<eos>";
  const ew = entityWords();
  const feats = [`w:${tok}`, `w-1:${prev}`, `w+1:${next}`];

  const padded = `^${tok}$`;
  for (let j = 0; j < padded.length - 2; j++) feats.push(`c:${padded.slice(j, j + 3)}`);

  if (/^\d+$/.test(tok)) feats.push("isdigit");
  feats.push(`len:${Math.min(tok.length, 6)}`);
  if (CONNECTIVES.has(tok)) feats.push("conn");
  if (PREPS.has(tok)) feats.push("prep");
  if (MOVE_VERB_WORDS.has(tok)) feats.push("movew");
  if (DIR_WORDS.has(tok)) feats.push("dirw");
  if (ew.has(tok)) feats.push("entw");
  if (ew.has(prev)) feats.push("entw-1");
  if (ew.has(next)) feats.push("entw+1");

  return feats.map(bucket);
}

/** tags every token; length matches `tokens`. */
export function tagTokens(tokens: string[]): Tag[] {
  const nTags = TAGS.length;
  return tokens.map((_, i) => {
    const feats = tokenFeatures(tokens, i);
    const z = Float32Array.from(B);
    for (const f of feats) for (let t = 0; t < nTags; t++) z[t] += W[f * nTags + t];
    let best = 0;
    for (let t = 1; t < nTags; t++) if (z[t] > z[best]) best = t;
    return TAGS[best];
  });
}

export interface TaggedSpan {
  tag: Tag;
  text: string;
}

/** groups tag-per-token into contiguous same-tag spans, dropping O/DIR (they
 *  carry no downstream meaning once segmentation is done — DIR's only job
 *  was keeping words like "back" out of the ACTION/TARGET spans). */
export function significantSpans(tokens: string[], tags: Tag[]): TaggedSpan[] {
  const spans: TaggedSpan[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tag = tags[i];
    let j = i + 1;
    while (j < tokens.length && tags[j] === tag) j++;
    if (tag === "ACTION" || tag === "TARGET" || tag === "MOVE") {
      spans.push({ tag, text: tokens.slice(i, j).join(" ") });
    }
    i = j;
  }
  return spans;
}
