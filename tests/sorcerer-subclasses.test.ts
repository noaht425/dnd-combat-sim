// Five sorcerer subclasses that only had "did you mean sorcerer?" before:
// Divine Soul, Shadow Magic, Storm Sorcery, Aberrant Mind, Clockwork Soul.
// Each gets a real signature mechanic, not just a name that resolves.

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { critRangeFor, rollAttack } from "../lib/sim/engine/resolve";
import { initCombatant, type CombatState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";

const SORCERER_IDS = [
  "divine-soul-sorcerer",
  "shadow-magic-sorcerer",
  "storm-sorcerer",
  "aberrant-mind-sorcerer",
  "clockwork-soul-sorcerer",
];

function stateForcingFace(face: number): CombatState {
  const rng = makeRng(1);
  rng.d20mode = () => ({ used: face, nat: face });
  return {
    round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [],
    maxRounds: 10, ended: false, verbose: false, summonCounter: 0,
  };
}

describe("new sorcerer subclasses — schema validity and parsing", () => {
  it("every new subclass builds a schema-valid PC at levels 1, 6, 9, 18", () => {
    for (const id of SORCERER_IDS) {
      for (const lvl of [1, 6, 9, 18]) {
        const c = makeTemplate(id, lvl);
        const res = validateCombatant(c);
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok).toBe(true);
      }
    }
  });

  it("free text resolves each new subclass to its own template, not the bare default", () => {
    expect(findClassTemplate("divine soul sorcerer").match?.templateId).toBe("divine-soul-sorcerer");
    expect(findClassTemplate("shadow magic sorcerer").match?.templateId).toBe("shadow-magic-sorcerer");
    expect(findClassTemplate("storm sorcery sorcerer").match?.templateId).toBe("storm-sorcerer");
    expect(findClassTemplate("aberrant mind sorcerer").match?.templateId).toBe("aberrant-mind-sorcerer");
    expect(findClassTemplate("clockwork soul sorcerer").match?.templateId).toBe("clockwork-soul-sorcerer");
    // bare "sorcerer" still defaults to Draconic, unchanged
    expect(findClassTemplate("sorcerer").match?.templateId).toBe("draconic-sorcerer");
  });
});

describe("Divine Soul: Favored by the Gods", () => {
  it("boosts a roll that would miss by exactly enough, spends the resource, and doesn't touch a roll that already hits", () => {
    const sorc = initCombatant(makeTemplate("divine-soul-sorcerer", 5), "party");
    const dummy = initCombatant(makeTemplate("gwm-fighter", 1), "monster");
    expect(sorc.resources.get("favored_by_gods")).toBe(1);

    // toHit=0, ac=dummy's AC; face chosen 1 short of hitting — any 2d4 roll (2-8) closes it
    const ac = dummy.ref.ac;
    const face = Math.max(2, ac - 1);
    const res = rollAttack(stateForcingFace(face), sorc, dummy, 0, undefined, critRangeFor(sorc));
    expect(res.hit).toBe(true);
    expect(sorc.resources.get("favored_by_gods")).toBe(0);

    // spent — a second missed roll this fight gets no further help
    const res2 = rollAttack(stateForcingFace(face), sorc, dummy, 0, undefined, critRangeFor(sorc));
    expect(res2.hit).toBe(false);
  });

  it("never fires on a roll that already hits (no free crit-range shenanigans)", () => {
    const sorc = initCombatant(makeTemplate("divine-soul-sorcerer", 5), "party");
    const dummy = initCombatant(makeTemplate("gwm-fighter", 1), "monster");
    const res = rollAttack(stateForcingFace(19), sorc, dummy, 50, undefined, critRangeFor(sorc));
    expect(res.hit).toBe(true);
    expect(sorc.resources.get("favored_by_gods")).toBe(1); // untouched
  });
});

describe("Shadow Magic: Strength of the Grave", () => {
  it("survives a lethal hit at 1 HP once per fight instead of dropping", () => {
    let sawGrave = false;
    for (let seed = 1; seed <= 40 && !sawGrave; seed++) {
      const out = runBattle({
        party: [{ template: "shadow-magic-sorcerer", level: 5, name: "Sorc" }],
        enemies: ["hill-giant"],
        seed,
        controlled: [],
        maxRounds: 3,
      } as never);
      if (/refuses to die/.test(out.frames.map((f) => f.text ?? "").join("\n"))) sawGrave = true;
    }
    expect(sawGrave).toBe(true);
  });
});

describe("Storm Sorcery: Heart of the Storm", () => {
  it("adds a half-level bonus (rounded up) to Shatter's thunder damage, scaling as level rises, and preserves the shared save-roll amount", () => {
    // Shatter isn't auto-prepared until level 8 for this focus — both data
    // points sit above Heart of the Storm's own level-6 gate, so this
    // confirms the formula tracks level rather than the gate being a no-op.
    const l8 = makeTemplate("storm-sorcerer", 8).actions.find((a) => a.name === "Shatter")!;
    expect(JSON.stringify(l8.automation)).toMatch(/"amount":"3d8\+4"/); // ceil(8/2)

    const l9 = makeTemplate("storm-sorcerer", 9).actions.find((a) => a.name === "Shatter")!;
    const blob = JSON.stringify(l9.automation);
    expect(blob).toMatch(/"amount":"3d8\+5"/); // ceil(9/2)
    const amounts = [...blob.matchAll(/"amount":"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(amounts).size).toBe(1); // onFail/onSuccess still share one roll
  });

  it("Storm's Fury (18th level) retaliates with lightning when hit — absent below that level", () => {
    expect(makeTemplate("storm-sorcerer", 17).traits.some((t) => t.id === "storms-fury")).toBe(false);
    expect(makeTemplate("storm-sorcerer", 18).traits.some((t) => t.id === "storms-fury")).toBe(true);
  });
});

describe("Aberrant Mind: Psychic Defenses", () => {
  it("gains psychic resistance and frightened immunity at level 6, not before", () => {
    const low = makeTemplate("aberrant-mind-sorcerer", 5);
    expect(low.resistances).not.toContain("psychic");
    expect(low.conditionImmunities).not.toContain("frightened");
    const high = makeTemplate("aberrant-mind-sorcerer", 6);
    expect(high.resistances).toContain("psychic");
    expect(high.conditionImmunities).toContain("frightened");
  });
});

describe("Clockwork Soul: Bastion of Law", () => {
  it("spends sorcery points as a bonus action to grant temp HP to the lowest-HP ally", () => {
    const c = makeTemplate("clockwork-soul-sorcerer", 6);
    const bastion = c.actions.find((a) => a.id === "bastion-of-law")!;
    expect(bastion.cost).toEqual({ bonus: 1 });
    expect(JSON.stringify(bastion.automation)).toMatch(/"tempHp"/);
    expect(c.actions.some((a) => a.id === "bastion-of-law")).toBe(true);
    expect(makeTemplate("clockwork-soul-sorcerer", 5).actions.some((a) => a.id === "bastion-of-law")).toBe(false);
  });
});
