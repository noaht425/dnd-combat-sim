// The conversation state machine: setup chat -> run the fight -> post-fight
// readout. Every message re-derives the current engine state by calling
// runBattle(setup) (cheap, pure, deterministic) rather than keeping a mutable
// server-side fight object — the client just carries the session JSON.

import { runBattle, type AwaitingInput, type AwaitingReaction, type BattleOutcome, type BattleSetup } from "../sim/battle";
import { standardParty } from "../sim/engine/scenario";
import { parsePartyMember, parseEnemies, buildSummaryLine, type PartyMemberParse } from "./setupParser";
import { classAliasFor } from "./classTemplates";
import { interpretTurnCommand, findBestAction } from "./commandParser";
import { interpretReaction } from "./reactionParser";
import { narrateNewFrames, postFightReadout } from "./narrate";
import { newSession, partyMemberIds, type FightSession, type SetupDraft, type FightingSession } from "./session";
import { findCombatant } from "./actionLookup";
import { describeAction } from "./describeAction";
import { liveUnits, type LiveUnit } from "./targetResolver";
import type { UnitSnap } from "../sim/battle/state";

const INFO_ALL = /^(actions?|options?|spells?|weapons?|abilities|what can i do|show actions|list actions|my options)\??$/i;
const INFO_ONE = /^(?:describe|what does|what is|explain|details?(?: on| for)?|look at|examine)\s+(.+?)\??$/i;

/** "actions" / "spells" -> every current option with a plain-English line;
 *  "describe fireball" / "what does X do" -> just that one. Read-only — it
 *  doesn't consume a turn or touch decisions. Returns undefined when the
 *  message isn't an info query, so the caller falls through to normal
 *  turn-command parsing. */
function answerInfoQuery(message: string, setup: BattleSetup, awaiting: AwaitingInput): string[] | undefined {
  const trimmed = message.trim();
  const pool = [...awaiting.actions, ...awaiting.bonusActions];
  const combatant = findCombatant(setup, awaiting.unitId);

  if (INFO_ALL.test(trimmed)) {
    if (!combatant) return ["Couldn't look up that unit's sheet."];
    if (!pool.length) return ["No actions available right now."];
    return pool.map((a) => {
      const full = combatant.actions.find((x) => x.id === a.id);
      return full ? `${a.name}: ${describeAction(full, combatant.actions)}` : a.name;
    });
  }

  const one = trimmed.match(INFO_ONE);
  if (one) {
    if (!combatant) return ["Couldn't look up that unit's sheet."];
    const found = findBestAction(one[1], pool);
    if (!found) return [`I don't see an action matching "${one[1]}". Options: ${pool.map((a) => a.name).join(", ") || "none"}.`];
    const full = combatant.actions.find((x) => x.id === found.action.id);
    return [full ? `${found.action.name}: ${describeAction(full, combatant.actions)}` : `${found.action.name}: (no details found)`];
  }

  return undefined;
}

export interface AdvanceResult {
  session: FightSession;
  lines: string[];
  /** structured turn-choice data for a picker UI — set only while a controlled
   *  unit's turn is open (fighting phase, no reaction pending) */
  awaiting?: AwaitingInput;
  /** structured reaction-prompt data for a Yes/No picker UI */
  awaitingReaction?: AwaitingReaction;
  /** the live board (position + HP), for a target picker — only set while a
   *  turn is open, since it's built from `awaiting.units` (positions) */
  liveUnits?: LiveUnit[];
  /** every combatant's current HP/conditions, for a status roster — set
   *  whenever there's been at least one frame, including mid-reaction
   *  (unlike liveUnits, which needs an open turn to have positions to merge) */
  roster?: UnitSnap[];
}

/** Attaches the current turn/reaction/board state to a response so the UI can
 *  render buttons instead of parsing what came back as chat text. `outcome`
 *  is omitted for setup-phase responses, where none of this applies. */
function attachLive(session: FightSession, lines: string[], outcome?: BattleOutcome): AdvanceResult {
  if (!outcome) return { session, lines };
  return {
    session,
    lines,
    awaiting: outcome.awaiting,
    awaitingReaction: outcome.awaitingReaction,
    liveUnits: outcome.awaiting ? liveUnits(outcome.awaiting.units, outcome.frames.at(-1)?.units) : undefined,
    roster: outcome.frames.at(-1)?.units,
  };
}

