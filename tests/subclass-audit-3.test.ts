// A dig prompted by "anything else to fix?" — found two more real gaps that
// the earlier audits missed: an orphaned reaction left on the wrong
// template, and a specialRule declared in the schema but never dispatched.

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { critRangeFor, rollAttack } from "../lib/sim/engine/resolve";
import { initCombatant, type CombatState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";

/** the smallest CombatState `rollAttack` needs, with `d20mode` forced to a fixed face */
function stateForcingFace(face: number): CombatState {
  const rng = makeRng(1);
  rng.d20mode = () => ({ used: face, nat: face });
  return {
    round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [],
    maxRounds: 10, ended: false, verbose: false, summonCounter: 0,
  };
}

describe("Subclass audit fixes, round 3", () => {
  it("Champion (GWM) fighter: Improved/Superior Critical widens the crit range in the schema", () => {
    // Great Weapon Fighting is the fighter's 1st-level style; Improved Critical only arrives at 3rd
    expect(makeTemplate("gwm-fighter", 2).specialRules).toEqual([{ rule: "greatWeaponFighting" }]);
    expect(makeTemplate("gwm-fighter", 3).specialRules).toContainEqual({ rule: "critRange", value: 19 });
    expect(makeTemplate("gwm-fighter", 15).specialRules).toContainEqual({ rule: "critRange", value: 18 });
  });

  it("Champion (GWM) fighter: a natural 19 actually crits from level 3 on, and doesn't below it", () => {
    // mirrors interpreter.ts's own wiring: Math.min(node.critRange ?? 20, critRangeFor(source))
    const novice = initCombatant(makeTemplate("gwm-fighter", 2), "party");
    const champ = initCombatant(makeTemplate("gwm-fighter", 3), "party");
    const dummy = initCombatant(makeTemplate("gwm-fighter", 1), "monster");

    const noviceRes = rollAttack(stateForcingFace(19), novice, dummy, 20 /* always hits */, undefined, critRangeFor(novice));
    const champRes = rollAttack(stateForcingFace(19), champ, dummy, 20, undefined, critRangeFor(champ));
    expect(noviceRes.crit).toBe(false);
    expect(champRes.crit).toBe(true);
  });

  it("Champion (GWM) fighter no longer carries Battle Master's orphaned superiority-dice Riposte", () => {
    const c = makeTemplate("gwm-fighter", 9);
    expect(c.reactions).toEqual([]);
    expect(c.resources.superiority).toBeUndefined();
  });
});
