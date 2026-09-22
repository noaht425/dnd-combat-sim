// The wizard and its arcane traditions, checked against the printed text (dnd5e.wikidot.com/wizard and each tradition's page). Numbers asserted
// here are the ones on those pages; the mechanics run through the real engine with rigged dice (every d20 lands on `faces`, every damage die
// rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { fireEncounterStartTraits, runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollAttack, rollSave } from "../lib/sim/engine/resolve";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { applyRest } from "../lib/sim/engine/day";
import { mayCounterspell } from "../lib/sim/engine/reactions";
import { beginTurn, effectiveAc, initCombatant, syncExhaustion, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import { cantripsKnown, preparedCount } from "../lib/sim/spells/prepare";
import { slotRow } from "../lib/sim/spells/slots";
import { SPELLS_BY_ID } from "../lib/sim/spells/catalog";
import type { Action, AutomationNode, Combatant } from "../lib/sim/schema";

const WIZARD_IDS = [
  "abjuration-wizard", "conjuration-wizard", "divination-wizard", "enchantment-wizard", "blaster-wizard", "illusion-wizard", "necromancy-wizard",
  "transmutation-wizard", "war-magic-wizard", "bladesinging-wizard", "scribes-wizard", "chronurgy-wizard", "graviturgy-wizard",
];

function state(faces: number | number[], modes: string[] = []): CombatState {
  const rng = makeRng(1);
  let i = 0;
  const next = () => (Array.isArray(faces) ? faces[Math.min(i++, faces.length - 1)] : faces);
  rng.d20 = () => next();
  rng.d20mode = (m) => { modes.push(m); const f = next(); return { used: f, nat: f }; };
  rng.dice = (n, sides) => n * sides;
  return { round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [], maxRounds: 10, ended: false, verbose: false, summonCounter: 0 };
}
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));
const wiz = (id: string, level: number, suffix = "-w") => initCombatant(makeTemplate(id, level), "party", suffix);
const fighter = (level = 6, suffix = "-a") => initCombatant(makeTemplate("gwm-fighter", level), "party", suffix);
/** a big, low-AC dummy foe: everything hits it, nothing kills it, and it fails saves unless given a high modifier */
function foe(id = "f", over: Partial<Record<keyof Combatant["abilities"], number>> = {}, ac = 8): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4) };
  for (const [k, v] of Object.entries(over)) abilities[k as keyof typeof abilities] = score(v as number);
  const u = initCombatant({ ...base, ac, abilities, proficientSaves: [], specialRules: [] }, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const action = (u: CombatantState, id: string): Action => {
  const a = u.ref.actions.find((x) => x.id === id);
  if (!a) throw new Error(`no action ${id}; has ${u.ref.actions.map((x) => x.id).join(", ")}`);
  return a;
};
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, action(u, id));
const cast = (s: CombatState, u: CombatantState, id: string) => { spend(u, action(u, id)); act(s, u, id); };
const startTurn = (s: CombatState, u: CombatantState) => { beginTurn(s, u); u.actionUsedThisTurn = u.bonusUsedThisTurn = false; u.reactionUsed = false; u.leveledSpellThisTurn = false; };
const lost = (u: CombatantState) => u.maxHp - u.hp;
const res = (u: CombatantState, name: string) => u.resources.get(name) ?? 0;
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
const hit = (s: CombatState, attacker: CombatantState, target: CombatantState, bonus = 99, dmg = "5") =>
  runAutomation([{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: "bludgeoning" }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });
const reactionOf = (c: Combatant, id: string) => c.reactions.find((r) => r.id === id);
const slots = (u: CombatantState) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => res(u, `slot${l}`));

