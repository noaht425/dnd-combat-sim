// Turns a player's free-text turn command into a BattleDecision (spec §4).
// Deliberately rigid-but-broad for v1: a fat synonym layer over "move" /
// "attack" / "hold", relational target qualifiers via targetResolver, and a
// narrow clarifying question instead of a hard error when it can't parse.
// Expand MOVE_WORDS / HOLD_WORDS / the verb-matching threshold over time —
// spec §4 explicitly wants "start rigid, expand coverage."

import type { AwaitAction, AwaitingInput } from "../sim/battle";
import type { BattleDecision } from "../sim/battle/control";
import { normalize, similarity } from "./fuzzy";
import { liveUnits, resolveTarget, type LiveUnit } from "./targetResolver";
import type { UnitSnap } from "../sim/battle/state";
import { tagTokens, significantSpans } from "./nluModel";

export type CommandResult =
  | { kind: "decision"; decision: BattleDecision; notes: string[] }
  | { kind: "clarify"; question: string }
  | { kind: "reaction-mismatch" }; // a reaction is pending — caller should route there instead

const HOLD_WORDS = /^(hold|pass|wait|do nothing|nothing|skip( (my )?turn)?|end turn)\.?$/;
const MOVE_VERBS = /\b(move|approach|advance|charge|go|walk|run|flee|retreat|withdraw|back away|fall back|close (the )?distance|close in|reposition)\b/;
const RETREAT_VERBS = /\b(retreat|withdraw|back away|fall back|flee|disengage)\b/;
const DASH_WORDS = /\bdash\b/;

// Scoring the action name against the WHOLE clause badly dilutes it once a
// target phrase is tacked on — "attack the goblin" vs "attack" and
// "cast fireball at the ogre" vs "Fireball" both used to score too low to
// match. Instead score every contiguous word n-gram of the clause (up to 4
// words — action names run 1-3 words) against each action and take the best
// hit anywhere in the clause; the target phrase is resolved separately via
// extractTargetPhrase / the trailing remainder.
export function findBestAction(text: string, pool: AwaitAction[]): { action: AwaitAction; score: number } | undefined {
  if (!pool.length) return undefined;
  const words = normalize(text).split(" ").filter(Boolean);
  const windows: string[] = [];
  for (let start = 0; start < words.length; start++) {
    for (let len = 1; len <= Math.min(4, words.length - start); len++) {
      windows.push(words.slice(start, start + len).join(" "));
    }
  }
  let best: { action: AwaitAction; score: number } | undefined;
  for (const a of pool) {
    const targets = [a.name, a.id.replace(/-/g, " ")];
    let s = 0;
    for (const w of windows) for (const t of targets) s = Math.max(s, similarity(w, t));
    if (!best || s > best.score) best = { action: a, score: s };
  }
  return best && best.score >= 0.5 ? best : undefined;
}

/** best reachable anchor cell (from `awaiting.reachable`) minimizing/maximizing
 *  distance to `target`'s box, per `dir` — used for "approach X" / "retreat". */
function pickAnchor(awaiting: AwaitingInput, target: LiveUnit | undefined, dir: "toward" | "away"): { x: number; y: number } | undefined {
  const cells = awaiting.reachable.map((s) => {
    const [x, y] = s.split(",").map(Number);
    return { x, y };
  });
  if (!cells.length) return undefined;
  if (!target) {
    // no named target: "retreat"/"advance" with nothing to anchor on — no-op move
    return undefined;
  }
  const tc = { x: (target.box.x0 + target.box.x1) / 2, y: (target.box.y0 + target.box.y1) / 2 };
  const dist = (c: { x: number; y: number }) => Math.hypot(c.x - tc.x, c.y - tc.y);
  const sorted = [...cells].sort((a, b) => (dir === "toward" ? dist(a) - dist(b) : dist(b) - dist(a)));
  return sorted[0];
}

function nearestLiving(units: LiveUnit[], self: LiveUnit, side: "party" | "monster"): LiveUnit | undefined {
  return [...units.filter((u) => u.side === side && u.id !== self.id)].sort(
    (a, b) => Math.hypot(a.box.x0 - self.box.x0, a.box.y0 - self.box.y0) - Math.hypot(b.box.x0 - self.box.x0, b.box.y0 - self.box.y0),
  )[0];
}

