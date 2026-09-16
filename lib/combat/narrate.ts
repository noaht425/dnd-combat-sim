// Turns the engine's frame stream into phone-friendly narration (spec §3):
// the engine's own play-by-play text is already substantive, so this layer's
// job is presentation — round headers, filtering the low-signal bookkeeping
// frames, and light randomized connective phrasing so a run of hits doesn't
// read identically every time.

import type { BattleFrame } from "../sim/battle";
import type { CombatResult } from "../sim/engine/loop";
import { damageReport } from "../sim/engine/scenario";

const HIT_LEADS = ["", "", "", "Then, ", "Meanwhile, "];
const CRIT_LEADS = ["Critical hit — ", "A clean critical — ", "Devastating — "];

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

/** true for frames that are pure bookkeeping ("X ends its turn") with nothing
 *  a player needs read aloud. */
function isNoise(f: BattleFrame): boolean {
  if (!f.text) return true;
  if (f.kind === "turn" && /ends its turn$/.test(f.text)) return true;
  return false;
}

let seedCounter = 0;

/** Render frames the client hasn't seen yet (`frames.slice(sinceIndex)`) as
 *  chat lines. Returns the lines and the new cursor to store client-side. */
export function narrateNewFrames(frames: BattleFrame[], sinceIndex: number): { lines: string[]; nextIndex: number } {
  const slice = frames.slice(sinceIndex);
  const lines: string[] = [];
  let lastRound = sinceIndex > 0 ? frames[sinceIndex - 1]?.round : undefined;

  for (const f of slice) {
    if (f.round !== lastRound) {
      if (f.round > 0) lines.push(`— Round ${f.round} —`); // round 0 = pre-battle setup, not a real round
      lastRound = f.round;
    }
    if (isNoise(f)) continue;
    let text = f.text!;
    if (f.kind === "action") {
      seedCounter++;
      if (/\bcrit(ical)?\b/i.test(text)) text = pick(CRIT_LEADS, seedCounter) + text;
      else if (/\bhits?\b/i.test(text)) text = pick(HIT_LEADS, seedCounter) + text;
    }
    lines.push(text);
  }
  return { lines, nextIndex: frames.length };
}

const MIN_FAILS_FOR_PATTERN = 2; // one bad roll isn't a "weakness" — a repeat is
const MIN_ATTEMPTS_FOR_RATE = 3; // don't call a 1-for-1 or 1-for-2 a trend
const WHIFF_RATE = 0.4; // hit on fewer than this share of swings
const GETS_HIT_RATE = 0.7; // hit by more than this share of incoming attacks

/** Spec §5's "derived weakness observations" — deterministic, computed from
 *  the fight's actual save/attack log (CombatState.saveLog/attackLog,
 *  populated by resolve.ts's rollSave/rollAttack wrappers), not text-mined
 *  from the narration (which doesn't even say which ability a save used). */
function weaknessObservations(result: CombatResult): string[] {
  const side = new Map(result.contributions.map((c) => [c.id, c.side]));
  const name = new Map(result.contributions.map((c) => [c.id, c.name]));
  const notes: string[] = [];

  if (result.saveLog?.length) {
    const byUnit = new Map<string, Map<string, { fail: number; total: number }>>();
    for (const s of result.saveLog) {
      if (side.get(s.unitId) !== "party") continue;
      const abilities = byUnit.get(s.unitId) ?? new Map<string, { fail: number; total: number }>();
      const e = abilities.get(s.ability) ?? { fail: 0, total: 0 };
      e.total++;
      if (!s.passed) e.fail++;
      abilities.set(s.ability, e);
      byUnit.set(s.unitId, abilities);
    }
    for (const [unitId, abilities] of byUnit) {
      let worst: { ability: string; fail: number; total: number } | undefined;
      for (const [ability, e] of abilities) {
        if (e.fail < MIN_FAILS_FOR_PATTERN) continue;
        if (!worst || e.fail > worst.fail) worst = { ability, ...e };
      }
      if (worst) notes.push(`${name.get(unitId)}'s ${worst.ability.toUpperCase()} saves were a weak point — failed ${worst.fail} of ${worst.total}.`);
    }
  }

  if (result.attackLog?.length) {
    const byAttacker = new Map<string, { hit: number; total: number }>();
    const byTarget = new Map<string, { hit: number; total: number }>();
    for (const a of result.attackLog) {
      if (side.get(a.attackerId) === "party") {
        const e = byAttacker.get(a.attackerId) ?? { hit: 0, total: 0 };
        e.total++;
        if (a.hit) e.hit++;
        byAttacker.set(a.attackerId, e);
      }
      if (side.get(a.targetId) === "party") {
        const e = byTarget.get(a.targetId) ?? { hit: 0, total: 0 };
        e.total++;
        if (a.hit) e.hit++;
        byTarget.set(a.targetId, e);
      }
    }
    for (const [id, e] of byAttacker) {
      if (e.total < MIN_ATTEMPTS_FOR_RATE) continue;
      if (e.hit / e.total < WHIFF_RATE) notes.push(`${name.get(id)} had a rough night on offense — only ${e.hit} of ${e.total} attacks landed.`);
    }
    for (const [id, e] of byTarget) {
      if (e.total < MIN_ATTEMPTS_FOR_RATE) continue;
      if (e.hit / e.total >= GETS_HIT_RATE) notes.push(`${name.get(id)}'s AC couldn't keep up — hit on ${e.hit} of ${e.total} incoming attacks.`);
    }
  }

  return notes;
}

/** Post-fight readout (spec §5): winner, rounds, first casualty, damage
 *  breakdown by source (damageReport(), reused wholesale) plus derived
 *  weakness observations mined from the fight's own save/attack log. */
export function postFightReadout(result: CombatResult): string {
  const weaknesses = weaknessObservations(result);
  return [damageReport(result), "", ...(weaknesses.length ? weaknesses : ["(Nothing stood out as a repeat weakness this fight.)"])].join("\n");
}