describe("wizard — validity and parsing", () => {
  it("every wizard template builds a schema-valid PC at every level", () => {
    for (const id of WIZARD_IDS) {
      for (let lvl = 1; lvl <= 20; lvl++) {
        const r = validateCombatant(makeTemplate(id, lvl));
        if (!r.ok) console.error(`${id} L${lvl}:`, r.errors);
        expect(r.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });

  it("free text resolves each tradition to its own template; bare 'wizard' is still the Evocation wizard", () => {
    for (const [text, id] of [
      ["wizard", "blaster-wizard"], ["evocation wizard", "blaster-wizard"], ["abjuration wizard", "abjuration-wizard"], ["conjurer", "conjuration-wizard"],
      ["divination wizard", "divination-wizard"], ["enchanter", "enchantment-wizard"], ["illusionist", "illusion-wizard"], ["necromancer", "necromancy-wizard"],
      ["transmutation wizard", "transmutation-wizard"], ["war magic wizard", "war-magic-wizard"], ["bladesinger wizard", "bladesinging-wizard"],
      ["order of scribes wizard", "scribes-wizard"], ["chronurgy wizard", "chronurgy-wizard"], ["graviturgy wizard", "graviturgy-wizard"],
    ]) expect(findClassTemplate(text).match?.templateId, text).toBe(id);
  });
});

describe("the Wizard table", () => {
  it("proficient in Intelligence and Wisdom saves only — Transmutation's stone later adds Constitution", () => {
    expect(makeTemplate("abjuration-wizard", 5).proficientSaves).toEqual(["int", "wis"]);
    expect(makeTemplate("transmutation-wizard", 5).proficientSaves).toEqual(["int", "wis"]);
    expect(makeTemplate("transmutation-wizard", 6).proficientSaves).toEqual(["int", "wis", "con"]);
  });

  it("a d6 hit die: 8 hit points at 1st level, 6 more each level (4 + Con 2)", () => {
    expect(makeTemplate("blaster-wizard", 1).maxHp).toBe(8);
    expect(makeTemplate("blaster-wizard", 5).maxHp).toBe(8 + 4 * 6);
    expect(makeTemplate("blaster-wizard", 20).maxHp).toBe(8 + 19 * 6);
  });

  it("spell slots, cantrips and spells prepared follow the table", () => {
    expect(slotRow("full", 5)).toEqual([4, 3, 2]);
    expect([1, 4, 10].map((l) => cantripsKnown("wizard", l))).toEqual([3, 4, 5]);
    expect(preparedCount("wizard", "full", 9, 4)).toBe(13); // Int modifier + wizard level
    const cantrips = (level: number) => makeTemplate("blaster-wizard", level).actions.filter((a) => a.isSpell && a.spellLevel === 0).length;
    expect(cantrips(9)).toBeLessThanOrEqual(4);
  });

  it("Mage Armor is up: AC 13 + Dex", () => {
    expect(makeTemplate("abjuration-wizard", 5).ac).toBe(15);
    expect(makeTemplate("bladesinging-wizard", 5).ac).toBe(16); // Dexterity 16
  });

  it("every spell action carries its school and the slot level it is cast at", () => {
    const c = makeTemplate("blaster-wizard", 9);
    const fb = c.actions.filter((a) => a.isSpell && /^cast-fireball-/.test(a.id));
    expect(fb.map((a) => a.spellLevel)).toEqual([3, 4, 5]);
    expect(new Set(fb.map((a) => a.school))).toEqual(new Set(["evocation"]));
    expect(c.actions.find((a) => a.id === "cast-fire-bolt")?.spellLevel).toBe(0);
  });

  it("Arcane Recovery: once a day, on a short rest, slots totalling up to half the wizard level (rounded up), none above 5th", () => {
    const w = wiz("abjuration-wizard", 10);
    for (let l = 1; l <= 9; l++) w.resources.set(`slot${l}`, 0);
    applyRest([w], "short", new Map([[w.id, 10]]), 10);
    const got = slots(w);
    expect(got.reduce((n, c, i) => n + c * (i + 1), 0)).toBeLessThanOrEqual(5);
    expect(got.reduce((n, c, i) => n + c * (i + 1), 0)).toBe(5); // a 5th-level slot: the most that fits
    expect(got[4]).toBe(1);
    const before = slots(w);
    for (let l = 1; l <= 9; l++) w.resources.set(`slot${l}`, 0);
    applyRest([w], "short", new Map([[w.id, 10]]), 10); // the second short rest: nothing
    expect(slots(w)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(before.some((c) => c > 0)).toBe(true);
    applyRest([w], "long", new Map([[w.id, 10]]), 10);
    expect(w.arcaneRecoveryUsed).toBe(false);
    expect(slots(w)).toEqual([4, 3, 3, 3, 2, 0, 0, 0, 0]);
  });

  it("Arcane Recovery never recovers a slot above 5th, and takes what fits", () => {
    const w = wiz("abjuration-wizard", 20);
    for (let l = 1; l <= 9; l++) w.resources.set(`slot${l}`, 0);
    applyRest([w], "short", new Map([[w.id, 20]]), 20); // budget 10: 5 + 5
    expect(slots(w).slice(5)).toEqual([0, 0, 0, 0]);
    expect(slots(w)[4]).toBe(2);
  });

  it("Spell Mastery (18th): Shield and Scorching Ray cost no slot", () => {
    const c = makeTemplate("blaster-wizard", 18);
    expect(reactionOf(c, "shield")?.limitedUse).toBeUndefined();
    const ray = c.actions.find((a) => a.id === "cast-scorching-ray-mastery")!;
    expect(ray.limitedUse).toBeUndefined();
    expect(makeTemplate("blaster-wizard", 17).actions.some((a) => a.id === "cast-scorching-ray-mastery")).toBe(false);
    expect(reactionOf(makeTemplate("blaster-wizard", 17), "shield")?.limitedUse).toBeDefined();
  });

  it("Signature Spells (20th): Fireball and Hypnotic Pattern once each per rest, free, at 3rd level", () => {
    const c = makeTemplate("blaster-wizard", 20);
    for (const id of ["fireball", "hypnotic-pattern"]) {
      const a = c.actions.find((x) => x.id === `cast-${id}-signature`)!;
      expect(a.limitedUse).toEqual({ resource: `signature_${id}`, amount: 1 });
      expect(a.spellLevel).toBe(3);
      expect(c.resources[`signature_${id}`]).toEqual({ max: 1, recharge: "shortRest" });
    }
    expect(makeTemplate("blaster-wizard", 19).actions.some((a) => a.id === "cast-fireball-signature")).toBe(false);
  });
});

describe("School of Abjuration", () => {
  it("Arcane Ward (2nd): the day starts with a ward of twice the wizard level + Int hit points (Mage Armor), and it takes damage first", () => {
    const w = wiz("abjuration-wizard", 6);
    const { s } = arena(15, w);
    fireEncounterStartTraits(s);
    expect(w.arcaneWard).toEqual({ hp: 2 * 6 + 4, maxHp: 16 });
    const before = w.hp;
    applyDamage(s, w, 10, "force", {});
    expect(w.hp).toBe(before);
    expect(w.arcaneWard!.hp).toBe(6);
    applyDamage(s, w, 10, "force", {}); // the ward holds 6; 4 lands
    expect(w.arcaneWard!.hp).toBe(0);
    expect(before - w.hp).toBe(4);
  });

  it("the ward is not raised before the 2nd level", () => {
    const w = wiz("abjuration-wizard", 1);
    const { s } = arena(15, w);
    fireEncounterStartTraits(s);
    expect(w.arcaneWard).toBeUndefined();
  });

  it("casting an abjuration spell of 1st level or higher restores twice its level to the ward — and a broken ward isn't raised again before a long rest", () => {
    const w = wiz("abjuration-wizard", 6);
    const { s } = arena(15, w);
    fireEncounterStartTraits(s);
    w.arcaneWard!.hp = 0;
    const shield = reactionOf(w.ref, "shield")!;
    runAction(s, w, shield, { asReaction: true });
    expect(w.arcaneWard!.hp).toBe(2); // Shield is 1st level
    expect(res(w, "arcane_ward")).toBe(0); // it was raised once already
    w.resources.set("slot1", 4);
  });

  it("the ward is capped at its maximum", () => {
    const w = wiz("abjuration-wizard", 6);
    const { s } = arena(15, w);
    fireEncounterStartTraits(s);
    runAction(s, w, reactionOf(w.ref, "shield")!, { asReaction: true });
    expect(w.arcaneWard!.hp).toBe(16);
  });

  it("Counterspell (an abjuration spell) feeds the ward too", () => {
    const w = wiz("abjuration-wizard", 6);
    const caster = foe("mage");
    const { s } = arena(15, w, caster);
    fireEncounterStartTraits(s);
    w.arcaneWard!.hp = 3;
    caster.side = "monster";
    const spell: Action = { id: "x", name: "Hold Person", cost: { action: 1 }, recharge: "none", isSpell: true, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "applyCondition", condition: "paralyzed", durationRounds: 2 }] }] };
    expect(mayCounterspell(s, caster, spell)).toBe(true);
    expect(w.arcaneWard!.hp).toBe(3 + 6); // a 3rd-level spell: twice 3
  });

  it("Projected Ward (6th): an ally within 30 ft has damage absorbed by the ward, using the reaction", () => {
    const w = wiz("abjuration-wizard", 6);
    const ally = fighter();
    const { s } = arena(15, w);
    put(s, ally);
    fireEncounterStartTraits(s);
    const before = ally.hp;
    applyDamage(s, ally, 12, "force", {});
    expect(ally.hp).toBe(before);
    expect(w.arcaneWard!.hp).toBe(16 - 12);
    expect(w.reactionUsed).toBe(true);
    applyDamage(s, ally, 12, "force", {}); // reaction spent
    expect(before - ally.hp).toBe(12);
    expect(makeTemplate("abjuration-wizard", 5).reactions.some((r) => r.id === "projected-ward")).toBe(false);
  });

  it("Spell Resistance (14th): resistance to spell damage and advantage on saves against spells", () => {
    const w = wiz("abjuration-wizard", 14);
    const modes: string[] = [];
    const { s } = arena(15, w);
    s.rng.d20mode = (m) => { modes.push(m); return { used: 15, nat: 15 }; };
    w.arcaneWard = undefined;
    const hp = w.hp;
    applyDamage(s, w, 20, "force", { viaSpell: true });
    expect(hp - w.hp).toBe(10);
    applyDamage(s, w, 20, "force", { viaAttack: true }); // a weapon isn't a spell
    expect(hp - w.hp).toBe(30);
    rollSave(s, w, "dex", 15, { magical: true });
    expect(modes.at(-1)).toBe("adv");
    rollSave(s, w, "dex", 15, { magical: false });
    expect(modes.at(-1)).toBe("flat");
  });
});

