// Pact of the Chain, Pact of the Talisman and the invocations that needed forced movement and speed penalties (Repelling Blast, Grasp of Hadar, Lance of Lethargy), checked against the printed text
// (dnd5e.wikidot.com/warlock and its invocations, Find Familiar, the SRD imp). The mechanics run through the real engine with rigged dice; movement on a real battle grid.

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { runBattle } from "../lib/sim/battle";
import { fireEncounterStartTraits, runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollSave, saveModifierOf } from "../lib/sim/engine/resolve";
import { talismanBoost } from "../lib/sim/engine/reactions";
import { actionAvailable, commandOnlyPlan, spend } from "../lib/sim/engine/ai";
import { beginTurn, initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import { speedFt, boxOfUnit } from "../lib/sim/battle/state";
import { feetBetweenBoxes } from "../lib/sim/battle/geometry";
import { impFamiliarFor, PC_SUMMONS } from "../lib/sim/engine/minions";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { battle, unitAt } from "./helpers/battle-state";
import type { Action, AutomationNode, Combatant, DamageType } from "../lib/sim/schema";

function state(faces = 15): CombatState {
  const rng = makeRng(1);
  rng.d20 = () => faces;
  rng.d20mode = () => ({ used: faces, nat: faces });
  rng.dice = (n, sides) => n * sides;
  return { round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [], maxRounds: 10, ended: false, verbose: true, summonCounter: 0 };
}
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));
const wlk = (id: string, level: number, suffix = "-w") => initCombatant(makeTemplate(id, level), "party", suffix);
const fighter = (level = 6, suffix = "-a") => initCombatant(makeTemplate("gwm-fighter", level), "party", suffix);
function foe(id: string, over: Partial<Combatant> = {}, mods: Partial<Record<keyof Combatant["abilities"], number>> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4), cha: score(-4) };
  for (const [k, v] of Object.entries(mods)) abilities[k as keyof typeof abilities] = score(v as number);
  const { creatureType: _drop, ...rest } = base;
  void _drop;
  const c: Combatant = { ...rest, ac: 8, abilities, proficientSaves: [], specialRules: [], ...over };
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
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
const lost = (u: CombatantState) => u.maxHp - u.hp;
const swing = (s: CombatState, attacker: CombatantState, target: CombatantState, bonus = 99, dmg = "5", type: DamageType = "bludgeoning") =>
  runAutomation([{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: type }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });
const familiarOf = (s: CombatState, w: CombatantState) => [...s.units.values()].find((u) => u.summonerId === w.id)!;
const text = (s: CombatState) => s.log.map((l) => l.text).join("\n");
const at = (s: ReturnType<typeof battle>, u: CombatantState) => s.pos.get(u.id)!;
const gap = (s: ReturnType<typeof battle>, a: CombatantState, b: CombatantState) => feetBetweenBoxes(boxOfUnit(s, a), boxOfUnit(s, b));

describe("the pact boon is chosen at the 3rd level", () => {
  it("before it, every warlock is the same Eldritch Blast caster, whatever boon the template names", () => {
    const shape = (id: string) => { const c = makeTemplate(id, 2); return [c.ac, c.actions.map((a) => a.id).sort().join(","), c.traits.map((t) => t.id).join(","), c.reactions.map((r) => r.id).join(",")]; };
    const plain = shape("fiend-warlock");
    for (const boon of ["blade", "chain", "talisman"]) expect(shape(`fiend-warlock-${boon}`), boon).toEqual(plain);
  });

  it("from the 3rd it does: a pact weapon, a familiar, an amulet", () => {
    expect(makeTemplate("fiend-warlock-blade", 3).actions.some((a) => a.name.startsWith("Pact"))).toBe(true);
    expect(makeTemplate("fiend-warlock-chain", 3).traits.some((t) => t.id === "familiar")).toBe(true);
    expect(makeTemplate("fiend-warlock-talisman", 3).traits.some((t) => t.id === "talisman")).toBe(true);
    expect(makeTemplate("fiend-warlock-chain", 3).resources.talisman_checks).toBeUndefined();
    expect(makeTemplate("fiend-warlock-talisman", 3).resources.talisman_checks).toEqual({ max: 2, recharge: "longRest" });
  });

  it("plain names find the Chain and Talisman builds", () => {
    expect(findClassTemplate("fiend chain warlock").match?.templateId).toBe("fiend-warlock-chain");
    expect(findClassTemplate("hexblade talisman warlock").match?.templateId).toBe("hexblade-warlock-talisman");
    expect(findClassTemplate("great old one pact of the chain warlock").match?.templateId).toBe("great-old-one-warlock-chain");
    expect(findClassTemplate("efreeti genie talisman warlock").match?.templateId).toBe("efreeti-genie-warlock-talisman");
  });

  it("the Hexblade's Hex Warrior gives a martial weapon and Charisma from the 1st level regardless", () => {
    expect(makeTemplate("hexblade-warlock", 1).actions.some((a) => a.name === "Pact Longsword")).toBe(true);
  });
});

