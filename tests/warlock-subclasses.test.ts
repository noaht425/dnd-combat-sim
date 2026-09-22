// The warlock and its patrons, checked against the printed text (dnd5e.wikidot.com/warlock and each patron's page). Numbers asserted here are the ones on those pages; the mechanics run
// through the real engine with rigged dice (every d20 lands on `faces`, every damage die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { fireEncounterStartTraits, runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollSave } from "../lib/sim/engine/resolve";
import { rollDeathSave } from "../lib/sim/engine/loop";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { applyRest } from "../lib/sim/engine/day";
import { initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import { SPELLS_BY_ID } from "../lib/sim/spells/catalog";
import { pactSlotLevel } from "../lib/sim/spells/slots";
import { preparedCount } from "../lib/sim/spells/prepare";
import { WARLOCK_BUILDERS } from "../lib/sim/spells/warlockTemplates";
import { canFly } from "../lib/sim/battle/state";
import type { Action, AutomationNode, Combatant, CreatureType, DamageType } from "../lib/sim/schema";

const ALL = Object.keys(WARLOCK_BUILDERS);

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
const wlk = (id = "fiend-warlock", level = 5, suffix = "-w") => initCombatant(makeTemplate(id, level), "party", suffix);
const fighter = (level = 6, suffix = "-a") => initCombatant(makeTemplate("gwm-fighter", level), "party", suffix);
function foe(id: string, type?: CreatureType, mods: Partial<Record<keyof Combatant["abilities"], number>> = {}, over: Partial<Combatant> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4), cha: score(-4) };
  for (const [k, v] of Object.entries(mods)) abilities[k as keyof typeof abilities] = score(v as number);
  const { creatureType: _drop, ...rest } = base;
  void _drop;
  const c: Combatant = { ...rest, ac: 8, abilities, proficientSaves: [], specialRules: [], ...(type ? { creatureType: type } : {}), ...over };
  const u = initCombatant(c, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const action = (u: CombatantState, id: string): Action => {
  const a = u.ref.actions.find((x) => x.id === id) ?? u.ref.reactions.find((x) => x.id === id);
  if (!a) throw new Error(`no action ${id}; has ${u.ref.actions.map((x) => x.id).join(", ")}`);
  return a;
};
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, action(u, id));
const cast = (s: CombatState, u: CombatantState, id: string) => { spend(u, action(u, id)); act(s, u, id); };
const res = (u: CombatantState, name: string) => u.resources.get(name) ?? 0;
const hasCond = (u: CombatantState, c: string) => u.conditions.has(c as never);
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
const lost = (u: CombatantState) => u.maxHp - u.hp;
const swing = (s: CombatState, attacker: CombatantState, target: CombatantState, bonus = 99, dmg = "5", type: DamageType = "bludgeoning") =>
  runAutomation([{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: type }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });
const arena = (faces: number | number[], w: CombatantState, target: CombatantState = foe("f"), modes: string[] = []) => {
  const s = state(faces, modes);
  put(s, w, target);
  w.zone = target.zone = "melee";
  return { s, target };
};
const attackNodes = (a: Action) => JSON.stringify(a.automation).match(/"type":"attack"/g)?.length ?? 0;