describe("Dispel Magic", () => {
  it("clears the target's standing magical effects, but leaves its conditions and exhaustion penalty alone", () => {
    // the engine has no record of which (if any) spell caused a given condition — poisoned could be a
    // monster's bite, grappled is never magical — so a wildcard clear only touches `effects`; exhaustion
    // is excluded even there because it mirrors `target.exhaustion` and nothing re-derives it mid-fight
    const w = wiz("abjuration-wizard", 5);
    const { s, target } = arena(15, w);
    target.effects.push({ name: "mage-armor", mods: { acBonus: 3 }, expiresRound: Infinity, sourceId: target.id });
    target.exhaustion = 3;
    syncExhaustion(target);
    target.conditions.set("poisoned", { expiresRound: Infinity, sourceId: target.id });
    target.conditions.set("grappled", { expiresRound: Infinity, sourceId: target.id });
    expect(target.effects.some((e) => e.name === "exhaustion")).toBe(true); // sanity: syncExhaustion worked

    const dispelMagic: Action = {
      id: "x", name: "Dispel Magic", cost: { action: 1 }, recharge: "none", isSpell: true, school: "abjuration", spellLevel: 3,
      automation: SPELLS_BY_ID["dispel-magic"].build!({ slotLevel: 3, casterLevel: 5, spellMod: 4, dc: 15, toHit: 7, pb: 3 }),
    };
    runAction(s, w, dispelMagic);

    expect(target.effects.some((e) => e.name === "mage-armor")).toBe(false);
    expect(target.effects.some((e) => e.name === "exhaustion")).toBe(true);
    expect(target.conditions.has("poisoned")).toBe(true);
    expect(target.conditions.has("grappled")).toBe(true);
  });
});

describe("School of Conjuration", () => {
  it("Focused Conjuration (10th): damage can't break concentration on a conjuration spell, but does on others", () => {
    const w = wiz("conjuration-wizard", 10);
    const { s } = arena(1, w); // every save rolls a 1
    w.concentratingOn = "cast-web-2";
    w.concentrationEffects = ["web"];
    applyDamage(s, w, 30, "fire", {});
    expect(w.concentratingOn).toBe("cast-web-2");
    const d = wiz("divination-wizard", 10, "-d");
    const a = arena(1, d);
    d.concentratingOn = "cast-mind-spike-2";
    applyDamage(a.s, d, 30, "fire", {});
    expect(d.concentratingOn).toBeUndefined();
  });

  it("no such protection below the 10th level", () => {
    const w = wiz("conjuration-wizard", 9);
    const { s } = arena(1, w);
    w.concentratingOn = "cast-web-2";
    applyDamage(s, w, 30, "fire", {});
    expect(w.concentratingOn).toBeUndefined();
  });

  it("Durable Summons (14th): creatures raised by a conjuration spell have 30 temporary hit points", () => {
    const summons = (level: number) => {
      const a = makeTemplate("conjuration-wizard", level).actions.find((x) => /^cast-conjure-(minor-)?elementals?-/.test(x.id) && x.automation.length)!;
      return JSON.stringify(a.automation);
    };
    expect(summons(14)).toContain('"tempHp":"30"');
    expect(summons(13)).not.toContain('"tempHp":"30"');
  });
});

describe("School of Divination", () => {
  it("Portent (2nd): two foretelling d20s at the start of the day, three at 14th (Greater Portent)", () => {
    const w = wiz("divination-wizard", 6);
    const { s } = arena([7, 19, 3], w);
    fireEncounterStartTraits(s);
    expect(w.portentDice).toEqual([7, 19]);
    const g = wiz("divination-wizard", 14, "-g");
    const a = arena([7, 19, 3], g);
    fireEncounterStartTraits(a.s);
    expect(g.portentDice).toEqual([7, 19, 3]);
    const early = wiz("divination-wizard", 1, "-e");
    fireEncounterStartTraits(arena([7, 19], early).s);
    expect(early.portentDice).toBeUndefined();
  });

  it("the dice are rolled once a day: another fight doesn't roll them again, a long rest does", () => {
    const w = wiz("divination-wizard", 6);
    const { s } = arena([7, 19, 3, 3], w);
    fireEncounterStartTraits(s);
    w.portentDice = [7];
    fireEncounterStartTraits(s);
    expect(w.portentDice).toEqual([7]);
    applyRest([w], "long", new Map([[w.id, 6]]), 6);
    expect(w.portentDice).toBeUndefined();
  });

  it("a low foretelling die turns a foe's attack on a hurt ally into a miss, once a turn", () => {
    const w = wiz("divination-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre");
    ally.hp = Math.floor(ally.maxHp * 0.4);
    const s = state(15);
    put(s, w, ally, monster);
    w.portentDice = [4, 18];
    const r = rollAttack(s, monster, ally, 5, "flat", 20, 0);
    expect(r.hit).toBe(false);
    expect(w.portentDice).toEqual([18]);
    const r2 = rollAttack(s, monster, ally, 5, "flat", 20, 0); // the same turn: no second die
    expect(w.portentDice).toEqual([18]);
    expect(r2.nat).toBe(15);
  });

  it("no die is spent on a healthy ally, or on an attack it couldn't stop", () => {
    const w = wiz("divination-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre");
    const s = state(15);
    put(s, w, ally, monster);
    w.portentDice = [4, 18];
    rollAttack(s, monster, ally, 5, "flat", 20, 0);
    expect(w.portentDice).toEqual([4, 18]);
    ally.hp = 1;
    w.portentDice = [19];
    rollAttack(s, monster, ally, 5, "flat", 20, 0); // a 19 hits
    expect(w.portentDice).toEqual([19]);
  });

  it("a low die makes a foe fail a save against a control effect; a high die saves an ally against one", () => {
    const w = wiz("divination-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre", { wis: 3 });
    const s = state([18, 5]);
    put(s, w, ally, monster);
    w.portentDice = [2, 20];
    const foeSave = rollSave(s, monster, "wis", 15, { magical: true, stakes: "control", sourceId: w.id });
    expect(foeSave.passed).toBe(false); // an 18 would have passed; the foretold 2 fails
    expect(w.portentDice).toEqual([20]);
    startTurn(s, w);
    s.activeIdx = 1; // another turn
    const allySave = rollSave(s, ally, "wis", 19, { magical: true, stakes: "lock", sourceId: monster.id });
    expect(allySave.passed).toBe(true); // a natural 18 would not have got there for the ally... the foretold 20 does
    expect(allySave.usedLegendaryResistance).toBe(false);
    expect(w.portentDice).toEqual([]);
  });

  it("no die goes on a save that only means damage", () => {
    const w = wiz("divination-wizard", 6);
    const monster = foe("ogre", { dex: 3 });
    const s = state(18);
    put(s, w, monster);
    w.portentDice = [2];
    rollSave(s, monster, "dex", 15, { magical: true, stakes: "damage", sourceId: w.id });
    expect(w.portentDice).toEqual([2]);
  });

  it("Expert Divination (6th): a divination spell of 2nd level or higher cast with a slot regains a slot of a lower level", () => {
    const w = wiz("divination-wizard", 6);
    const monster = foe();
    const { s } = arena(15, w, monster);
    const a = action(w, "cast-mind-spike-2");
    expect(JSON.stringify(a.automation)).toContain("regainSlot");
    w.resources.set("slot1", 1);
    cast(s, w, "cast-mind-spike-2");
    expect(res(w, "slot1")).toBe(2);
    expect(res(w, "slot2")).toBe(2);
    const early = makeTemplate("divination-wizard", 5).actions.find((x) => x.id === "cast-mind-spike-2");
    expect(JSON.stringify(early?.automation)).not.toContain("regainSlot");
  });
});

