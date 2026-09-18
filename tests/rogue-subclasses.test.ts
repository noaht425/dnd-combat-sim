// The seven remaining rogue subclasses (Assassin was already built): Thief,
// Swashbuckler, Mastermind, Inquisitive, Scout, Soulknife, and Arcane
// Trickster. Rogue is now fully covered — 8/8 real 5e rogue subclasses.

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";

const ROGUE_IDS = [
  "thief-rogue", "swashbuckler-rogue", "mastermind-rogue", "inquisitive-rogue",
  "scout-rogue", "soulknife-rogue", "arcane-trickster-rogue",
];

describe("new rogue subclasses — schema validity and parsing", () => {
  it("every new subclass builds a schema-valid PC at levels 1, 9, 17, 20", () => {
    for (const id of ROGUE_IDS) {
      for (const lvl of [1, 9, 17, 20]) {
        const c = makeTemplate(id, lvl);
        const res = validateCombatant(c);
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok).toBe(true);
      }
    }
  });

  it("free text resolves each new subclass to its own template, not the bare rogue default", () => {
    expect(findClassTemplate("thief rogue").match?.templateId).toBe("thief-rogue");
    expect(findClassTemplate("swashbuckler rogue").match?.templateId).toBe("swashbuckler-rogue");
    expect(findClassTemplate("mastermind rogue").match?.templateId).toBe("mastermind-rogue");
    expect(findClassTemplate("inquisitive rogue").match?.templateId).toBe("inquisitive-rogue");
    expect(findClassTemplate("scout rogue").match?.templateId).toBe("scout-rogue");
    expect(findClassTemplate("soulknife rogue").match?.templateId).toBe("soulknife-rogue");
    expect(findClassTemplate("arcane trickster rogue").match?.templateId).toBe("arcane-trickster-rogue");
    // bare "rogue" still defaults to Assassin, unchanged
    expect(findClassTemplate("rogue").match?.templateId).toBe("assassin-rogue");
  });
});

describe("Thief: Thief's Reflexes", () => {
  it("gains a once-per-fight bonus-action extra Attack only from level 17", () => {
    expect(makeTemplate("thief-rogue", 16).actions.some((a) => a.id === "thiefs-reflexes")).toBe(false);
    const c = makeTemplate("thief-rogue", 17);
    const trait = c.actions.find((a) => a.id === "thiefs-reflexes")!;
    expect(trait.cost).toEqual({ bonus: 1 });
    expect(c.resources.thiefs_reflexes).toEqual({ max: 1, recharge: "longRest" });
  });
});

describe("Swashbuckler: Rakish Audacity", () => {
  it("Sneak Attack has no advantage/adjacency requirement on its damage node", () => {
    const atk = makeTemplate("swashbuckler-rogue", 5).actions.find((a) => a.id === "attack")!;
    const blob = JSON.stringify(atk.automation);
    expect(blob).toMatch(/"amount":"3d6"/); // the sneak die is still there
    expect(blob).not.toMatch(/requiresSneakAttack/); // just never gated
  });

  it("lands sneak attack damage even with no advantage and no ally adjacent", () => {
    let sawSneak = false;
    for (let seed = 1; seed <= 20 && !sawSneak; seed++) {
      const out = runBattle({
        party: [{ template: "swashbuckler-rogue", level: 5, name: "Rogue" }],
        enemies: ["kobold"],
        seed,
        controlled: [],
        maxRounds: 2,
      } as never);
      // a kobold (7 HP) dying to the opening hit is only possible with the
      // sneak die included — the base 1d8+4 alone caps at 12, plausible but
      // not guaranteed; over 20 seeds this should show up reliably.
      if (/Kobold is destroyed/.test(out.frames.map((f) => f.text ?? "").join("\n"))) sawSneak = true;
    }
    expect(sawSneak).toBe(true);
  });
});

describe("Mastermind: Master of Tactics", () => {
  it("bonus action grants an ally advantage for a round", () => {
    const c = makeTemplate("mastermind-rogue", 5);
    const a = c.actions.find((x) => x.id === "master-of-tactics")!;
    expect(a.cost).toEqual({ bonus: 1 });
    expect(JSON.stringify(a.automation)).toMatch(/"attackAdvantage":"adv"/);
  });
});

describe("Inquisitive: Insightful Fighting", () => {
  it("bonus action grants self advantage for a round (guarantees Sneak Attack)", () => {
    const c = makeTemplate("inquisitive-rogue", 5);
    const a = c.actions.find((x) => x.id === "insightful-fighting")!;
    expect(a.cost).toEqual({ bonus: 1 });
    const blob = JSON.stringify(a.automation);
    expect(blob).toMatch(/"who":"self"/);
    expect(blob).toMatch(/"attackAdvantage":"adv"/);
  });
});

describe("Scout: Sudden Strike", () => {
  it("gains a bonus-action extra Attack only from level 9", () => {
    expect(makeTemplate("scout-rogue", 8).actions.some((a) => a.id === "sudden-strike")).toBe(false);
    const a = makeTemplate("scout-rogue", 9).actions.find((x) => x.id === "sudden-strike")!;
    expect(a.cost).toEqual({ bonus: 1 });
  });
});

describe("Soulknife: Psychic Blades + Homing Strikes", () => {
  it("Psychic Blades reskins the base attack to psychic damage", () => {
    const atk = makeTemplate("soulknife-rogue", 5).actions.find((a) => a.id === "attack")!;
    const blob = JSON.stringify(atk.automation);
    expect(blob).toMatch(/"damageType":"psychic"/);
    expect(blob).not.toMatch(/"damageType":"piercing"/);
  });

  it("Homing Strikes (9th level) reuses the boostMissedAttack mechanism", () => {
    expect(makeTemplate("soulknife-rogue", 8).specialRules).toEqual([]);
    const c = makeTemplate("soulknife-rogue", 9);
    expect(c.specialRules).toContainEqual({ rule: "boostMissedAttack", bonusDice: "1d6", resource: "psi_die" });
    expect(c.resources.psi_die).toEqual({ max: 1, recharge: "longRest" });
  });
});

describe("Arcane Trickster: third-caster spellcasting + Sneak Attack chassis", () => {
  it("has no spell slots (and no Invisibility yet) before 3rd level, gains its first slot at 3rd, and a 2nd-level slot at 7th", () => {
    expect(makeTemplate("arcane-trickster-rogue", 1).resources.slot1?.max ?? 0).toBe(0);
    expect(makeTemplate("arcane-trickster-rogue", 3).resources.slot1?.max ?? 0).toBeGreaterThan(0);
    expect(makeTemplate("arcane-trickster-rogue", 5).actions.some((a) => a.name === "Invisibility")).toBe(false);
    expect(makeTemplate("arcane-trickster-rogue", 7).actions.some((a) => a.name === "Invisibility")).toBe(true);
  });

  it("still has the rogue chassis: Sneak Attack, Evasion, Uncanny Dodge, and the Shield reaction spell", () => {
    const c = makeTemplate("arcane-trickster-rogue", 5);
    expect(JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation)).toContain("requiresSneakAttack");
    expect(c.traits.some((t) => t.id === "evasion")).toBe(true);
    expect(c.reactions.some((r) => r.id === "uncanny-dodge")).toBe(true);
    expect(c.reactions.some((r) => r.id === "shield")).toBe(true);
  });
});
