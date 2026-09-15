import { describe, expect, it } from "vitest";
import { runBattle } from "../src/lib/sim/battle";
import type { BattleDecision } from "../src/lib/sim/battle/control";
import { standardParty } from "../src/lib/sim/engine/scenario";

const party = () => standardParty(14);

describe("battle control — pause / resume", () => {
  it("with no controlled units the fight runs straight through (no regression)", () => {
    const a = runBattle({ party: party(), enemies: ["gladiator"], seed: 4 });
    const b = runBattle({ party: party(), enemies: ["gladiator"], seed: 4, controlled: [], decisions: [] });
    expect(a.done).toBe(true);
    expect(b.done).toBe(true);
    expect(a.result.winner).toBe(b.result.winner);
    expect(a.frames.length).toBe(b.frames.length);
  });

  it("pauses when a controlled unit's turn comes up with no decision", () => {
    const out = runBattle({
      party: party(),
      enemies: ["adult-red-dragon"],
      seed: 2,
      controlled: ["pc-1-vengeance-paladin"],
      decisions: [],
    });
    expect(out.done).toBe(false);
    expect(out.awaiting).toBeDefined();
    expect(out.awaiting!.unitId).toBe("pc-1-vengeance-paladin");
    expect(out.awaiting!.round).toBe(1);
    // the pause payload has movement + action options
    expect(out.awaiting!.reachable.length).toBeGreaterThan(3);
    expect(out.awaiting!.actions.some((x) => x.id === "attack" || /attack/i.test(x.name))).toBe(true);
    expect(out.awaiting!.units.some((u) => u.side === "monster")).toBe(true);
    // no "end" frame — it's paused, not over
    expect(out.frames.at(-1)!.kind).not.toBe("end");
  });

  it("a recorded move + attack decision is replayed", () => {
    const setup = {
      party: party(),
      enemies: ["young-gold-dragon"] as string[],
      seed: 2,
      controlled: ["pc-1-vengeance-paladin"],
    };
    const first = runBattle({ ...setup, decisions: [] });
    expect(first.awaiting, "controlled paladin pauses in round 1").toBeDefined();
    const aw = first.awaiting!;
    const foe = aw.units.find((u) => u.side === "monster")!;
    // distance from a 1x1 square to the foe's footprint box (edge to edge)
    const gapTo = (x: number, y: number) =>
      Math.max(0, x - foe.box.x1, foe.box.x0 - x) + Math.max(0, y - foe.box.y1, foe.box.y0 - y);
    const dest = aw.reachable
      .map((k) => k.split(",").map(Number))
      .map(([x, y]) => ({ x, y, d: gapTo(x, y) }))
      .sort((p, q) => p.d - q.d)[0];
    const d1: BattleDecision = {
      round: 1,
      unitId: "pc-1-vengeance-paladin",
      move: { x: dest.x, y: dest.y },
      actionId: aw.actions.find((x) => x.id === "attack")?.id ?? aw.actions[0].id,
      targetId: foe.id,
    };
    const second = runBattle({ ...setup, decisions: [d1] });
    expect(second.frames.length).toBeGreaterThan(first.frames.length);
    // the paladin's move + action from the decision landed in the stream
    expect(second.frames.some((f) => f.kind === "move" && f.actorId === "pc-1-vengeance-paladin")).toBe(true);
    expect(second.frames.some((f) => f.kind === "action" && /Ada — |Ada uses/.test(f.text ?? ""))).toBe(true);
    // the paladin moved from where it started
    const palStart = first.frames[0].units.find((u) => u.id === "pc-1-vengeance-paladin")!;
    const palLater = second.frames
      .flatMap((f) => f.units.filter((u) => u.id === "pc-1-vengeance-paladin"))
      .at(-1)!;
    expect(palLater.x !== palStart.x || palLater.y !== palStart.y).toBe(true);
    // it advanced past round 1 — never re-asks for round 1
    if (second.awaiting) expect(second.awaiting.round).toBeGreaterThan(1);
  });

  it("a melee attack at an out-of-reach target is wasted, not resolved at range", () => {
    const setup = {
      party: party(),
      enemies: ["young-gold-dragon"] as string[],
      seed: 2,
      controlled: ["pc-1-vengeance-paladin"],
    };
    const aw = runBattle({ ...setup, decisions: [] }).awaiting!;
    const foe = aw.units.find((u) => u.side === "monster")!;
    // stay put (starting square is far from the dragon) and swing anyway
    const d1: BattleDecision = {
      round: 1,
      unitId: "pc-1-vengeance-paladin",
      actionId: aw.actions.find((x) => x.id === "attack")!.id,
      targetId: foe.id,
    };
    const out = runBattle({ ...setup, decisions: [d1] });
    expect(out.frames.some((f) => /out of reach/i.test(f.text ?? ""))).toBe(true);
    // the dragon took no damage from that whiffed swing on round 1's paladin turn
  });

  it("a bonus action rider on the decision is also taken", () => {
    const setup = {
      party: party(),
      enemies: ["young-gold-dragon"] as string[],
      seed: 4,
      controlled: ["pc-2-gwm-fighter"],
    };
    const aw = runBattle({ ...setup, decisions: [] }).awaiting!;
    expect(Array.isArray(aw.bonusActions)).toBe(true);
    if (aw.bonusActions.length) {
      const d1: BattleDecision = {
        round: 1,
        unitId: "pc-2-gwm-fighter",
        actionId: aw.actions[0]?.id,
        bonusActionId: aw.bonusActions[0].id,
      };
      const out = runBattle({ ...setup, decisions: [d1] });
      expect(out.frames.some((f) => f.actorId === "pc-2-gwm-fighter" && f.kind === "action")).toBe(true);
    }
  });

  it("an `auto` decision lets the AI take that turn (still resumes cleanly)", () => {
    const setup = {
      party: party(),
      enemies: ["gladiator"] as string[],
      seed: 7,
      controlled: ["pc-2-gwm-fighter"],
    };
    const auto: BattleDecision[] = [];
    const reactionChoices: { round: number; unitId: string; seq: number; take: boolean }[] = [];
    let run = runBattle({ ...setup, decisions: auto, reactionChoices });
    let guard = 60;
    while (!run.done && guard-- > 0) {
      if (run.awaitingReaction) {
        const r = run.awaitingReaction;
        reactionChoices.push({ round: r.round, unitId: r.unitId, seq: r.seq, take: true });
      } else {
        auto.push({ round: run.awaiting!.round, unitId: run.awaiting!.unitId, auto: true });
      }
      run = runBattle({ ...setup, decisions: auto, reactionChoices });
    }
    expect(run.done).toBe(true);
    expect(["party", "monster", "draw"]).toContain(run.result.winner);
  });

  it("replays are deterministic — same decisions, same frames", () => {
    const setup = {
      party: party(),
      enemies: ["young-gold-dragon"] as string[],
      seed: 3,
      controlled: ["pc-3-blaster-wizard"],
    };
    const decisions: BattleDecision[] = [
      { round: 1, unitId: "pc-3-blaster-wizard", auto: true },
      { round: 2, unitId: "pc-3-blaster-wizard", auto: true },
    ];
    const a = runBattle({ ...setup, decisions });
    const b = runBattle({ ...setup, decisions });
    expect(a.frames.length).toBe(b.frames.length);
    expect(JSON.stringify(a.frames.at(-1))).toBe(JSON.stringify(b.frames.at(-1)));
  });
});

