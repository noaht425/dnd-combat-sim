// Battle mode surfaces a controlled unit's reaction (Shield / Counterspell /
// Uncanny Dodge / Riposte) to the player instead of auto-firing it: the loop
// pauses with `awaitingReaction`, the UI records a yes/no answer keyed to
// `(round, unitId, seq)`, and the fight replays from seed with that answer.

import { describe, expect, it } from "vitest";
import { runBattle } from "../src/lib/sim/battle";
import type { BattleDecision } from "../src/lib/sim/battle/control";
import type { ReactionChoice } from "../src/lib/sim/battle/state";

const party = () => [
  { template: "assassin-rogue", name: "Sly", level: 9 },
  { template: "gwm-fighter", name: "Bront", level: 9 },
];

/** play a fight to the end, taking every turn on auto and answering every
 *  reaction prompt with `take`; returns the finished run + the prompts seen. */
function playOut(seed: number, controlled: string, take: boolean) {
  const setup = { party: party(), enemies: ["adult-red-dragon"] as string[], seed, controlled: [controlled] };
  const decisions: BattleDecision[] = [];
  const reactionChoices: ReactionChoice[] = [];
  const prompts: { kind: string; seq: number; round: number; prompt: string; unitName: string }[] = [];
  let run = runBattle({ ...setup, decisions, reactionChoices });
  let guard = 400;
  while (!run.done && guard-- > 0) {
    if (run.awaitingReaction) {
      const r = run.awaitingReaction;
      prompts.push({ kind: r.kind, seq: r.seq, round: r.round, prompt: r.prompt, unitName: r.unitName });
      reactionChoices.push({ round: r.round, unitId: r.unitId, seq: r.seq, take });
    } else if (run.awaiting) {
      decisions.push({ round: run.awaiting.round, unitId: run.awaiting.unitId, auto: true });
    } else {
      break;
    }
    run = runBattle({ ...setup, decisions, reactionChoices });
  }
  return { run, prompts, decisions, reactionChoices };
}

describe("battle reactions — surfaced to the player", () => {
  it("pauses on a controlled rogue's Uncanny Dodge instead of auto-halving", () => {
    const setup = {
      party: party(),
      enemies: ["adult-red-dragon"] as string[],
      seed: 1,
      controlled: ["pc-1-assassin-rogue"],
      decisions: [{ round: 2, unitId: "pc-1-assassin-rogue", auto: true } as BattleDecision],
    };
    // feed auto turn decisions until the first reaction prompt appears
    const decisions: BattleDecision[] = [];
    let run = runBattle({ ...setup, decisions });
    let guard = 40;
    while (!run.done && !run.awaitingReaction && guard-- > 0) {
      decisions.push({ round: run.awaiting!.round, unitId: run.awaiting!.unitId, auto: true });
      run = runBattle({ ...setup, decisions });
    }
    expect(run.done).toBe(false);
    expect(run.awaiting).toBeUndefined();
    const r = run.awaitingReaction!;
    expect(r).toBeDefined();
    expect(r.kind).toBe("uncannyDodge");
    expect(r.unitName).toBe("Sly");
    expect(r.seq).toBe(0);
    expect(r.prompt.length).toBeGreaterThan(10);
    expect(r.takeLabel).toBeTruthy();
    expect(r.declineLabel).toBeTruthy();
    // it's paused, not over — no "end" frame yet
    expect(run.frames.at(-1)!.kind).not.toBe("end");
  });

  it("a recorded reaction answer is replayed and the fight finishes", () => {
    const taken = playOut(1, "pc-1-assassin-rogue", true);
    const declined = playOut(1, "pc-1-assassin-rogue", false);
    expect(taken.run.done).toBe(true);
    expect(declined.run.done).toBe(true);
    expect(taken.prompts.length).toBeGreaterThan(0);
    expect(taken.prompts.every((p) => p.kind === "uncannyDodge")).toBe(true);
    // the answer is honored: "take" fires Uncanny Dodge, "decline" never does
    const text = (r: typeof taken) => r.run.frames.map((f) => f.text ?? "").join("\n");
    expect(text(taken)).toMatch(/Uncanny Dodge/);
    expect(text(declined)).not.toMatch(/Uncanny Dodge/);
  });

  it("surfaces a controlled fighter's Riposte", () => {
    // Riposte fires when a MELEE attack misses the fighter — a pair of owlbears
    // (many +7 swings vs the fighter's AC 19) makes that happen reliably
    const setup = {
      party: [
        { template: "assassin-rogue", name: "Sly", level: 5 },
        { template: "gwm-fighter", name: "Bront", level: 5 },
      ],
      enemies: ["owlbear x2"] as string[],
      seed: 2,
      controlled: ["pc-2-gwm-fighter"],
    };
    const decisions: BattleDecision[] = [];
    const reactionChoices: ReactionChoice[] = [];
    const kinds: string[] = [];
    let run = runBattle({ ...setup, decisions, reactionChoices });
    let guard = 300;
    while (!run.done && guard-- > 0) {
      if (run.awaitingReaction) {
        const r = run.awaitingReaction;
        kinds.push(r.kind);
        expect(r.unitName).toBe("Bront");
        reactionChoices.push({ round: r.round, unitId: r.unitId, seq: r.seq, take: true });
      } else if (run.awaiting) {
        decisions.push({ round: run.awaiting.round, unitId: run.awaiting.unitId, auto: true });
      } else break;
      run = runBattle({ ...setup, decisions, reactionChoices });
    }
    expect(run.done).toBe(true);
    expect(kinds).toContain("riposte");
  });

  it("replays are deterministic — same answers, same final frame", () => {
    const a = playOut(7, "pc-1-assassin-rogue", true);
    const b = playOut(7, "pc-1-assassin-rogue", true);
    expect(a.prompts).toEqual(b.prompts);
    expect(a.run.frames.length).toBe(b.run.frames.length);
    expect(JSON.stringify(a.run.frames.at(-1))).toBe(JSON.stringify(b.run.frames.at(-1)));
  });

  it("no seam installed for an AI unit — reactions still auto-fire (no regression)", () => {
    // same fight, rogue NOT controlled: runs straight through, Uncanny Dodge
    // still handled by the engine's own heuristic
    const setup = { party: party(), enemies: ["adult-red-dragon"] as string[], seed: 1 };
    const plain = runBattle(setup);
    const empty = runBattle({ ...setup, controlled: [], decisions: [], reactionChoices: [] });
    expect(plain.done).toBe(true);
    expect(empty.done).toBe(true);
    expect(plain.frames.length).toBe(empty.frames.length);
    expect(plain.result.winner).toBe(empty.result.winner);
  });

  it("`reactionAuto` hands a unit's reactions back to the AI (stops prompting)", () => {
    const setup = {
      party: party(),
      enemies: ["adult-red-dragon"] as string[],
      seed: 1,
      controlled: ["pc-1-assassin-rogue"],
      reactionAuto: ["pc-1-assassin-rogue"],
    };
    const decisions: BattleDecision[] = [];
    let run = runBattle({ ...setup, decisions });
    let guard = 60;
    while (!run.done && guard-- > 0) {
      expect(run.awaitingReaction).toBeUndefined(); // never asked
      decisions.push({ round: run.awaiting!.round, unitId: run.awaiting!.unitId, auto: true });
      run = runBattle({ ...setup, decisions });
    }
    expect(run.done).toBe(true);
  });
});

