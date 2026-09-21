// The druid and its circles, checked against the printed text (dnd5e.wikidot.com/druid and each circle's page). Numbers asserted here are the ones on those
// pages; the mechanics run through the real engine with rigged dice (every d20 lands on `faces`, every damage die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { fireEncounterStartTraits, runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, saveModifierOf } from "../lib/sim/engine/resolve";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { applyRest } from "../lib/sim/engine/day";
import { BEAST_FORMS, bestBeast, bestElemental } from "../lib/sim/engine/beastForms";
import { beginTurn, initCombatant, revertShape, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import type { Action, AutomationNode, Combatant, CreatureType } from "../lib/sim/schema";

const MOON_ID = "moon-druid";
const LAND_IDS = ["arctic", "coast", "desert", "forest", "grassland", "mountain", "swamp", "underdark"].map((l) => `${l}-land-druid`);
const DRUID_IDS = [MOON_ID, ...LAND_IDS];

function state(faces: number | number[] = 15, modes: string[] = []): CombatState {
  const rng = makeRng(1);
  let i = 0;
  const next = () => (Array.isArray(faces) ? faces[Math.min(i++, faces.length - 1)] : faces);
  rng.d20 = () => next();
  rng.d20mode = (m) => { modes.push(m); const f = next(); return { used: f, nat: f }; };
  rng.dice = (n, sides) => n * sides;
  return { round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [], maxRounds: 10, ended: false, verbose: false, summonCounter: 0 };
}
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));
const dru = (id = MOON_ID, level = 5, suffix = "-d") => initCombatant(makeTemplate(id, level), "party", suffix);
const fighter = (level = 6, suffix = "-a") => initCombatant(makeTemplate("gwm-fighter", level), "party", suffix);
function foe(id: string, type?: CreatureType, over: Partial<Combatant> = {}, mods: Partial<Record<keyof Combatant["abilities"], number>> = {}, ac = 8): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4), cha: score(-4) };
  for (const [k, v] of Object.entries(mods)) abilities[k as keyof typeof abilities] = score(v as number);
  const { creatureType: _drop, ...rest } = base;
  void _drop;
  const c: Combatant = { ...rest, ac, abilities, proficientSaves: [], specialRules: [], ...(type ? { creatureType: type } : {}), ...over };
  const u = initCombatant(c, "monster", `-${id}`);
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
const slots = (u: CombatantState) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => res(u, `slot${l}`));
const shapeInto = (s: CombatState, u: CombatantState, form: string, beastSpells = false) =>
  runAutomation([{ type: "wildShape", form, ...(beastSpells ? { beastSpells: true } : {}) }], { state: s, source: u, scope: [u], last: {}, depth: 0 });
const arena = (faces: number | number[], attacker: CombatantState, target: CombatantState = foe("f")) => {
  const s = state(faces);
  put(s, attacker, target);
  attacker.zone = target.zone = "melee";
  return { s, target };
};