/** everything in melee at once, with a wizard and a foe, the Monte-Carlo engine's way */
function arena(faces: number | number[], attacker: CombatantState, target: CombatantState = foe()) {
  const s = state(faces);
  put(s, attacker, target);
  attacker.zone = target.zone = "melee";
  return { s, target };
}

describe("School of Enchantment", () => {
  it("Instinctive Charm (6th): an attacker that fails the Wisdom save must attack another creature instead", () => {
    const w = wiz("enchantment-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre"); // fails Wis saves
    const other = foe("brute");
    other.zone = "melee";
    const s = state(15);
    put(s, w, ally, monster, other);
    w.zone = ally.zone = monster.zone = "melee";
    // the swing was aimed at the wizard; the save fails, so it lands on someone else in the attacker's zone
    hit(s, monster, w);
    expect(w.hp).toBe(w.maxHp);
    expect(lost(ally) + lost(other)).toBe(5);
    expect(w.reactionUsed).toBe(true);
    expect(monster.effects.some((e) => e.name === "charm-diverted")).toBe(true);
  });

  it("a creature that makes the save attacks the wizard as it meant to; and each attacker can be diverted only once until a long rest", () => {
    const w = wiz("enchantment-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre", { wis: 8 }); // passes
    const s = state(15);
    put(s, w, ally, monster);
    w.zone = ally.zone = monster.zone = "melee";
    hit(s, monster, w);
    expect(w.hp).toBeLessThan(w.maxHp);
    expect(monster.effects.some((e) => e.name === "charm-diverted")).toBe(true);
    startTurn(s, w);
    const failing = foe("g2");
    put(s, failing);
    failing.zone = "melee";
    failing.effects.push({ name: "charm-diverted", expiresRound: Infinity, sourceId: w.id });
    const before = w.hp;
    hit(s, failing, w);
    expect(before - w.hp).toBe(5); // already diverted once: no second try
  });

  it("no diversion below the 6th level, or from a creature that can't be charmed", () => {
    const w = wiz("enchantment-wizard", 5);
    const monster = foe("ogre");
    const s = state(15);
    put(s, w, monster);
    hit(s, monster, w);
    expect(lost(w)).toBe(5);
    const w6 = wiz("enchantment-wizard", 6, "-6");
    const immune = foe("golem");
    immune.ref = { ...immune.ref, conditionImmunities: ["charmed"] };
    const other = fighter(6, "-o");
    const a = state(15);
    put(a, w6, immune, other);
    hit(a, immune, w6);
    expect(lost(w6)).toBe(5);
  });

  it("Split Enchantment (10th): an enchantment spell that targets one creature can target a second, at no extra cost", () => {
    const c = makeTemplate("enchantment-wizard", 10);
    const split = c.actions.find((a) => /-split$/.test(a.id))!;
    expect(split).toBeDefined();
    const base = c.actions.find((a) => a.id === split.id.replace(/-split$/, ""))!;
    expect(split.limitedUse).toEqual(base.limitedUse);
    expect(JSON.stringify(split.automation)).toContain('"upTo":2');
    expect(makeTemplate("enchantment-wizard", 9).actions.some((a) => /-split$/.test(a.id))).toBe(false);
  });

  it("the split cast reaches both creatures", () => {
    const w = wiz("enchantment-wizard", 10);
    const a = foe("a");
    const b = foe("b");
    const s = state(2);
    put(s, w, a, b);
    const hold = w.ref.actions.find((x) => x.id === "cast-hold-person-2-split")!;
    runAction(s, w, hold);
    expect([a, b].filter((u) => u.conditions.has("paralyzed")).length).toBe(2);
  });
});

describe("School of Evocation", () => {
  it("Potent Cantrip (6th): a creature that saves against a cantrip still takes half its damage", () => {
    const w = wiz("blaster-wizard", 6);
    const monster = foe("ogre", { dex: 10, con: 10 }); // passes
    const { s } = arena(15, w, monster);
    const cantrip = w.ref.actions.find((a) => a.isSpell && a.spellLevel === 0 && a.automation.some((n) => JSON.stringify(n).includes('"save"')))!;
    act(s, w, cantrip.id);
    expect(lost(monster)).toBeGreaterThan(0);
    const early = makeTemplate("blaster-wizard", 5).actions.find((a) => a.id === cantrip.id)!;
    expect(JSON.stringify(early.automation)).not.toContain('"half":true');
    expect(JSON.stringify(cantrip.automation)).toContain('"half":true');
  });

  it("Empowered Evocation (10th): + Int to one damage roll of an evocation spell (not before 10th, not for another school)", () => {
    const dmg = (level: number, id: string) => JSON.stringify(makeTemplate("blaster-wizard", level).actions.find((a) => a.id === id)!.automation);
    expect(dmg(10, "cast-fireball-3")).toContain("8d6+4");
    expect(dmg(9, "cast-fireball-3")).not.toContain("8d6+4");
    expect(dmg(17, "cast-fireball-3")).toContain("8d6+5");
  });

  it("Overchannel (14th): a 1st-5th level damage spell deals maximum damage, once until a long rest", () => {
    const w = wiz("blaster-wizard", 14);
    const monster = foe();
    const { s } = arena(15, w, monster);
    const oc = w.ref.actions.find((a) => a.id === "cast-fireball-3-overchannel")!;
    expect(oc).toBeDefined();
    expect(actionAvailable(s, w, oc)).toBe(true);
    const slot3 = res(w, "slot3");
    cast(s, w, oc.id);
    expect(lost(monster)).toBe(8 * 6 + 4); // 8d6 at its maximum, + Int (Empowered Evocation)
    expect(res(w, "overchannel")).toBe(0);
    expect(actionAvailable(s, w, oc)).toBe(false);
    expect(res(w, "slot3")).toBe(slot3 - 1); // one slot spent
  });

  it("Overchannel is only for spells of 1st to 5th level that deal damage, and not before 14th", () => {
    const c = makeTemplate("blaster-wizard", 14);
    const oc = c.actions.filter((a) => /-overchannel$/.test(a.id));
    expect(oc.length).toBeGreaterThan(0);
    expect(oc.every((a) => (a.spellLevel ?? 0) >= 1 && (a.spellLevel ?? 0) <= 5)).toBe(true);
    expect(makeTemplate("blaster-wizard", 13).actions.some((a) => /-overchannel$/.test(a.id))).toBe(false);
  });
});

describe("School of Illusion", () => {
  it("Illusory Self (10th): a reaction — an attack against you automatically misses; once per short or long rest", () => {
    const w = wiz("illusion-wizard", 10);
    const monster = foe("ogre");
    const s = state(15);
    put(s, w, monster);
    w.hp = Math.floor(w.maxHp * 0.6);
    const before = w.hp;
    hit(s, monster, w);
    expect(w.hp).toBe(before);
    expect(w.reactionUsed).toBe(true);
    expect(res(w, "illusory_self")).toBe(0);
    expect(w.ref.resources.illusory_self).toEqual({ max: 1, recharge: "shortRest" });
    startTurn(s, w);
    hit(s, monster, w); // spent until a rest
    expect(before - w.hp).toBe(5);
    applyRest([w], "short", new Map([[w.id, 10]]), 10);
    expect(res(w, "illusory_self")).toBe(1);
  });

  it("is kept for when it matters: a healthy wizard takes an ordinary hit; a critical hit is always turned aside", () => {
    const w = wiz("illusion-wizard", 10);
    const monster = foe("ogre");
    const s = state(15);
    put(s, w, monster);
    hit(s, monster, w);
    expect(lost(w)).toBe(5);
    expect(w.reactionUsed).toBeFalsy();
    const w2 = wiz("illusion-wizard", 10, "-2");
    const s2 = state(20);
    put(s2, w2, monster);
    hit(s2, monster, w2);
    expect(lost(w2)).toBe(0);
  });

  it("no such reaction below the 10th level", () => {
    expect(reactionOf(makeTemplate("illusion-wizard", 9), "illusory-self")).toBeUndefined();
  });
});

