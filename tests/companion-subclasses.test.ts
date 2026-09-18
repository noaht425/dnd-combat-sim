// Beast Master ranger and Battle Smith artificer: a real persistent
// companion, not a spell-slot summon — joins the roster at the start of the
// fight (via the existing "summon" automation node, triggered as a
// round-1-only opener) and keeps acting on its own turn-order slot for the
// whole encounter, the way an animal companion / Steel Defender actually
// works. The underlying summon mechanic already worked (Conjure Animals
// spawns real fighting wolves); these subclasses just didn't use it.

import { describe, expect, it } from "vitest";
import { runBattle } from "../lib/sim/battle";
import { makeTemplate } from "../lib/sim/engine/templates";

function companionFightText(template: string, name: string) {
  const out = runBattle({
    party: [{ template, level: 5, name }],
    enemies: ["owlbear"],
    seed: 3,
    controlled: [],
    maxRounds: 3,
  } as never);
  return {
    roster: out.frames.at(-1)?.units.map((u) => u.name) ?? [],
    text: out.frames.map((f) => f.text ?? "").join("\n"),
  };
}

describe("Companion subclasses", () => {
  it("Beast Master ranger summons a Primal Companion round 1 that acts all fight", () => {
    const { roster, text } = companionFightText("beastmaster-ranger", "Ranger");
    expect(roster.some((n) => n.startsWith("Primal Companion"))).toBe(true);
    expect(text).toMatch(/uses Call Companion -> Primal Companion 1 \+\d+.*raises 1× Primal Companion/);
    // it acts on its own turn independently of the ranger's own attack
    expect(text).toMatch(/Primal Companion 1 uses Multiattack/);
  });

  it("Battle Smith artificer has its Steel Defender from the start of the fight and commands it with a bonus action", () => {
    const { roster, text } = companionFightText("battlesmith-artificer", "Smith");
    expect(roster.some((n) => n.startsWith("Steel Defender"))).toBe(true);
    // created at the end of a long rest, so it's there before anyone acts — not a round-1 action
    expect(text).toMatch(/The battle begins\nSmith raises 1× Steel Defender/);
    // it attacks only when the artificer spends a bonus action commanding it
    expect(text).toMatch(/Smith uses Command Steel Defender: Rend[\s\S]*Steel Defender 1 \(commanded\) uses Force-Empowered Rend/);
  });

  it("the Steel Defender's command is a bonus action; Beast Master's companion is still a bonus-action summon", () => {
    expect(makeTemplate("beastmaster-ranger", 5).actions.find((a) => a.id === "call-companion")?.cost).toEqual({ bonus: 1 });
    expect(makeTemplate("battlesmith-artificer", 5).actions.find((a) => a.id === "command-rend")?.cost).toEqual({ bonus: 1 });
  });
});