describe("warlock — validity and parsing", () => {
  it("every patron and pact boon builds a schema-valid PC at every level", () => {
    expect(ALL).toHaveLength(49); // twelve patrons x four pact boons, and the pre-rebuild `warlock`
    for (const id of ALL) {
      for (let lvl = 1; lvl <= 20; lvl++) {
        const r = validateCombatant(makeTemplate(id, lvl));
        if (!r.ok) console.error(`${id} L${lvl}:`, r.errors);
        expect(r.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });

  it("plain names find their patron; a bare 'warlock' is still the Fiend; an unrelated word containing 'old' isn't a Great Old One", () => {
    expect(findClassTemplate("warlock").match?.templateId).toBe("fiend-warlock");
    expect(findClassTemplate("hexblade warlock").match?.templateId).toBe("hexblade-warlock");
    expect(findClassTemplate("great old one warlock").match?.templateId).toBe("great-old-one-warlock");
    expect(findClassTemplate("djinni genie warlock").match?.templateId).toBe("djinni-genie-warlock");
    expect(findClassTemplate("archfey blade warlock").match?.templateId).toBe("archfey-warlock-blade");
    expect(findClassTemplate("kobold").match).toBeUndefined();
  });
});

describe("the Warlock table", () => {
  it("proficient in Wisdom and Charisma saves; a d8 hit die (10 hit points at 1st, 7 more a level)", () => {
    expect(makeTemplate("fiend-warlock", 5).proficientSaves).toEqual(["wis", "cha"]);
    expect(makeTemplate("fiend-warlock", 1).maxHp).toBe(10);
    expect(makeTemplate("fiend-warlock", 20).maxHp).toBe(10 + 19 * 7);
  });

  it("Pact Magic: 1 slot at 1st, 2 from 2nd, 3 from 11th, 4 from 17th — back on a SHORT rest — all of one level: 1st, 2nd (3rd), 3rd (5th), 4th (7th), 5th (9th)", () => {
    const slots = [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4];
    slots.forEach((n, i) => expect(makeTemplate("fiend-warlock", i + 1).resources.pactSlot, `level ${i + 1}`).toEqual({ max: n, recharge: "shortRest" }));
    const levels = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    levels.forEach((n, i) => expect(pactSlotLevel(i + 1)).toBe(n));
  });

  it("spells known are 2 at 1st rising to 15 at 19th", () => {
    const known = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15];
    known.forEach((n, i) => expect(preparedCount("warlock", "warlock", i + 1, 4), `level ${i + 1}`).toBe(n));
  });

  it("Mystic Arcanum: a 6th-level spell at 11th, a 7th at 13th, an 8th at 15th, a 9th at 17th, once each per long rest", () => {
    const has = (level: number, n: number) => makeTemplate("fiend-warlock", level).resources[`arcanum${n}`];
    expect(has(10, 6)).toBeUndefined();
    expect(has(11, 6)).toEqual({ max: 1, recharge: "longRest" });
    expect(has(12, 7)).toBeUndefined();
    expect(has(13, 7)).toEqual({ max: 1, recharge: "longRest" });
    expect(has(14, 8)).toBeUndefined();
    expect(has(15, 8)).toEqual({ max: 1, recharge: "longRest" });
    expect(has(16, 9)).toBeUndefined();
    expect(has(17, 9)).toEqual({ max: 1, recharge: "longRest" });
    // ...and the spells are on the sheet, castable from the arcanum and nothing else
    const c = makeTemplate("fiend-warlock", 17);
    for (const n of [6, 7, 8, 9]) expect(c.actions.some((a) => a.limitedUse?.resource === `arcanum${n}`), `arcanum ${n}`).toBe(true);
  });

  it("a pact slot comes back on a short rest, an arcanum only on a long one", () => {
    const w = wlk("fiend-warlock", 13);
    w.resources.set("pactSlot", 0);
    w.resources.set("arcanum6", 0);
    applyRest([w], "short", new Map([[w.id, 13]]), 13);
    expect(res(w, "pactSlot")).toBe(2 + 1);
    expect(res(w, "arcanum6")).toBe(0);
    applyRest([w], "long", new Map([[w.id, 13]]), 13);
    expect(res(w, "arcanum6")).toBe(1);
  });

  it("cantrips: 2 at 1st, 3 at 4th, 4 at 10th (Eldritch Blast is one of them) — the catalog only has three warlock cantrips with automation, so the fourth isn't filled", () => {
    const cantrips = (level: number) => makeTemplate("fiend-warlock-blade", level).actions.filter((a) => a.isSpell && a.spellLevel === 0).length;
    expect(cantrips(1)).toBe(2);
    expect(cantrips(3)).toBe(2);
    expect(cantrips(4)).toBe(3);
    expect(cantrips(9)).toBe(3);
    expect(cantrips(10)).toBe(3);
  });

  it("Eldritch Blast: one beam, two from 5th, three from 11th, four from 17th; Agonizing Blast (from 2nd) adds Charisma to each", () => {
    const blast = (level: number) => makeTemplate("fiend-warlock", level).actions.find((a) => a.id === "attack")!;
    expect([1, 4, 5, 10, 11, 16, 17, 20].map((l) => attackNodes(blast(l)))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(JSON.stringify(blast(1).automation)).toContain('"amount":"1d10"');
    expect(JSON.stringify(blast(2).automation)).toContain('"amount":"1d10+4"');
    expect(JSON.stringify(blast(17).automation)).toContain('"amount":"1d10+5"');
  });

  it("armor: studded leather (AC 14), Mage Armor from Armor of Shadows (15); the Hexblade wears scale mail and a shield (18)", () => {
    expect(makeTemplate("fiend-warlock", 1).ac).toBe(14);
    expect(makeTemplate("fiend-warlock", 2).ac).toBe(15);
    expect(makeTemplate("hexblade-warlock", 1).ac).toBe(18);
    expect(makeTemplate("fiend-warlock-blade", 2).ac).toBe(15); // no pact boon yet: the same Eldritch Blast caster as any other
    expect(makeTemplate("fiend-warlock-blade", 3).ac).toBe(14); // a Blade build takes Armor of Shadows later...
    expect(makeTemplate("fiend-warlock-blade", 8).ac).toBe(14);
    expect(makeTemplate("fiend-warlock-blade", 9).ac).toBe(15); // ...once its first four are chosen (Armor of Shadows is the fifth)
  });
});

describe("Hex, Armor of Agathys and Hellish Rebuke", () => {
  it("Hex: a bonus action, 90 feet, 1d6 NECROTIC (not force) whenever the caster hits the cursed creature", () => {
    expect(SPELLS_BY_ID.hex.castTime).toBe("bonus");
    expect(JSON.stringify(SPELLS_BY_ID.hex.build!({ slotLevel: 1, casterLevel: 5, spellMod: 4, pb: 3, dc: 15, toHit: 7 }))).toContain('"damageType":"necrotic"');
  });

  it("only the warlock cashes in the curse, and only against the cursed creature", () => {
    const w = wlk("fiend-warlock", 5);
    const a = foe("a");
    const b = foe("b");
    const ally = fighter();
    const s = state();
    put(s, w, a, b, ally);
    w.zone = a.zone = b.zone = ally.zone = "melee";
    cast(s, w, "cast-hex");
    const cursed = [a, b].find((f) => hasEffect(f, "hex"))!;
    const other = cursed === a ? b : a;
    swing(s, w, cursed, 99, "5");
    expect(lost(cursed)).toBe(5 + 6);
    swing(s, w, other, 99, "5");
    expect(lost(other)).toBe(5);
    swing(s, ally, cursed, 99, "5");
    expect(lost(cursed)).toBe(5 + 6 + 5); // an ally's blow carries no curse
    expect(res(w, "pactSlot")).toBe(1);
  });

  it("when the cursed creature dies a bonus action moves the curse to another — no new slot — and not while it still lives", () => {
    const w = wlk("fiend-warlock", 5);
    const a = foe("a");
    const b = foe("b");
    const s = state();
    put(s, w, a, b);
    w.zone = a.zone = b.zone = "melee";
    cast(s, w, "cast-hex");
    const cursed = [a, b].find((f) => hasEffect(f, "hex"))!;
    const other = cursed === a ? b : a;
    expect(actionAvailable(s, w, action(w, "hex-move"))).toBe(false);
    cursed.hp = 1;
    swing(s, w, cursed, 99, "20");
    expect(cursed.alive).toBe(false);
    expect(actionAvailable(s, w, action(w, "hex-move"))).toBe(true);
    const slots = res(w, "pactSlot");
    act(s, w, "hex-move");
    expect(hasEffect(other, "hex")).toBe(true);
    expect(res(w, "pactSlot")).toBe(slots);
    expect(actionAvailable(s, w, action(w, "hex-move"))).toBe(false);
  });

  it("a Hex is not recast every turn: only with nothing else held in concentration and no creature already cursed", () => {
    const w = wlk("fiend-warlock", 5);
    const a = foe("a");
    const s = state();
    put(s, w, a);
    expect(actionAvailable(s, w, action(w, "cast-hex"))).toBe(true);
    cast(s, w, "cast-hex");
    expect(actionAvailable(s, w, action(w, "cast-hex"))).toBe(false);
  });

  it("Armor of Agathys: 5 temporary hit points a slot level, and a melee attacker takes 5 cold a slot level while they last", () => {
    const w = wlk("fiend-warlock", 5); // pact slots are 3rd level
    const a = foe("a");
    const { s } = arena(15, w, a);
    w.reactionUsed = true; // (no Hellish Rebuke this time)
    cast(s, w, "cast-armor-of-agathys");
    expect(w.tempHp).toBe(15);
    swing(s, a, w, 99, "5");
    expect(lost(a)).toBe(15);
    expect(w.tempHp).toBe(10);
    // a ranged attack doesn't burn
    a.zone = "ranged";
    swing(s, a, w, 99, "5");
    expect(lost(a)).toBe(15);
  });

  it("...the blow that strips the last temporary hit points still burns; the next one doesn't", () => {
    const w = wlk("fiend-warlock", 5);
    const a = foe("a");
    const { s } = arena(15, w, a);
    w.reactionUsed = true;
    cast(s, w, "cast-armor-of-agathys");
    swing(s, a, w, 99, "40");
    expect(w.tempHp).toBe(0);
    expect(lost(a)).toBe(15);
    swing(s, a, w, 99, "5");
    expect(lost(a)).toBe(15);
  });

  it("Hellish Rebuke: a reaction — 2d10 fire (Dexterity save for half), a die more a slot level above 1st", () => {
    const w = wlk("fiend-warlock", 5);
    const a = foe("a");
    const { s } = arena(15, w, a);
    swing(s, a, w, 99, "5");
    expect(lost(a)).toBe(40); // the 3rd-level slot: 2d10 and a die a level above the first, so 4d10 (rigged 40), and the foe fails its Dexterity save
    expect(w.reactionUsed).toBe(true);
  });
});

describe("Eldritch Invocations", () => {
  it("the Warlock table gives 2 at 2nd, 3 at 5th, 4 at 7th, 5 at 9th, 6 at 12th, 7 at 15th, 8 at 18th", () => {
    // observable through the Tome build's list, in the order it takes them: Agonizing Blast, Armor of Shadows, Repelling Blast, Maddening Hex, Eldritch Mind, Lance of Lethargy, Fiendish Vigor, Mire the Mind
    const seen = (level: number) => {
      const c = makeTemplate("fiend-warlock", level);
      const blast = JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation);
      return [
        /"1d10\+[45]"/.test(blast),
        c.ac === 15,
        blast.includes('"kind":"push"'),
        c.actions.some((a) => a.id === "maddening-hex"),
        c.specialRules.some((r) => r.rule === "concentrationAdvantage"),
        blast.includes("lance-of-lethargy"),
        c.traits.some((t) => t.id === "fiendish-vigor"),
        c.actions.some((a) => a.id === "cast-slow-mire-the-mind"),
      ].filter(Boolean).length;
    };
    expect([1, 2, 4, 5, 7, 9, 12, 15, 18].map(seen)).toEqual([0, 2, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("Fiendish Vigor: false life at will, as a 1st-level spell — 1d4 + 4 temporary hit points at the start of a fight", () => {
    const w = wlk("fiend-warlock", 15);
    const s = state();
    put(s, w, foe("f"));
    fireEncounterStartTraits(s);
    expect(w.tempHp).toBe(8);
  });

  it("Eldritch Mind: advantage on the Constitution saves that hold a concentration spell", () => {
    const modes: string[] = [];
    const w = wlk("fiend-warlock", 9);
    const a = foe("a");
    const s = state(15, modes);
    put(s, w, a);
    w.concentratingOn = "cast-hex";
    applyDamage(s, w, 10, "slashing", { sourceId: a.id });
    expect(modes).toContain("adv");
  });

  it("Maddening Hex: a bonus action for Charisma psychic damage to the cursed creature — only while something is cursed", () => {
    const w = wlk("fiend-warlock", 7);
    const a = foe("a");
    const { s } = arena(15, w, a);
    expect(actionAvailable(s, w, action(w, "maddening-hex"))).toBe(false);
    cast(s, w, "cast-hex");
    expect(actionAvailable(s, w, action(w, "maddening-hex"))).toBe(true);
    const before = lost(a);
    act(s, w, "maddening-hex");
    expect(lost(a) - before).toBe(4);
  });

  it("Mire the Mind and its kin: the spell once a long rest, using a pact slot — and never twice", () => {
    const w = wlk("fiend-warlock", 18);
    const a = foe("a");
    const { s } = arena(1, w, a);
    const slow = action(w, "cast-slow-mire-the-mind");
    expect(actionAvailable(s, w, slow)).toBe(true);
    const slots = res(w, "pactSlot");
    cast(s, w, "cast-slow-mire-the-mind");
    expect(res(w, "pactSlot")).toBe(slots - 1);
    expect(hasEffect(a, "slow")).toBe(true);
    expect(actionAvailable(s, w, slow)).toBe(false);
  });

  it("Pact of the Blade: a pact weapon — Improved Pact Weapon +1, Thirsting Blade two attacks (5th), Eldritch Smite, Lifedrinker (12th)", () => {
    const weapon = (level: number) => makeTemplate("fiend-warlock-blade", level).actions.find((a) => a.id === "attack")!;
    expect(attackNodes(weapon(4))).toBe(1);
    expect(attackNodes(weapon(5))).toBe(2);
    expect(makeTemplate("fiend-warlock-blade", 2).actions.some((a) => a.id === "attack" && a.name.startsWith("Pact"))).toBe(false); // the boon comes at the 3rd level
    // a rapier and Dexterity, +1 from Improved Pact Weapon: pb 2 + 2 + 1 to hit, 1d8 + 2 + 1 damage
    expect(JSON.stringify(weapon(3).automation)).toContain('"bonus":5');
    expect(JSON.stringify(weapon(3).automation)).toContain('"amount":"1d8+3"');
    expect(JSON.stringify(weapon(17).automation)).not.toContain("necrotic");
    expect(JSON.stringify(weapon(18).automation)).toContain('"amount":"5","damageType":"necrotic"'); // Charisma modifier (5 at 20) extra necrotic on each hit — the eighth invocation
  });

  it("Eldritch Smite (5th, Blade): a pact-weapon hit spends a slot for 1d8 + 1d8 a slot level of force damage and knocks a Huge or smaller creature prone", () => {
    const w = wlk("fiend-warlock-blade", 7); // 4th-level slots
    const a = foe("a");
    const { s } = arena(15, w, a);
    const slots = res(w, "pactSlot");
    cast(s, w, "attack-eldritch-smite");
    expect(res(w, "pactSlot")).toBe(slots - 1);
    expect(hasCond(a, "prone")).toBe(true);
    // two swings (Thirsting Blade is 5th): 2 x (1d8 + Dex 2 + 1) at their maximum, and 5d8 of force once
    expect(lost(a)).toBe(2 * (8 + 3) + 5 * 8);
  });
});

describe("The Archfey", () => {
  it("Fey Presence (1st): creatures near the warlock make a Wisdom save or are charmed — once a short rest", () => {
    const w = wlk("archfey-warlock", 5);
    const a = foe("a");
    const b = foe("b");
    const s = state(1);
    put(s, w, a, b);
    cast(s, w, "fey-presence");
    expect([hasCond(a, "charmed"), hasCond(b, "charmed")]).toEqual([true, true]);
    expect(actionAvailable(s, w, action(w, "fey-presence"))).toBe(false);
    const strong = foe("s", undefined, { wis: 5 });
    const w2 = wlk("archfey-warlock", 5, "-w2");
    const s2 = state(20);
    put(s2, w2, strong);
    cast(s2, w2, "fey-presence");
    expect(hasCond(strong, "charmed")).toBe(false);
  });

  it("Misty Escape (6th): hurt, a reaction turns the warlock invisible and moves them away — once a short rest", () => {
    const w = wlk("archfey-warlock", 6);
    const a = foe("a");
    const { s } = arena(15, w, a);
    swing(s, a, w, 99, "5");
    expect(hasCond(w, "invisible")).toBe(true);
    expect(w.zone).toBe("ranged");
    expect(res(w, "misty_escape")).toBe(0);
    expect(makeTemplate("archfey-warlock", 5).reactions.some((r) => r.id === "misty-escape")).toBe(false);
  });

  it("Beguiling Defenses (10th): immune to being charmed", () => {
    expect(makeTemplate("archfey-warlock", 9).conditionImmunities).not.toContain("charmed");
    expect(makeTemplate("archfey-warlock", 10).conditionImmunities).toContain("charmed");
  });

  it("Beguiling Defenses: a reaction can turn a charm attempt back on whoever tried it — a failed Wisdom save charms them instead", () => {
    const w = wlk("archfey-warlock", 10);
    const a = foe("a");
    const s = state(1); // the reflected save always fails
    put(s, w, a);
    runAutomation([{ type: "applyCondition", condition: "charmed", durationRounds: 10 }], { state: s, source: a, scope: [w], last: {}, depth: 0 });
    expect(hasCond(w, "charmed")).toBe(false); // the warlock's own immunity holds either way
    expect(hasCond(a, "charmed")).toBe(true); // turned back on the caster
    expect(w.reactionUsed).toBe(true);
  });

  it("...a successful save just shrugs it off, and it never triggers below 10th level", () => {
    const w = wlk("archfey-warlock", 10);
    const a = foe("a");
    const s = state(20); // the reflected save always succeeds
    put(s, w, a);
    runAutomation([{ type: "applyCondition", condition: "charmed", durationRounds: 10 }], { state: s, source: a, scope: [w], last: {}, depth: 0 });
    expect(hasCond(w, "charmed")).toBe(false);
    expect(hasCond(a, "charmed")).toBe(false);
    expect(w.reactionUsed).toBe(true);
    const w9 = wlk("archfey-warlock", 9, "-w9");
    const a9 = foe("a9");
    const s9 = state(1);
    put(s9, w9, a9);
    runAutomation([{ type: "applyCondition", condition: "charmed", durationRounds: 10 }], { state: s9, source: a9, scope: [w9], last: {}, depth: 0 });
    expect(hasCond(w9, "charmed")).toBe(true); // no immunity, and no reaction, below 10th
  });

  it("Dark Delirium (14th): a creature that fails a Wisdom save is lost in the illusion until it takes damage, and the warlock concentrates", () => {
    const w = wlk("archfey-warlock", 14);
    const a = foe("a");
    const { s } = arena(1, w, a);
    cast(s, w, "dark-delirium");
    expect(hasCond(a, "turned")).toBe(true);
    expect(w.concentratingOn).toBe("dark-delirium");
    s.rng.d20mode = () => ({ used: 15, nat: 15 });
    swing(s, w, a);
    expect(hasCond(a, "turned")).toBe(false);
  });
});

describe("The Celestial", () => {
  it("Healing Light (1st): a pool of 1 + the warlock level d6s, up to the Charisma modifier at a time, as a bonus action — only worth it once someone is hurt", () => {
    const w = wlk("celestial-warlock", 5);
    const ally = fighter();
    const s = state();
    put(s, w, ally);
    expect(w.resources.get("healing_light")).toBe(6);
    expect(actionAvailable(s, w, action(w, "healing-light"))).toBe(false);
    ally.hp = 1;
    expect(actionAvailable(s, w, action(w, "healing-light"))).toBe(true);
    cast(s, w, "healing-light");
    expect(ally.hp - 1).toBe(4 * 6);
    expect(res(w, "healing_light")).toBe(2);
  });

  it("Radiant Soul (6th): resistance to radiant, and the Charisma modifier added to one radiant or fire damage roll of a spell", () => {
    expect(makeTemplate("celestial-warlock", 5).resistances).not.toContain("radiant");
    expect(makeTemplate("celestial-warlock", 6).resistances).toContain("radiant");
    const bonus = (level: number) => {
      const c = makeTemplate("celestial-warlock", level);
      const fire = c.actions.find((a) => a.isSpell && (a.spellLevel ?? 0) > 0 && /"damageType":"(fire|radiant)"/.test(JSON.stringify(a.automation)));
      return fire ? (JSON.stringify(fire.automation).match(/"amount":"[^"]*\+4"/g) ?? []).length : -1;
    };
    expect(bonus(5)).toBe(0);
    expect(bonus(6)).toBe(1);
  });

  it("Celestial Resilience (10th): after a rest, temporary hit points — warlock level + Charisma for the warlock, half the level + Charisma for up to five allies", () => {
    const w = wlk("celestial-warlock", 10);
    const allies = [1, 2, 3, 4, 5, 6].map((n) => fighter(6, `-a${n}`));
    const s = state();
    put(s, w, ...allies, foe("f"));
    fireEncounterStartTraits(s);
    expect(w.tempHp).toBe(10 + 4);
    expect(allies.filter((a) => a.tempHp === 5 + 4)).toHaveLength(5);
    fireEncounterStartTraits(s);
    expect(w.tempHp).toBe(14); // once a rest
  });

  it("Searing Vengeance (14th): at the start of a death-save turn, spring up with half the maximum hit points and sear the foes within 30 feet (2d8 + Charisma radiant, blinded)", () => {
    const w = wlk("celestial-warlock", 14);
    const a = foe("a");
    const { s } = arena(15, w, a);
    w.hp = 0;
    w.downed = true;
    expect(rollDeathSave(s, w)).toBe(true);
    expect(w.downed).toBe(false);
    expect(w.hp).toBe(Math.floor(w.maxHp / 2));
    expect(lost(a)).toBe(16 + 4);
    expect(hasCond(a, "blinded")).toBe(true);
    w.hp = 0;
    w.downed = true;
    expect(rollDeathSave(s, w)).toBe(false); // once a long rest
  });
});

describe("The Fathomless", () => {
  it("Tentacle of the Deeps (1st): a bonus action, proficiency-bonus times a day — 1d8 cold on a melee spell attack (2d8 from 10th), and a bonus action each turn to strike again", () => {
    const w = wlk("fathomless-warlock", 5);
    const a = foe("a");
    const { s } = arena(15, w, a);
    expect(w.resources.get("tentacle_of_the_deeps")).toBe(3);
    cast(s, w, "tentacle-of-the-deeps");
    expect(hasEffect(w, "tentacle")).toBe(true);
    expect(lost(a)).toBe(8);
    expect(actionAvailable(s, w, action(w, "tentacle-of-the-deeps"))).toBe(false); // already out
    act(s, w, "tentacle-strike");
    expect(lost(a)).toBe(16);
    const w10 = wlk("fathomless-warlock", 10, "-w10");
    const a10 = foe("b");
    const { s: s10 } = arena(15, w10, a10);
    cast(s10, w10, "tentacle-of-the-deeps");
    expect(lost(a10)).toBe(16);
  });

  it("Oceanic Soul (6th): resistance to cold damage", () => {
    expect(makeTemplate("fathomless-warlock", 5).resistances).not.toContain("cold");
    expect(makeTemplate("fathomless-warlock", 6).resistances).toContain("cold");
  });

  it("Guardian Coil (6th): a reaction to shave 1d8 (2d8 from 10th) off damage to a creature near the tentacle — only while it is out", () => {
    const reduced = (level: number, tentacle: boolean) => {
      const w = wlk("fathomless-warlock", level);
      const ally = fighter(level);
      const a = foe("a");
      const s = state();
      put(s, w, ally, a);
      w.zone = ally.zone = a.zone = "melee";
      if (tentacle) w.effects.push({ name: "tentacle", expiresRound: 99, sourceId: w.id });
      swing(s, a, ally, 99, "30");
      return lost(ally);
    };
    expect(reduced(6, false)).toBe(30);
    expect(reduced(6, true)).toBe(30 - 8);
    expect(reduced(10, true)).toBe(30 - 16);
  });

  it("Grasping Tentacles (10th): Evard's Black Tentacles once a long rest with no slot, temporary hit points equal to the warlock level, and concentration that damage can't break", () => {
    const w = wlk("fathomless-warlock", 10);
    const a = foe("a");
    const { s } = arena(1, w, a);
    const slots = res(w, "pactSlot");
    cast(s, w, "grasping-tentacles");
    expect(res(w, "pactSlot")).toBe(slots);
    expect(w.tempHp).toBe(10);
    expect(w.concentratingOn).toBe("grasping-tentacles");
    applyDamage(s, w, 60, "slashing", { sourceId: a.id });
    expect(w.concentratingOn).toBe("grasping-tentacles");
    expect(actionAvailable(s, w, action(w, "grasping-tentacles"))).toBe(false);
  });
});

describe("The Fiend", () => {
  it("Dark One's Blessing (1st): killing a hostile creature gives temporary hit points equal to the Charisma modifier + warlock level", () => {
    const w = wlk("fiend-warlock", 5);
    const a = foe("a");
    a.hp = 1;
    const { s } = arena(15, w, a);
    swing(s, w, a, 99, "9");
    expect(a.alive).toBe(false);
    expect(w.tempHp).toBe(4 + 5);
  });

  it("Dark One's Own Luck (6th): a d10 added to a save that would fail, once a short rest", () => {
    const w = wlk("fiend-warlock", 6);
    const s = state(11); // 11 + 3 = 14 against DC 16: fails by 2
    put(s, w);
    expect(rollSave(s, w, "wis", 16).passed).toBe(true);
    expect(res(w, "dark_ones_own_luck")).toBe(0);
    expect(rollSave(s, w, "wis", 16).passed).toBe(false);
    expect(makeTemplate("fiend-warlock", 5).resources.dark_ones_own_luck).toBeUndefined();
  });

  it("Fiendish Resilience (10th): resistance to a chosen damage type", () => {
    expect(makeTemplate("fiend-warlock", 9).resistances).not.toContain("fire");
    expect(makeTemplate("fiend-warlock", 10).resistances).toContain("fire");
  });

  it("Hurl Through Hell (14th): a hit sends the creature away — 10d10 psychic damage unless it is a fiend — once a long rest", () => {
    const hurl = (type: CreatureType) => {
      const w = wlk("fiend-warlock", 14);
      const a = foe("a", type);
      const { s } = arena(15, w, a);
      cast(s, w, "attack-hurl-through-hell");
      return { lost: lost(a), incapacitated: hasCond(a, "incapacitated"), left: res(w, "hurl_through_hell") };
    };
    const human = hurl("humanoid");
    expect(human.lost).toBeGreaterThanOrEqual(100);
    expect(human.incapacitated).toBe(true);
    expect(human.left).toBe(0);
    const devil = hurl("fiend");
    expect(devil.lost).toBeLessThan(100);
    expect(devil.incapacitated).toBe(true);
  });
});

describe("The Great Old One", () => {
  it("Entropic Ward (6th): a reaction gives an attack against the warlock disadvantage, and if it misses the warlock's next attack against that creature has advantage", () => {
    const modes: string[] = [];
    const w = wlk("great-old-one-warlock", 6);
    const a = foe("a");
    const s = state(15, modes);
    put(s, w, a);
    w.zone = a.zone = "melee";
    swing(s, a, w, -50, "5"); // a miss
    expect(modes).toContain("dis");
    expect(hasEffect(a, "entropic-ward")).toBe(true);
    expect(res(w, "entropic_ward")).toBe(0);
    modes.length = 0;
    swing(s, w, a, 99, "5");
    expect(modes).toContain("adv");
    expect(hasEffect(a, "entropic-ward")).toBe(false); // spent
    modes.length = 0;
    swing(s, w, a, 99, "5");
    expect(modes).not.toContain("adv");
  });

  it("Entropic Ward: a hit doesn't grant the advantage", () => {
    const w = wlk("great-old-one-warlock", 6);
    const a = foe("a");
    const { s } = arena(15, w, a);
    swing(s, a, w, 99, "5");
    expect(hasEffect(a, "entropic-ward")).toBe(false);
  });

  it("Thought Shield (10th): resistance to psychic damage, and whoever deals it takes the same amount", () => {
    const w = wlk("great-old-one-warlock", 10);
    const a = foe("a");
    const { s } = arena(15, w, a);
    w.reactionUsed = true;
    applyDamage(s, w, 20, "psychic", { sourceId: a.id });
    expect(lost(w)).toBe(10);
    expect(lost(a)).toBe(10);
    expect(makeTemplate("great-old-one-warlock", 9).resistances).not.toContain("psychic");
  });

  it("Create Thrall (14th): an incapacitated humanoid is charmed — taken over — and nothing else can be", () => {
    const w = wlk("great-old-one-warlock", 14);
    const man = foe("m", "humanoid");
    const beast = foe("b", "beast");
    const s = state();
    put(s, w, man, beast);
    expect(actionAvailable(s, w, action(w, "create-thrall"))).toBe(false);
    beast.conditions.set("incapacitated", { expiresRound: 99 } as never);
    expect(actionAvailable(s, w, action(w, "create-thrall"))).toBe(false); // not a humanoid
    man.conditions.set("incapacitated", { expiresRound: 99 } as never);
    expect(actionAvailable(s, w, action(w, "create-thrall"))).toBe(true);
    act(s, w, "create-thrall");
    expect(man.side).toBe("party");
    expect(beast.side).toBe("monster");
  });
});

describe("The Hexblade", () => {
  it("Hex Warrior: Charisma for the pact weapon's attack and damage — a longsword, armor class 18", () => {
    const c = makeTemplate("hexblade-warlock", 5);
    expect(c.ac).toBe(18);
    const swings = JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation);
    expect(swings).toContain('"bonus":8'); // 3 + Charisma 4, and Improved Pact Weapon's +1
    expect(swings).toContain('"1d8+5"'); // Charisma 4 + 1
  });

  it("Hexblade's Curse (1st): a bonus action — the proficiency bonus added to each damage roll against the cursed creature, and a critical hit on a 19 or 20", () => {
    const w = wlk("hexblade-warlock", 5);
    const a = foe("a");
    const other = foe("o");
    const s = state(19);
    put(s, w, a, other);
    w.zone = a.zone = other.zone = "melee";
    swing(s, w, a, 99, "2d6");
    expect(lost(a)).toBe(12); // a 19 is only a hit
    cast(s, w, "hexblades-curse");
    const cursed = [a, other].find((f) => hasEffect(f, "hexblades-curse"))!;
    const before = lost(cursed);
    swing(s, w, cursed, 99, "2d6");
    expect(lost(cursed) - before).toBe(12 * 2 + 3 - 0); // the dice doubled by the critical hit, plus 3
  });

  it("...and only the cursed creature; not more than once a short rest", () => {
    const w = wlk("hexblade-warlock", 5);
    const a = foe("a");
    const other = foe("o");
    const s = state(19);
    put(s, w, a, other);
    w.zone = a.zone = other.zone = "melee";
    cast(s, w, "hexblades-curse");
    const cursed = [a, other].find((f) => hasEffect(f, "hexblades-curse"))!;
    const spared = cursed === a ? other : a;
    swing(s, w, spared, 99, "2d6");
    expect(lost(spared)).toBe(12);
    expect(actionAvailable(s, w, action(w, "hexblades-curse"))).toBe(false);
  });

  it("the cursed creature's death heals the warlock — the warlock level + Charisma modifier", () => {
    const w = wlk("hexblade-warlock", 5);
    const a = foe("a");
    const { s } = arena(15, w, a);
    cast(s, w, "hexblades-curse");
    w.hp -= 30;
    a.hp = 1;
    swing(s, w, a, 99, "5");
    expect(a.alive).toBe(false);
    expect(lost(w)).toBe(30 - (5 + 4));
  });

  it("Master of Hexes (14th): the curse jumps to another creature instead, with no healing", () => {
    const w = wlk("hexblade-warlock", 14);
    const a = foe("a");
    const b = foe("b");
    const s = state();
    put(s, w, a, b);
    w.zone = a.zone = b.zone = "melee";
    cast(s, w, "hexblades-curse");
    const cursed = [a, b].find((f) => hasEffect(f, "hexblades-curse"))!;
    const next = cursed === a ? b : a;
    w.hp -= 30;
    cursed.hp = 1;
    swing(s, w, cursed, 99, "5");
    expect(cursed.alive).toBe(false);
    expect(hasEffect(next, "hexblades-curse")).toBe(true);
    expect(lost(w)).toBe(30);
  });

  it("Accursed Specter (6th): slaying a humanoid raises its spirit as a specter — half the warlock level in temporary hit points, the Charisma modifier added to its attacks — once a long rest", () => {
    const w = wlk("hexblade-warlock", 6);
    const man = foe("m", "humanoid");
    const beast = foe("b", "beast");
    const other = foe("o", "humanoid");
    const { s } = arena(15, w, man);
    put(s, beast, other);
    beast.hp = 1;
    swing(s, w, beast, 99, "9");
    expect([...s.units.values()].some((u) => u.summonerId === w.id)).toBe(false); // "When you slay a humanoid"
    man.hp = 1;
    swing(s, w, man, 99, "9");
    const specter = [...s.units.values()].find((u) => u.summonerId === w.id)!;
    expect(specter).toBeDefined();
    expect(specter.ref.creatureType).toBe("undead");
    expect(specter.maxHp).toBe(22);
    expect(specter.tempHp).toBe(3);
    expect(specter.ref.ac).toBe(12);
    expect(JSON.stringify(specter.ref.actions.find((a) => a.id === "attack")!.automation)).toContain('"bonus":8'); // +4 and Charisma 4
    expect(res(w, "accursed_specter")).toBe(0);
    other.hp = 1;
    swing(s, w, other, 99, "9");
    expect([...s.units.values()].filter((u) => u.summonerId === w.id)).toHaveLength(1); // once a long rest
    expect(makeTemplate("hexblade-warlock", 5).traits.some((t) => t.id === "accursed-specter")).toBe(false);
  });

  it("Armor of Hexes (10th): the cursed creature hits the warlock — a reaction, a d6, and a 4 or higher turns it into a miss", () => {
    const w = wlk("hexblade-warlock", 10);
    const a = foe("a");
    const { s } = arena(15, w, a);
    cast(s, w, "hexblades-curse");
    swing(s, a, w, 99, "20");
    expect(lost(w)).toBe(0); // the d6 came up 6
    expect(w.reactionUsed).toBe(true);
    const w2 = wlk("hexblade-warlock", 10, "-w2");
    const a2 = foe("b");
    const { s: s2 } = arena(15, w2, a2);
    s2.rng.dice = () => 3;
    cast(s2, w2, "hexblades-curse");
    swing(s2, a2, w2, 99, "20");
    expect(lost(w2)).toBe(20); // a 3 isn't enough
    expect(makeTemplate("hexblade-warlock", 9).reactions.some((r) => r.id === "armor-of-hexes")).toBe(false);
  });
});

describe("The Undead", () => {
  it("Form of Dread (1st): a bonus action, proficiency-bonus times a day — 1d10 + the warlock level temporary hit points, and immunity to being frightened", () => {
    const w = wlk("undead-warlock", 5);
    const s = state();
    put(s, w, foe("f"));
    expect(w.resources.get("form_of_dread")).toBe(3);
    cast(s, w, "form-of-dread");
    expect(w.tempHp).toBe(10 + 5);
    runAutomation([{ type: "applyCondition", condition: "frightened", durationRounds: 2 }], { state: s, source: foe("g"), scope: [w], last: {}, depth: 0 });
    expect(hasCond(w, "frightened")).toBe(false);
    expect(actionAvailable(s, w, action(w, "form-of-dread"))).toBe(false); // already in it
  });

  it("...and in the form a hit makes the creature save against fear (Wisdom) — never outside it", () => {
    const w = wlk("undead-warlock", 5);
    const a = foe("a");
    const { s } = arena(5, w, a); // 5 + 6 hits armor class 8; 5 - 4 fails a Wisdom save against 15
    act(s, w, "attack");
    expect(hasCond(a, "frightened")).toBe(false);
    cast(s, w, "form-of-dread");
    act(s, w, "attack");
    expect(hasCond(a, "frightened")).toBe(true);
  });

  it("Grave Touched (6th): in the form, one extra damage die of necrotic damage once a turn", () => {
    const dealt = (level: number, inForm: boolean) => {
      const w = wlk("undead-warlock", level);
      const a = foe("a");
      const { s } = arena(15, w, a);
      if (inForm) cast(s, w, "form-of-dread");
      act(s, w, "attack");
      return lost(a);
    };
    expect(dealt(6, true) - dealt(6, false)).toBe(10);
    expect(dealt(5, true) - dealt(5, false)).toBe(0);
  });

  it("Grave Touched (6th): a hit's damage can become necrotic to beat a resistance — once a turn, and not gated on Form of Dread", () => {
    const resistantToForce = (level: number) => {
      const w = wlk("undead-warlock", level);
      const a = foe("a", undefined, {}, { resistances: ["force"] });
      const { s } = arena(15, w, a);
      act(s, w, "attack"); // Eldritch Blast — two beams from 5th, force damage
      return lost(a);
    };
    expect(resistantToForce(5)).toBe(2 * 7); // no Grave Touched yet: both beams resisted (1d10+4 = 14, halved to 7)
    expect(resistantToForce(6)).toBe(14 + 7); // the first beam becomes necrotic (full 14), the second stays force (resisted) — once a turn
  });

  it("Necrotic Husk (10th): dropped to 0 hit points a reaction leaves the warlock at 1 and burns every foe within 30 feet — 2d10 + the level, no save — once", () => {
    const w = wlk("undead-warlock", 10);
    const a = foe("a");
    const b = foe("b");
    const { s } = arena(15, w, a);
    put(s, b);
    applyDamage(s, w, 500, "slashing", { sourceId: a.id });
    expect(w.hp).toBe(1);
    expect(w.downed).toBe(false);
    expect(lost(a)).toBe(20 + 10);
    expect(lost(b)).toBe(30);
    w.reactionUsed = false;
    applyDamage(s, w, 500, "slashing", { sourceId: a.id });
    expect(w.hp).toBeLessThanOrEqual(0);
    expect(makeTemplate("undead-warlock", 9).resistances).not.toContain("necrotic");
    expect(makeTemplate("undead-warlock", 10).resistances).toContain("necrotic");
  });
});

describe("The Undying", () => {
  it("Among the Dead (1st): an undead creature that attacks the warlock makes a Wisdom save or its attack comes to nothing — and only undead", () => {
    const w = wlk("undying-warlock", 5);
    w.reactionUsed = true; // (no Hellish Rebuke)
    const zombie = foe("z", "undead");
    const { s } = arena(5, w, zombie); // the attack would hit; the Wisdom save (5 - 4 against 15) fails
    swing(s, zombie, w, 99, "20");
    expect(lost(w)).toBe(0);
    const w2 = wlk("undying-warlock", 5, "-w2");
    w2.reactionUsed = true;
    const orc = foe("o", "humanoid");
    const { s: s2 } = arena(5, w2, orc);
    swing(s2, orc, w2, 99, "20");
    expect(lost(w2)).toBe(20);
  });

  it("Among the Dead also covers a single-target harmful SPELL, not just an attack — but not an area one", () => {
    const w = wlk("undying-warlock", 5);
    const zombie = foe("z", "undead");
    const s = state(1); // the Wisdom save always fails
    put(s, w, zombie);
    // a single-target save-based spell: forced onto exactly one scope, as a "target" node with one creature would leave it
    runAutomation(
      [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "save", ability: "wis", dc: 15, onFail: [{ type: "damage", amount: "20", damageType: "necrotic" }] }] }],
      { state: s, source: zombie, scope: [], last: {}, depth: 0, spell: true, forceScope: [w] },
    );
    expect(lost(w)).toBe(0); // no other ally to turn on: the zombie wastes the spell
    // an area spell (more than one creature caught) is explicitly exempt in the printed text
    const w2 = wlk("undying-warlock", 5, "-w2");
    const s2 = state(1);
    put(s2, w2, w, zombie);
    runAutomation(
      [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "save", ability: "wis", dc: 15, onFail: [{ type: "damage", amount: "20", damageType: "necrotic" }] }] }],
      { state: s2, source: zombie, scope: [], last: {}, depth: 0, spell: true, forceScope: [w, w2] },
    );
    expect(lost(w)).toBe(20);
    expect(lost(w2)).toBe(20);
  });

  it("...and a single-target spell ATTACK roll too (Nature's Sanctuary, which shares this engine, never covers spells — see druid-subclasses.test.ts)", () => {
    const w = wlk("undying-warlock", 5);
    const zombie = foe("z", "undead");
    const s = state(2); // a hit (bonus 99 overwhelms the target's AC) that isn't a natural 1 — that would auto-miss regardless of Among the Dead
    put(s, w, zombie);
    runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "20", damageType: "necrotic" }] }], { state: s, source: zombie, scope: [w], last: {}, depth: 0, spell: true });
    expect(lost(w)).toBe(0);
  });

  it("Spare the Dying (1st, taught for free by Among the Dead): an action that stabilizes a downed ally — no hit points restored", () => {
    const w = wlk("undying-warlock", 1);
    const ally = fighter(5, "-a");
    const s = state();
    put(s, w, ally, foe("f"));
    expect(actionAvailable(s, w, action(w, "spare-the-dying"))).toBe(false); // no one is even hurt
    ally.hp = 0;
    ally.downed = true;
    expect(actionAvailable(s, w, action(w, "spare-the-dying"))).toBe(true);
    act(s, w, "spare-the-dying");
    expect(ally.stable).toBe(true);
    expect(ally.hp).toBe(0);
    // it targets the lowest-hp ally regardless of whether they're actually downed — running it on one who isn't is simply a no-op
    ally.downed = false;
    ally.stable = false;
    ally.hp = 1;
    act(s, w, "spare-the-dying");
    expect(ally.stable).toBe(false);
  });

  it("Defy Death (6th): a successful death saving throw restores 1d8 + the Constitution modifier hit points, once a long rest", () => {
    const w = wlk("undying-warlock", 6);
    const s = state(15);
    put(s, w);
    w.hp = 0;
    w.downed = true;
    expect(rollDeathSave(s, w)).toBe(true);
    expect(w.hp).toBe(8 + 2);
    expect(w.downed).toBe(false);
    w.hp = 0;
    w.downed = true;
    expect(rollDeathSave(s, w)).toBe(false); // the second success is only a success
    expect(w.deathSaves.success).toBe(1);
  });

  it("Indestructible Life (14th): a bonus action for 1d8 + the warlock level, once a short rest — worth it when hurt", () => {
    const w = wlk("undying-warlock", 14);
    const s = state();
    put(s, w, foe("f"));
    expect(actionAvailable(s, w, action(w, "indestructible-life"))).toBe(false);
    w.hp = 10;
    expect(actionAvailable(s, w, action(w, "indestructible-life"))).toBe(true);
    cast(s, w, "indestructible-life");
    expect(w.hp).toBe(10 + 8 + 14);
  });
});

