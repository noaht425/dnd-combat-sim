// Wild Magic Sorcerer: a Surge check appended after every leveled spell cast
// (not cantrips). Verifies the mechanic actually fires and narrates
// correctly — including the self-damage case, which collided with an
// earlier session's "don't double-narrate a reaction's retaliation" fix
// (that fix excluded the caster's own HP loss during its own action
// entirely; Wild Magic Surge needed it distinguished from reaction
// collateral specifically, since it's the caster's own effect with no other
// line that would show it).

import { describe, expect, it } from "vitest";
import { runBattle } from "../lib/sim/battle";
import { makeTemplate } from "../lib/sim/engine/templates";

describe("Wild Magic Sorcerer — Wild Magic Surge", () => {
  const spellAction = makeTemplate("wild-magic-sorcerer", 5).actions.find((a) => a.isSpell && /-\d+$/.test(a.id))!;

  it("every leveled spell action carries a randomEffect surge check", () => {
    for (const a of makeTemplate("wild-magic-sorcerer", 9).actions) {
      const hasSurge = a.automation.some((n) => n.type === "randomEffect");
      if (a.isSpell && /-\d+$/.test(a.id)) expect(hasSurge, a.id).toBe(true);
      else expect(hasSurge, a.id).toBe(false); // cantrips and Weapon don't surge
    }
  });

  it("fires across many seeds, and narrates the self-damage case correctly", () => {
    let sawSurge = 0;
    let sawSelfDamageLine = false;
    for (let seed = 1; seed <= 200; seed++) {
      const out = runBattle({
        party: [{ template: "wild-magic-sorcerer", level: 5 }],
        enemies: ["kobold"],
        seed,
        controlled: ["pc-1-wild-magic-sorcerer"],
        maxRounds: 1,
        decisions: [{ round: 1, unitId: "pc-1-wild-magic-sorcerer", actionId: spellAction.id, targetId: "monster-1-kobold" }],
      } as never);
      const text = out.frames.map((f) => f.text ?? "").join("\n");
      if (/wild magic surge/i.test(text)) {
        sawSurge++;
        // the self-damage variant must show a real HP delta, not just the
        // flavor note with no mechanical effect visible
        if (/force energy crackles wildly/.test(text)) {
          expect(text).toMatch(/Sorcerer 5 uses Misty Step -> Sorcerer 5 -\d+/);
          sawSelfDamageLine = true;
        }
      }
    }
    // ~18% designed rate over 200 rolls — a wide but real floor
    expect(sawSurge).toBeGreaterThan(10);
    expect(sawSelfDamageLine).toBe(true);
  });
});