// --------------------------------------------------- Absorb Elements / Hellish Rebuke

const casters = () => [
  { template: "blaster-wizard", name: "Cy", level: 9 },
  { template: "warlock", name: "Wa", level: 9 },
];

/** drive an all-auto fight, answering every reaction prompt with `take` */
function playCasters(seed: number, controlled: string, take: boolean) {
  const setup = { party: casters(), enemies: ["adult-red-dragon"] as string[], seed, controlled: [controlled] };
  const decisions: BattleDecision[] = [];
  const reactionChoices: ReactionChoice[] = [];
  const kinds: string[] = [];
  let run = runBattle({ ...setup, decisions, reactionChoices });
  let guard = 300;
  while (!run.done && guard-- > 0) {
    if (run.awaitingReaction) {
      kinds.push(run.awaitingReaction.kind);
      const r = run.awaitingReaction;
      reactionChoices.push({ round: r.round, unitId: r.unitId, seq: r.seq, take });
    } else if (run.awaiting) {
      decisions.push({ round: run.awaiting.round, unitId: run.awaiting.unitId, auto: true });
    } else break;
    run = runBattle({ ...setup, decisions, reactionChoices });
  }
  const log = run.frames.map((f) => f.text ?? "").join("\n");
  return { run, kinds, log };
}

describe("battle reactions — Absorb Elements & Hellish Rebuke", () => {
  it("a full caster carries Absorb Elements; a warlock carries Hellish Rebuke", async () => {
    const { CASTER_BUILDERS } = await import("../src/lib/sim/spells/casterTemplates");
    const wiz = CASTER_BUILDERS["blaster-wizard"](9);
    const lock = CASTER_BUILDERS["warlock"](9);
    expect(wiz.reactions.map((r) => r.id)).toContain("absorb-elements");
    expect(lock.reactions.map((r) => r.id)).toContain("hellish-rebuke");
    const hr = lock.reactions.find((r) => r.id === "hellish-rebuke")!;
    expect(JSON.stringify(hr.automation)).toMatch(/"damageType":"fire"/);
    expect(JSON.stringify(hr.automation)).toMatch(/"half":true/);
  });

  it("pauses on a controlled wizard's Absorb Elements when the dragon breathes fire", () => {
    const { kinds, log } = playCasters(2, "pc-1-blaster-wizard", true);
    expect(kinds).toContain("absorbElements");
    expect(log).toMatch(/Absorb Elements/);
  });

  it("Absorb Elements halves the triggering elemental hit", () => {
    const took = playCasters(2, "pc-1-blaster-wizard", true);
    const declined = playCasters(2, "pc-1-blaster-wizard", false);
    const cyHp = (r: typeof took) => {
      // Cy's HP right after round 1 (the breath) — first frame at round >= 2
      const f = r.run.frames.find((x) => x.round >= 2) ?? r.run.frames.at(-1)!;
      return f.units.find((u) => u.name === "Cy")?.hp ?? 0;
    };
    // absorbing leaves Cy with strictly more HP than eating the breath full
    expect(cyHp(took)).toBeGreaterThan(cyHp(declined));
  });

  it("surfaces a controlled warlock's Hellish Rebuke and it burns the attacker", () => {
    const { kinds, log } = playCasters(1, "pc-2-warlock", true);
    expect(kinds).toContain("retaliate");
    expect(log).toMatch(/Hellish Rebuke/);
  });

  it("replays with the new kinds are deterministic", () => {
    const a = playCasters(2, "pc-1-blaster-wizard", true);
    const b = playCasters(2, "pc-1-blaster-wizard", true);
    expect(a.kinds).toEqual(b.kinds);
    expect(JSON.stringify(a.run.frames.at(-1))).toBe(JSON.stringify(b.run.frames.at(-1)));
  });
});