describe("The Genie", () => {
  const kinds: [string, DamageType][] = [["dao", "bludgeoning"], ["djinni", "thunder"], ["efreeti", "fire"], ["marid", "cold"]];

  it("Genie's Wrath (1st): once a turn a hit deals extra damage equal to the proficiency bonus — bludgeoning (Dao), thunder (Djinni), fire (Efreeti), cold (Marid)", () => {
    for (const [kind, type] of kinds) {
      const dealt = (immune: boolean) => {
        const w = wlk(`${kind}-genie-warlock`, 5);
        const a = foe("a", undefined, {}, immune ? { immunities: [type] } : {});
        const { s } = arena(15, w, a);
        act(s, w, "attack");
        return lost(a);
      };
      expect(dealt(false) - dealt(true), kind).toBe(3);
      expect(dealt(false), kind).toBe(2 * 14 + 3);
    }
  });

  it("Elemental Gift (6th): resistance to the kind's damage type", () => {
    for (const [kind, type] of kinds) {
      expect(makeTemplate(`${kind}-genie-warlock`, 5).resistances, kind).not.toContain(type);
      expect(makeTemplate(`${kind}-genie-warlock`, 6).resistances, kind).toContain(type);
    }
  });

  it("Elemental Gift: ...and, as a bonus action, a 30ft flying speed — proficiency-bonus times a long rest", () => {
    const w = wlk("djinni-genie-warlock", 6);
    const s = state();
    put(s, w, foe("f"));
    expect(canFly(w)).toBe(false);
    expect(res(w, "elemental_gift_fly")).toBe(3); // proficiency bonus at 6th
    cast(s, w, "elemental-gift-fly");
    expect(canFly(w)).toBe(true);
    expect(res(w, "elemental_gift_fly")).toBe(2);
    expect(actionAvailable(s, w, action(w, "elemental-gift-fly"))).toBe(false); // already flying
    expect(makeTemplate("djinni-genie-warlock", 5).actions.some((a) => a.id === "elemental-gift-fly")).toBe(false);
  });

  it("Limited Wish (14th): once every long rest, an action that casts a 6th-level-or-lower spell with a 1-action casting time and no slot (Disintegrate here)", () => {
    const w = wlk("efreeti-genie-warlock", 14);
    const a = foe("a");
    const { s } = arena(1, w, a); // the Dexterity save always fails
    const slots = res(w, "pactSlot");
    cast(s, w, "limited-wish");
    expect(res(w, "pactSlot")).toBe(slots); // no slot spent
    expect(lost(a)).toBe(100); // 10d6 (rigged to max) + 40 force damage
    expect(actionAvailable(s, w, action(w, "limited-wish"))).toBe(false);
    expect(makeTemplate("efreeti-genie-warlock", 13).actions.some((a2) => a2.id === "limited-wish")).toBe(false);
  });
});