export function interpretTurnCommand(
  text: string,
  awaiting: AwaitingInput,
  lastSnap: UnitSnap[] | undefined,
): CommandResult {
  const raw = text.trim();
  const n = normalize(raw);
  if (!n) return { kind: "clarify", question: `What should ${awaiting.unitName} do?` };
  if (HOLD_WORDS.test(n)) return { kind: "decision", decision: { round: awaiting.round, unitId: awaiting.unitId }, notes: [`${awaiting.unitName} holds.`] };

  const units = liveUnits(awaiting.units, lastSnap);
  const self = units.find((u) => u.id === awaiting.unitId);
  if (!self) return { kind: "clarify", question: "I lost track of who's acting — try again?" };

  let move: { x: number; y: number } | undefined;
  const notes: string[] = [];
  let working = n;

  // an exact coordinate ("move to 5,7") and bare "dash" are precise
  // syntactic keywords, not a segmentation problem — handled directly rather
  // than asking the tagger to learn two patterns it'll never see naturally
  const coordMatch = n.match(/\bmove to\s+(\d+)\s*,\s*(\d+)/);
  if (coordMatch) {
    move = { x: Number(coordMatch[1]), y: Number(coordMatch[2]) };
    working = working.replace(coordMatch[0], " ").trim();
  }
  if (DASH_WORDS.test(working) && !MOVE_VERBS.test(working.replace(DASH_WORDS, ""))) {
    // bare "dash" (no verb telling it which way) reads as "close the
    // distance" — matches its own note below, rather than being a pure
    // no-op that CLAIMS it moved at normal speed but doesn't move at all
    notes.push("(dash noted — this build doesn't model doubled movement from Dash yet; moving toward the nearest enemy at normal speed.)");
    const anchor = pickAnchor(awaiting, nearestLiving(units, self, "monster"), "toward");
    if (anchor && !move) move = anchor;
    working = working.replace(DASH_WORDS, " ").trim();
  }

  // segmentation: a locally-trained tagger (tools/nlu — no LLM, no network
  // call) marks each remaining word O / ACTION / TARGET / MOVE / DIR, then
  // spans are paired (each MOVE/ACTION claims the TARGET span(s) immediately
  // following it) — replaces the old regex clause-splitter, which is what
  // mismatched "back" against the Weapon action's id "attack" and similar.
  const tokens = working.split(" ").filter(Boolean);

  let actionId: string | undefined;
  let targetId: string | undefined;
  let aoeOrigin: { x: number; y: number } | undefined;
  let bonusActionId: string | undefined;
  let bonusTargetId: string | undefined;

  // Resolve a target for `action` given the clause's target phrase (possibly
  // empty). Spec §4.1: a qualifier or a confident name resolves silently; a
  // named-but-ambiguous or unresolved reference against MORE THAN ONE enemy
  // is asked about, never guessed. Only "no reference at all, and it doesn't
  // matter because there's just one enemy" is left to the engine's own
  // built-in nearest-enemy default (an AoE always needs an explicit aim).
  const resolveActionTarget = (
    action: AwaitAction,
    phrase: string | undefined,
  ): { targetId?: string; aoeOrigin?: { x: number; y: number } } | { clarify: string } => {
    // Bless-style effects hit every ally/enemy automatically — there's no
    // single unit to resolve a phrase against, so a named target (or several,
    // comma-separated) is a no-op rather than an ambiguity to clarify.
    if (action.autoTargets) return {};
    const side = action.friendly ? "party" : "monster";
    const enemyCount = units.filter((u) => u.side === "monster").length;
    if (phrase) {
      const r = resolveTarget(phrase, units, self, side);
      if (r.kind === "ambiguous") return { clarify: `Which one — ${r.candidates.map((c) => c.name).join(", ")}?` };
      if (r.kind === "found") {
        const aoeOrigin = action.aoe ? { x: Math.round((r.unit.box.x0 + r.unit.box.x1) / 2), y: Math.round((r.unit.box.y0 + r.unit.box.y1) / 2) } : undefined;
        return { targetId: r.unit.id, aoeOrigin };
      }
      // couldn't match the phrase to anyone
      if (action.aoe) return { clarify: `Where should ${awaiting.unitName} aim ${action.name} — name a target?` };
      if (!action.friendly && enemyCount > 1) return { clarify: `${action.name} on who? I don't recognize "${phrase}" — options: ${units.filter((u) => u.side === "monster").map((u) => u.name).join(", ")}.` };
      return {}; // single enemy (or a friendly heal) — the engine's own default is unambiguous here
    }
    if (action.aoe) return { clarify: `Where should ${awaiting.unitName} aim ${action.name} — name a target?` };
    if (!action.friendly && enemyCount > 1) return { clarify: `${action.name} on who?` };
    return {};
  };

  if (tokens.length) {
    const tags = tagTokens(tokens);
    const spans = significantSpans(tokens, tags);

    // pair each MOVE/ACTION span with the TARGET span(s) immediately
    // following it (before the next MOVE/ACTION) — mirrors "clause order"
    // without needing clause delimiters, since connectives are tagged O and
    // fall out of significantSpans already
    type Entry = { kind: "move" | "action"; text: string; targetText?: string };
    const entries: Entry[] = [];
    const leftoverTargets: string[] = [];
    for (const span of spans) {
      if (span.tag === "TARGET") {
        const last = entries.at(-1);
        if (last) last.targetText = last.targetText ? `${last.targetText} ${span.text}` : span.text;
        else leftoverTargets.push(span.text);
        continue;
      }
      entries.push({ kind: span.tag === "MOVE" ? "move" : "action", text: span.text });
    }

    for (const entry of entries) {
      if (entry.kind === "move") {
        if (move) continue; // an exact coord/dash already claimed the move
        const dir: "toward" | "away" = RETREAT_VERBS.test(entry.text) ? "away" : "toward";
        let anchor: { x: number; y: number } | undefined;
        if (entry.targetText) {
          const r = resolveTarget(entry.targetText, units, self, "monster");
          if (r.kind === "ambiguous") return { kind: "clarify", question: `Which one — ${r.candidates.map((c) => c.name).join(", ")}?` };
          if (r.kind === "found") anchor = pickAnchor(awaiting, r.unit, dir);
        } else {
          // no named target ("advance" / "retreat" alone) — anchor off the
          // nearest enemy either way, matching how the target-given case
          // already treats "away" as relative to whoever's closest
          anchor = pickAnchor(awaiting, nearestLiving(units, self, "monster"), dir);
        }
        if (anchor) move = anchor;
        continue;
      }

      // Check both pools and take whichever scores higher — matching main
      // first unconditionally let a borderline false-positive main match
      // beat an unambiguous bonus-action match just because main happened to
      // be checked first.
      const main = !actionId ? findBestAction(entry.text, awaiting.actions) : undefined;
      const bonus = !bonusActionId ? findBestAction(entry.text, awaiting.bonusActions) : undefined;
      if (main && (!bonus || main.score >= bonus.score)) {
        actionId = main.action.id;
        const r = resolveActionTarget(main.action, entry.targetText);
        if ("clarify" in r) return { kind: "clarify", question: r.clarify };
        targetId = r.targetId;
        aoeOrigin = r.aoeOrigin;
        continue;
      }
      if (bonus) {
        bonusActionId = bonus.action.id;
        // a bonus action named with no target of its own ("... then Action
        // Surge") isn't a fresh targeting decision — it's another swing this
        // same turn, so it defaults to whoever the main action just hit
        // rather than re-asking "on who?" for an attack the player didn't
        // separately aim.
        if (!entry.targetText && !bonus.action.friendly && !bonus.action.aoe && targetId) {
          bonusTargetId = targetId;
        } else {
          const r = resolveActionTarget(bonus.action, entry.targetText);
          if ("clarify" in r) return { kind: "clarify", question: r.clarify };
          bonusTargetId = r.targetId;
        }
        continue;
      }
      // this span didn't read as the main action, a bonus action, or a move
      // — most often a third action reference this build has no slot left
      // for (one main + one bonus). Say so instead of just dropping it.
      if (entry.text) notes.push(`(didn't know what to do with "${entry.text}" — ignored it.)`);
    }

    for (const t of leftoverTargets) notes.push(`(didn't know what to do with "${t}" — ignored it.)`);
  }

  if (!move && !actionId && !bonusActionId) {
    const names = [...awaiting.actions, ...awaiting.bonusActions].map((a) => a.name).join(", ") || "attack";
    return {
      kind: "clarify",
      question: `I got that ${awaiting.unitName} is acting, but not what to do. Options: ${names}, or "hold".`,
    };
  }

  return {
    kind: "decision",
    decision: { round: awaiting.round, unitId: awaiting.unitId, move, actionId, targetId, aoeOrigin, bonusActionId, bonusTargetId },
    notes,
  };
}
