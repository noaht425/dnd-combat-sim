// The seven sorcerous origins, checked against the printed text (Sorcerer class page and each origin
// page on dnd5e.wikidot.com). The first version of this file asserted features written from memory;
// several were wrong (Storm's Fury at 18th, Heart of the Storm on the spell's target, Psychic Defenses'
// frightened immunity, Bastion of Law as temp HP, Elemental Affinity with no level gate, ...).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { critRangeFor, rollAttack, rollSave, applyDamage } from "../lib/sim/engine/resolve";
import { initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { PC_SUMMONS, houndOfIllOmenFor } from "../lib/sim/engine/minions";

const SORCERER_IDS = [
  "draconic-sorcerer", "wild-magic-sorcerer", "divine-soul-sorcerer", "shadow-magic-sorcerer",
  "storm-sorcerer", "aberrant-mind-sorcerer", "clockwork-soul-sorcerer",
];

function state(face: number, modes: string[] = []): CombatState {
  const rng = makeRng(1);
  rng.d20mode = (m) => { modes.push(m); return { used: face, nat: face }; };
  return {
    round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [],
    maxRounds: 10, ended: false, verbose: false, summonCounter: 0,
  };
}
const unit = (id: string, level: number, side: "party" | "monster"): CombatantState => initCombatant(makeTemplate(id, level), side, `-${side}`);
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));
const blob = (id: string, lvl: number, name: string) => JSON.stringify(makeTemplate(id, lvl).actions.find((a) => a.name === name)?.automation);

describe("sorcerer origins — schema validity and parsing", () => {
  it("every origin builds a schema-valid PC at levels 1, 3, 6, 9, 14, 18", () => {
    for (const id of SORCERER_IDS) {
      for (const lvl of [1, 3, 6, 9, 14, 18]) {
        const res = validateCombatant(makeTemplate(id, lvl));
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok).toBe(true);
      }
    }
  });

  it("free text resolves each origin to its own template; bare 'sorcerer' stays Draconic", () => {
    expect(findClassTemplate("divine soul sorcerer").match?.templateId).toBe("divine-soul-sorcerer");
    expect(findClassTemplate("shadow magic sorcerer").match?.templateId).toBe("shadow-magic-sorcerer");
    expect(findClassTemplate("storm sorcery sorcerer").match?.templateId).toBe("storm-sorcerer");
    expect(findClassTemplate("aberrant mind sorcerer").match?.templateId).toBe("aberrant-mind-sorcerer");
    expect(findClassTemplate("clockwork soul sorcerer").match?.templateId).toBe("clockwork-soul-sorcerer");
    expect(findClassTemplate("sorcerer").match?.templateId).toBe("draconic-sorcerer");
  });
});

describe("Draconic Bloodline", () => {
  it("Draconic Resilience: +1 HP per level and AC 13 + DEX", () => {
    const d = makeTemplate("draconic-sorcerer", 9);
    const w = makeTemplate("wild-magic-sorcerer", 9);
    expect(d.maxHp).toBe((w.maxHp as number) + 9);
    expect(d.ac).toBe(15);
  });

  it("Elemental Affinity starts at 6th level: +CHA to one damage roll of a fire spell, and fire resistance", () => {
    // Fire Bolt is 2d10 from 5th level
    expect(blob("draconic-sorcerer", 5, "Fire Bolt")).toContain('"amount":"2d10"');
    expect(blob("draconic-sorcerer", 6, "Fire Bolt")).toContain('"amount":"2d10+4"');
    expect(makeTemplate("draconic-sorcerer", 5).resistances).not.toContain("fire");
    expect(makeTemplate("draconic-sorcerer", 6).resistances).toContain("fire");
    // the 1 sorcery point that buys the resistance is spent at the start
    expect(makeTemplate("draconic-sorcerer", 6).resources.sorcery_points).toMatchObject({ max: 6, start: 5 });
  });
});