describe("School of Necromancy", () => {
  it("Grim Harvest (2nd): a spell that kills heals twice its level (three times for a necromancy spell), and nothing for a cantrip", () => {
    const w = wiz("necromancy-wizard", 6);
    const victim = foe("orc");
    const { s } = arena(15, w, victim);
    w.hp = 1;
    victim.hp = 1;
    const dmgSpell: Action = { id: "cast-magic-missile-1", name: "Magic Missile", cost: { action: 1 }, recharge: "none", isSpell: true, school: "evocation", spellLevel: 3, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: "5", damageType: "force" }] }] };
    runAction(s, w, dmgSpell);
    expect(victim.hp).toBeLessThanOrEqual(0);
    expect(w.hp).toBe(1 + 6); // an evocation spell cast at 3rd level: twice 3
    const v2 = foe("orc2");
    v2.hp = 1;
    put(s, v2);
    w.hp = 1;
    runAction(s, w, { ...dmgSpell, id: "cast-ray-of-sickness-3", school: "necromancy" });
    expect(w.hp).toBe(1 + 9); // three times 3
    const v3 = foe("orc3");
    v3.hp = 1;
    put(s, v3);
    w.hp = 1;
    runAction(s, w, { ...dmgSpell, spellLevel: 0 });
    expect(w.hp).toBe(1); // a cantrip
  });

  it("Grim Harvest gives nothing for constructs or undead", () => {
    const w = wiz("necromancy-wizard", 6);
    const zombie = foe("zombie");
    zombie.ref = { ...zombie.ref, creatureType: "undead" };
    zombie.hp = 1;
    const { s } = arena(15, w, zombie);
    w.hp = 1;
    runAction(s, w, { id: "x", name: "Bolt", cost: { action: 1 }, recharge: "none", isSpell: true, school: "evocation", spellLevel: 2, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: "5", damageType: "force" }] }] });
    expect(w.hp).toBe(1);
  });

  it("Grim Harvest is not a class feature of the other schools", () => {
    expect(makeTemplate("blaster-wizard", 6).specialRules.some((r) => r.rule === "grimHarvest")).toBe(false);
    expect(makeTemplate("necromancy-wizard", 2).specialRules.some((r) => r.rule === "grimHarvest")).toBe(true);
  });

  it("Undead Thralls (6th): Animate Dead raises one more corpse, and what a necromancy spell raises has the wizard's level in extra hit points and the proficiency bonus on weapon damage", () => {
    const w = wiz("necromancy-wizard", 6);
    const { s } = arena(15, w);
    const ad = w.ref.actions.find((a) => /^cast-animate-dead-/.test(a.id))!;
    const summon = JSON.stringify(ad.automation);
    expect(summon).toContain('"count":"3"');
    expect(summon).toContain('"hpBonus":6');
    expect(summon).toContain('"damageBonus":3');
    const base = JSON.stringify(SPELLS_BY_ID["animate-dead"].build!({ slotLevel: 3, casterLevel: 6, spellMod: 4, dc: 15, toHit: 7, pb: 3 }));
    expect(base).toContain('"count":"2"'); // the spell itself raises two
    expect(base).not.toContain("hpBonus");
    cast(s, w, ad.id);
    const thralls = [...s.units.values()].filter((u) => u.summonerId === w.id);
    expect(thralls.length).toBe(3);
    const plainThrall = initCombatant(thralls[0].ref, "party", "-b");
    expect(thralls[0].maxHp).toBe(plainThrall.maxHp + 6);
    const dmgOf = (u: CombatantState) => JSON.stringify(u.ref.actions.map((a) => a.automation));
    const plainZombie = initCombatant(makeTemplate("gwm-fighter", 1), "party", "-z");
    expect(dmgOf(thralls[0])).not.toBe(dmgOf(plainZombie));
  });

  it("Inured to Undeath (10th): resistance to necrotic damage", () => {
    expect(makeTemplate("necromancy-wizard", 10).resistances).toContain("necrotic");
    expect(makeTemplate("necromancy-wizard", 9).resistances).not.toContain("necrotic");
  });
});

describe("School of Transmutation", () => {
  it("Transmuter's Stone (6th) is taken as Constitution save proficiency — the saving throw that keeps a concentration spell up", () => {
    const w = wiz("transmutation-wizard", 6);
    const plain = wiz("abjuration-wizard", 6, "-p");
    const { s } = arena(10, w);
    put(s, plain);
    // a 10 on a Constitution save: +2 Con, +3 proficiency for the transmuter
    const t = rollSave(s, w, "con", 15, { magical: false });
    const a = rollSave(s, plain, "con", 15, { magical: false });
    expect(t.passed).toBe(true);
    expect(a.passed).toBe(false);
  });
});

