// A pass over the existing subclasses (beyond the four built earlier this
// session) looking for the same pattern: a signature feature either
// completely absent, or its supporting mechanism built but never wired up.

import { describe, expect, it } from "vitest";
import { runBattle } from "../lib/sim/battle";
import { makeTemplate } from "../lib/sim/engine/templates";

describe("Subclass audit fixes", () => {
  it("Assassin rogue: Assassinate from 3rd level (advantage against creatures that haven't taken a turn) — no initiative jump, no assumed surprise", () => {
    expect(makeTemplate("assassin-rogue", 2).specialRules).toEqual([]);
    expect(makeTemplate("assassin-rogue", 5).specialRules).toContainEqual({ rule: "assassinate" });
    expect(makeTemplate("assassin-rogue", 5).specialRules).not.toContainEqual({ rule: "ambush" });
  });

  it("Path of the Totem Warrior (Bear): rage resists bludgeoning / piercing / slashing, and everything but psychic from 3rd level", () => {
    const resist = (level: number) => {
      const a = makeTemplate("totem-barbarian", level).actions.find((x) => x.id === "rage")!;
      const gate = a.automation[0];
      if (gate.type !== "branch") throw new Error("unexpected shape");
      const target = gate.then[0];
      if (target.type !== "target") throw new Error("unexpected shape");
      const effect = target.effects[0];
      if (effect.type !== "applyEffect") throw new Error("unexpected shape");
      return effect.mods?.resistTypes ?? [];
    };
    expect(resist(1).sort()).toEqual(["bludgeoning", "piercing", "slashing"]);
    expect(resist(3)).toContain("fire");
    expect(resist(3)).not.toContain("psychic");
  });

  it("Way of the Open Hand: Open Hand Technique knocks a Flurry of Blows target prone", () => {
    const flurry = makeTemplate("open-hand-monk", 5).actions.find((a) => a.id === "flurry")!;
    let sawProne = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const out = runBattle({
        party: [{ template: "open-hand-monk", level: 5 }],
        enemies: ["troll"],
        seed,
        controlled: ["pc-1-open-hand-monk"],
        maxRounds: 1,
        decisions: [{ round: 1, unitId: "pc-1-open-hand-monk", bonusActionId: flurry.id }],
      } as never);
      if (/Prone/.test(out.frames.map((f) => f.text ?? "").join("\n"))) sawProne++;
    }
    expect(sawProne).toBeGreaterThan(5);
  });

  it("Circle of the Moon: Combat Wild Shape grants temp HP and a real attack, once per short rest", () => {
    const c = makeTemplate("moon-druid", 5);
    expect(c.resources.wild_shape).toEqual({ max: 2, recharge: "shortRest" });
    const out = runBattle({
      party: [{ template: "moon-druid", level: 5, name: "Druid" }],
      enemies: ["kobold"],
      seed: 1,
      controlled: [],
      maxRounds: 1,
    } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/Wild Shape \(Bear\) -> .*Druid \+\d+/);
  });

  it("Life Domain: Disciple of Life adds a flat bonus to any healing spell", () => {
    const c = makeTemplate("life-cleric", 5);
    const healSpell = c.actions.find((a) => a.isSpell && /-\d+$/.test(a.id) && JSON.stringify(a.automation).includes('"heal"'))!;
    const healNodes = JSON.stringify(healSpell.automation).match(/"heal"/g) ?? [];
    expect(healNodes.length).toBeGreaterThanOrEqual(2); // the spell's own heal + Disciple of Life's bonus
  });
});