describe("Tomb of Levistus and Cloak of Flies (invocations, 5th level — reachable on the Talisman build's 7th and 8th picks)", () => {
  it("Tomb of Levistus: a reaction to taking damage — 10 temporary hit points a warlock level, incapacitated, speed 0, vulnerable to fire until the ice melts", () => {
    // the Great Old One (unlike the Fiend or the Efreeti/Dao genies) has no fire resistance to cancel the vulnerability out
    const w = wlk("great-old-one-warlock-talisman", 15);
    const a = foe("a");
    const { s } = arena(15, w, a);
    w.resources.set("pactSlot", 0); // no Hellish Rebuke competing for the reaction
    w.resources.set("entropic_ward", 0); // ...nor Entropic Ward (it fires on the attack roll itself, before any damage lands)
    swing(s, a, w, 99, "5");
    expect(lost(w)).toBe(5); // the triggering hit itself isn't retroactively absorbed
    expect(w.tempHp).toBe(10 * 15);
    expect(hasCond(w, "incapacitated")).toBe(true);
    expect(hasEffect(w, "tomb-of-levistus")).toBe(true);
    expect(w.reactionUsed).toBe(true);
    const tempBefore = w.tempHp;
    applyDamage(s, w, 10, "fire", { sourceId: a.id });
    expect(tempBefore - w.tempHp).toBe(20); // vulnerable: doubled — 20 taken off the temporary hit points, real hp untouched
    expect(lost(w)).toBe(5);
    expect(res(w, "tomb_of_levistus")).toBe(0);
  });

  it("...once a short or long rest, and not present before 5th level on that build", () => {
    const w = wlk("fiend-warlock-talisman", 15);
    const a = foe("a");
    const { s } = arena(15, w, a);
    w.resources.set("pactSlot", 0);
    swing(s, a, w, 99, "5");
    expect(w.tempHp).toBe(150);
    w.tempHp = 0; // clear the cushion to isolate the second hit
    w.reactionUsed = false;
    const before = lost(w);
    swing(s, a, w, 99, "5"); // no charges left
    expect(lost(w) - before).toBe(5); // a plain hit — no more temp HP, no more incapacitation
    expect(w.tempHp).toBe(0);
    expect(makeTemplate("fiend-warlock-talisman", 14).reactions.some((r) => r.id === "tomb-of-levistus")).toBe(false);
  });

  it("Cloak of Flies: a bonus-action aura — any OTHER creature, ally or foe, that starts its turn beside the warlock takes Charisma-modifier poison damage", async () => {
    const { startOfTurn } = await import("../lib/sim/engine/loop");
    const w = wlk("fiend-warlock-talisman", 18);
    const a = foe("a");
    const ally = fighter(18, "-a2");
    const s = state();
    put(s, w, a, ally);
    w.zone = a.zone = ally.zone = "melee";
    expect(makeTemplate("fiend-warlock-talisman", 17).actions.some((act2) => act2.id === "cloak-of-flies")).toBe(false);
    cast(s, w, "cloak-of-flies");
    expect(hasEffect(w, "cloak-of-flies")).toBe(true);
    startOfTurn(s, a);
    expect(lost(a)).toBe(5); // Charisma modifier at 18th level (proficiency bonus +6, so Charisma 20: +5)
    startOfTurn(s, ally);
    expect(lost(ally)).toBe(5); // the text doesn't spare the warlock's own side
    startOfTurn(s, w);
    expect(lost(w)).toBe(0); // never itself
    expect(res(w, "cloak_of_flies")).toBe(0); // once a short or long rest
  });

  it("...only within 5 feet, and only while it's up", async () => {
    const { startOfTurn } = await import("../lib/sim/engine/loop");
    const w = wlk("fiend-warlock-talisman", 18);
    const far = foe("far");
    const s = state();
    put(s, w, far);
    w.zone = "melee";
    far.zone = "ranged"; // more than 5 feet away
    cast(s, w, "cloak-of-flies");
    startOfTurn(s, far);
    expect(lost(far)).toBe(0);
    far.zone = "melee";
    startOfTurn(s, far);
    expect(lost(far)).toBe(5);
  });
});

