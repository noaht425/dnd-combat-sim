// The conversation state machine: setup chat -> run the fight -> post-fight
// readout. Every message re-derives the current engine state by calling
// runBattle(setup) (cheap, pure, deterministic) rather than keeping a mutable
// server-side fight object — the client just carries the session JSON.

import { runBattle, type BattleOutcome } from "../sim/battle";
import { standardParty } from "../sim/engine/scenario";
import { parsePartyMember, parseEnemies, buildSummaryLine } from "./setupParser";
import { classAliasFor } from "./classTemplates";
import { interpretTurnCommand } from "./commandParser";
import { interpretReaction } from "./reactionParser";
import { narrateNewFrames, postFightReadout } from "./narrate";
import { newSession, partyMemberIds, type FightSession, type SetupDraft, type FightingSession } from "./session";

export interface AdvanceResult {
  session: FightSession;
  lines: string[];
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
  return { session, lines };
}

function promptLines(outcome: BattleOutcome): string[] {
  if (outcome.awaitingReaction) {
    const r = outcome.awaitingReaction;
    return [`${r.unitName}: ${r.prompt} (${r.takeLabel} / ${r.declineLabel})`];
  }
  if (outcome.awaiting) {
    const a = outcome.awaiting;
    const actionNames = [...a.actions, ...a.bonusActions].map((x) => x.name).join(", ");
    return [`${a.unitName}'s turn (round ${a.round}). Actions: ${actionNames || "none"}.`];
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

  const enemyMatch = text.match(/^(?:enemies?|vs|versus|against|fight(?:ing)?)\s*:?\s*(.+)$/i);
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
      return { session: started.session, lines: [...lines, ...started.lines] };
    }
    return { session: cur, lines };
  }

  // bare minimal spec, e.g. "draconic sorcerer level 12"
  return applyPartyText(d, text);
}

function applyPartyText(d: SetupDraft, text: string): AdvanceResult {
  const p = parsePartyMember(text);
  if (!p.ok) {
    const sug = p.suggestions?.length ? ` Did you mean: ${p.suggestions.map((s) => s.className).join(", ")}?` : "";
    return { session: d, lines: [`I couldn't parse "${text}" as a party member.${sug}`] };
  }
  // auto-disambiguate a repeated unnamed build so it has a unique display name
  let spec = p.spec!;
  if (!spec.name) {
    const dupes = d.party.filter((m) => m.template === spec.template && m.level === spec.level).length;
    if (dupes > 0) spec = { ...spec, name: `${p.classInfo!.className[0].toUpperCase()}${p.classInfo!.className.slice(1)} ${spec.level} (${dupes + 1})` };
  }
  const nd: SetupDraft = { ...d, party: [...d.party, spec] };
  return { session: nd, lines: [buildSummaryLine(p), ...draftSummary(nd)] };
}

function applyEnemyText(d: SetupDraft, text: string): AdvanceResult {
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
    const r = interpretReaction(message, outcomeBefore.awaitingReaction);
    if (r.kind === "clarify") return { session: s, lines: [r.question] };
    const reactionChoices = [...(s.setup.reactionChoices ?? []), { round: outcomeBefore.awaitingReaction.round, unitId: outcomeBefore.awaitingReaction.unitId, seq: outcomeBefore.awaitingReaction.seq, take: r.take }];
    const setup = { ...s.setup, reactionChoices };
    return continueFight({ ...s, setup });
  }

  if (outcomeBefore.awaiting) {
    if (/^undo$/i.test(message.trim())) {
      const decisions = (s.setup.decisions ?? []).slice(0, -1);
      return continueFight({ ...s, setup: { ...s.setup, decisions } });
    }
    const r = interpretTurnCommand(message, outcomeBefore.awaiting, lastSnap);
    if (r.kind === "clarify") return { session: s, lines: [r.question] };
    if (r.kind === "reaction-mismatch") return { session: s, lines: ["(no reaction is pending right now)"] };
    const decisions = [...(s.setup.decisions ?? []), r.decision];
    return continueFight({ ...s, setup: { ...s.setup, decisions } }, r.notes);
  }

  if (s.phase === "done") return { session: s, lines: ["The fight is over. Start a new session to run another."] };
  return { session: s, lines: ["Nothing is waiting on input right now."] };
}

function continueFight(s: FightingSession, extraNotes: string[] = []): AdvanceResult {
  const outcome = runBattle(s.setup);
  const { lines: narration, nextIndex } = narrateNewFrames(outcome.frames, s.frameCursor);
  const session: FightingSession = { ...s, frameCursor: nextIndex, phase: outcome.done ? "done" : "fighting" };
  const lines = [...extraNotes, ...narration, ...promptLines(outcome)];
  return { session, lines };
}

export function advance(session: FightSession | undefined, message: string): AdvanceResult {
  const s = session ?? newSession();
  if (s.phase === "setup") return handleSetupMessage(s, message);
  return handleFightMessage(s, message);
}

export { newSession };