describe("War Magic", () => {
  it("Tactical Wit (2nd): Int is added to initiative", () => {
    expect(makeTemplate("war-magic-wizard", 2).initiativeBonus).toBe(2 + 4);
    expect(makeTemplate("war-magic-wizard", 1).initiativeBonus).toBeUndefined();
    expect(makeTemplate("war-magic-wizard", 17).initiativeBonus).toBe(2 + 5);
  });

  it("Arcane Deflection (2nd): a reaction turns a near-miss on a hurt wizard into a miss (+2 AC) — and it may then cast only cantrips until the end of its next turn", () => {
    const w = wiz("war-magic-wizard", 6);
    const monster = foe("ogre");
    const s = state(15);
    put(s, w, monster);
    w.hp = Math.floor(w.maxHp * 0.5);
    const before = w.hp;
    // toHit chosen so 15 + toHit is exactly the wizard's AC, or one over: a hit by margin < 2
    const r = rollAttack(s, monster, w, w.ac - 15, "flat", 20, 0);
    expect(r.hit).toBe(false);
    expect(w.hp).toBe(before);
    expect(w.reactionUsed).toBe(true);
    expect(hasEffect(w, "deflection-lockout")).toBe(true);
    const fireball = action(w, "cast-fireball-3");
    expect(actionAvailable(s, w, fireball)).toBe(false);
    expect(actionAvailable(s, w, action(w, "cast-fire-bolt"))).toBe(true);
  });

  it("Arcane Deflection saves a control save it just failed (+4), when that is enough", () => {
    const w = wiz("war-magic-wizard", 6);
    const monster = foe("ogre");
    const s = state(10);
    put(s, w, monster);
    // Wisdom: 10 + Wis 1 + prof 3 = 14; DC 17 fails by 3, so +4 is enough
    const r = rollSave(s, w, "wis", 17, { magical: true, stakes: "control", sourceId: monster.id });
    expect(r.passed).toBe(true);
    expect(w.reactionUsed).toBe(true);
    const w2 = wiz("war-magic-wizard", 6, "-2");
    const s2 = state(10);
    put(s2, w2, monster);
    const r2 = rollSave(s2, w2, "wis", 25, { magical: true, stakes: "control", sourceId: monster.id }); // hopeless
    expect(r2.passed).toBe(false);
    expect(w2.reactionUsed).toBeFalsy();
    const w3 = wiz("war-magic-wizard", 6, "-3");
    const s3 = state(10);
    put(s3, w3, monster);
    expect(rollSave(s3, w3, "wis", 17, { magical: true, stakes: "damage", sourceId: monster.id }).passed).toBe(false); // not worth the lockout for damage
  });

  it("Power Surge (6th): starts at one surge, and once a turn a damaging spell adds force damage equal to half the wizard level", () => {
    const w = wiz("war-magic-wizard", 6);
    const monster = foe();
    const { s } = arena(15, w, monster);
    expect(res(w, "power_surge")).toBe(1);
    expect(w.ref.resources.power_surge).toEqual({ max: 4, recharge: "longRest", start: 1 });
    cast(s, w, "cast-fireball-3");
    // 8d6 fire + 3 force
    expect(lost(monster)).toBe(48 + 3);
    expect(res(w, "power_surge")).toBe(0);
    startTurn(s, w);
    const before = lost(monster);
    cast(s, w, "cast-fireball-3");
    expect(lost(monster) - before).toBe(48); // no surges left
  });

  it("a surge is spent once a turn even when the spell hits several creatures", () => {
    const w = wiz("war-magic-wizard", 6);
    const a = foe("a");
    const b = foe("b");
    const c = foe("c");
    const { s } = arena(15, w, a);
    put(s, b, c);
    w.resources.set("power_surge", 3);
    cast(s, w, "cast-fireball-3");
    expect(res(w, "power_surge")).toBe(2);
  });

  it("no surges before the 6th level", () => {
    expect(makeTemplate("war-magic-wizard", 5).resources.power_surge).toBeUndefined();
  });

  it("Power Surge: a Counterspell that succeeds steals a surge (up to the cap), and a short rest with none gives one", () => {
    const w = wiz("war-magic-wizard", 6);
    const caster = foe("mage");
    const { s } = arena(15, w, caster);
    w.resources.set("power_surge", 0);
    const spell: Action = { id: "x", name: "Hold Person", cost: { action: 1 }, recharge: "none", isSpell: true, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "applyCondition", condition: "paralyzed", durationRounds: 2 }] }] };
    expect(mayCounterspell(s, caster, spell)).toBe(true);
    expect(res(w, "power_surge")).toBe(1);
    w.resources.set("power_surge", 0);
    applyRest([w], "short", new Map([[w.id, 6]]), 6);
    expect(res(w, "power_surge")).toBe(1);
    applyRest([w], "long", new Map([[w.id, 6]]), 6);
    expect(res(w, "power_surge")).toBe(1); // a long rest resets to one
  });

  it("Durable Magic (10th): +2 AC and +2 to every saving throw while concentrating on a spell", () => {
    const w = wiz("war-magic-wizard", 10);
    const { s } = arena(10, w);
    const ac = effectiveAc(w);
    // a 10 on a Dexterity save is 12: it clears DC 12 only while the +2 applies
    expect(rollSave(s, w, "dex", 14, { magical: false }).passed).toBe(false);
    w.concentratingOn = "cast-web-2";
    expect(effectiveAc(w)).toBe(ac + 2);
    expect(rollSave(s, w, "dex", 14, { magical: false }).passed).toBe(true);
    const early = wiz("war-magic-wizard", 9, "-e");
    early.concentratingOn = "cast-web-2";
    expect(effectiveAc(early)).toBe(early.ac);
  });
});

describe("Bladesinging", () => {
  it("Bladesong (2nd): a bonus action for a minute — AC + Int, +10 ft speed, + Int to concentration saves — proficiency-bonus times per long rest", () => {
    const w = wiz("bladesinging-wizard", 5);
    const { s } = arena(15, w);
    expect(w.ref.ai.opener).toContain("bladesong");
    expect(w.ref.ai.bonusRoutine).toContain("bladesong");
    expect(w.ref.resources.bladesong).toEqual({ max: 3, recharge: "longRest" });
    const ac = effectiveAc(w);
    cast(s, w, "bladesong");
    const e = w.effects.find((x) => x.name === "bladesong")!;
    expect(e.mods).toEqual({ acBonus: 4, speedBonusFt: 10, concentrationSaveBonus: 4 });
    expect(effectiveAc(w)).toBe(ac + 4);
    expect(res(w, "bladesong")).toBe(2);
    expect(actionAvailable(s, w, action(w, "bladesong"))).toBe(false); // already up
  });

  it("the Bladesong's Intelligence bonus goes on the Constitution save that keeps concentration", () => {
    // a natural 5: +2 Con, +4 Bladesong = 11 — enough for DC 10 (damage 20)
    const w = wiz("bladesinging-wizard", 5);
    const { s } = arena(5, w);
    w.concentratingOn = "cast-web-2";
    w.concentrationEffects = ["web"];
    applyDamage(s, w, 20, "force", {});
    expect(w.concentratingOn).toBeUndefined();
    const b = wiz("bladesinging-wizard", 5, "-b");
    const a = arena(5, b);
    cast(a.s, b, "bladesong");
    b.concentratingOn = "cast-web-2";
    b.concentrationEffects = ["web"];
    applyDamage(a.s, b, 20, "force", {});
    expect(b.concentratingOn).toBe("cast-web-2");
  });

  it("Extra Attack (6th): two attacks, or one attack and a cantrip in place of the other; one attack before that", () => {
    const count = (level: number, id = "attack") => {
      const a = makeTemplate("bladesinging-wizard", level).actions.find((x) => x.id === id)!;
      const t = a.automation[0];
      return t.type === "target" ? t.effects.filter((n) => n.type === "attack").length : -1;
    };
    expect(count(5)).toBe(1);
    expect(count(6)).toBe(2);
    expect(makeTemplate("bladesinging-wizard", 5).actions.some((a) => a.id === "attack-cantrip")).toBe(false);
    expect(count(6, "attack-cantrip")).toBe(2);
  });

  it("the rapier swings at proficiency + Dex and does 1d8 + Dex piercing", () => {
    const w = wiz("bladesinging-wizard", 6);
    const monster = foe();
    const { s } = arena(15, w, monster);
    act(s, w, "attack");
    expect(lost(monster)).toBe(2 * (8 + 3));
  });

  it("Song of Defense (10th): while the Bladesong is up, a reaction and a spell slot cut damage by five times the slot's level", () => {
    const w = wiz("bladesinging-wizard", 10);
    const { s } = arena(15, w);
    applyDamage(s, w, 30, "force", {}); // no Bladesong yet
    expect(lost(w)).toBe(30);
    w.hp = w.maxHp;
    cast(s, w, "bladesong");
    const slot1 = res(w, "slot1");
    const slot3 = res(w, "slot3");
    applyDamage(s, w, 12, "force", {}); // a 3rd-level slot soaks 15, but the smallest that soaks it all is 3rd (1st: 5, 2nd: 10)
    expect(lost(w)).toBe(0);
    expect(res(w, "slot3")).toBe(slot3 - 1);
    expect(res(w, "slot1")).toBe(slot1);
    expect(w.reactionUsed).toBe(true);
    expect(makeTemplate("bladesinging-wizard", 9).reactions.some((r) => r.id === "song-of-defense")).toBe(false);
  });

  it("Song of Victory (14th): + Int to melee weapon damage while the Bladesong is up", () => {
    const w = wiz("bladesinging-wizard", 14);
    const monster = foe();
    const { s } = arena(15, w, monster);
    act(s, w, "attack");
    const plain = lost(monster);
    expect(plain).toBe(2 * (8 + 4));
    cast(s, w, "bladesong");
    const before = lost(monster);
    act(s, w, "attack");
    expect(lost(monster) - before).toBe(2 * (8 + 4 + 4));
  });
});