describe("Eldritch Spear (an invocation): Eldritch Blast's range becomes 300 feet, past the shared 120ft long-range-disadvantage threshold", () => {
  it("an attack node carries its own long-range threshold through the battle seam", async () => {
    const { attackModsFor } = await import("../lib/sim/battle/ai");
    const { makeGrid } = await import("../lib/sim/battle/grid");
    const rogue = fighter(5);
    const far = foe("f");
    const bs = { grid: makeGrid(40, 40), units: new Map([[rogue.id, rogue], [far.id, far]]), pos: new Map([[rogue.id, { x: 0, y: 0 }], [far.id, { x: 28, y: 0 }]]) } as never;
    const mods = attackModsFor(bs, rogue);
    expect(mods(far, { ranged: true }).disadvantage).toBe(true); // 140 feet: past the normal 120ft
    expect(mods(far, { ranged: true, longRangeFt: 300 }).disadvantage).toBeUndefined(); // Eldritch Spear's 300ft
  });

  it("the interpreter reads an attack node's longRangeFt and passes it to the battle seam", () => {
    const w = wlk("fiend-warlock", 5);
    const a = foe("a");
    const s = state();
    put(s, w, a);
    let seen: { longRangeFt?: number } | undefined;
    runAutomation(
      [{ type: "attack", bonus: 99, longRangeFt: 300, onHit: [{ type: "damage", amount: "5", damageType: "force" }] } as AutomationNode],
      { state: s, source: w, scope: [a], last: {}, depth: 0, attackMods: (_t, info) => { seen = info; return {}; } },
    );
    expect(seen?.longRangeFt).toBe(300);
  });
});