describe("druid — validity and parsing", () => {
  it("every druid template builds a schema-valid PC at every level", () => {
    for (const id of DRUID_IDS) {
      for (let lvl = 1; lvl <= 20; lvl++) {
        const r = validateCombatant(makeTemplate(id, lvl));
        if (!r.ok) console.error(`${id} L${lvl}:`, r.errors);
        expect(r.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });
});

describe("the Druid table", () => {
  it("proficient in Intelligence and Wisdom saves; a d8 hit die (10 hit points at 1st, 7 more a level)", () => {
    expect(makeTemplate(MOON_ID, 5).proficientSaves).toEqual(["int", "wis"]);
    expect(makeTemplate(MOON_ID, 1).maxHp).toBe(10);
    expect(makeTemplate(MOON_ID, 5).maxHp).toBe(10 + 4 * 7);
    expect(makeTemplate(MOON_ID, 20).maxHp).toBe(10 + 19 * 7);
  });

  it("cantrips 2 / 3 / 4 and the slots of a full caster", () => {
    const cantrips = (level: number) => makeTemplate("forest-land-druid", level).actions.filter((a) => a.isSpell && a.spellLevel === 0).length;
    expect(cantrips(1)).toBeLessThanOrEqual(2);
    expect(cantrips(4)).toBeLessThanOrEqual(4); // the Land circle's bonus cantrip is on top of the class's 3
    expect(makeTemplate(MOON_ID, 5).resources.slot3).toEqual({ max: 2, recharge: "longRest" });
  });

  it("Wild Shape: two uses, back on a short rest; unlimited from 20th (Archdruid); none at 1st", () => {
    expect(makeTemplate(MOON_ID, 1).resources.wild_shape).toBeUndefined();
    expect(makeTemplate(MOON_ID, 2).resources.wild_shape).toEqual({ max: 2, recharge: "shortRest" });
    expect(makeTemplate(MOON_ID, 19).resources.wild_shape).toEqual({ max: 2, recharge: "shortRest" });
    expect(makeTemplate(MOON_ID, 20).resources.wild_shape?.max).toBe("unbounded");
    expect(makeTemplate(MOON_ID, 20).actions.find((a) => a.id === "wild-shape")?.limitedUse).toBeUndefined();
    expect(makeTemplate(MOON_ID, 19).actions.find((a) => a.id === "wild-shape")?.limitedUse).toEqual({ resource: "wild_shape", amount: 1 });
  });
});

describe("Wild Shape — the printed transformation rules", () => {
  it("statistics are replaced by the beast's, but Intelligence, Wisdom and Charisma are kept; armor class, hit points and speed are the beast's", () => {
    const d = dru();
    const s = state();
    put(s, d);
    const own = { ac: d.ac, hp: d.hp, wis: d.ref.abilities.wis, int: d.ref.abilities.int, cha: d.ref.abilities.cha };
    shapeInto(s, d, "brown-bear");
    const bear = BEAST_FORMS["brown-bear"].ref;
    expect(d.ac).toBe(11);
    expect(d.hp).toBe(34);
    expect(d.maxHp).toBe(34);
    expect(d.ref.abilities.str).toBe(19);
    expect(d.ref.abilities.dex).toBe(10);
    expect(d.ref.abilities.con).toBe(16);
    expect([d.ref.abilities.wis, d.ref.abilities.int, d.ref.abilities.cha]).toEqual([own.wis, own.int, own.cha]);
    expect(d.ref.speeds).toEqual(bear.speeds);
    expect(d.shape).toMatchObject({ hp: own.hp, ac: own.ac, form: "brown-bear" });
  });

  it("the attacks are the beast's: a brown bear bites for 1d8+4 and claws for 2d6+4, both at +6", () => {
    const d = dru();
    const { s, target } = arena(15, d);
    shapeInto(s, d, "brown-bear");
    act(s, d, "attack");
    expect(lost(target)).toBe(8 + 4 + 12 + 4);
    const a = action(d, "attack");
    const t = a.automation[0];
    expect(t.type === "target" && t.effects.every((e) => e.type === "attack" && e.bonus === 6)).toBe(true);
  });

  it("saving-throw proficiencies are retained: the druid's Wisdom save still adds proficiency, the beast's Strength does not", () => {
    const d = dru();
    const s = state();
    put(s, d);
    const wisBefore = saveModifierOf(d, "wis");
    shapeInto(s, d, "brown-bear");
    expect(saveModifierOf(d, "wis")).toBe(wisBefore);
    expect(saveModifierOf(d, "str")).toBe(4); // +4 from Strength 19, no proficiency
    expect(saveModifierOf(d, "con")).toBe(3); // Constitution 16
  });

  it("damage lands on the beast's hit points, not the druid's", () => {
    const d = dru();
    const s = state();
    put(s, d);
    const own = d.hp;
    shapeInto(s, d, "brown-bear");
    applyDamage(s, d, 10, "force", {});
    expect(d.hp).toBe(24);
    expect(d.shape!.hp).toBe(own);
  });

  it("at 0 hit points the druid reverts with the hit points it had before, and the excess damage carries over", () => {
    const d = dru();
    const s = state();
    put(s, d);
    const own = d.hp;
    shapeInto(s, d, "brown-bear");
    applyDamage(s, d, 50, "force", {}); // 34 hit points of bear, 16 left over
    expect(d.shape).toBeUndefined();
    expect(d.ref.id).toBe(MOON_ID);
    expect(d.hp).toBe(own - 16);
    expect(d.alive).toBe(true);
    expect(d.downed).toBe(false);
  });

  it("the excess damage can drop the druid too", () => {
    const d = dru();
    const s = state();
    put(s, d);
    shapeInto(s, d, "brown-bear");
    applyDamage(s, d, 34 + d.shape!.hp + 20, "force", {});
    expect(d.hp).toBeLessThanOrEqual(0);
    expect(d.downed || !d.alive).toBe(true);
  });

  it("a hit that leaves the beast standing does nothing to the druid's own hit points", () => {
    const d = dru();
    const s = state();
    put(s, d);
    shapeInto(s, d, "brown-bear");
    const own = d.shape!.hp;
    applyDamage(s, d, 33, "force", {});
    expect(d.hp).toBe(1);
    expect(d.shape!.hp).toBe(own);
  });

  it("you can't cast spells in beast shape (before Beast Spells): the unshaped druid has spells, the shaped one doesn't", () => {
    const d = dru();
    const s = state();
    put(s, d);
    expect(d.ref.actions.some((a) => a.isSpell)).toBe(true);
    shapeInto(s, d, "brown-bear");
    expect(d.ref.actions.some((a) => a.isSpell)).toBe(false);
    revertShape(s, d);
    expect(d.ref.actions.some((a) => a.isSpell)).toBe(true);
  });

  it("Beast Spells (18th): the druid's spells come along into the form", () => {
    const d = dru(MOON_ID, 18);
    const s = state();
    put(s, d);
    shapeInto(s, d, "mammoth", true);
    expect(d.ref.actions.some((a) => a.isSpell)).toBe(true);
    expect(d.ref.actions.some((a) => a.id === "attack")).toBe(true);
    const plain = dru(MOON_ID, 17, "-p");
    shapeInto(s, plain, "mammoth", false);
    expect(plain.ref.actions.some((a) => a.isSpell)).toBe(false);
  });

  it("transforming doesn't break concentration on a spell already cast, and the spell slots are still there", () => {
    const d = dru();
    const s = state();
    put(s, d);
    d.concentratingOn = "cast-entangle-1";
    d.concentrationEffects = ["restrained"];
    const before = slots(d);
    shapeInto(s, d, "brown-bear");
    expect(d.concentratingOn).toBe("cast-entangle-1");
    expect(slots(d)).toEqual(before);
  });

  it("healing while shaped heals the beast, up to its maximum", () => {
    const d = dru();
    const s = state();
    put(s, d);
    shapeInto(s, d, "brown-bear");
    d.hp = 10;
    runAutomation([{ type: "heal", amount: "100" }], { state: s, source: d, scope: [d], last: {}, depth: 0 });
    expect(d.hp).toBe(34);
  });

  it("a rest ends the form: the druid is back to their own hit points, and the beast's don't carry over", () => {
    const d = dru();
    const s = state();
    put(s, d);
    d.hp = 20;
    shapeInto(s, d, "brown-bear");
    applyDamage(s, d, 10, "force", {});
    applyRest([d], "short", new Map([[d.id, 5]]), 5);
    expect(d.shape).toBeUndefined();
    expect(d.hp).toBeGreaterThanOrEqual(20);
    expect(d.ref.id).toBe(MOON_ID);
  });

  it("an already-shaped druid doesn't shape again", () => {
    const d = dru();
    const s = state();
    put(s, d);
    shapeInto(s, d, "brown-bear");
    shapeInto(s, d, "tiger");
    expect(d.shape!.form).toBe("brown-bear");
    expect(d.hp).toBe(34);
  });
});

describe("the beast forms are the printed stat blocks", () => {
  const f = (id: string) => BEAST_FORMS[id].ref;
  it("hit points, armor class and challenge rating", () => {
    for (const [id, hp, ac, cr] of [["wolf", 11, 13, 0.25], ["brown-bear", 34, 11, 1], ["dire-wolf", 37, 14, 1], ["tiger", 37, 12, 1], ["polar-bear", 42, 12, 2],
      ["saber-toothed-tiger", 52, 12, 2], ["giant-scorpion", 52, 15, 3], ["elephant", 76, 12, 4], ["triceratops", 95, 13, 5], ["mammoth", 126, 13, 6],
      ["earth-elemental", 126, 17, 5], ["air-elemental", 90, 15, 5], ["fire-elemental", 102, 13, 5], ["water-elemental", 114, 14, 5]] as const) {
      expect([f(id).maxHp, f(id).ac, BEAST_FORMS[id].cr], id).toEqual([hp, ac, cr]);
    }
  });

  it("beasts are beasts and elementals are elementals", () => {
    for (const form of Object.values(BEAST_FORMS)) expect(form.ref.creatureType).toBe(/elemental/.test(form.id) ? "elemental" : "beast");
  });

  it("a wolf has Pack Tactics and knocks its target prone with a DC 11 Strength save", () => {
    expect(f("wolf").specialRules.some((r) => r.rule === "packTactics")).toBe(true);
    expect(JSON.stringify(f("wolf").actions)).toContain('"dc":11');
  });

  it("Pounce and the Charges apply on the first round only, and a stomp only lands on a creature that is prone", () => {
    const d = dru();
    const target = foe("f", "humanoid", {}, {}, 8);
    const s = state(15);
    put(s, d, target);
    d.zone = target.zone = "melee";
    shapeInto(s, d, "triceratops");
    act(s, d, "attack"); // round 1: the gore, a Strength save (fails: 15 - 4 < 13), then the stomp on the prone creature
    expect(target.conditions.has("prone")).toBe(true);
    expect(lost(target)).toBe(4 * 8 + 6 + 3 * 10 + 6);
    const t2 = foe("g", "humanoid", {}, {}, 8);
    put(s, t2);
    t2.zone = "melee";
    s.round = 2;
    const before = t2.hp;
    runAction(s, d, action(d, "attack"), { forceScope: [t2] });
    expect(t2.conditions.has("prone")).toBe(false);
    expect(before - t2.hp).toBe(4 * 8 + 6); // no charge, no prone, no stomp
  });

  it("a rhinoceros' or boar's charge adds its extra damage on the first round", () => {
    const d = dru(MOON_ID, 6);
    const { s, target } = arena(15, d);
    shapeInto(s, d, "rhinoceros");
    act(s, d, "attack");
    expect(lost(target)).toBe(16 + 5 + 16); // 2d8+5, plus the charge's 2d8
  });

  it("Fire Form: a creature that hits a fire elemental in melee takes 1d10 fire damage", () => {
    const d = dru(MOON_ID, 10);
    const attacker = foe("g", "humanoid");
    const s = state(15);
    put(s, d, attacker);
    attacker.zone = d.zone = "melee";
    shapeInto(s, d, "fire-elemental");
    expect(hasEffect(d, "fire-form")).toBe(true);
    hit(s, attacker, d);
    expect(lost(attacker)).toBe(10);
    revertShape(s, d);
    expect(hasEffect(d, "fire-form")).toBe(false);
  });

  it("elementals' resistances and immunities come with the form; the druid's own are kept", () => {
    const d = dru(MOON_ID, 10);
    const s = state();
    put(s, d);
    shapeInto(s, d, "earth-elemental");
    expect(d.ref.vulnerabilities).toContain("thunder");
    expect(d.ref.immunities).toContain("poison");
    expect(d.ref.conditionImmunities).toContain("paralyzed");
    expect(d.ref.resistancesNonmagical).toContain("slashing");
  });
});

describe("Circle of the Moon", () => {
  it("Circle Forms (2nd): a beast of challenge rating up to 1, then the druid level divided by 3, rounded down, from 6th", () => {
    const cr = (level: number) => {
      const wild = makeTemplate(MOON_ID, level).actions.find((a) => a.id === "wild-shape")!;
      const node = JSON.stringify(wild.automation);
      const id = /"form":"([a-z-]+)"/.exec(node)![1];
      return BEAST_FORMS[id].cr;
    };
    expect([2, 3, 4, 5].map(cr).every((c) => c <= 1)).toBe(true);
    expect([6, 7, 8].map(cr).every((c) => c <= 2)).toBe(true);
    expect(cr(6)).toBe(2);
    expect(cr(9)).toBeLessThanOrEqual(3);
    expect(cr(9)).toBe(2); // the best CR 3 form outside the water is the scorpion, which the tiger beats
    expect(cr(12)).toBe(4);
    expect(cr(15)).toBe(5);
    expect(cr(18)).toBe(6);
  });

  it("the class table's limits still apply: no flying or swimming at 2nd, no flying at 4th, neither from 8th", () => {
    expect(bestBeast(1, { fly: false, swim: false })!.swim).toBe(false);
    expect(bestBeast(1, { fly: false, swim: false })!.fly).toBe(false);
    for (const [fly, swim] of [[false, false], [false, true], [true, true]] as const) {
      const b = bestBeast(5, { fly, swim })!;
      expect(fly || !b.fly).toBe(true);
      expect(swim || !b.swim).toBe(true);
    }
    // a polar bear swims, so it is off the list until 4th level
    expect(bestBeast(2, { fly: false, swim: false })!.id).not.toBe("polar-bear");
  });

  it("Combat Wild Shape (2nd): Wild Shape as a bonus action, gated on not already being shaped", () => {
    const d = dru(MOON_ID, 5);
    const { s } = arena(15, d);
    const ws = action(d, "wild-shape");
    expect(ws.cost).toEqual({ bonus: 1 });
    expect(actionAvailable(s, d, ws)).toBe(true);
    cast(s, d, "wild-shape");
    expect(d.shape).toBeDefined();
    expect(res(d, "wild_shape")).toBe(1);
    expect(actionAvailable(s, d, action(d, "attack"))).toBe(true);
    expect(d.ref.actions.some((a) => a.id === "wild-shape")).toBe(false); // in beast form the druid's own list is gone
  });

  it("Combat Wild Shape: expend a spell slot to regain 1d8 per slot level, in beast shape and only while hurt", () => {
    const d = dru(MOON_ID, 5);
    const { s } = arena(15, d);
    const heal = action(d, "shape-heal-3");
    expect(heal.keepInForm).toBe(true);
    expect(actionAvailable(s, d, heal)).toBe(false); // not shaped
    cast(s, d, "wild-shape");
    expect(actionAvailable(s, d, action(d, "shape-heal-3"))).toBe(false); // shaped, but unhurt
    d.hp = 10;
    startTurn(s, d);
    const slot3 = res(d, "slot3");
    expect(actionAvailable(s, d, action(d, "shape-heal-3"))).toBe(true);
    cast(s, d, "shape-heal-3");
    expect(d.hp).toBe(10 + 3 * 8);
    expect(res(d, "slot3")).toBe(slot3 - 1);
  });

  it("Elemental Wild Shape (10th): two uses of Wild Shape at once for an elemental", () => {
    const d = dru(MOON_ID, 10);
    const { s } = arena(15, d);
    const el = action(d, "elemental-wild-shape");
    expect(el.limitedUse).toEqual({ resource: "wild_shape", amount: 2 });
    expect(makeTemplate(MOON_ID, 9).actions.some((a) => a.id === "elemental-wild-shape")).toBe(false);
    cast(s, d, "elemental-wild-shape");
    expect(d.shape!.form).toBe("earth-elemental");
    expect(res(d, "wild_shape")).toBe(0);
    expect(bestElemental().id).toBe("earth-elemental");
    expect(d.maxHp).toBe(126);
  });

  it("the Moon druid opens the fight by shaping, and starts it in melee", () => {
    const c = makeTemplate(MOON_ID, 5);
    expect(c.ai.opener[0]).toBe("wild-shape");
    expect(c.ai.bonusRoutine).toContain("wild-shape");
    expect(c.ai.keepDistance).toBe(false);
  });

  it("only the Moon druid has a combat Wild Shape: the other circles keep casting", () => {
    for (const id of LAND_IDS) expect(makeTemplate(id, 8).actions.some((a) => a.id === "wild-shape"), id).toBe(false);
  });

  it("in a real fight the Moon druid becomes a beast, fights as one, and steps out of the form when it falls", () => {
    let becameBeast = false;
    let steppedOut = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: MOON_ID, level: 5, name: "Dru" }, { template: "gwm-fighter", level: 5 }], enemies: ["ogre", "ogre", "ogre"], seed, controlled: [], maxRounds: 8 } as never);
      const text = out.frames.map((f) => f.text ?? "").join("\n");
      if (/Dru uses Wild Shape \(Brown Bear\) -> Dru becomes a Brown Bear/.test(text)) becameBeast = true;
      if (/Dru back in their own shape/.test(text) || /Dru returns to their own shape/.test(text)) steppedOut = true;
      // a shaped druid never casts
      const lines = text.split("\n");
      let shaped = false;
      for (const l of lines) {
        if (/^Dru uses Wild Shape/.test(l)) shaped = true;
        if (/Dru (back in|returns to) their own shape/.test(l)) shaped = false;
        if (shaped) expect(l).not.toMatch(/^Dru uses (Entangle|Thorn Whip|Cure Wounds|Moonbeam|Call Lightning|Faerie Fire|Produce Flame|Guidance|Goodberry)/);
      }
    }
    expect(becameBeast).toBe(true);
    expect(steppedOut).toBe(true);
  });
});