const START_WORDS = /^(start|begin|fight|go|let'?s go|roll initiative)\.?$/i;

function draftSummary(d: SetupDraft): string[] {
  const lines: string[] = [];
  const memberLabel = (p: (typeof d.party)[number]) => `${p.name ?? classAliasFor(p.template)?.className ?? p.template} ${p.level}`;
  lines.push(d.party.length ? `Party so far: ${d.party.map(memberLabel).join(", ")}.` : "Party is empty.");
  lines.push(d.enemyNames.length ? `Enemies so far: ${d.enemyNames.join(", ")}.` : "No enemies yet.");
  if (d.party.length && d.enemyEntries.length) lines.push(`Say "start" when ready, or keep adding.`);
  return lines;
}

function startFight(d: SetupDraft): AdvanceResult {
  const setup = {
    party: d.party,
    enemies: d.enemyEntries,
    seed: d.seed,
    maxRounds: 30,
    recordFrames: true,
    controlled: partyMemberIds(d.party),
    decisions: [],
    reactionChoices: [],
  };
  const outcome = runBattle(setup);
  const session: FightingSession = { phase: outcome.done ? "done" : "fighting", setup, frameCursor: 0 };
  const { lines: narration, nextIndex } = narrateNewFrames(outcome.frames, 0);
  session.frameCursor = nextIndex;
  const lines = [...narration, ...promptLines(outcome)];
  return attachLive(session, lines, outcome);
}

function promptLines(outcome: BattleOutcome): string[] {
  if (outcome.awaitingReaction) {
    const r = outcome.awaitingReaction;
    // r.prompt already names the reacting unit ("Wizard 6 is taking...") —
    // don't prefix the name again. Round number isn't in the prompt text
    // itself, and this can fire before any frame for the round has been
    // narrated yet, so say it explicitly.
    return [`(Round ${r.round}) ${r.prompt} — ${r.takeLabel}, or ${r.declineLabel}?`];
  }
  if (outcome.awaiting) {
    const a = outcome.awaiting;
    const actionNames = [...a.actions, ...a.bonusActions].map((x) => x.name).join(", ");
    return [`${a.unitName}'s turn (round ${a.round}). Actions: ${actionNames || "none"}. (say "actions" for what they do, or "describe <name>" for one)`];
  }
  if (outcome.done) return [postFightReadout(outcome.result)];
  return [];
}

function handleSetupMessage(d: SetupDraft, message: string): AdvanceResult {
  const text = message.trim();
  const low = text.toLowerCase();

  if (/^(status|party|who|show)$/i.test(low)) return { session: d, lines: draftSummary(d) };

  if (START_WORDS.test(low)) {
    if (!d.party.length) return { session: d, lines: ["No party members yet — add at least one (e.g. \"draconic sorcerer level 12\")."] };
    if (!d.enemyEntries.length) return { session: d, lines: ["No enemies yet — say who you're fighting (e.g. \"enemies: an adult red dragon\")."] };
    return startFight(d);
  }

  const standardMatch = low.match(/^(standard|default) party(?: level (\d+))?/);
  if (standardMatch) {
    const lvl = standardMatch[2] ? Number(standardMatch[2]) : 5;
    const party = standardParty(lvl);
    const nd: SetupDraft = { ...d, party };
    return { session: nd, lines: [`Standard party loaded at level ${lvl}: ${party.map((p) => p.name).join(", ")}.`, ...draftSummary(nd)] };
  }

  const enemyMatch = text.match(/^(?:enem(?:y|ies)|vs\.?|versus|against|fight(?:ing)?)\s*:?\s*(.*)$/i);
  const addMatch = text.match(/^add\s+(.+)$/i);
  const vsSplit = text.match(/^(.+?)\s+(?:vs\.?|versus|against)\s+(.+)$/i);

  if (enemyMatch) return applyEnemyText(d, enemyMatch[1]);

  if (addMatch) return applyPartyText(d, addMatch[1]);

  if (vsSplit) {
    // one-shot "<party spec[s]> vs <enemy spec>" — parses both sides and
    // auto-starts, since both halves of the fight are now known (spec §1.3:
    // don't pause for approval once the setup is expressed).
    let cur = d;
    const memberClauses = vsSplit[1].split(/\band\b|;/i).map((s) => s.trim()).filter(Boolean);
    const lines: string[] = [];
    for (const clause of memberClauses) {
      const r = applyPartyText(cur, clause);
      cur = r.session as SetupDraft;
      lines.push(...r.lines);
    }
    const er = applyEnemyText(cur, vsSplit[2]);
    cur = er.session as SetupDraft;
    lines.push(...er.lines);
    if (cur.party.length && cur.enemyEntries.length) {
      const started = startFight(cur);
      // spread started, not just session/lines — dropping its
      // awaiting/awaitingReaction/roster meant the picker UI rendered
      // completely blank (no roster bar, no turn or reaction card) on the
      // very first frame of any fight kicked off this way, until the next
      // message repopulated it via the normal continueFight() path
      return { ...started, lines: [...lines, ...started.lines] };
    }
    return { session: cur, lines };
  }

  // bare minimal spec, e.g. "draconic sorcerer level 12"
  return applyPartyText(d, text);
}

/** Applies one already-parsed member to the draft, auto-disambiguating a
 *  repeated unnamed build so it has a unique display name. Returns the new
 *  draft + the build-summary line, WITHOUT the trailing draftSummary block
 *  (callers adding several members in one message add that once, at the end). */
function addOneMember(d: SetupDraft, p: PartyMemberParse): { draft: SetupDraft; line: string } {
  let spec = p.spec!;
  if (!spec.name) {
    const dupes = d.party.filter((m) => m.template === spec.template && m.level === spec.level).length;
    if (dupes > 0) spec = { ...spec, name: `${p.classInfo!.className[0].toUpperCase()}${p.classInfo!.className.slice(1)} ${spec.level} (${dupes + 1})` };
  }
  return { draft: { ...d, party: [...d.party, spec] }, line: buildSummaryLine(p) };
}

function applyPartyText(d: SetupDraft, text: string): AdvanceResult {
  // "wizard level 6, cleric level 6, rogue level 6" — a natural way to type
  // several party members in one message. Only treat commas/",and"/";" as
  // member separators when EVERY resulting segment independently parses as
  // its own class+level — that's what distinguishes this from the
  // fully-specified single-character syntax ("sorcerer level 10, CHA 19,
  // knows fireball"), where the segments after the first aren't classes.
  const segments = text.split(/,|;|\band\b/i).map((s) => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    const parses = segments.map((s) => parsePartyMember(s));
    if (parses.every((p) => p.ok)) {
      let cur = d;
      const lines: string[] = [];
      for (const p of parses) {
        const r = addOneMember(cur, p);
        cur = r.draft;
        lines.push(r.line);
      }
      return { session: cur, lines: [...lines, ...draftSummary(cur)] };
    }
  }

  const p = parsePartyMember(text);
  if (p.ok) {
    const { draft, line } = addOneMember(d, p);
    return { session: draft, lines: [line, ...draftSummary(draft)] };
  }

  // doesn't read as a party member at all — maybe it's an enemy typed
  // without the "enemies:" prefix ("young blue dragon" on its own line)
  const enemyAttempt = parseEnemies(text);
  if (enemyAttempt.ok) {
    const nd: SetupDraft = { ...d, enemyEntries: [...d.enemyEntries, ...enemyAttempt.entries], enemyNames: [...d.enemyNames, ...enemyAttempt.names] };
    return { session: nd, lines: [`(Read that as an enemy, not a party member.) Added: ${enemyAttempt.names.join(", ")}.`, ...draftSummary(nd)] };
  }

  const sug = p.suggestions?.length ? ` Did you mean: ${p.suggestions.map((s) => s.className).join(", ")}?` : "";
  return { session: d, lines: [`I couldn't parse "${text}" as a party member or an enemy.${sug}`] };
}

function applyEnemyText(d: SetupDraft, text: string): AdvanceResult {
  if (!text.trim()) return { session: d, lines: [`Who are you fighting? e.g. "enemies: an adult red dragon".`] };
  const r = parseEnemies(text);
  const lines: string[] = [];
  if (r.entries.length) lines.push(`Added: ${r.names.join(", ")}.`);
  for (const u of r.unknown) {
    const sug = u.suggestions.length ? ` Closest matches: ${u.suggestions.join(", ")}.` : "";
    lines.push(`I don't have a stat block for "${u.text}".${sug}`);
  }
  const nd: SetupDraft = { ...d, enemyEntries: [...d.enemyEntries, ...r.entries], enemyNames: [...d.enemyNames, ...r.names] };
  lines.push(...draftSummary(nd));
  return { session: nd, lines };
}

function handleFightMessage(s: FightingSession, message: string): AdvanceResult {
  const outcomeBefore = runBattle(s.setup);
  const lastSnap = outcomeBefore.frames.at(-1)?.units;

  if (outcomeBefore.awaitingReaction) {
    if (/^undo$/i.test(message.trim())) {
      // undo the most recent thing that led here — a previous reaction
      // answer if one's been given this fight, else the last turn decision
      const reactionChoices = s.setup.reactionChoices ?? [];
      if (reactionChoices.length) return continueFight({ ...s, setup: { ...s.setup, reactionChoices: reactionChoices.slice(0, -1) } });
      const decisions = (s.setup.decisions ?? []).slice(0, -1);
      return continueFight({ ...s, setup: { ...s.setup, decisions } });
    }
    const r = interpretReaction(message, outcomeBefore.awaitingReaction);
    if (r.kind === "clarify") return attachLive(s, [r.question], outcomeBefore);
    const reactionChoices = [...(s.setup.reactionChoices ?? []), { round: outcomeBefore.awaitingReaction.round, unitId: outcomeBefore.awaitingReaction.unitId, seq: outcomeBefore.awaitingReaction.seq, take: r.take }];
    const setup = { ...s.setup, reactionChoices };
    return continueFight({ ...s, setup });
  }

  if (outcomeBefore.awaiting) {
    if (/^undo$/i.test(message.trim())) {
      const decisions = (s.setup.decisions ?? []).slice(0, -1);
      return continueFight({ ...s, setup: { ...s.setup, decisions } });
    }
    const info = answerInfoQuery(message, s.setup, outcomeBefore.awaiting);
    if (info) return attachLive(s, info, outcomeBefore);
    const r = interpretTurnCommand(message, outcomeBefore.awaiting, lastSnap);
    if (r.kind === "clarify") return attachLive(s, [r.question], outcomeBefore);
    if (r.kind === "reaction-mismatch") return attachLive(s, ["(no reaction is pending right now)"], outcomeBefore);
    const decisions = [...(s.setup.decisions ?? []), r.decision];
    return continueFight({ ...s, setup: { ...s.setup, decisions } }, r.notes);
  }

  if (s.phase === "done") return attachLive(s, ["The fight is over. Start a new session to run another."], outcomeBefore);
  return attachLive(s, ["Nothing is waiting on input right now."], outcomeBefore);
}

function continueFight(s: FightingSession, extraNotes: string[] = []): AdvanceResult {
  const outcome = runBattle(s.setup);
  const { lines: narration, nextIndex } = narrateNewFrames(outcome.frames, s.frameCursor);
  const session: FightingSession = { ...s, frameCursor: nextIndex, phase: outcome.done ? "done" : "fighting" };
  const lines = [...extraNotes, ...narration, ...promptLines(outcome)];
  return attachLive(session, lines, outcome);
}

/** Read-only: current awaiting/awaitingReaction/board state without
 *  consuming a turn — used to re-derive the UI's picker state after
 *  restoring a fight from localStorage or a loaded save file (where there's
 *  no fresh `advance()` response to read it off of). */
export function peekFight(s: FightingSession): AdvanceResult {
  return attachLive(s, [], runBattle(s.setup));
}

/** Directly send a reaction answer built from a picker tap. */
export function sendReaction(s: FightingSession, awaitingReaction: AwaitingReaction, take: boolean): AdvanceResult {
  const reactionChoices = [...(s.setup.reactionChoices ?? []), { round: awaitingReaction.round, unitId: awaitingReaction.unitId, seq: awaitingReaction.seq, take }];
  return continueFight({ ...s, setup: { ...s.setup, reactionChoices } });
}

export function advance(session: FightSession | undefined, message: string): AdvanceResult {
  const s = session ?? newSession();
  if (s.phase === "setup") return handleSetupMessage(s, message);
  return handleFightMessage(s, message);
}

export { newSession };