describe("Repelling Blast, Grasp of Hadar and Lance of Lethargy", () => {
  it("Repelling Blast: each hit pushes the creature up to 10 feet away in a straight line — two beams, twenty feet", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 5, 5, {}, "fiend-warlock", 5);
    const o = unitAt(s, "o", "monster", 6, 5, { ac: 8 });
    runAction(s, w, action(w, "attack"));
    expect(at(s, o)).toEqual({ x: 10, y: 5 });
    expect(o.zone).toBe("ranged");
    const s1 = battle();
    const w1 = unitAt(s1, "w", "party", 5, 5, {}, "fiend-warlock", 4); // two invocations: Repelling Blast is the third, at 5th level
    const o1 = unitAt(s1, "o", "monster", 6, 5, { ac: 8 });
    runAction(s1, w1, action(w1, "attack"));
    expect(at(s1, o1)).toEqual({ x: 6, y: 5 });
  });

  it("Repelling Blast is not there before the invocation is (a 1st-level warlock has none)", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 5, 5, {}, "fiend-warlock", 1);
    const o = unitAt(s, "o", "monster", 6, 5, { ac: 8 });
    runAction(s, w, action(w, "attack"));
    expect(at(s, o)).toEqual({ x: 6, y: 5 });
  });

  it("a push stops at a wall, or another creature, like any forced movement", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 5, 5, {}, "fiend-warlock", 5);
    const o = unitAt(s, "o", "monster", 6, 5, { ac: 8 });
    unitAt(s, "b", "monster", 9, 5, { ac: 8 });
    runAction(s, w, action(w, "attack"));
    expect(at(s, o)).toEqual({ x: 8, y: 5 });
  });

  it("Grasp of Hadar: once on each of your turns, a hit moves the creature 10 feet closer", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 5, 5, {}, "fiend-warlock-blade", 12); // the Blade build's sixth invocation
    const o = unitAt(s, "o", "monster", 15, 5, { ac: 8 });
    o.hp = o.maxHp = 1000;
    beginTurn(s, w);
    runAction(s, w, action(w, "cast-eldritch-blast")); // three beams: only the first pulls
    expect(at(s, o)).toEqual({ x: 13, y: 5 });
    runAction(s, w, action(w, "cast-eldritch-blast"));
    expect(at(s, o)).toEqual({ x: 13, y: 5 }); // still that turn
    beginTurn(s, w);
    runAction(s, w, action(w, "cast-eldritch-blast"));
    expect(at(s, o)).toEqual({ x: 11, y: 5 });
  });

  it("Lance of Lethargy: once on each of your turns, a hit cuts the creature's speed by 10 feet — the beams don't stack — until the warlock's next turn", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 5, 5, {}, "fiend-warlock", 12);
    const o = unitAt(s, "o", "monster", 6, 5, { ac: 8 });
    beginTurn(s, w);
    runAction(s, w, action(w, "attack")); // three beams
    expect(hasEffect(o, "lance-of-lethargy")).toBe(true);
    expect(speedFt(o)).toBe(20);
    beginTurn(s, w);
    expect(hasEffect(o, "lance-of-lethargy")).toBe(false);
    expect(speedFt(o)).toBe(30);
  });

  it("Tentacle of the Deeps: a hit reduces the target's speed by 10 feet until the start of the warlock's next turn", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 5, 5, {}, "fathomless-warlock", 5);
    const o = unitAt(s, "o", "monster", 6, 5, { ac: 8 });
    spend(w, action(w, "tentacle-of-the-deeps"));
    runAction(s, w, action(w, "tentacle-of-the-deeps"));
    expect(speedFt(o)).toBe(20);
    beginTurn(s, w);
    expect(speedFt(o)).toBe(30);
  });

  it("a slowed creature that can't close the distance in a turn is left behind by the push", () => {
    const s = battle(40, 20);
    const w = unitAt(s, "w", "party", 5, 5, {}, "fiend-warlock", 12);
    const o = unitAt(s, "o", "monster", 6, 5, { ac: 8 });
    runAction(s, w, action(w, "attack"));
    // three beams push 30 feet; slowed to 20 feet of speed it needs two turns to come back
    expect(gap(s, w, o)).toBe(35);
    expect(speedFt(o)).toBeLessThan(gap(s, w, o));
  });
});

