// End-to-end regression tests for the real parsing bugs found and fixed this
// session, now driven by the locally-trained segmentation tagger (see
// lib/combat/nluModel.ts, tools/nlu/) instead of the old regex clause
// splitter. These assert the actual decision/outcome, not just token tags —
// nlu-model-port.test.ts covers tag-level fidelity to the Python training run.

import { describe, expect, it } from "vitest";
import { advance, sendReaction } from "../lib/combat/orchestrator";
import { newSession } from "../lib/combat/session";
import type { FightingSession } from "../lib/combat/session";

function startFight(setupText: string) {
  let r = advance(newSession(), setupText);
  if (!r.awaiting && !r.awaitingReaction) r = advance(r.session, "start");
  while (r.awaitingReaction) r = sendReaction(r.session as FightingSession, r.awaitingReaction, false);
  return r;
}

describe("command parser — real bug regressions", () => {
  it('"misty step back, then fire bolt at owlbear 1" resolves both actions, not "Weapon"', () => {
    let r = startFight("sorcerer level 5 vs 1 owlbear");
    expect(r.awaiting?.bonusActions.map((a) => a.name)).toContain("Misty Step");
    r = advance(r.session, "Misty Step back, then fire bolt at Owlbear 1");
    const text = r.lines.join(" | ");
    expect(text).not.toMatch(/didn't know what to do/);
    expect(text).toMatch(/Fire Bolt/);
    expect(text).toMatch(/Misty Step/);
    expect(text).not.toMatch(/uses Weapon/);
  });

  it('"Multiattack at Kobold 2 then Action Surge" runs both without re-asking a target', () => {
    let r = startFight("gwm fighter level 5 vs 2 kobolds");
    r = advance(r.session, "Multiattack (GWM) at Kobold 2 then Action Surge");
    expect(r.lines.join(" | ")).not.toMatch(/on who\?/);
    expect(r.lines.join(" | ")).toMatch(/Action Surge/);
  });

  it('"Bless at Kobold 1" (an eachAlly action) never asks "which one?"', () => {
    const r = startFight("cleric level 5 vs 1 kobold");
    const result = advance(r.session, "Bless at Kobold 1");
    expect(result.lines.join(" | ")).not.toMatch(/Which one/);
  });

  it("Spike Growth cast at a named target doesn't ask to clarify", () => {
    let r = startFight("druid level 5 vs 3 kobolds");
    r = advance(r.session, "Spike Growth at Kobold 1");
    expect(r.lines.join(" | ")).not.toMatch(/Where should.*aim/);
  });

  it('plain "attack" and "hold" still work exactly as before', () => {
    const r1 = startFight("gwm fighter level 5 vs 1 kobold");
    const attacked = advance(r1.session, "attack kobold 1");
    expect(attacked.lines.join(" | ")).not.toMatch(/didn't know what to do|clarify|Which one/i);

    const r2 = startFight("gwm fighter level 5 vs 1 kobold");
    const held = advance(r2.session, "hold");
    expect(held.lines.join(" | ")).toMatch(/holds/);
  });
});