describe("Order of Scribes", () => {
  it("Awakened Spellbook (2nd): a spell cast with a slot swaps its damage type past a resistance or immunity", () => {
    const w = wiz("scribes-wizard", 6);
    const monster = foe("fiend");
    monster.ref = { ...monster.ref, immunities: ["fire"], resistances: ["cold"] };
    const { s } = arena(15, w, monster);
    const before = monster.hp;
    applyDamage(s, monster, 20, "fire", { viaSpell: true, spellLevel: 3, sourceId: w.id }); // swapped: cold is resisted, so lightning
    expect(before - monster.hp).toBe(20);
    const hp = monster.hp;
    applyDamage(s, monster, 20, "fire", { viaSpell: true, spellLevel: 0, sourceId: w.id }); // a cantrip isn't cast with a slot
    expect(monster.hp).toBe(hp);
    const other = wiz("blaster-wizard", 6, "-o");
    const a = arena(15, other, monster);
    const hp2 = monster.hp;
    applyDamage(a.s, monster, 20, "fire", { viaSpell: true, spellLevel: 3, sourceId: other.id });
    expect(monster.hp).toBe(hp2);
  });

  it("Master Scrivener (10th): a scroll of Scorching Ray at 3rd level, once per long rest", () => {
    const w = wiz("scribes-wizard", 10);
    const monster = foe();
    const { s } = arena(15, w, monster);
    const a = action(w, "cast-scorching-ray-scroll");
    expect(a.limitedUse).toEqual({ resource: "master_scrivener", amount: 1 });
    cast(s, w, a.id);
    expect(lost(monster)).toBe(4 * 2 * 6); // four rays at 3rd level (one more than at 2nd), 2d6 fire each
  });

  it("One with the Word (14th): damage that would drop you to 0 is negated, at the cost of 3d6 levels of spell slots, once a day", () => {
    const w = wiz("scribes-wizard", 14);
    const { s } = arena(15, w);
    w.hp = 5;
    const total = () => slots(w).reduce((n, c, i) => n + c * (i + 1), 0);
    const before = total();
    applyDamage(s, w, 500, "slashing", {});
    expect(w.hp).toBe(5);
    expect(w.alive).toBe(true);
    expect(before - total()).toBeGreaterThanOrEqual(18); // 3d6 rolled at its maximum, taken off the top
    expect(res(w, "one_with_the_word")).toBe(0);
    applyDamage(s, w, 500, "slashing", {});
    expect(w.hp).toBeLessThanOrEqual(0);
  });
});

describe("Chronurgy Magic", () => {
  it("Temporal Awareness (2nd): Int is added to initiative", () => {
    expect(makeTemplate("chronurgy-wizard", 2).initiativeBonus).toBe(6);
    expect(makeTemplate("chronurgy-wizard", 1).initiativeBonus).toBeUndefined();
  });

  it("Chronal Shift (2nd): twice per long rest, a reaction makes an attack that hit an ally be rolled again", () => {
    const w = wiz("chronurgy-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre");
    const s = state([15, 2]); // the attack hits; the reroll is a 2
    put(s, w, ally, monster);
    expect(w.ref.resources.chronal_shift).toEqual({ max: 2, recharge: "longRest" });
    const r = rollAttack(s, monster, ally, ally.ac - 15, "flat", 20, 0); // hits by 0
    expect(r.hit).toBe(false);
    expect(res(w, "chronal_shift")).toBe(1);
    expect(w.reactionUsed).toBe(true);
  });

  it("the reroll stands even if it's worse: a second hit is a hit", () => {
    const w = wiz("chronurgy-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre");
    const s = state([15, 19]);
    put(s, w, ally, monster);
    const r = rollAttack(s, monster, ally, ally.ac - 15, "flat", 20, 0);
    expect(r.hit).toBe(true);
    expect(r.nat).toBe(19);
  });

  it("a hit that isn't close is left alone (the reroll could only be worse)", () => {
    const w = wiz("chronurgy-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre");
    const s = state([15, 2]);
    put(s, w, ally, monster);
    const r = rollAttack(s, monster, ally, 30, "flat", 20, 0); // hits by a mile
    expect(r.hit).toBe(true);
    expect(res(w, "chronal_shift")).toBe(2);
  });

  it("Chronal Shift on an ally's failed control save gives it another roll", () => {
    const w = wiz("chronurgy-wizard", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre");
    const s = state([3, 17]);
    put(s, w, ally, monster);
    const r = rollSave(s, ally, "wis", 15, { magical: true, stakes: "control", sourceId: monster.id });
    expect(r.passed).toBe(true);
    expect(res(w, "chronal_shift")).toBe(1);
  });

  it("Chronal Shift on a foe that shrugged off a control effect makes it roll again", () => {
    const w = wiz("chronurgy-wizard", 6);
    const monster = foe("ogre", { wis: 6 });
    const s = state([18, 2]);
    put(s, w, monster);
    const r = rollSave(s, monster, "wis", 15, { magical: true, stakes: "control", sourceId: w.id });
    expect(r.passed).toBe(false);
    expect(res(w, "chronal_shift")).toBe(1);
  });

  it("no Chronal Shift for a save that only means damage", () => {
    const w = wiz("chronurgy-wizard", 6);
    const monster = foe("ogre", { dex: 6 });
    const s = state([18, 2]);
    put(s, w, monster);
    const r = rollSave(s, monster, "dex", 15, { magical: true, stakes: "damage", sourceId: w.id });
    expect(r.passed).toBe(true);
    expect(res(w, "chronal_shift")).toBe(2);
  });

  it("Momentary Stasis (6th): a Large or smaller creature fails a Constitution save and is incapacitated with 0 speed; Int-modifier uses", () => {
    const w = wiz("chronurgy-wizard", 6);
    const monster = foe("ogre");
    const { s } = arena(10, w, monster);
    expect(w.ref.resources.momentary_stasis).toEqual({ max: 4, recharge: "longRest" });
    cast(s, w, "momentary-stasis");
    expect(monster.conditions.has("incapacitated")).toBe(true);
    expect(hasEffect(monster, "stasis")).toBe(true);
    expect(res(w, "momentary_stasis")).toBe(3);
    const huge = foe("dragon");
    huge.ref = { ...huge.ref, size: "huge" };
    const a = arena(10, wiz("chronurgy-wizard", 6, "-2"), huge);
    act(a.s, [...a.s.units.values()][0], "momentary-stasis");
    expect(huge.conditions.has("incapacitated")).toBe(false);
    expect(makeTemplate("chronurgy-wizard", 5).actions.some((x) => x.id === "momentary-stasis")).toBe(false);
  });

  it("Convergent Future (14th): turns a save that would take an ally out of the fight into a success, for a level of exhaustion, up to two", () => {
    const w = wiz("chronurgy-wizard", 14);
    w.resources.set("chronal_shift", 0);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre");
    const s = state(3);
    put(s, w, ally, monster);
    expect(rollSave(s, ally, "wis", 20, { magical: true, stakes: "lock", sourceId: monster.id }).passed).toBe(true);
    expect(w.exhaustion).toBe(1);
    startTurn(s, w);
    expect(rollSave(s, ally, "wis", 20, { magical: true, stakes: "lock", sourceId: monster.id }).passed).toBe(true);
    expect(w.exhaustion).toBe(2);
    startTurn(s, w);
    expect(rollSave(s, ally, "wis", 20, { magical: true, stakes: "lock", sourceId: monster.id }).passed).toBe(false); // not a third
    expect(w.exhaustion).toBe(2);
    expect(makeTemplate("chronurgy-wizard", 13).reactions.some((r) => r.id === "convergent-future")).toBe(false);
  });

  it("Convergent Future on a foe that shrugged off a lockdown effect makes it fail", () => {
    const w = wiz("chronurgy-wizard", 14);
    w.resources.set("chronal_shift", 0);
    const monster = foe("ogre", { wis: 8 });
    const s = state(18);
    put(s, w, monster);
    const r = rollSave(s, monster, "wis", 15, { magical: true, stakes: "lock", sourceId: w.id });
    expect(r.passed).toBe(false);
    expect(w.exhaustion).toBe(1);
  });

  it("Convergent Future turns a crit that could finish a nearly-dead ally into a miss", () => {
    const w = wiz("chronurgy-wizard", 14);
    w.resources.set("chronal_shift", 0);
    const ally = fighter(6, "-ally");
    ally.hp = 3;
    const monster = foe("ogre");
    const s = state(20);
    put(s, w, ally, monster);
    const r = rollAttack(s, monster, ally, 5, "flat", 20, 0);
    expect(r.hit).toBe(false);
    expect(w.exhaustion).toBe(1);
  });
});

describe("Graviturgy Magic", () => {
  it("Violent Attraction (10th): a reaction adds 1d10 to a weapon hit by a creature within 60 ft; Int-modifier uses per long rest", () => {
    const w = wiz("graviturgy-wizard", 10);
    const ally = fighter(6, "-ally");
    const monster = foe();
    const s = state(15);
    put(s, w, ally, monster);
    w.zone = ally.zone = monster.zone = "melee";
    expect(w.ref.resources.violent_attraction).toEqual({ max: 4, recharge: "longRest" });
    hit(s, ally, monster);
    expect(lost(monster)).toBe(5 + 10);
    expect(res(w, "violent_attraction")).toBe(3);
    expect(w.reactionUsed).toBe(true);
    hit(s, ally, monster); // reaction spent
    expect(lost(monster)).toBe(5 + 10 + 5);
  });

  it("Violent Attraction isn't triggered by a spell", () => {
    const w = wiz("graviturgy-wizard", 10);
    const monster = foe();
    const { s } = arena(15, w, monster);
    const fb: Action = { id: "x", name: "Firebolt", cost: { action: 1 }, recharge: "none", isSpell: true, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "5", damageType: "fire" }] }] }] };
    const ally = fighter(6, "-ally");
    put(s, ally);
    runAction(s, ally, fb);
    expect(lost(monster)).toBe(5);
  });

  it("Event Horizon (14th): a concentration aura — Strength save or 2d10 force and 0 speed; once per long rest, or a 3rd-level slot", () => {
    const w = wiz("graviturgy-wizard", 14);
    const monster = foe("ogre");
    const { s } = arena(10, w, monster);
    expect(w.ref.resources.event_horizon).toEqual({ max: 1, recharge: "longRest" });
    const horizon = action(w, "event-horizon");
    expect(horizon.concentration).toBe(true);
    cast(s, w, "event-horizon");
    expect(lost(monster)).toBe(20);
    expect(hasEffect(monster, "event-horizon-slow")).toBe(true);
    expect(w.concentratingOn).toBe("event-horizon");
    expect(res(w, "event_horizon")).toBe(0);
    expect(actionAvailable(s, w, horizon)).toBe(false);
    const slotVariant = action(w, "event-horizon-slot");
    expect(slotVariant.limitedUse).toEqual({ resource: "slot3", amount: 1 });
    expect(makeTemplate("graviturgy-wizard", 13).actions.some((a) => a.id === "event-horizon")).toBe(false);
  });
});

