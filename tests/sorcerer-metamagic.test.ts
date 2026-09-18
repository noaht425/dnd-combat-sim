// Sorcerer Metamagic: Twinned Spell and Quickened Spell, spending sorcery
// points on top of the normal spell-slot cost. Applies to cantrips too (RAW,
// and "Twinned Fire Bolt" every turn at 1 sorcery point is the single most
// iconic sorcerer combo — an earlier version of this wrongly excluded
// cantrips since Wild Magic Surge correctly excludes them and this borrowed
// that filter without reconsidering it).
//
// Finding these bugs also surfaced a real gap in the branch-condition
// expression evaluator: it only ever matched the literal pattern
// "self.resource('x') > 0" — a ">= N" condition (needed for Twinned's
// variable per-spell-level cost) matched nothing and silently evaluated to
// "assume it doesn't fire", which actionBranchGateFails() then read as the
// whole action being permanently unavailable. Fixed to support ">=" and any
// N generally (lib/sim/engine/interpreter.ts's evalExpr), not just this case.

import { describe, expect, it } from "vitest";
import { runBattle } from "../lib/sim/battle";
import { makeTemplate } from "../lib/sim/engine/templates";

function runWithReactionsDeclined(setup: Record<string, unknown>) {
  const s = { ...setup, reactionChoices: [] as { round: number; unitId: string; seq: number; take: boolean }[] };
  let out = runBattle(s as never);
  let guard = 10;
  while (!out.done && out.awaitingReaction && guard-- > 0) {
    const r = out.awaitingReaction;
    s.reactionChoices.push({ round: r.round, unitId: r.unitId, seq: r.seq, take: false });
    out = runBattle(s as never);
  }
  return out;
}

describe("Sorcerer Metamagic", () => {
  it("Twinned/Quickened variants exist for cantrips, not just leveled spells", () => {
    const names = makeTemplate("draconic-sorcerer", 5).actions.map((a) => a.name);
    expect(names).toContain("Fire Bolt (Twinned)");
    expect(names).toContain("Fire Bolt (Quickened)");
  });

  it("sorcery points resource is tracked (level 2+)", () => {
    expect(makeTemplate("draconic-sorcerer", 5).resources.sorcery_points).toEqual({ max: 5, recharge: "longRest" });
    expect(makeTemplate("draconic-sorcerer", 1).resources.sorcery_points).toEqual({ max: 0, recharge: "longRest" });
  });

  it("Twinned Chill Touch hits two separate targets in one cast", () => {
    const c = makeTemplate("draconic-sorcerer", 5);
    const twinned = c.actions.find((a) => a.id === "cast-chill-touch-twinned")!;
    const out = runWithReactionsDeclined({
      party: [{ template: "draconic-sorcerer", level: 5 }],
      enemies: ["kobold x2"],
      seed: 1,
      controlled: ["pc-1-draconic-sorcerer"],
      maxRounds: 1,
      decisions: [{ round: 1, unitId: "pc-1-draconic-sorcerer", actionId: twinned.id }],
    });
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/Chill Touch \(Twinned\) -> Kobold 1 -\d+.*Kobold 2 -\d+|Kobold 2 -\d+.*Kobold 1 -\d+/);
  });

  it("Quickened lets a bonus-action spell fire alongside a normal action spell", () => {
    const c = makeTemplate("draconic-sorcerer", 5);
    const quickened = c.actions.find((a) => a.id === "cast-chill-touch-quickened")!;
    const out = runWithReactionsDeclined({
      party: [{ template: "draconic-sorcerer", level: 5 }],
      enemies: ["kobold x2"],
      seed: 1,
      controlled: ["pc-1-draconic-sorcerer"],
      maxRounds: 1,
      decisions: [{
        round: 1, unitId: "pc-1-draconic-sorcerer",
        actionId: "cast-fire-bolt", targetId: "monster-1-kobold",
        bonusActionId: quickened.id, bonusTargetId: "monster-2-kobold",
      }],
    });
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/uses Fire Bolt/);
    expect(text).toMatch(/uses Chill Touch \(Quickened\)/);
  });
});