describe("Relentless Hex and Misty Escape", () => {
  it("Relentless Hex (7th): a bonus action to teleport within 5 feet of the creature cursed by Hex or the warlock's curse — only when it is out of reach", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 2, 5, {}, "hexblade-warlock", 12);
    const o = unitAt(s, "o", "monster", 8, 5, { ac: 8 });
    cast(s, w as never, "hexblades-curse");
    expect(hasEffect(o, "hexblades-curse")).toBe(true);
    expect(actionAvailable(s, w, action(w, "relentless-hex"))).toBe(true);
    runAction(s, w, action(w, "relentless-hex"));
    expect(gap(s, w, o)).toBe(5);
    expect(actionAvailable(s, w, action(w, "relentless-hex"))).toBe(false); // already beside it
  });

  it("Relentless Hex can't reach a creature more than 30 feet away", () => {
    const s = battle(40, 10);
    const w = unitAt(s, "w", "party", 1, 5, {}, "hexblade-warlock", 12);
    const o = unitAt(s, "o", "monster", 20, 5, { ac: 8 });
    cast(s, w as never, "hexblades-curse");
    runAction(s, w, action(w, "relentless-hex"));
    expect(at(s, w)).toEqual({ x: 1, y: 5 });
    void o;
  });

  it("Misty Escape (6th): hurt, the warlock turns invisible and really lands up to 60 feet away", () => {
    const s = battle(40, 20);
    const w = unitAt(s, "w", "party", 10, 10, {}, "archfey-warlock", 6);
    const o = unitAt(s, "o", "monster", 11, 10, { ac: 8 });
    swing(s, o, w, 99, "5");
    expect(w.conditions.has("invisible")).toBe(true);
    expect(gap(s, w, o)).toBeGreaterThanOrEqual(45);
    expect(gap(s, w, o)).toBeLessThanOrEqual(65);
  });
});

