// Second pass over the "remaining, lower-priority gaps" flagged at the end of
// the first subclass audit — each was a real signature feature that was
// either entirely absent or built but never wired up.

import { describe, expect, it } from "vitest";
import { runBattle } from "../lib/sim/battle";
import { makeTemplate } from "../lib/sim/engine/templates";

describe("Subclass audit fixes, round 2", () => {
  it("Evocation Wizard: Empowered Evocation adds INT to one damage-dealing evocation spell per cast", () => {
    // Empowered Evocation is the School of Evocation's 10th-level feature
    const fire = (level: number) => makeTemplate("blaster-wizard", level).actions.find((a) => a.isSpell && /Fireball$/.test(a.name))!;
    expect(JSON.stringify(fire(10).automation)).toMatch(/8d6\+4/); // base 8d6 + INT mod
    expect(JSON.stringify(fire(9).automation)).not.toMatch(/8d6\+4/);
  });

  it("Draconic Sorcerer: Elemental Affinity adds CHA to the first fire-damage node of every spell, without splitting the shared AoE roll", () => {
    const c = makeTemplate("draconic-sorcerer", 9);
    expect(c.ac).toBe(15); // 13 + DEX (Draconic Resilience), not the old flat 14
    const fireball = c.actions.find((a) => a.isSpell && /Fireball$/.test(a.name))!;
    const blob = JSON.stringify(fireball.automation);
    // onFail and onSuccess must carry the *identical* amount string so the
    // interpreter's sharedRolls cache still ties them to one roll.
    const amounts = [...blob.matchAll(/"amount":"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(amounts).size).toBe(1);
    expect(amounts[0]).toMatch(/^8d6\+\d/);
  });

  it("Hunter Ranger: Colossus Slayer adds 1d8 once per turn against a hurt target", () => {
    // the flavor text isn't narrated per-node, so check the automation shape
    // directly, and confirm the battle actually runs with it without throwing.
    const c = makeTemplate("hunter-ranger", 5);
    const atk = c.actions.find((a) => a.id === "attack")!;
    expect(JSON.stringify(atk.automation)).toContain("target.wounded_at_hit");
    const out = runBattle({
      party: [{ template: "hunter-ranger", level: 5, name: "Ranger" }],
      enemies: ["troll"],
      seed: 1,
      controlled: [],
      maxRounds: 3,
    } as never);
    expect(out.frames.length).toBeGreaterThan(0);
  });

  it("Fiend Warlock: Dark One's Blessing grants temp HP on reducing a hostile creature to 0 HP", () => {
    let sawBlessing = false;
    for (let seed = 1; seed <= 30 && !sawBlessing; seed++) {
      const out = runBattle({
        party: [{ template: "warlock", level: 5, name: "Warlock" }],
        enemies: ["kobold"],
        seed,
        controlled: [],
        maxRounds: 3,
      } as never);
      if (/Dark One's Blessing/.test(out.frames.map((f) => f.text ?? "").join("\n"))) sawBlessing = true;
    }
    expect(sawBlessing).toBe(true);
  });

  it("Lore Bard: Cutting Words lets an ally spend Bardic Inspiration to turn a close hit against a party member into a miss", () => {
    const c = makeTemplate("lore-bard", 5);
    expect(c.resources.bardic_inspiration).toEqual({ max: 4, recharge: "shortRest" });
    expect(c.reactions.some((r) => r.id === "cutting-words")).toBe(true);

    let saw = false;
    for (let seed = 1; seed <= 60 && !saw; seed++) {
      const out = runBattle({
        party: [
          { template: "lore-bard", level: 5, name: "Bard" },
          { template: "totem-barbarian", level: 5, name: "Barbarian" },
        ],
        enemies: ["troll", "troll"],
        seed,
        controlled: [],
        maxRounds: 3,
      } as never);
      if (/Cutting Words/.test(out.frames.map((f) => f.text ?? "").join("\n"))) saw = true;
    }
    expect(saw).toBe(true);
  });
});