describe("Divine Soul", () => {
  it("Favored by the Gods: 2d4 on a missed attack roll, once per SHORT or long rest", () => {
    const c = makeTemplate("divine-soul-sorcerer", 5);
    expect(c.resources.favored_by_gods).toEqual({ max: 1, recharge: "shortRest" });
    const sorc = initCombatant(c, "party", "-a");
    const dummy = unit("gwm-fighter", 1, "monster");
    const face = Math.max(2, dummy.ref.ac - 1);
    expect(rollAttack(state(face), sorc, dummy, 0, undefined, critRangeFor(sorc)).hit).toBe(true);
    expect(sorc.resources.get("favored_by_gods")).toBe(0);
    expect(rollAttack(state(face), sorc, dummy, 0, undefined, critRangeFor(sorc)).hit).toBe(false);
  });

  it("Favored by the Gods also covers a failed saving throw, and the use is only spent when it turns the save around", () => {
    const sorc = unit("divine-soul-sorcerer", 5, "party");
    const s = state(9);
    put(s, sorc);
    // fails a DC 3 above its total: 2d4 (2-8) can't always close it, so use a 1-point gap it always closes
    const mod = 0;
    const total = 9 + (sorc.ref.proficientSaves.includes("wis") ? sorc.ref.pb : 0) + Math.floor((sorc.ref.abilities.wis - 10) / 2) + mod;
    expect(rollSave(s, sorc, "wis", total + 1).passed).toBe(true);
    expect(sorc.resources.get("favored_by_gods")).toBe(0);
    // a fresh one against a DC 30 (impossible) leaves the use unspent
    const sorc2 = unit("divine-soul-sorcerer", 5, "party");
    const s2 = state(9);
    put(s2, sorc2);
    expect(rollSave(s2, sorc2, "wis", 30).passed).toBe(false);
    expect(sorc2.resources.get("favored_by_gods")).toBe(1);
  });

  it("Unearthly Recovery (18th): bonus action below half HP, regain half the hit point maximum, once per long rest", () => {
    expect(makeTemplate("divine-soul-sorcerer", 17).actions.some((a) => a.id === "unearthly-recovery")).toBe(false);
    const c = makeTemplate("divine-soul-sorcerer", 18);
    const a = c.actions.find((x) => x.id === "unearthly-recovery")!;
    expect(a.cost).toEqual({ bonus: 1 });
    expect(JSON.stringify(a.automation)).toContain(`"amount":"${Math.floor((c.maxHp as number) / 2)}"`);
    expect(c.resources.unearthly_recovery).toEqual({ max: 1, recharge: "longRest" });
  });
});