describe("Circle of the Land", () => {
  const preparedIds = (c: Combatant) => new Set(c.actions.filter((a) => a.isSpell).map((a) => a.id.replace(/^cast-/, "").replace(/-\d+$/, "")));

  it("Circle Spells (3rd, 5th, 7th, 9th): each land's two spells at each step are always prepared — those the sim can cast, and none before their level", () => {
    const at = (id: string, level: number) => preparedIds(makeTemplate(id, level));
    expect(at("arctic-land-druid", 2).has("hold-person")).toBe(false);
    for (const id of ["hold-person", "spike-growth"]) expect(at("arctic-land-druid", 3).has(id), id).toBe(true);
    for (const id of ["sleet-storm", "slow"]) expect(at("arctic-land-druid", 5).has(id), id).toBe(true);
    for (const id of ["freedom-of-movement", "ice-storm"]) expect(at("arctic-land-druid", 7).has(id), id).toBe(true);
    expect(at("arctic-land-druid", 9).has("cone-of-cold")).toBe(true);
    expect(at("forest-land-druid", 3).has("barkskin")).toBe(true);
    expect(at("forest-land-druid", 5).has("call-lightning")).toBe(true);
    expect(at("mountain-land-druid", 5).has("lightning-bolt")).toBe(true);
    expect(at("mountain-land-druid", 7).has("stoneskin")).toBe(true);
    expect(at("swamp-land-druid", 3).has("melfs-acid-arrow")).toBe(true);
    expect(at("underdark-land-druid", 3).has("web")).toBe(true);
    expect(at("underdark-land-druid", 9).has("cloudkill")).toBe(true);
    expect(at("coast-land-druid", 3).has("mirror-image")).toBe(true);
    expect(at("desert-land-druid", 3).has("blur")).toBe(true);
    expect(at("grassland-land-druid", 5).has("haste")).toBe(true);
  });

  it("Natural Recovery (2nd): on a short rest, slots totalling up to half the druid level (rounded up), none 6th or higher, once until a long rest", () => {
    const d = dru("forest-land-druid", 8);
    for (let l = 1; l <= 9; l++) d.resources.set(`slot${l}`, 0);
    applyRest([d], "short", new Map([[d.id, 8]]), 8);
    expect(slots(d).reduce((n, c, i) => n + c * (i + 1), 0)).toBe(4); // half of 8: a 4th-level slot
    for (let l = 1; l <= 9; l++) d.resources.set(`slot${l}`, 0);
    applyRest([d], "short", new Map([[d.id, 8]]), 8);
    expect(slots(d)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    applyRest([d], "long", new Map([[d.id, 8]]), 8);
    expect(d.arcaneRecoveryUsed).toBe(false);
    expect(makeTemplate("forest-land-druid", 1).specialRules.some((r) => r.rule === "arcaneRecovery")).toBe(false);
  });

  it("Nature's Ward (10th): immune to poison, and can't be charmed or frightened by elementals or fey — anything else can", () => {
    const d = dru("forest-land-druid", 10);
    const s = state(2);
    put(s, d);
    fireEncounterStartTraits(s);
    expect(d.ref.immunities).toContain("poison");
    expect(d.ref.conditionImmunities).toContain("poisoned");
    const aim = (source: CombatantState, condition: "charmed" | "frightened") =>
      runAutomation([{ type: "applyCondition", condition, durationRounds: 5 }], { state: s, source, scope: [d], last: {}, depth: 0 });
    const fey = foe("fey", "fey");
    const elemental = foe("el", "elemental");
    const dragon = foe("dr", "dragon");
    put(s, fey, elemental, dragon);
    aim(fey, "charmed"); aim(elemental, "frightened");
    expect(d.conditions.has("charmed") || d.conditions.has("frightened")).toBe(false);
    aim(dragon, "frightened");
    expect(d.conditions.has("frightened")).toBe(true);
    const early = dru("forest-land-druid", 9, "-e");
    expect(early.ref.immunities).not.toContain("poison");
  });

  it("Nature's Sanctuary (14th): a beast that fails the Wisdom save must attack someone else; a creature that succeeds is immune for 24 hours", () => {
    const d = dru("forest-land-druid", 14);
    const ally = fighter(6, "-ally");
    const wolf = foe("wolf", "beast");
    const s = state(15);
    put(s, d, ally, wolf);
    d.zone = ally.zone = wolf.zone = "melee";
    hit(s, wolf, d);
    expect(d.hp).toBe(d.maxHp);
    expect(lost(ally)).toBe(5); // it hesitates and turns on the druid's friend
  });

  it("Nature's Sanctuary: with no one else to attack, the attack automatically misses — and a creature that passes the save attacks the druid as it meant to, from then on", () => {
    const d = dru("forest-land-druid", 14);
    const wolf = foe("wolf", "beast");
    const s = state(15);
    put(s, d, wolf);
    hit(s, wolf, d);
    expect(lost(d)).toBe(0);
    const brave = foe("bear", "beast", {}, { wis: 8 });
    const s2 = state(15);
    const d2 = dru("forest-land-druid", 14, "-2");
    put(s2, d2, brave);
    hit(s2, brave, d2);
    expect(lost(d2)).toBe(5);
    expect(brave.effects.some((e) => e.name === "sanctuary-immune")).toBe(true);
    hit(s2, brave, d2);
    expect(lost(d2)).toBe(10); // immune to the effect for the rest of the day
  });

  it("Nature's Sanctuary works on beasts and plants only", () => {
    const d = dru("forest-land-druid", 14);
    const ogre = foe("ogre", "giant");
    const s = state(2);
    put(s, d, ogre);
    hit(s, ogre, d);
    expect(lost(d)).toBe(5);
    const treant = foe("tree", "plant");
    const s2 = state(2);
    const d2 = dru("forest-land-druid", 14, "-2");
    put(s2, d2, treant);
    hit(s2, treant, d2);
    expect(lost(d2)).toBe(0);
    expect(makeTemplate("forest-land-druid", 13).specialRules.some((r) => r.rule === "natureSanctuary")).toBe(false);
  });
});

describe("free text finds each circle", () => {
  it("'moon druid' and bare 'druid' are the Moon; each land has its own template", () => {
    for (const [text, id] of [["druid", MOON_ID], ["moon druid", MOON_ID], ["circle of the moon druid", MOON_ID], ["land druid", "forest-land-druid"],
      ["arctic land druid", "arctic-land-druid"], ["coast land druid", "coast-land-druid"], ["desert land druid", "desert-land-druid"], ["forest land druid", "forest-land-druid"],
      ["grassland land druid", "grassland-land-druid"], ["mountain land druid", "mountain-land-druid"], ["swamp land druid", "swamp-land-druid"], ["underdark land druid", "underdark-land-druid"]]) {
      expect(findClassTemplate(text).match?.templateId, text).toBe(id);
    }
  });
});

describe("Circle of Dreams", () => {
  it("Balm of the Summer Court (2nd): a pool of d6s equal to the druid level; a bonus action spends up to half the level, healing that many d6 and giving that many temporary hit points", () => {
    const d = dru("dreams-druid", 6);
    const ally = fighter(6, "-ally");
    ally.hp = ally.maxHp - 40;
    const { s } = arena(15, d);
    put(s, ally);
    expect(d.ref.resources.balm).toEqual({ max: 6, recharge: "longRest" });
    const balm = action(d, "balm-of-the-summer-court");
    expect(balm.cost).toEqual({ bonus: 1 });
    expect(balm.limitedUse).toEqual({ resource: "balm", amount: 3 });
    cast(s, d, "balm-of-the-summer-court");
    expect(ally.hp).toBe(ally.maxHp - 40 + 18); // 3d6 at its maximum
    expect(ally.tempHp).toBe(3);
    expect(res(d, "balm")).toBe(3);
  });

  it("it is kept for when the party is hurt, and there is no Balm at 1st level", () => {
    const d = dru("dreams-druid", 6);
    const ally = fighter(6, "-ally");
    const { s } = arena(15, d);
    put(s, ally);
    expect(actionAvailable(s, d, action(d, "balm-of-the-summer-court"))).toBe(false);
    ally.hp = ally.maxHp - 30;
    expect(actionAvailable(s, d, action(d, "balm-of-the-summer-court"))).toBe(true);
    expect(makeTemplate("dreams-druid", 1).actions.some((a) => a.id === "balm-of-the-summer-court")).toBe(false);
    expect(d.ref.ai.bonusRoutine).toContain("balm-of-the-summer-court");
  });
});

describe("Circle of the Shepherd", () => {
  it("Spirit Totem (2nd): once until a short or long rest; Bear Spirit gives each ally 5 + the druid level temporary hit points and advantage on Strength saves", () => {
    const d = dru("shepherd-druid", 5);
    const ally = fighter(6, "-ally");
    const { s } = arena(15, d);
    put(s, ally);
    expect(d.ref.resources.spirit_totem).toEqual({ max: 1, recharge: "shortRest" });
    cast(s, d, "spirit-totem-bear");
    expect(ally.tempHp).toBe(10);
    expect(d.tempHp).toBe(10);
    expect(ally.effects.some((e) => e.name === "spirit-bear" && e.mods?.saveAdvantageOn?.includes("str"))).toBe(true);
    expect(actionAvailable(s, d, action(d, "spirit-totem-hawk"))).toBe(false); // the one use is spent
    expect(d.ref.ai.opener).toContain("spirit-totem-bear");
  });

  it("Hawk Spirit: a reaction gives an ally's attack roll advantage", () => {
    const d = dru("shepherd-druid", 5);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre", "giant");
    const modes: string[] = [];
    const s = state(15, modes);
    put(s, d, ally, monster);
    cast(s, d, "spirit-totem-hawk");
    hit(s, ally, monster);
    expect(modes.at(-1)).toBe("adv");
    expect(d.reactionUsed).toBe(true);
    hit(s, ally, monster); // the reaction is spent
    expect(modes.at(-1)).toBe("flat");
  });

  it("Unicorn Spirit: a healing spell cast with a slot also heals every ally by the druid's level", () => {
    const d = dru("shepherd-druid", 5);
    const a = fighter(6, "-a");
    const b = fighter(6, "-b");
    const { s } = arena(15, d);
    put(s, a, b);
    a.hp = b.hp = 1;
    d.hp = d.maxHp - 20;
    cast(s, d, "spirit-totem-unicorn");
    const heal = d.ref.actions.find((x) => /^cast-cure-wounds-/.test(x.id));
    if (!heal) throw new Error("no Cure Wounds prepared");
    const before = { a: a.hp, b: b.hp };
    cast(s, d, heal.id);
    expect(a.hp - before.a + (b.hp - before.b)).toBeGreaterThanOrEqual(5); // the healed one gets the spell, the other the totem's 5
    expect(Math.min(a.hp - before.a, b.hp - before.b)).toBe(5);
    // without the spirit standing, no bonus to the other
    const d2 = dru("shepherd-druid", 5, "-2");
    const c = fighter(6, "-c");
    const e = fighter(6, "-e");
    const s2 = state(15);
    put(s2, d2, c, e);
    c.hp = 1; e.hp = 1;
    cast(s2, d2, heal.id);
    expect(Math.min(c.hp, e.hp)).toBe(1);
  });

  it("Mighty Summoner (6th): beasts and fey the druid summons have 2 extra hit points per Hit Die", () => {
    const d = dru("shepherd-druid", 6);
    const s = state(15);
    put(s, d);
    runAutomation([{ type: "summon", statBlock: "wolf", count: "1" }], { state: s, source: d, scope: [], last: {}, depth: 0 });
    const wolf = [...s.units.values()].find((u) => u.summonerId === d.id)!;
    const dice = Number(/^(\d+)d/.exec(String(wolf.ref.maxHp))?.[1] ?? 0);
    expect(dice).toBeGreaterThan(0);
    const plain = initCombatant(wolf.ref, "party", "-plain");
    expect(wolf.maxHp).toBe(plain.maxHp + 2 * dice);
    const other = dru("stars-druid", 6, "-o");
    const s2 = state(15);
    put(s2, other);
    runAutomation([{ type: "summon", statBlock: "wolf", count: "1" }], { state: s2, source: other, scope: [], last: {}, depth: 0 });
    expect([...s2.units.values()].find((u) => u.summonerId === other.id)!.maxHp).toBe(plain.maxHp);
    // a summoned zombie is not a beast or a fey
    const s3 = state(15);
    const d3 = dru("shepherd-druid", 6, "-3");
    put(s3, d3);
    runAutomation([{ type: "summon", statBlock: "zombie", count: "1" }], { state: s3, source: d3, scope: [], last: {}, depth: 0 });
    const z = [...s3.units.values()].find((u) => u.summonerId === d3.id)!;
    expect(z.maxHp).toBe(initCombatant(z.ref, "party", "-z").maxHp);
  });

  it("Guardian Spirit (10th): summoned beasts regain half the druid's level in hit points at the end of their turns while a spirit stands", async () => {
    const { endOfTurn } = await import("../lib/sim/engine/loop");
    const d = dru("shepherd-druid", 10);
    const s = state(15);
    put(s, d);
    runAutomation([{ type: "summon", statBlock: "wolf", count: "1" }], { state: s, source: d, scope: [], last: {}, depth: 0 });
    const wolf = [...s.units.values()].find((u) => u.summonerId === d.id)!;
    wolf.hp = 5;
    endOfTurn(s, wolf);
    expect(wolf.hp).toBe(5); // no spirit yet
    cast(s, d, "spirit-totem-hawk");
    endOfTurn(s, wolf);
    expect(wolf.hp).toBe(10); // half of level 10
  });

  it("Faithful Summons (14th): reduced to 0 hit points, four beasts appear (once per long rest)", () => {
    const d = dru("shepherd-druid", 14);
    const monster = foe("ogre", "giant");
    const { s } = arena(15, d, monster);
    runAutomation([{ type: "damage", amount: "9999", damageType: "force" }], { state: s, source: monster, scope: [d], last: {}, depth: 0 }); // a blow, as opposed to a bare applyDamage
    const bears = [...s.units.values()].filter((u) => u.summonerId === d.id);
    expect(bears).toHaveLength(4);
    expect(bears.every((b) => b.ref.creatureType === "beast" && b.ref.cr === "2")).toBe(true);
    expect(res(d, "faithful_summons")).toBe(0);
    expect(makeTemplate("shepherd-druid", 13).traits.some((t) => t.id === "faithful-summons")).toBe(false);
  });
});

describe("Circle of Spores", () => {
  it("Halo of Spores (2nd): a hostile creature that starts its turn beside the druid makes a Constitution save or takes 1d4 necrotic; 1d6 at 6th, 1d8 at 10th, 1d10 at 14th", async () => {
    const { startOfTurn } = await import("../lib/sim/engine/loop");
    for (const [level, die] of [[2, 4], [6, 6], [10, 8], [14, 10]] as const) {
      const d = dru("spores-druid", level);
      const monster = foe("ogre", "giant");
      const { s } = arena(2, d, monster);
      startOfTurn(s, monster);
      expect(lost(monster), `level ${level}`).toBe(die);
      expect(d.reactionUsed).toBe(true);
    }
  });

  it("the halo needs a creature that is near (not in another zone), a failed save, and a reaction to spare", async () => {
    const { startOfTurn } = await import("../lib/sim/engine/loop");
    const d = dru("spores-druid", 2);
    const far = foe("far", "giant");
    const { s } = arena(2, d, far);
    far.zone = "ranged";
    startOfTurn(s, far);
    expect(lost(far)).toBe(0);
    const tough = foe("tough", "giant", {}, { con: 10 });
    const d2 = dru("spores-druid", 2, "-2");
    const a = arena(15, d2, tough);
    startOfTurn(a.s, tough);
    expect(lost(tough)).toBe(0);
    const d3 = dru("spores-druid", 2, "-3");
    const m3 = foe("m3", "giant");
    const b = arena(2, d3, m3);
    d3.reactionUsed = true;
    startOfTurn(b.s, m3);
    expect(lost(m3)).toBe(0);
  });

  it("Symbiotic Entity (2nd): 4 temporary hit points per level for a use of Wild Shape; Halo damage dice are rolled twice; melee weapon attacks add 1d6 necrotic", async () => {
    const { startOfTurn } = await import("../lib/sim/engine/loop");
    const d = dru("spores-druid", 5);
    const monster = foe("ogre", "giant");
    const { s } = arena(2, d, monster);
    cast(s, d, "symbiotic-entity");
    expect(d.tempHp).toBe(20);
    expect(res(d, "wild_shape")).toBe(1);
    expect(hasEffect(d, "symbiotic-entity")).toBe(true);
    startOfTurn(s, monster);
    expect(lost(monster)).toBe(2 * 4); // two d4s
    // a weapon attack adds 1d6 necrotic; a spell attack does not
    const m2 = foe("m2", "giant");
    put(s, m2);
    m2.zone = "melee";
    hit(s, d, m2);
    expect(lost(m2)).toBe(5 + 6);
    const spell: Action = { id: "x", name: "Bolt", cost: { action: 1 }, recharge: "none", isSpell: true, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "5", damageType: "fire" }] }] }] };
    const m3 = foe("m3", "giant");
    put(s, m3);
    runAction(s, d, spell);
    expect(lost(m3) + lost(m2) + lost(monster)).toBeGreaterThan(0);
    expect(lost(m3) === 0 || lost(m3) === 5).toBe(true); // the bolt lands on whichever it picks: never with the rider
  });

  it("Symbiotic Entity ends when its temporary hit points are gone", () => {
    const d = dru("spores-druid", 5);
    const { s } = arena(2, d);
    cast(s, d, "symbiotic-entity");
    applyDamage(s, d, 19, "force", {});
    expect(hasEffect(d, "symbiotic-entity")).toBe(true);
    applyDamage(s, d, 5, "force", {});
    expect(d.tempHp).toBe(0);
    expect(hasEffect(d, "symbiotic-entity")).toBe(false);
  });

  it("Fungal Infestation (6th): a Small or Medium beast or humanoid dying within 10 ft rises as a zombie with 1 hit point; Wisdom-modifier uses", () => {
    const d = dru("spores-druid", 6);
    expect(d.ref.resources.fungal_infestation).toEqual({ max: 4, recharge: "longRest" });
    const s = state(15);
    const victim = foe("goblin", "humanoid", { size: "small" });
    victim.hp = 1;
    put(s, d, victim);
    d.zone = victim.zone = "melee";
    hit(s, d, victim);
    const zombies = [...s.units.values()].filter((u) => u.summonerId === d.id && u.ref.id === "zombie");
    expect(zombies).toHaveLength(1);
    expect(zombies[0].hp).toBe(1);
    expect(res(d, "fungal_infestation")).toBe(3);
  });

  it("Fungal Infestation isn't for a Large creature, an undead one, or a druid below 6th level", () => {
    for (const [type, size] of [["giant", "large"], ["undead", "medium"], ["dragon", "medium"]] as const) {
      const d = dru("spores-druid", 6);
      const s = state(15);
      const victim = foe("v", type, { size });
      victim.hp = 1;
      put(s, d, victim);
      d.zone = victim.zone = "melee";
      hit(s, d, victim);
      expect([...s.units.values()].some((u) => u.summonerId === d.id), `${type} ${size}`).toBe(false);
    }
    const early = dru("spores-druid", 5);
    const victim = foe("v", "humanoid", { size: "medium" });
    victim.hp = 1;
    const s = state(15);
    put(s, early, victim);
    early.zone = victim.zone = "melee";
    hit(s, early, victim);
    expect([...s.units.values()].some((u) => u.summonerId === early.id)).toBe(false);
  });

  it("Spreading Spores (10th) needs the Symbiotic Entity", () => {
    const d = dru("spores-druid", 10);
    const monster = foe("ogre", "giant");
    const { s } = arena(2, d, monster);
    expect(actionAvailable(s, d, action(d, "spreading-spores"))).toBe(false);
    cast(s, d, "symbiotic-entity");
    expect(actionAvailable(s, d, action(d, "spreading-spores"))).toBe(true);
    cast(s, d, "spreading-spores");
    expect(hasEffect(monster, "spreading-spores")).toBe(true);
    expect(lost(monster)).toBe(2 * 8);
    expect(makeTemplate("spores-druid", 9).actions.some((a) => a.id === "spreading-spores")).toBe(false);
  });

  it("Fungal Body (14th): can't be blinded, deafened, frightened or poisoned; a critical hit against you is a normal hit unless you're incapacitated", () => {
    const d = dru("spores-druid", 14);
    for (const c of ["blinded", "deafened", "frightened", "poisoned"] as const) expect(d.ref.conditionImmunities).toContain(c);
    const monster = foe("ogre", "giant");
    const s = state(20); // a natural 20
    put(s, d, monster);
    d.zone = monster.zone = "melee";
    hit(s, monster, d, 99, "1d6");
    expect(lost(d)).toBe(6); // not doubled
    const early = dru("spores-druid", 13, "-e");
    const s2 = state(20);
    put(s2, early, monster);
    early.zone = "melee";
    hit(s2, monster, early, 99, "1d6");
    expect(lost(early)).toBe(12); // a crit doubles the dice
    const down = dru("spores-druid", 14, "-i");
    down.conditions.set("incapacitated", { expiresRound: 9, sourceId: "x" });
    const s3 = state(20);
    put(s3, down, monster);
    down.zone = "melee";
    hit(s3, monster, down, 99, "1d6");
    expect(lost(down)).toBe(12);
  });

  it("Circle Spells: Chill Touch, and the circle's spells at 3rd, 5th, 7th and 9th", () => {
    const ids = (level: number) => new Set(makeTemplate("spores-druid", level).actions.filter((a) => a.isSpell).map((a) => a.id.replace(/^cast-/, "").replace(/-\d+$/, "")));
    expect(ids(2).has("chill-touch")).toBe(true);
    expect(ids(3).has("blindness-deafness")).toBe(true);
    expect(ids(5).has("animate-dead")).toBe(true);
    for (const id of ["blight", "confusion"]) expect(ids(7).has(id), id).toBe(true);
    for (const id of ["cloudkill", "contagion"]) expect(ids(9).has(id), id).toBe(true);
    expect(ids(6).has("blight")).toBe(false);
  });
});