describe("wizards in battle", () => {
  it("every school fights at levels 2, 6, 10, 14 and 20 without breaking", () => {
    for (const id of WIZARD_IDS) {
      for (const level of [2, 6, 10, 14, 20]) {
        const out = runBattle({ party: [{ template: id, level }, { template: "gwm-fighter", level }], enemies: ["ogre", "ogre"], seed: 5, controlled: [], maxRounds: 6 } as never);
        expect(out.frames.length, `${id} L${level}`).toBeGreaterThan(0);
      }
    }
  });

  it("a Bladesinger starts the fight with its Bladesong and fights in melee", () => {
    const out = runBattle({ party: [{ template: "bladesinging-wizard", level: 6, name: "Song" }, { template: "gwm-fighter", level: 6 }], enemies: ["ogre"], seed: 2, controlled: [], maxRounds: 3 } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/Song uses Bladesong/);
    expect(text).toMatch(/Song uses (Rapier|Shocking Grasp)/);
  });

  it("an Abjurer's ward and a Diviner's portent show up in the play-by-play", () => {
    const ward = runBattle({ party: [{ template: "abjuration-wizard", level: 6, name: "Ab" }, { template: "gwm-fighter", level: 6 }], enemies: ["ogre", "ogre"], seed: 4, controlled: [], maxRounds: 4 } as never);
    expect(ward.frames.map((f) => f.text ?? "").join("\n")).toMatch(/Arcane Ward/);
    const port = runBattle({ party: [{ template: "divination-wizard", level: 6, name: "Di" }, { template: "gwm-fighter", level: 6 }], enemies: ["ogre"], seed: 4, controlled: [], maxRounds: 3 } as never);
    expect(port.frames.map((f) => f.text ?? "").join("\n")).toMatch(/foretells/);
  });
});

describe("casters don't recast control on a target that already has the condition", () => {
  it("Hold Person is worth nothing more against a creature that is already paralyzed", async () => {
    const { scoreAction } = await import("../lib/sim/engine/score");
    const w = wiz("enchantment-wizard", 5);
    const monster = foe("troll");
    const { s } = arena(15, w, monster);
    const hold = action(w, "cast-hold-person-2");
    const fresh = scoreAction(s, w, hold).control;
    expect(fresh).toBeGreaterThan(0);
    monster.conditions.set("paralyzed", { expiresRound: 99, sourceId: w.id });
    expect(scoreAction(s, w, hold).control).toBe(0);
  });
});

describe("a caster doesn't throw away a concentration spell that is still working", () => {
  it("starting a new concentration spell costs the value of what the old one is still doing", async () => {
    const { scoreAction } = await import("../lib/sim/engine/score");
    const w = wiz("enchantment-wizard", 5);
    const held = foe("troll");
    const fresh = foe("ogre");
    const { s } = arena(15, w, held);
    put(s, fresh);
    const hold = action(w, "cast-hold-person-2");
    const alone = scoreAction(s, w, hold).score;
    // concentrating on Web, with the troll still restrained by it
    w.concentratingOn = "cast-web-2";
    w.concentrationEffects = ["restrained"];
    held.conditions.set("restrained", { expiresRound: 99, sourceId: w.id });
    const dropping = scoreAction(s, w, hold).score;
    expect(dropping).toBeLessThan(alone);
    // once nothing is left of the old spell, there is nothing to lose
    held.conditions.delete("restrained");
    expect(scoreAction(s, w, hold).score).toBe(alone);
  });
});
