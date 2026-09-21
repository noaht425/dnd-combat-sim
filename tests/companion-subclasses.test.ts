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
  it("Beast Master ranger (Ranger's Companion) has its wolf from the start of the fight and commands it with an action", () => {
    const { roster, text } = companionFightText("beastmaster-ranger", "Ranger");
    expect(roster.some((n) => n.startsWith("Wolf (companion)"))).toBe(true);
    expect(text).toMatch(/The battle begins\nRanger raises 1× Wolf \(companion\)/);
    // the wolf only Bites when its ranger uses an action to command it
    expect(text).toMatch(/Ranger uses Command the beast to Attack[\s\S]*Wolf \(companion\) 1 \(commanded\) uses Bite/);
  });

  it("Battle Smith artificer has its Steel Defender from the start of the fight and commands it with a bonus action", () => {
    const { roster, text } = companionFightText("battlesmith-artificer", "Smith");
    expect(roster.some((n) => n.startsWith("Steel Defender"))).toBe(true);
    // created at the end of a long rest, so it's there before anyone acts — not a round-1 action
    expect(text).toMatch(/The battle begins\nSmith raises 1× Steel Defender/);
    // it attacks only when the artificer spends a bonus action commanding it
    expect(text).toMatch(/Smith uses Command Steel Defender: Rend[\s\S]*Steel Defender 1 \(commanded\) uses Force-Empowered Rend/);
  });

  it("the Steel Defender's command is a bonus action; the Ranger's Companion is commanded with the ranger's ACTION (the optional Primal Companion, a bonus action)", () => {
    expect(makeTemplate("beastmaster-ranger", 5).actions.find((a) => a.id === "command-attack")?.cost).toEqual({ action: 1 });
    expect(makeTemplate("beastmaster-land-ranger", 5).actions.find((a) => a.id === "command-beast")?.cost).toEqual({ bonus: 1 });
    expect(makeTemplate("battlesmith-artificer", 5).actions.find((a) => a.id === "command-rend")?.cost).toEqual({ bonus: 1 });
  });
});