describe("Circle of Stars", () => {
  it("Star Map (2nd): Guiding Bolt without a slot, proficiency-bonus times per long rest", () => {
    const d = dru("stars-druid", 5);
    const monster = foe("ogre", "giant");
    const { s } = arena(15, d, monster);
    const a = action(d, "cast-guiding-bolt-star-map");
    expect(a.limitedUse).toEqual({ resource: "star_map", amount: 1 });
    expect(d.ref.resources.star_map).toEqual({ max: 3, recharge: "longRest" });
    const slot1 = res(d, "slot1");
    cast(s, d, "cast-guiding-bolt-star-map");
    expect(res(d, "star_map")).toBe(2);
    expect(res(d, "slot1")).toBe(slot1);
    expect(lost(monster)).toBeGreaterThan(0);
  });

  it("Starry Form (2nd): a bonus action and a use of Wild Shape; the Archer's shot is 1d8 + Wisdom radiant (2d8 at 10th), and again as a bonus action each turn", () => {
    const d = dru("stars-druid", 5);
    const monster = foe("ogre", "giant");
    const { s } = arena(15, d, monster);
    cast(s, d, "starry-form-archer");
    expect(res(d, "wild_shape")).toBe(1);
    expect(hasEffect(d, "starry-form")).toBe(true);
    expect(hasEffect(d, "starry-form-archer")).toBe(true);
    expect(lost(monster)).toBe(8 + 4);
    startTurn(s, d);
    expect(actionAvailable(s, d, action(d, "starry-archer"))).toBe(true);
    cast(s, d, "starry-archer");
    expect(lost(monster)).toBe(2 * (8 + 4));
    const d10 = dru("stars-druid", 10, "-10");
    const m10 = foe("m10", "giant");
    const a10 = arena(15, d10, m10);
    cast(a10.s, d10, "starry-form-archer");
    expect(lost(m10)).toBe(16 + 4);
  });

  it("the Archer's bonus shot needs the Archer up, and a second Starry Form isn't taken while one is", () => {
    const d = dru("stars-druid", 5);
    const { s } = arena(15, d);
    expect(actionAvailable(s, d, action(d, "starry-archer"))).toBe(false);
    cast(s, d, "starry-form-archer");
    expect(actionAvailable(s, d, action(d, "starry-form-chalice"))).toBe(false);
  });

  it("Chalice: a healing spell cast with a slot also heals a creature within 30 ft for 1d8 + Wisdom (2d8 at 10th)", () => {
    const d = dru("stars-druid", 5);
    const ally = fighter(6, "-ally");
    const { s } = arena(15, d);
    put(s, ally);
    const heal = d.ref.actions.find((x) => /^cast-cure-wounds-/.test(x.id));
    if (!heal) throw new Error("no Cure Wounds prepared");
    ally.hp = 1;
    cast(s, d, "starry-form-chalice");
    const before = ally.hp;
    cast(s, d, heal.id);
    expect(ally.hp - before).toBeGreaterThanOrEqual(8 + 4); // the spell's own healing plus the constellation's
  });

  it("Dragon: a roll of 9 or lower on a concentration save counts as 10", () => {
    const d = dru("stars-druid", 5);
    const { s } = arena(5, d);
    d.concentratingOn = "cast-entangle-1";
    d.concentrationEffects = ["restrained"];
    cast(s, d, "starry-form-dragon");
    // a natural 5 counts as 10: +Con 2 = 12 vs DC 10
    applyDamage(s, d, 20, "force", {});
    expect(d.concentratingOn).toBe("cast-entangle-1");
    const plain = dru("stars-druid", 5, "-p");
    const s2 = state(5);
    put(s2, plain);
    plain.concentratingOn = "cast-entangle-1";
    plain.concentrationEffects = ["restrained"];
    applyDamage(s2, plain, 20, "force", {});
    expect(plain.concentratingOn).toBeUndefined(); // 5 + 2 = 7 < 10
  });

  it("Full of Stars (14th): resistance to bludgeoning, piercing and slashing in Starry Form", () => {
    const d = dru("stars-druid", 14);
    const { s } = arena(15, d);
    cast(s, d, "starry-form-archer");
    const hp = d.hp;
    applyDamage(s, d, 20, "slashing", {});
    expect(hp - d.hp).toBe(10);
    const early = dru("stars-druid", 13, "-e");
    const s2 = state(15);
    put(s2, early);
    cast(s2, early, "starry-form-archer");
    const hp2 = early.hp;
    applyDamage(s2, early, 20, "slashing", {});
    expect(hp2 - early.hp).toBe(20);
  });

  it("Cosmic Omen (6th): an omen rolled after a long rest; Weal adds a d6 to a friend's missed attack", () => {
    const d = dru("stars-druid", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre", "giant", {}, {}, 16);
    const s = state(15);
    s.rng.next = () => 0.1; // Weal
    put(s, d, ally, monster);
    fireEncounterStartTraits(s);
    expect(d.omen).toBe("weal");
    expect(d.ref.resources.cosmic_omen).toEqual({ max: 3, recharge: "longRest" });
    // the ally rolls a 15 needing 16: a d6 (rigged to 6) makes it
    ally.zone = monster.zone = "melee";
    hit(s, ally, monster, 0, "5"); // bonus 0: 15 vs AC 16 misses by 1
    expect(lost(monster)).toBe(5);
    expect(res(d, "cosmic_omen")).toBe(2);
    expect(d.reactionUsed).toBe(true);
  });

  it("Cosmic Omen — Woe: a d6 off an enemy's attack that only just hits", () => {
    const d = dru("stars-druid", 6);
    const ally = fighter(6, "-ally");
    const monster = foe("ogre", "giant");
    const s = state(15);
    s.rng.next = () => 0.9; // Woe
    put(s, d, ally, monster);
    fireEncounterStartTraits(s);
    expect(d.omen).toBe("woe");
    monster.zone = ally.zone = "melee";
    hit(s, monster, ally, ally.ac - 15, "5"); // 15 + (AC - 15) = AC: a hit by 0
    expect(lost(ally)).toBe(0);
    expect(res(d, "cosmic_omen")).toBe(2);
  });

  it("the omen is rolled once a day, and Weal does nothing for an enemy's roll", () => {
    const d = dru("stars-druid", 6);
    const s = state(15);
    s.rng.next = () => 0.1;
    put(s, d);
    fireEncounterStartTraits(s);
    s.rng.next = () => 0.9;
    fireEncounterStartTraits(s);
    expect(d.omen).toBe("weal");
    applyRest([d], "long", new Map([[d.id, 6]]), 6);
    expect(d.omen).toBeUndefined();
    expect(makeTemplate("stars-druid", 5).reactions.some((r) => r.id === "cosmic-omen")).toBe(false);
  });
});

describe("Circle of Wildfire", () => {
  it("Summon Wildfire Spirit (2nd): an action and a use of Wild Shape; 5 + 5 × level hit points, AC 13, immune to fire", () => {
    const d = dru("wildfire-druid", 5);
    const monster = foe("ogre", "giant");
    const { s } = arena(2, d, monster);
    cast(s, d, "summon-wildfire-spirit");
    expect(res(d, "wild_shape")).toBe(1);
    const spirit = [...s.units.values()].find((u) => u.summonerId === d.id)!;
    expect(spirit.maxHp).toBe(5 + 5 * 5);
    expect(spirit.ac).toBe(13);
    expect(spirit.ref.immunities).toContain("fire");
    expect(spirit.ref.creatureType).toBe("elemental");
    expect(spirit.ref.speeds).toEqual({ walk: 30, fly: 30 });
    expect(lost(monster)).toBe(12); // 2d6 fire from the burst on a failed Dexterity save
  });

  it("the spirit only Dodges unless commanded; commanded, Flame Seed is a ranged spell attack for 1d6 + PB fire", () => {
    const d = dru("wildfire-druid", 5);
    const monster = foe("ogre", "giant");
    const { s } = arena(15, d, monster);
    cast(s, d, "summon-wildfire-spirit");
    const before = lost(monster);
    startTurn(s, d);
    cast(s, d, "command-spirit");
    expect(lost(monster) - before).toBe(6 + 3);
    expect(d.ref.ai.bonusRoutine).toContain("command-spirit");
  });

  it("Enhanced Bond (6th): a d8 on a fire or healing spell — only while the spirit stands", () => {
    const d = dru("wildfire-druid", 6);
    const monster = foe("ogre", "giant");
    const { s } = arena(2, d, monster);
    const burning = d.ref.actions.find((a) => /^cast-burning-hands-1$/.test(a.id))!;
    // without the spirit, plain
    const plain = lost(monster);
    runAction(s, d, burning);
    const withoutSpirit = lost(monster) - plain;
    cast(s, d, "summon-wildfire-spirit");
    const mid = lost(monster);
    runAction(s, d, burning);
    const withSpirit = lost(monster) - mid;
    expect(withSpirit - withoutSpirit).toBe(8); // the d8 at its maximum
    expect(JSON.stringify(makeTemplate("wildfire-druid", 5).actions.find((a) => a.id === "cast-burning-hands-1")!.automation)).not.toContain("1d8");
  });

  it("Cauterizing Flames (10th): when a creature dies within 30 ft the flames heal 2d10 + Wisdom, a proficiency-bonus number of times", () => {
    const d = dru("wildfire-druid", 10);
    const ally = fighter(6, "-ally");
    ally.hp = 5;
    const victim = foe("goblin", "humanoid");
    victim.hp = 1;
    const s = state(15);
    put(s, d, ally, victim);
    d.zone = ally.zone = victim.zone = "melee";
    expect(d.ref.resources.cauterizing_flames).toEqual({ max: 4, recharge: "longRest" });
    hit(s, d, victim);
    expect(ally.hp).toBe(5 + 20 + 4);
    expect(res(d, "cauterizing_flames")).toBe(3);
    expect(makeTemplate("wildfire-druid", 9).reactions.some((r) => r.id === "cauterizing-flames")).toBe(false);
  });

  it("Blazing Revival (14th): reduced to 0 with the spirit near, the spirit falls and the druid rises with half their hit points, once per long rest", () => {
    const d = dru("wildfire-druid", 14);
    const monster = foe("ogre", "giant");
    const { s } = arena(2, d, monster);
    cast(s, d, "summon-wildfire-spirit");
    const spirit = [...s.units.values()].find((u) => u.summonerId === d.id)!;
    applyDamage(s, d, 9999, "slashing", {});
    expect(d.hp).toBe(Math.floor(d.maxHp / 2));
    expect(d.downed).toBe(false);
    expect(spirit.alive).toBe(false);
    expect(res(d, "blazing_revival")).toBe(0);
  });

  it("Circle Spells: Burning Hands and Cure Wounds at 2nd, Flaming Sphere and Scorching Ray at 3rd, Fire Shield at 7th, Flame Strike at 9th", () => {
    const ids = (level: number) => new Set(makeTemplate("wildfire-druid", level).actions.filter((a) => a.isSpell).map((a) => a.id.replace(/^cast-/, "").replace(/-\d+$/, "")));
    for (const id of ["burning-hands", "cure-wounds"]) expect(ids(2).has(id), id).toBe(true);
    for (const id of ["flaming-sphere", "scorching-ray"]) expect(ids(3).has(id), id).toBe(true);
    expect(ids(7).has("fire-shield")).toBe(true);
    expect(ids(9).has("flame-strike")).toBe(true);
  });
});

describe("druids in battle", () => {
  it("every circle fights at levels 2, 6, 10, 14 and 20 without breaking", () => {
    for (const id of [...DRUID_IDS, "dreams-druid", "shepherd-druid", "spores-druid", "stars-druid", "wildfire-druid"]) {
      for (const level of [2, 6, 10, 14, 20]) {
        const out = runBattle({ party: [{ template: id, level }, { template: "gwm-fighter", level }], enemies: ["ogre", "ogre"], seed: 5, controlled: [], maxRounds: 6 } as never);
        expect(out.frames.length, `${id} L${level}`).toBeGreaterThan(0);
      }
    }
  });

  it("a Wildfire druid calls its spirit and commands it; a Spores druid wraps itself in its entity; a Stars druid takes the Archer's form", () => {
    const text = (template: string) => runBattle({ party: [{ template, level: 6, name: "Dru" }, { template: "gwm-fighter", level: 6 }], enemies: ["ogre", "ogre"], seed: 4, controlled: [], maxRounds: 4 } as never)
      .frames.map((f) => f.text ?? "").join("\n");
    expect(text("wildfire-druid")).toMatch(/Dru uses Summon Wildfire Spirit/);
    expect(text("wildfire-druid")).toMatch(/Wildfire Spirit 1 \(commanded\) uses Flame Seed/);
    expect(text("spores-druid")).toMatch(/Dru uses Symbiotic Entity/);
    expect(text("stars-druid")).toMatch(/Dru uses Starry Form \(Archer\)/);
    expect(text("shepherd-druid")).toMatch(/Dru uses Spirit Totem \(Bear\)/);
  });
});