describe("Pact of the Chain", () => {
  it("Find Familiar as a ritual: the imp is already there when the fight starts — Tiny fiend, armor class 13, 10 hit points, fly 40 feet", () => {
    const w = wlk("fiend-warlock-chain", 5);
    const s = state();
    put(s, w, foe("f"));
    fireEncounterStartTraits(s);
    const imp = familiarOf(s, w);
    expect(imp).toBeDefined();
    expect([imp.ref.creatureType, imp.ref.size, imp.ac, imp.maxHp, imp.ref.speeds.fly, imp.ref.speeds.walk]).toEqual(["fiend", "tiny", 13, 10, 40, 20]);
    expect(imp.ref.abilities.dex).toBe(17);
    expect(imp.ref.resistances).toContain("cold");
    expect(imp.ref.immunities).toEqual(expect.arrayContaining(["fire", "poison"]));
    expect(imp.ref.specialRules.some((r) => r.rule === "magicResistance")).toBe(true);
    expect(fireEncounterStartTraits.length).toBeGreaterThanOrEqual(0);
  });

  it("'A familiar can't attack': on its own turn it takes the Help action, and only stings when the warlock commands it", () => {
    const w = wlk("fiend-warlock-chain", 5);
    const a = foe("a");
    const s = state();
    put(s, w, a);
    fireEncounterStartTraits(s);
    const imp = familiarOf(s, w);
    expect(commandOnlyPlan(s, imp).dodge?.id).toBe("help");
    act(s, imp, "help");
    expect(hasEffect(a, "helped")).toBe(true);
    expect(lost(a)).toBe(0);
  });

  it("Help: the next attack roll against that creature by an ally has advantage, and the help is used up", () => {
    const modes: string[] = [];
    const w = wlk("fiend-warlock-chain", 5);
    const a = foe("a");
    const s = state();
    s.rng.d20mode = (m) => { modes.push(m); return { used: 15, nat: 15 }; };
    put(s, w, a);
    fireEncounterStartTraits(s);
    act(s, familiarOf(s, w), "help");
    swing(s, w, a);
    expect(modes).toContain("adv");
    modes.length = 0;
    swing(s, w, a);
    expect(modes).not.toContain("adv");
  });

  it("Investment of the Chain Master (3rd+): a bonus action orders the Attack action — Sting, 1d4 + 3 piercing and a Constitution save for 3d6 poison — using the warlock's save DC", () => {
    const w = wlk("fiend-warlock-chain", 5);
    const a = foe("a");
    const s = state();
    put(s, w, a);
    expect(actionAvailable(s, w, action(w, "command-familiar"))).toBe(false); // no familiar yet
    fireEncounterStartTraits(s);
    expect(actionAvailable(s, w, action(w, "command-familiar"))).toBe(true);
    const dc = 8 + 3 + 4;
    expect(JSON.stringify(familiarOf(s, w).ref.actions.find((x) => x.id === "sting")!.automation)).toContain(`"dc":${dc}`);
    cast(s, w, "command-familiar");
    expect(lost(a)).toBe(4 + 3 + 18); // the sting, and the poison (the save fails) at their maximum
    expect(text(s)).toMatch(/Imp 1 \(commanded\)/);
    expect(familiarOf(s, w).commandedRound).toBe(1);
  });

  it("the imp's Sting without the invocation is the printed DC 11 (only at levels where nothing better was chosen)", () => {
    expect(PC_SUMMONS[impFamiliarFor(11)].actions.find((x) => x.id === "sting")!.automation[0]).toBeDefined();
    expect(JSON.stringify(PC_SUMMONS[impFamiliarFor(11)].actions.find((x) => x.id === "sting")!.automation)).toContain('"dc":11');
    expect(JSON.stringify(PC_SUMMONS[impFamiliarFor(11)].actions.find((x) => x.id === "sting")!.automation)).toContain('"bonus":5');
  });

  it("Investment: when the familiar takes damage the warlock's reaction gives it resistance to that damage — once a round", () => {
    const w = wlk("fiend-warlock-chain", 5);
    const a = foe("a");
    const s = state();
    put(s, w, a);
    fireEncounterStartTraits(s);
    const imp = familiarOf(s, w);
    applyDamage(s, imp, 8, "slashing", { sourceId: a.id, attackerMagical: true });
    expect(imp.maxHp - imp.hp).toBe(4);
    expect(w.reactionUsed).toBe(true);
    applyDamage(s, imp, 2, "slashing", { sourceId: a.id, attackerMagical: true });
    expect(imp.maxHp - imp.hp).toBe(6); // the reaction is spent
  });

  it("Gift of the Ever-Living Ones: with the familiar near, healing dice count as their maximum", () => {
    const heal = (level: number, withFamiliar: boolean) => {
      const w = wlk("fiend-warlock-chain", level);
      const s = state();
      s.rng.dice = () => 1; // every die comes up 1
      put(s, w, foe("f"));
      if (withFamiliar) fireEncounterStartTraits(s);
      w.hp = 1;
      runAutomation([{ type: "heal", amount: "2d8" }], { state: s, source: w, scope: [w], last: {}, depth: 0 });
      return w.hp - 1;
    };
    expect(heal(15, false)).toBe(1);
    expect(heal(15, true)).toBe(16);
    expect(heal(14, true)).toBe(1); // not the invocation yet
  });

  it("Chains of Carceri (15th): Hold Monster at will on a celestial, fiend or elemental — no slot — and not again on the same creature", () => {
    const w = wlk("fiend-warlock-chain", 18);
    const devil = foe("d", { creatureType: "fiend" });
    const orc = foe("o", { creatureType: "humanoid" });
    const s = state();
    s.rng.d20 = () => 1;
    s.rng.d20mode = () => ({ used: 1, nat: 1 });
    put(s, w, orc);
    const chains = action(w, "cast-hold-monster-chains");
    expect(actionAvailable(s, w, chains)).toBe(false); // nothing it may target
    put(s, devil);
    expect(actionAvailable(s, w, chains)).toBe(true);
    const slots = res(w, "pactSlot");
    act(s, w, "cast-hold-monster-chains");
    expect(devil.conditions.has("paralyzed")).toBe(true);
    expect(orc.conditions.has("paralyzed")).toBe(false);
    expect(res(w, "pactSlot")).toBe(slots);
    w.concentratingOn = undefined;
    devil.conditions.clear();
    expect(actionAvailable(s, w, chains)).toBe(false); // "You must finish a long rest before you can use this invocation on the same creature again"
  });
});

