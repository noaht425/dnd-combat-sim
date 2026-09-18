// Battle Master fighter: real maneuvers beyond Riposte (which already
// worked) — Trip Attack, Menacing Attack, Disarming Attack, and Rally, each
// spending a superiority die. A low-HP target (e.g. a kobold) dies from the
// base weapon damage before the maneuver's own extra die + save ever
// executes (applyDamage/rollSave no-op against an already-dead unit) — these
// use a troll specifically so the maneuver's own effect is observable.

import { describe, expect, it } from "vitest";
import { runBattle } from "../lib/sim/battle";
import { makeTemplate } from "../lib/sim/engine/templates";

describe("Battle Master fighter — maneuvers", () => {
  it("offers Trip/Menacing/Disarming as distinct choices, plus Rally", () => {
    const names = makeTemplate("battlemaster-fighter", 5).actions.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining([
      "Attack", "Attack + Trip Attack", "Attack + Menacing Attack", "Attack + Disarming Attack", "Rally",
    ]));
  });

  it("Trip Attack spends a die and knocks prone on a failed save", () => {
    const trip = makeTemplate("battlemaster-fighter", 5).actions.find((a) => a.id === "attack-trip")!;
    let sawProne = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const out = runBattle({
        party: [{ template: "battlemaster-fighter", level: 5 }],
        enemies: ["troll"],
        seed,
        controlled: ["pc-1-battlemaster-fighter"],
        maxRounds: 1,
        decisions: [{ round: 1, unitId: "pc-1-battlemaster-fighter", actionId: trip.id, targetId: "monster-1-troll" }],
      } as never);
      if (/[Pp]rone/.test(out.frames.map((f) => f.text ?? "").join("\n"))) sawProne++;
    }
    expect(sawProne).toBeGreaterThan(5);
  });

  it("Rally grants temp HP to the most-hurt ally (or self)", () => {
    let sawRally = false;
    for (let seed = 1; seed <= 20 && !sawRally; seed++) {
      const out = runBattle({
        party: [{ template: "battlemaster-fighter", level: 5, name: "Bront" }],
        enemies: ["kobold"],
        seed,
        controlled: ["pc-1-battlemaster-fighter"],
        maxRounds: 1,
        decisions: [{ round: 1, unitId: "pc-1-battlemaster-fighter", bonusActionId: "rally" }],
      } as never);
      if (/Rally -> Bront \+\d+/.test(out.frames.map((f) => f.text ?? "").join("\n"))) sawRally = true;
    }
    expect(sawRally).toBe(true);
  });
});
