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

/** Post-fight readout (spec §5): winner, rounds, first casualty, damage
 *  breakdown by source — reuses the engine's own damageReport() wholesale.
 *  Derived "weakness observation" mining (failed-save patterns by save type)
 *  isn't wired up yet — noted as a follow-up, not silently skipped. */
export function postFightReadout(result: CombatResult): string {
  return [
    damageReport(result),
    "",
    "(Deeper weakness call-outs — failed-save patterns by ability, whiff rates — aren't computed yet; flagged as a follow-up.)",
  ].join("\n");
}