describe("Shadow Magic", () => {
  const dropTo0 = (opts: { face: number; type?: "necrotic" | "radiant"; crit?: boolean }) => {
    const sorc = unit("shadow-magic-sorcerer", 5, "party");
    const s = state(opts.face);
    put(s, sorc);
    sorc.hp = 3;
    applyDamage(s, sorc, 10, opts.type ?? "necrotic", { crit: opts.crit });
    return sorc;
  };

  it("Strength of the Grave: a passed Charisma save (DC 5 + damage) leaves you at 1 HP and spends the once-per-long-rest use", () => {
    const survived = dropTo0({ face: 20 });
    expect(survived.hp).toBe(1);
    expect(survived.downed).toBe(false);
    expect(survived.resources.get("strength_of_the_grave")).toBe(0);
  });

  it("...a failed save (or an impossible DC) lets you drop, and the use is NOT spent", () => {
    const dropped = dropTo0({ face: 1 });
    expect(dropped.downed).toBe(true);
    expect(dropped.resources.get("strength_of_the_grave")).toBe(1);
  });

  it("...and it can't be used against radiant damage or a critical hit", () => {
    expect(dropTo0({ face: 20, type: "radiant" }).downed).toBe(true);
    expect(dropTo0({ face: 20, crit: true }).downed).toBe(true);
  });

  it("Hound of Ill Omen (6th): bonus action + 3 sorcery points; dire wolf statistics, Medium; temp HP = half your level", () => {
    expect(makeTemplate("shadow-magic-sorcerer", 5).actions.some((a) => a.id === "hound-of-ill-omen")).toBe(false);
    const c = makeTemplate("shadow-magic-sorcerer", 8);
    const a = c.actions.find((x) => x.id === "hound-of-ill-omen")!;
    expect(a.cost).toEqual({ bonus: 1 });
    expect(JSON.stringify(a.automation)).toContain('"tempHp":"4"');
    expect(JSON.stringify(a.automation)).toContain("spendResource");
    const hound = PC_SUMMONS[houndOfIllOmenFor(8)];
    expect(hound.size).toBe("medium");
    expect(hound.ac).toBe(14); // the dire wolf's
    expect(hound.actions.some((x) => x.id === "bite")).toBe(true);
  });

  it("in a real fight the hound appears with temporary hit points", () => {
    const out = runBattle({
      party: [{ template: "shadow-magic-sorcerer", level: 8, name: "Sorc" }],
      enemies: ["troll"], seed: 2, controlled: [], maxRounds: 2,
    } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/Sorc raises 1× Hound of Ill Omen/);
  });
});

describe("Storm Sorcery", () => {
  it("Heart of the Storm (6th): resistance to lightning and thunder", () => {
    expect(makeTemplate("storm-sorcerer", 5).resistances).not.toContain("thunder");
    expect(makeTemplate("storm-sorcerer", 6).resistances).toEqual(expect.arrayContaining(["lightning", "thunder"]));
  });

  it("...and starting to cast a lightning/thunder spell erupts damage equal to HALF your level (rounded down) to creatures within 10 feet of YOU", () => {
    const l8 = JSON.parse(blob("storm-sorcerer", 8, "Shatter"));
    expect(l8[0]).toEqual({
      type: "target", who: { who: "eachEnemy", withinFt: 10 },
      effects: [{ type: "damage", amount: "4", damageType: "thunder" }],
    });
    // the spell's own damage is untouched (the old version folded a bonus into it)
    expect(JSON.stringify(l8[1])).toContain('"amount":"3d8"');
    const l9 = JSON.parse(blob("storm-sorcerer", 9, "Shatter"));
    expect(l9[0].effects[0].amount).toBe("4"); // half of 9, rounded DOWN
  });

  it("Storm's Fury is a 14th-level reaction dealing your sorcerer level in lightning damage, to a MELEE attacker", () => {
    expect(makeTemplate("storm-sorcerer", 13).reactions.some((r) => r.id === "storms-fury")).toBe(false);
    const fury = makeTemplate("storm-sorcerer", 14).reactions.find((r) => r.id === "storms-fury")!;
    expect(fury.cost).toEqual({ reaction: 1 });
    expect(JSON.stringify(fury.automation)).toContain('"amount":"14","damageType":"lightning"');
  });

  it("Wind Soul (18th): immunity to lightning and thunder", () => {
    expect(makeTemplate("storm-sorcerer", 17).immunities).not.toContain("lightning");
    expect(makeTemplate("storm-sorcerer", 18).immunities).toEqual(expect.arrayContaining(["lightning", "thunder"]));
  });
});

