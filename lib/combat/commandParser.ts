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

export type CommandResult =
  | { kind: "decision"; decision: BattleDecision; notes: string[] }
  | { kind: "clarify"; question: string }
  | { kind: "reaction-mismatch" }; // a reaction is pending — caller should route there instead

const HOLD_WORDS = /^(hold|pass|wait|do nothing|nothing|skip( (my )?turn)?|end turn)\.?$/;
const MOVE_VERBS = /\b(move|approach|advance|charge|go|walk|run|flee|retreat|withdraw|back away|fall back|close (the )?distance|close in|reposition)\b/;
const RETREAT_VERBS = /\b(retreat|withdraw|back away|fall back|flee|disengage)\b/;
const DASH_WORDS = /\bdash\b/;

function findBestAction(text: string, pool: AwaitAction[]): { action: AwaitAction; score: number } | undefined {
  if (!pool.length) return undefined;
  const scored = pool
    .map((a) => ({ a, s: Math.max(similarity(text, a.name), similarity(text, a.id.replace(/-/g, " "))) }))
    .sort((x, y) => y.s - x.s);
  return scored[0].s >= 0.5 ? { action: scored[0].a, score: scored[0].s } : undefined;
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

function extractTargetPhrase(clause: string): string | undefined {
  const m =
    clause.match(/\b(?:at|on|against|toward|towards)\s+(.+)$/) ??
    clause.match(/\battack\s+(.+)$/) ??
    clause.match(/\bcast\s+\S+\s+(?:at|on)?\s*(.+)$/);
  return m?.[1]?.trim();
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

  // split into clauses on "then"/"and" — first movement-shaped clause becomes
  // the move, the rest are tried as main action then bonus action, in order
  const clauses = n.split(/\bthen\b|\band\b|,/).map((c) => c.trim()).filter(Boolean);

  let move: { x: number; y: number } | undefined;
  const actionClauses: string[] = [];
  const notes: string[] = [];

  for (const clause of clauses) {
    const coordMatch = clause.match(/\bmove to\s+(\d+)\s*,\s*(\d+)/);
    if (coordMatch) {
      move = { x: Number(coordMatch[1]), y: Number(coordMatch[2]) };
      continue;
    }
    if (DASH_WORDS.test(clause) && !MOVE_VERBS.test(clause.replace(DASH_WORDS, ""))) {
      notes.push("(dash noted — this build doesn't model doubled movement from Dash yet; moving at normal speed.)");
      continue;
    }
    if (MOVE_VERBS.test(clause)) {
      const dir: "toward" | "away" = RETREAT_VERBS.test(clause) ? "away" : "toward";
      const targetPhrase = clause.replace(MOVE_VERBS, "").replace(/\b(to|the|towards?)\b/g, "").trim();
      let anchor: { x: number; y: number } | undefined;
      if (targetPhrase) {
        const r = resolveTarget(targetPhrase, units, self, "monster");
        if (r.kind === "ambiguous") {
          return { kind: "clarify", question: `Which one — ${r.candidates.map((c) => c.name).join(", ")}?` };
        }
        if (r.kind === "found") anchor = pickAnchor(awaiting, r.unit, dir);
      } else if (dir === "away") {
        const nearestEnemy = [...units.filter((u) => u.side === "monster")].sort(
          (a, b) =>
            Math.hypot(a.box.x0 - self.box.x0, a.box.y0 - self.box.y0) -
            Math.hypot(b.box.x0 - self.box.x0, b.box.y0 - self.box.y0),
        )[0];
        anchor = pickAnchor(awaiting, nearestEnemy, "away");
      }
      if (anchor) move = anchor;
      continue;
    }
    actionClauses.push(clause);
  }

  let actionId: string | undefined;
  let targetId: string | undefined;
  let aoeOrigin: { x: number; y: number } | undefined;
  let bonusActionId: string | undefined;
  let bonusTargetId: string | undefined;

  const resolvePool = (clause: string, pool: AwaitAction[]): { action: AwaitAction; targetPhrase?: string } | undefined => {
    const found = findBestAction(clause, pool);
    if (!found) return undefined;
    return { action: found.action, targetPhrase: extractTargetPhrase(clause) };
  };

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

  for (const clause of actionClauses) {
    if (!actionId) {
      const main = resolvePool(clause, awaiting.actions);
      if (main) {
        actionId = main.action.id;
        const phrase = main.targetPhrase ?? clause.replace(main.action.name.toLowerCase(), "").trim();
        const r = resolveActionTarget(main.action, phrase);
        if ("clarify" in r) return { kind: "clarify", question: r.clarify };
        targetId = r.targetId;
        aoeOrigin = r.aoeOrigin;
        continue;
      }
    }
    if (!bonusActionId) {
      const bonus = resolvePool(clause, awaiting.bonusActions);
      if (bonus) {
        bonusActionId = bonus.action.id;
        const phrase = bonus.targetPhrase ?? clause.replace(bonus.action.name.toLowerCase(), "").trim();
        const r = resolveActionTarget(bonus.action, phrase);
        if ("clarify" in r) return { kind: "clarify", question: r.clarify };
        bonusTargetId = r.targetId;
        continue;
      }
    }
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