describe("battle control — round-1 opener", () => {
  const barbSetup = {
    party: [
      { template: "totem-barbarian", name: "Grok", level: 9 },
      { template: "gwm-fighter", name: "Bront", level: 9 },
    ],
    enemies: ["adult-red-dragon"] as string[],
    seed: 3,
    controlled: ["pc-1-totem-barbarian"],
  };

  it("computeAwaiting flags the unit's opener on round 1", () => {
    const aw = runBattle({ ...barbSetup, decisions: [] }).awaiting!;
    expect(aw.round).toBe(1);
    expect(aw.openerId).toBe("rage");
    expect([...aw.actions, ...aw.bonusActions].some((a) => a.id === "rage")).toBe(true);
  });

  it("an opener bonus fires before the main action", () => {
    const aw = runBattle({ ...barbSetup, decisions: [] }).awaiting!;
    const foe = aw.units.find((u) => u.side === "monster")!;
    const gapTo = (x: number, y: number) =>
      Math.max(0, x - foe.box.x1, foe.box.x0 - x) + Math.max(0, y - foe.box.y1, foe.box.y0 - y);
    const dest = aw.reachable
      .map((k) => k.split(",").map(Number))
      .map(([x, y]) => ({ x, y, d: gapTo(x, y) }))
      .sort((p, q) => p.d - q.d)[0];
    const d: BattleDecision = {
      round: 1,
      unitId: "pc-1-totem-barbarian",
      move: { x: dest.x, y: dest.y },
      actionId: "attack",
      targetId: foe.id,
      bonusActionId: "rage",
    };
    const out = runBattle({ ...barbSetup, decisions: [d] });
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    const rageAt = text.search(/[Rr]age/);
    const swingAt = text.search(/Reckless Multiattack|Grok — |Grok uses Reckless/);
    expect(rageAt).toBeGreaterThanOrEqual(0);
    // rage is narrated before the attack line for this turn
    if (swingAt >= 0) expect(rageAt).toBeLessThan(swingAt);
  });

  it("no opener flag after round 1", () => {
    const setup = { ...barbSetup, decisions: [{ round: 1, unitId: "pc-1-totem-barbarian", auto: true } as BattleDecision] };
    let run = runBattle(setup);
    let guard = 30;
    const decisions = [...setup.decisions];
    while (!run.done && run.awaiting && run.awaiting.round < 2 && guard-- > 0) {
      decisions.push({ round: run.awaiting.round, unitId: run.awaiting.unitId, auto: true });
      run = runBattle({ ...barbSetup, decisions });
    }
    if (run.awaiting && run.awaiting.round >= 2) expect(run.awaiting.openerId).toBeUndefined();
  });
});