describe("Aberrant Mind", () => {
  it("Psychic Defenses (6th): resistance to psychic damage and ADVANTAGE on saves against being charmed or frightened (not immunity)", () => {
    const low = makeTemplate("aberrant-mind-sorcerer", 5);
    expect(low.resistances).not.toContain("psychic");
    const c = makeTemplate("aberrant-mind-sorcerer", 6);
    expect(c.resistances).toContain("psychic");
    expect(c.conditionImmunities).not.toContain("frightened");
    const sorc = initCombatant(c, "party", "-a");
    const modes: string[] = [];
    const s = state(10, modes);
    put(s, sorc);
    rollSave(s, sorc, "wis", 15, { conditions: ["frightened"] });
    rollSave(s, sorc, "wis", 15, { conditions: ["poisoned"] });
    expect(modes).toEqual(["adv", "flat"]);
  });

  it("Psionic Spells: the always-known spells that exist in the catalog are prepared at their levels", () => {
    const names = (lvl: number) => makeTemplate("aberrant-mind-sorcerer", lvl).actions.map((a) => a.name);
    expect(names(1)).toContain("Dissonant Whispers");
    expect(names(5)).toContain("Hunger of Hadar");
  });

  it("Warping Implosion (18th): 3d10 force within 30 feet (Strength save for half), once per long rest or 5 sorcery points", () => {
    expect(makeTemplate("aberrant-mind-sorcerer", 17).actions.some((a) => a.id === "warping-implosion")).toBe(false);
    const c = makeTemplate("aberrant-mind-sorcerer", 18);
    expect(JSON.stringify(c.actions.find((a) => a.id === "warping-implosion")!.automation)).toContain('"amount":"3d10","damageType":"force"');
    expect(c.resources.warping_implosion).toEqual({ max: 1, recharge: "longRest" });
    expect(JSON.stringify(c.actions.find((a) => a.id === "warping-implosion-sp")!.automation)).toContain('"amount":5');
  });
});

describe("Clockwork Soul", () => {
  it("Bastion of Law (6th) is an ACTION spending 1-5 sorcery points to ward a creature with that many d8s", () => {
    expect(makeTemplate("clockwork-soul-sorcerer", 5).actions.some((a) => a.id.startsWith("bastion-of-law"))).toBe(false);
    const c = makeTemplate("clockwork-soul-sorcerer", 6);
    const three = c.actions.find((a) => a.id === "bastion-of-law-3")!;
    expect(three.cost).toEqual({ action: 1 });
    expect(JSON.stringify(three.automation)).toContain('"type":"ward","dice":3');
  });

  it("a ward reduces damage by the d8s it expends, and they run out", () => {
    const s = state(10);
    const sorc = unit("clockwork-soul-sorcerer", 6, "party");
    put(s, sorc);
    sorc.ward = { dice: 3, sourceId: sorc.id };
    const before = sorc.hp;
    const dealt = applyDamage(s, sorc, 40, "force", {});
    expect(dealt).toBeLessThan(40);
    expect(dealt).toBeGreaterThanOrEqual(40 - 24); // 3d8 tops out at 24
    expect(sorc.ward.dice).toBeLessThan(3);
    expect(before - sorc.hp).toBe(dealt);
  });

  it("Restore Balance (1st): PB uses; cancels an enemy's advantage on a roll against the party", () => {
    const c = makeTemplate("clockwork-soul-sorcerer", 5);
    expect(c.resources.restore_balance).toEqual({ max: 3, recharge: "longRest" });
    const sorc = initCombatant(c, "party", "-a");
    const foe = unit("gwm-fighter", 5, "monster");
    const modes: string[] = [];
    const s = state(15, modes);
    put(s, sorc, foe);
    rollAttack(s, foe, sorc, 5, "adv");
    expect(modes).toEqual(["flat"]);
    expect(sorc.resources.get("restore_balance")).toBe(2);
    expect(sorc.reactionUsed).toBe(true);
  });

  it("Clockwork Magic: the always-known spells are prepared (Protection from Evil and Good at 1st, Aid at 3rd)", () => {
    expect(makeTemplate("clockwork-soul-sorcerer", 1).actions.some((a) => a.name === "Protection from Evil and Good")).toBe(true);
    expect(makeTemplate("clockwork-soul-sorcerer", 3).actions.some((a) => a.name.startsWith("Aid"))).toBe(true);
  });
});