describe("regressions the Warlock pass fixed in shared spells and rules", () => {
  it("False Life is 1d4 + 4 temporary hit points at 1st level, 5 more a slot level (it was 1d4 + 3)", () => {
    expect(JSON.stringify(SPELLS_BY_ID["false-life"].build!({ slotLevel: 1, casterLevel: 5, spellMod: 4, pb: 3, dc: 15, toHit: 7 }))).toContain('"amount":"1d4+4"');
    expect(JSON.stringify(SPELLS_BY_ID["false-life"].build!({ slotLevel: 3, casterLevel: 5, spellMod: 4, pb: 3, dc: 15, toHit: 7 }))).toContain('"amount":"1d4+14"');
  });

  it("ignoring resistance doesn't ignore vulnerability", () => {
    const a = foe("a", undefined, {}, { vulnerabilities: ["necrotic"] });
    const s = state();
    put(s, a);
    applyDamage(s, a, 10, "necrotic", { ignoreResistances: true });
    expect(lost(a)).toBe(20);
  });
});

describe("warlocks in battle", () => {
  it("every patron and boon fights at levels 2, 6, 10, 14 and 20 without breaking", () => {
    for (const id of ALL) {
      for (const level of [2, 6, 10, 14, 20]) {
        const out = runBattle({ party: [{ template: id, level }, { template: "gwm-fighter", level }], enemies: ["ogre", "zombie"], seed: 5, controlled: [], maxRounds: 6 } as never);
        expect(out.frames.length, `${id} L${level}`).toBeGreaterThan(0);
      }
    }
  });

  it("a warlock opens by cursing a creature with Hex, keeps its blasts on it, and moves the curse when it falls", () => {
    let hexed = false;
    let moved = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: "fiend-warlock", level: 5, name: "Wlk" }, { template: "gwm-fighter", level: 5 }], enemies: ["ogre", "ogre", "ogre"], seed, controlled: [], maxRounds: 8 } as never);
      const text = out.frames.map((f) => f.text ?? "").join("\n");
      if (/Wlk uses Hex \(pact\) -> Ogre \d Hex/.test(text)) hexed = true;
      if (/Wlk uses Hex \(move the curse\) -> Ogre \d Hex/.test(text)) moved = true;
      expect(text).not.toMatch(/Wlk uses Hex \(move the curse\) \(no effect\)\n[^]*?Wlk uses Hex \(move the curse\) \(no effect\)\n[^]*?Wlk uses Hex \(move the curse\) \(no effect\)/);
    }
    expect(hexed).toBe(true);
    expect(moved).toBe(true);
  });

  it("the Undead warlock takes its Form of Dread and the Hexblade curses first", () => {
    const text = (template: string) => runBattle({ party: [{ template, level: 9, name: "Wlk" }, { template: "gwm-fighter", level: 9 }], enemies: ["ogre", "ogre"], seed: 4, controlled: [], maxRounds: 4 } as never)
      .frames.map((f) => f.text ?? "").join("\n");
    expect(text("undead-warlock")).toMatch(/Wlk uses Form of Dread/);
    expect(text("hexblade-warlock")).toMatch(/Wlk uses Hexblade's Curse/);
  });
});
