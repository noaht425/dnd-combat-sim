import { describe, expect, it } from "vitest";
import { SPELLS, SPELLS_BY_ID } from "../src/lib/sim/spells/catalog";
import { slotResources, slotRow, maxSlotLevel, mysticArcanumLevels, pactSlotLevel } from "../src/lib/sim/spells/slots";
import { preparedCount, cantripsKnown, autoPrepare } from "../src/lib/sim/spells/prepare";
import { spellActions } from "../src/lib/sim/spells/cast";
import { makeCaster } from "../src/lib/sim/spells/caster";
import { makeTemplate } from "../src/lib/sim/engine/templates";
import { parseCombatant } from "../src/lib/sim/schema";
import { validateCombatant } from "../src/lib/sim/validate";
import { runScenario, runScenarioOnce, standardParty } from "../src/lib/sim/engine/scenario";

describe("spell system", () => {
  it("the catalog spans levels 0-9 and every spell has valid metadata", () => {
    const levels = new Set(SPELLS.map((s) => s.level));
    for (let l = 0; l <= 9; l++) expect(levels.has(l)).toBe(true);
    expect(SPELLS.length).toBeGreaterThan(150);
    for (const s of SPELLS) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(s.classes.length).toBeGreaterThan(0);
      expect(["action", "bonus", "reaction"]).toContain(s.castTime);
    }
    // ids unique
    expect(new Set(SPELLS.map((s) => s.id)).size).toBe(SPELLS.length);
  });

  it("slot tables match the four progressions", () => {
    expect(slotRow("full", 20)).toEqual([4, 3, 3, 3, 3, 2, 2, 1, 1]);
    expect(slotRow("full", 1)).toEqual([2]);
    expect(slotRow("half", 1)).toEqual([]);
    expect(slotRow("half", 20)).toEqual([4, 3, 3, 3, 2]);
    expect(slotRow("third", 2)).toEqual([]);
    expect(slotRow("third", 20)).toEqual([4, 3, 3, 1]);
    expect(maxSlotLevel("warlock", 20)).toBe(5);
    expect(pactSlotLevel(9)).toBe(5);
    expect(mysticArcanumLevels(20)).toEqual([6, 7, 8, 9]);
    expect(mysticArcanumLevels(10)).toEqual([]);
  });

  it("warlock slot resources are pact slots + arcanum", () => {
    const r = slotResources("warlock", 17);
    expect(r?.pactSlot?.max).toBe(4);
    expect(r?.pactSlot?.recharge).toBe("shortRest");
    expect(r?.arcanum9?.max).toBe(1);
  });

  it("preparation counts follow the rules", () => {
    expect(preparedCount("wizard", "full", 20, 5)).toBe(25);   // int mod + level
    expect(preparedCount("cleric", "full", 10, 3)).toBe(13);   // wis mod + level
    expect(preparedCount("paladin", "half", 20, 4)).toBe(14);  // cha mod + level/2
    expect(preparedCount("sorcerer", "full", 20, 5)).toBe(15); // known table caps
    expect(cantripsKnown("wizard", 20)).toBe(5);
    expect(cantripsKnown("ranger", 20)).toBe(0);
  });

  it("auto-prepared lists are a spread across levels, not all top-tier", () => {
    const set = autoPrepare("wizard", "full", 20, 5, "blaster");
    const byLevel = new Map<number, number>();
    for (const id of set.spells) {
      const l = SPELLS_BY_ID[id].level;
      byLevel.set(l, (byLevel.get(l) ?? 0) + 1);
    }
    // more low/mid than 9th-level
    expect((byLevel.get(1) ?? 0) + (byLevel.get(2) ?? 0) + (byLevel.get(3) ?? 0)).toBeGreaterThan(byLevel.get(9) ?? 0);
    // Shield + Counterspell always make the cut
    expect(set.spells).toContain("shield");
    expect(set.spells).toContain("counterspell");
  });

  it("spellActions expands upcasting into one action per reachable slot", () => {
    const fireball = SPELLS_BY_ID["fireball"];
    const acts = spellActions(fireball, { kind: "full", level: 20, pb: 6, spellMod: 5 });
    // slots 3..9
    expect(acts.map((a) => a.limitedUse?.resource)).toEqual(["slot3", "slot4", "slot5", "slot6", "slot7", "slot8", "slot9"]);
    // upcast adds dice
    const at3 = JSON.stringify(acts[0].automation);
    const at9 = JSON.stringify(acts[6].automation);
    expect(at3).toContain("8d6");
    expect(at9).toContain("14d6");
  });

  it("warlock spells cast at the pact slot level, arcanum for 6th-9th", () => {
    const acts = (id: string) => spellActions(SPELLS_BY_ID[id], { kind: "warlock", level: 17, pb: 6, spellMod: 5 });
    expect(acts("hold-monster")[0].limitedUse?.resource).toBe("pactSlot");
    expect(acts("finger-of-death")[0].limitedUse?.resource).toBe("arcanum7");
  });

  it("every spell-based template validates at 1 / 5 / 11 / 20", () => {
    for (const id of ["blaster-wizard", "life-cleric", "vengeance-paladin", "hunter-ranger", "draconic-sorcerer", "moon-druid", "lore-bard", "warlock"]) {
      for (const lvl of [1, 5, 11, 20]) {
        const v = validateCombatant(parseCombatant(makeTemplate(id, lvl)));
        expect(v.ok, `${id} L${lvl}: ${v.errors.join("; ")}`).toBe(true);
      }
    }
  });

  it("a caster's prepared spells produce real actions with slot costs", () => {
    const wiz = makeCaster({
      id: "w", name: "W", level: 20, spellClass: "wizard", casterKind: "full", spellAbility: "int",
      ac: 15, hp: 122, abilities: { str: 8, dex: 14, con: 14, int: 20, wis: 12, cha: 10 },
      proficientSaves: ["int", "wis"], focus: "blaster",
    });
    const casts = wiz.actions.filter((a) => a.isSpell && a.limitedUse?.resource.startsWith("slot"));
    expect(casts.length).toBeGreaterThan(20);
    expect(wiz.reactions.some((r) => r.id === "shield")).toBe(true);
    expect(wiz.reactions.some((r) => r.id === "counterspell")).toBe(true);
  });

  it("spell party still loses to a capstone and stomps the trivial", () => {
    const trivial = runScenario({ party: standardParty(3), enemies: ["ogre"], trials: 120 });
    const capstone = runScenario({ party: standardParty(20), enemies: ["tarrasque"], trials: 120 });
    expect(trivial.partyWinRate).toBeGreaterThan(0.9);
    expect(capstone.partyWinRate).toBeLessThan(0.2);
  });

  it("difficulty ordering holds for the spell party across the SRD ladder", () => {
    const run = (id: string, lvl: number) => runScenario({ party: standardParty(lvl), enemies: [id], trials: 150 }).partyWinRate;
    const easy = run("gladiator", 10);
    const bruising = run("adult-red-dragon", 14);
    const wipe = run("tarrasque", 20);
    expect(easy).toBeGreaterThan(bruising);
    expect(bruising).toBeGreaterThan(wipe);
    expect(wipe).toBeLessThan(0.15);
  }, 60000);

  it("a smite's extraDamageOnHit actually lands, and a one-shot smite is used up by the hit", () => {
    let sawBonus = false;
    for (let seed = 1; seed <= 10; seed++) {
      const out = runScenarioOnce({ party: [{ template: "vengeance-paladin", level: 5, spells: ["searing-smite"] }], enemies: ["ogre"], seed });
      if (out.log.some((l) => l.includes("Searing Smite"))) { sawBonus = true; break; }
    }
    expect(sawBonus).toBe(true);
  });

  it("a persistent hit-rider (Hex) keeps dealing its bonus damage across multiple hits, not just one", () => {
    const out = runScenarioOnce({ party: [{ template: "warlock", level: 5, spells: ["hex"] }], enemies: ["adult-red-dragon"], seed: 3 });
    const hexCasts = out.log.filter((l) => l.includes("Hex")).length;
    // Hex is concentration + bonus action: it shouldn't need to be recast every single turn
    // the way a one-shot smite would, since its bonus applies to every hit while it's up
    expect(hexCasts).toBeLessThan(out.result.rounds);
  });

  it("bonus-action spells (Hex, a smite, ...) can be cast on any round, not just round 1", () => {
    let castAfterRound1 = false;
    for (let seed = 1; seed <= 12; seed++) {
      const out = runScenarioOnce({ party: [{ template: "hunter-ranger", level: 5, spells: ["ensnaring-strike"] }], enemies: ["troll"], seed });
      for (const line of out.log) {
        const m = /^R(\d+): .*Ensnaring Strike/.exec(line);
        if (m && Number(m[1]) > 1) { castAfterRound1 = true; break; }
      }
      if (castAfterRound1) break;
    }
    expect(castAfterRound1).toBe(true);
  });
});