describe("Pact of the Talisman", () => {
  it("the amulet goes to the sturdiest ally — or the warlock, alone", () => {
    const w = wlk("fiend-warlock-talisman", 5);
    const tank = fighter(8);
    const s = state();
    put(s, w, tank, foe("f"));
    fireEncounterStartTraits(s);
    expect(hasEffect(tank, "talisman")).toBe(true);
    expect(hasEffect(w, "talisman")).toBe(false);
    const alone = wlk("fiend-warlock-talisman", 5, "-solo");
    const s2 = state();
    put(s2, alone, foe("f"));
    fireEncounterStartTraits(s2);
    expect(hasEffect(alone, "talisman")).toBe(true);
  });

  it("the wearer's failed ability check gains a d4, proficiency-bonus times a long rest — only when the d4 can turn it", () => {
    const w = wlk("fiend-warlock-talisman", 5);
    const tank = fighter(8);
    const s = state();
    put(s, w, tank);
    fireEncounterStartTraits(s);
    expect(res(w, "talisman_checks")).toBe(3);
    expect(talismanBoost(s, tank, 5, 12, "talisman_checks")).toBe(false); // 7 short: no d4 helps (and none is spent)
    expect(res(w, "talisman_checks")).toBe(3);
    expect(talismanBoost(s, tank, 10, 12, "talisman_checks")).toBe(true); // 2 short; the d4 (rigged to 4) makes it
    expect(res(w, "talisman_checks")).toBe(2);
  });

  it("Rebuke of the Talisman (3rd+): the wearer is hit — a reaction: psychic damage equal to the proficiency bonus to the attacker, pushed 10 feet away from the wearer", () => {
    const s = battle();
    const w = unitAt(s, "w", "party", 5, 5, {}, "fiend-warlock-talisman", 3);
    const tank = unitAt(s, "t", "party", 6, 5, {}, "gwm-fighter", 8);
    const o = unitAt(s, "o", "monster", 7, 5, { ac: 8 });
    fireEncounterStartTraits(s);
    expect(hasEffect(tank, "talisman")).toBe(true);
    swing(s, o, tank, 99, "5");
    expect(lost(o)).toBe(2); // the proficiency bonus at 3rd level
    expect(at(s, o)).toEqual({ x: 9, y: 5 }); // 10 feet from the wearer, not from the warlock
    expect(w.reactionUsed).toBe(true);
  });

  it("...not if the attack misses, not if the attacker is over 30 feet from the warlock, not with the reaction spent", () => {
    const s = battle(40, 10);
    const w = unitAt(s, "w", "party", 1, 5, {}, "fiend-warlock-talisman", 3);
    const tank = unitAt(s, "t", "party", 2, 5, {}, "gwm-fighter", 8);
    const o = unitAt(s, "o", "monster", 3, 5, { ac: 8 });
    fireEncounterStartTraits(s);
    swing(s, o, tank, -50, "5"); // a miss
    expect(lost(o)).toBe(0);
    w.reactionUsed = true;
    swing(s, o, tank, 99, "5");
    expect(lost(o)).toBe(0);
    w.reactionUsed = false;
    const far = unitAt(s, "far", "monster", 20, 5, { ac: 8 });
    swing(s, far, tank, 99, "5");
    expect(lost(far)).toBe(0); // 95 feet from the warlock
  });

  it("Protection of the Talisman (7th): the wearer's failed saving throw gains a d4 — proficiency-bonus times a long rest", () => {
    const w = wlk("fiend-warlock-talisman", 9);
    const tank = fighter(8);
    const s = state(10);
    put(s, w, tank);
    fireEncounterStartTraits(s);
    expect(res(w, "protection_of_the_talisman")).toBe(4);
    const total = 10 + saveModifierOf(tank, "wis");
    expect(rollSave(s, tank, "wis", total + 3).passed).toBe(true); // 3 short, the d4 (4) turns it
    expect(res(w, "protection_of_the_talisman")).toBe(3);
    expect(rollSave(s, tank, "wis", total + 9).passed).toBe(false); // 9 short: nothing to spend
    expect(res(w, "protection_of_the_talisman")).toBe(3);
    expect(makeTemplate("fiend-warlock-talisman", 6).resources.protection_of_the_talisman).toBeUndefined();
  });

  it("Bond of the Talisman (12th): an action to teleport to the wearer — proficiency-bonus times a long rest", () => {
    const s = battle(40, 20);
    const w = unitAt(s, "w", "party", 2, 5, {}, "fiend-warlock-talisman", 12);
    const tank = unitAt(s, "t", "party", 30, 5, {}, "gwm-fighter", 20); // sturdier than the warlock, so it wears the amulet
    unitAt(s, "o", "monster", 32, 5, { ac: 8 });
    fireEncounterStartTraits(s);
    expect(hasEffect(tank, "talisman")).toBe(true);
    expect(res(w, "bond_of_the_talisman")).toBe(4);
    cast(s, w as never, "bond-of-the-talisman");
    expect(gap(s, w, tank)).toBe(5);
    expect(res(w, "bond_of_the_talisman")).toBe(3);
  });
});

describe("Chain and Talisman warlocks in battle", () => {
  it("the imp flies up beside a foe and Helps; and stings on command", () => {
    let helped = false;
    let stung = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: "fiend-warlock-chain", level: 5, name: "Wlk" }, { template: "gwm-fighter", level: 5 }], enemies: ["ogre", "ogre", "ogre"], seed, controlled: [], maxRounds: 8 } as never);
      const log = out.frames.map((f) => f.text ?? "").join("\n");
      if (/Imp 1 uses Help/.test(log)) helped = true;
      if (/Imp 1 \(commanded\) uses Sting/.test(log)) stung = true;
      expect(log).not.toMatch(/Imp 1 uses Sting/); // never on its own
    }
    expect(helped).toBe(true);
    expect(stung).toBe(true);
  });

  it("a Talisman warlock's wearer strikes back through Rebuke of the Talisman", () => {
    let rebuked = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: "fiend-warlock-talisman", level: 5, name: "Wlk" }, { template: "gwm-fighter", level: 5 }], enemies: ["ogre", "ogre", "ogre"], seed, controlled: [], maxRounds: 8 } as never);
      if (out.frames.some((f) => /Rebuke of the Talisman/.test(f.text ?? ""))) rebuked = true;
    }
    expect(rebuked).toBe(true);
  });

  it("a warlock with Repelling Blast pushes melee foes back and they lose ground in a real fight", () => {
    let pushed = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: "fiend-warlock", level: 5, name: "Wlk" }, { template: "gwm-fighter", level: 5 }], enemies: ["ogre", "ogre"], seed, controlled: [], maxRounds: 8 } as never);
      if (out.frames.some((f) => /is pushed \d+ ft/.test(f.text ?? ""))) pushed = true;
    }
    expect(pushed).toBe(true);
  });
});
