// The barbarian and its nine paths, checked against the printed text (dnd5e.wikidot.com/barbarian and each path's
// page). Numbers asserted here are the ones on those pages; the mechanics are exercised through the real engine with
// rigged dice (every d20 lands on `faces`, every damage die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollAttack, rollSave } from "../lib/sim/engine/resolve";
import { spend } from "../lib/sim/engine/ai";
import { endOfTurn } from "../lib/sim/engine/loop";
import { beginTurn, initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { unitReachFt } from "../lib/sim/battle/state";
import type { AutomationNode, Combatant } from "../lib/sim/schema";

const BARBARIAN_IDS = [
  "berserker-barbarian", "totem-barbarian", "ancestral-guardian-barbarian", "storm-herald-barbarian",
  "storm-herald-desert-barbarian", "storm-herald-tundra-barbarian", "zealot-barbarian", "battlerager-barbarian",
  "beast-barbarian", "giant-barbarian", "wild-magic-barbarian",
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
const barb = (id: string, level: number) => initCombatant(makeTemplate(id, level), "party", "-b");
const ally = (level = 6) => initCombatant(makeTemplate("gwm-fighter", level), "party", "-a");
/** a big, low-AC dummy foe: every attack rolled at 15+ hits, and nothing dies */
function foe(over: Partial<Combatant["abilities"]> = {}, id = "f"): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const u = initCombatant({ ...base, ac: 8, abilities: { ...base.abilities, ...over } }, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, u.ref.actions.find((a) => a.id === id)!);
const cast = (s: CombatState, u: CombatantState, id: string) => { spend(u, u.ref.actions.find((a) => a.id === id)!); act(s, u, id); };
const startTurn = (s: CombatState, u: CombatantState) => { beginTurn(s, u); u.actionUsedThisTurn = u.bonusUsedThisTurn = false; u.reactionUsed = false; };
const raging = (u: CombatantState) => u.effects.some((e) => e.name === "rage");
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
/** a foe's hit on `target`, for the on-hit riders (hit-back damage) */
const hit = (s: CombatState, attacker: CombatantState, target: CombatantState) =>
  runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "5", damageType: "bludgeoning" }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });

describe("barbarian — validity and parsing", () => {
  it("every barbarian template builds a schema-valid PC at levels 1, 3, 6, 10, 14, 17, 20", () => {
    for (const id of BARBARIAN_IDS) {
      for (const lvl of [1, 3, 6, 10, 14, 17, 20]) {
        const res = validateCombatant(makeTemplate(id, lvl));
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });

  it("free text resolves each path to its own template; bare 'barbarian' is still the Totem Warrior", () => {
    for (const [text, id] of [
      ["berserker barbarian", "berserker-barbarian"], ["totem warrior barbarian", "totem-barbarian"],
      ["ancestral guardian barbarian", "ancestral-guardian-barbarian"], ["storm herald barbarian", "storm-herald-barbarian"],
      ["desert storm herald barbarian", "storm-herald-desert-barbarian"], ["tundra storm herald barbarian", "storm-herald-tundra-barbarian"],
      ["zealot barbarian", "zealot-barbarian"], ["battlerager barbarian", "battlerager-barbarian"], ["beast barbarian", "beast-barbarian"],
      ["giant barbarian", "giant-barbarian"], ["wild magic barbarian", "wild-magic-barbarian"], ["barbarian", "totem-barbarian"],
    ]) expect(findClassTemplate(text).match?.templateId, text).toBe(id);
  });
});

describe("the Barbarian table", () => {
  it("rages per day 2 / 3 / 4 / 5 / 6, unlimited at 20th; Rage damage +2 / +3 / +4", () => {
    const rages = (l: number) => makeTemplate("berserker-barbarian", l).resources.rage.max;
    expect([1, 2, 3, 5, 6, 11, 12, 16, 17, 19, 20].map(rages)).toEqual([2, 2, 3, 3, 4, 4, 5, 5, 6, 6, "unbounded"]);
    const dmg = (l: number) => {
      const c = makeTemplate("berserker-barbarian", l);
      const gate = c.actions.find((a) => a.id === "rage")!.automation[0];
      if (gate.type !== "branch" || gate.then[0].type !== "target" || gate.then[0].effects[0].type !== "applyEffect") throw new Error("shape");
      return gate.then[0].effects[0].mods!.extraDamageOnHit!.amount;
    };
    expect([1, 8, 9, 15, 16, 20].map(dmg)).toEqual(["2", "2", "3", "3", "4", "4"]);
  });

  it("Unarmored Defense 10 + Dex + Con; Danger Sense 2nd; Extra Attack 5th; Fast Movement 5th; Feral Instinct 7th", () => {
    const c = (l: number) => makeTemplate("berserker-barbarian", l);
    expect(c(5).ac).toBe(10 + 2 + 4);
    expect(c(1).specialRules.some((r) => r.rule === "advantageOnSaves")).toBe(false);
    expect(c(2).specialRules).toContainEqual({ rule: "advantageOnSaves", abilities: ["dex"] });
    const swings = (l: number) => JSON.stringify(c(l).actions.find((a) => a.id === "attack")!.automation).match(/"type":"attack"/g)!.length;
    expect([swings(4), swings(5), swings(20)]).toEqual([1, 2, 2]); // a barbarian never gets a third attack
    expect([c(4).speeds.walk, c(5).speeds.walk]).toEqual([30, 40]);
    expect(c(6).specialRules.some((r) => r.rule === "initiativeAdvantage")).toBe(false);
    expect(c(7).specialRules.some((r) => r.rule === "initiativeAdvantage")).toBe(true);
  });

  it("Brutal Critical, Relentless Rage, Persistent Rage arrive at 9th / 13th / 17th, 11th, 15th", () => {
    const rules = (l: number) => makeTemplate("berserker-barbarian", l).specialRules;
    const bc = (l: number) => (rules(l).find((r) => r.rule === "brutalCritical") as { dice: number } | undefined)?.dice;
    expect([bc(8), bc(9), bc(13), bc(17)]).toEqual([undefined, 1, 2, 3]);
    expect(rules(10).some((r) => r.rule === "relentlessRage")).toBe(false);
    expect(rules(11).some((r) => r.rule === "relentlessRage")).toBe(true);
    expect(rules(14).some((r) => r.rule === "persistentRage")).toBe(false);
    expect(rules(15).some((r) => r.rule === "persistentRage")).toBe(true);
  });

  it("Primal Champion (20th): Str and Con 24 (+7), so AC and to-hit rise", () => {
    const c = makeTemplate("berserker-barbarian", 20);
    expect(c.abilities.str).toBe(24);
    expect(c.abilities.con).toBe(24);
    expect(c.ac).toBe(10 + 2 + 7);
  });

  it("Brutal Critical adds extra weapon dice on a critical hit only", () => {
    const dmg = (level: number, face: number) => {
      const s = state(face);
      const b = barb("berserker-barbarian", level);
      const f = foe();
      put(s, b, f);
      act(s, b, "careful-attack");
      return f.maxHp - f.hp;
    };
    // L9 (not raging): two swings of 1d12 + 4. A crit doubles the die and Brutal Critical (9th) adds one more die.
    expect(dmg(9, 15)).toBe(2 * (12 + 4));
    expect(dmg(9, 20)).toBe(2 * (12 * 2 + 4 + 12));
    expect(dmg(8, 20)).toBe(2 * (12 * 2 + 4)); // no Brutal Critical yet
  });
});

describe("Rage", () => {
  it("is a bonus action that resists bludgeoning / piercing / slashing (not fire), and adds its damage to every hit", () => {
    const s = state(15);
    const b = barb("berserker-barbarian", 5);
    const f = foe();
    put(s, b, f);
    expect(makeTemplate("berserker-barbarian", 5).actions.find((a) => a.id === "rage")!.cost).toEqual({ bonus: 1 });
    cast(s, b, "rage");
    expect(raging(b)).toBe(true);
    expect(b.resources.get("rage")).toBe(2);
    b.tempHp = 0;
    const before = b.hp;
    applyDamage(s, b, 20, "slashing", {});
    expect(before - b.hp).toBe(10); // resisted
    b.hp = before;
    applyDamage(s, b, 20, "fire", {});
    expect(before - b.hp).toBe(20); // not resisted
    // a hit: 1d12 + 4 + Rage damage 2
    act(s, b, "careful-attack");
    expect(f.maxHp - f.hp).toBe(2 * (12 + 4 + 2));
  });

  it("can't be started while already raging", () => {
    const s = state(15);
    const b = barb("berserker-barbarian", 5);
    put(s, b, foe());
    cast(s, b, "rage");
    const left = b.resources.get("rage");
    const rage = b.ref.actions.find((a) => a.id === "rage")!;
    act(s, b, "rage");
    expect(b.effects.filter((e) => e.name === "rage")).toHaveLength(1);
    expect(rage.automation[0].type).toBe("branch"); // gated: the AI won't offer it mid-rage
    expect(left).toBe(2);
  });

  it("gives advantage on Strength saves while raging", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const b = barb("berserker-barbarian", 5);
    put(s, b, foe());
    rollSave(s, b, "str", 10);
    expect(modes.at(-1)).toBe("flat");
    cast(s, b, "rage");
    rollSave(s, b, "str", 10);
    expect(modes.at(-1)).toBe("adv");
    rollSave(s, b, "wis", 10);
    expect(modes.at(-1)).toBe("flat");
  });

  it("ends when you fall unconscious", () => {
    const s = state(15);
    const b = barb("berserker-barbarian", 5);
    put(s, b, foe());
    cast(s, b, "rage");
    applyDamage(s, b, 9999, "force", {});
    expect(b.downed).toBe(true);
    expect(raging(b)).toBe(false);
  });

  it("ends at the end of a turn on which you neither attacked nor took damage — unless you did, or have Persistent Rage", () => {
    const turn = (level: number, doWhat: "nothing" | "attack" | "hurt") => {
      const s = state(15);
      const b = barb("berserker-barbarian", level);
      const f = foe();
      put(s, b, f);
      startTurn(s, b);
      cast(s, b, "rage");
      if (doWhat === "attack") act(s, b, "careful-attack");
      if (doWhat === "hurt") applyDamage(s, b, 3, "force", {});
      endOfTurn(s, b);
      return raging(b);
    };
    expect(turn(5, "nothing")).toBe(false);
    expect(turn(5, "attack")).toBe(true);
    expect(turn(5, "hurt")).toBe(true);
    expect(turn(15, "nothing")).toBe(true); // Persistent Rage
  });

  it("keeps going across turns while the barbarian keeps fighting, and lapses after a quiet one", () => {
    const s = state(15);
    const b = barb("berserker-barbarian", 5);
    const f = foe();
    put(s, b, f);
    startTurn(s, b);
    cast(s, b, "rage");
    act(s, b, "careful-attack");
    endOfTurn(s, b);
    expect(raging(b)).toBe(true);
    startTurn(s, b);
    endOfTurn(s, b); // did nothing this turn, and nobody touched them in between
    expect(raging(b)).toBe(false);
  });
});

describe("Reckless Attack", () => {
  it("gives advantage on your swings and lets attackers have advantage against you until your next turn", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const b = barb("berserker-barbarian", 5);
    const f = foe();
    put(s, b, f);
    startTurn(s, b);
    act(s, b, "attack");
    expect(modes.slice(0, 2)).toEqual(["adv", "adv"]);
    modes.length = 0;
    rollAttack(s, f, b, 0, undefined);
    expect(modes).toEqual(["adv"]);
    startTurn(s, b);
    modes.length = 0;
    rollAttack(s, f, b, 0, undefined);
    expect(modes).toEqual(["flat"]);
  });

  it("the careful attack is an ordinary attack, and there is no Reckless Attack at 1st level", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const b = barb("berserker-barbarian", 5);
    put(s, b, foe());
    act(s, b, "careful-attack");
    expect(modes).toEqual(["flat", "flat"]);
    expect(makeTemplate("berserker-barbarian", 1).actions.some((a) => a.id === "careful-attack")).toBe(false);
  });
});

describe("Relentless Rage (11th)", () => {
  it("dropping to 0 while raging: a Con save (DC 10, then 15 ...) to stay at 1 HP", () => {
    const s = state(5); // 5 + Con 4 + PB 4 (proficient) = 13: passes DC 10, fails DC 15
    const b = barb("berserker-barbarian", 11);
    put(s, b, foe());
    cast(s, b, "rage");
    b.hp = 30;
    applyDamage(s, b, 45, "force", {});
    expect(b.hp).toBe(1);
    expect(b.downed).toBe(false);
    b.hp = 30;
    applyDamage(s, b, 45, "force", {});
    expect(b.downed).toBe(true); // DC 15 now
  });

  it("needs the rage, and the feature", () => {
    const s = state(20);
    const b = barb("berserker-barbarian", 11);
    put(s, b, foe());
    b.hp = 30;
    applyDamage(s, b, 45, "force", {});
    expect(b.downed).toBe(true); // not raging
    const s2 = state(20);
    const c = barb("berserker-barbarian", 10);
    put(s2, c, foe());
    cast(s2, c, "rage");
    c.hp = 30;
    applyDamage(s2, c, 45, "force", {});
    expect(c.downed).toBe(true); // no Relentless Rage yet
  });
});

describe("Path of the Berserker", () => {
  it("Frenzy: a bonus-action melee attack while raging (from 3rd level), and none without a rage", () => {
    expect(makeTemplate("berserker-barbarian", 2).actions.some((a) => a.id === "frenzy")).toBe(false);
    expect(makeTemplate("berserker-barbarian", 3).ai.bonusAfterAttack).toEqual(["frenzy"]);
    const s = state(15);
    const b = barb("berserker-barbarian", 5);
    const f = foe();
    put(s, b, f);
    act(s, b, "frenzy");
    expect(f.hp).toBe(f.maxHp);
    cast(s, b, "rage");
    act(s, b, "frenzy");
    expect(f.maxHp - f.hp).toBe(12 + 4 + 2);
  });

  it("Mindless Rage (6th): can't be frightened or charmed while raging", () => {
    const frighten: AutomationNode = { type: "target", who: { who: "aiChoice" }, effects: [{ type: "applyCondition", condition: "frightened" }] };
    const test = (level: number, rage: boolean) => {
      const s = state(15);
      const b = barb("berserker-barbarian", level);
      const f = foe();
      put(s, b, f);
      if (rage) cast(s, b, "rage");
      runAutomation([frighten], { state: s, source: f, scope: [b], forceScope: [b], last: {}, depth: 0 });
      return b.conditions.has("frightened");
    };
    expect(test(6, true)).toBe(false);
    expect(test(6, false)).toBe(true);
    expect(test(5, true)).toBe(true);
  });

  it("Intimidating Presence (10th): a Wisdom save (DC 8 + PB) or frightened", () => {
    expect(makeTemplate("berserker-barbarian", 9).actions.some((a) => a.id === "intimidating-presence")).toBe(false);
    const s = state(5);
    const b = barb("berserker-barbarian", 10);
    const f = foe({ wis: 1 });
    put(s, b, f);
    act(s, b, "intimidating-presence");
    expect(f.conditions.has("frightened")).toBe(true);
  });

  it("Retaliation (14th): a melee attack in reply to a melee hit", () => {
    const c = makeTemplate("berserker-barbarian", 14);
    expect(c.reactions.map((r) => r.id)).toEqual(["retaliation"]);
    expect(makeTemplate("berserker-barbarian", 13).reactions).toEqual([]);
  });
});

describe("Path of the Totem Warrior (Bear)", () => {
  it("resists every damage type but psychic while raging (from 3rd level)", () => {
    const taken = (level: number, type: "fire" | "psychic" | "necrotic") => {
      const s = state(15);
      const b = barb("totem-barbarian", level);
      put(s, b, foe());
      cast(s, b, "rage");
      const before = b.hp;
      applyDamage(s, b, 20, type, {});
      return before - b.hp;
    };
    expect(taken(3, "fire")).toBe(10);
    expect(taken(3, "necrotic")).toBe(10);
    expect(taken(3, "psychic")).toBe(20);
    expect(taken(2, "fire")).toBe(20);
  });

  it("Totemic Attunement (14th): hostile creatures beside a raging barbarian have disadvantage against anyone else", () => {
    const roll = (level: number, rage: boolean, who: "other" | "barb") => {
      const modes: string[] = [];
      const s = state(15, modes);
      const b = barb("totem-barbarian", level);
      const a = ally(14);
      const f = foe();
      put(s, b, a, f);
      if (rage) cast(s, b, "rage");
      rollAttack(s, f, who === "other" ? a : b, 0, undefined);
      return modes.at(-1);
    };
    expect(roll(14, true, "other")).toBe("dis");
    expect(roll(14, true, "barb")).toBe("flat");
    expect(roll(14, false, "other")).toBe("flat");
    expect(roll(13, true, "other")).toBe("flat");
  });
});

describe("Path of the Ancestral Guardian", () => {
  it("Ancestral Protectors: the first creature you hit while raging has disadvantage against anyone but you, and its blows on others are resisted", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const b = barb("ancestral-guardian-barbarian", 5);
    const a = ally();
    const f = foe();
    put(s, b, a, f);
    startTurn(s, b);
    cast(s, b, "rage");
    act(s, b, "attack");
    expect(hasEffect(f, "ancestral-protectors")).toBe(true);
    modes.length = 0;
    rollAttack(s, f, a, 0, undefined);
    rollAttack(s, f, b, 0, undefined);
    expect(modes).toEqual(["dis", "adv"]); // (the barbarian's Reckless Attack still gives attackers advantage on it)
    const before = a.hp;
    applyDamage(s, a, 20, "slashing", { sourceId: f.id, viaAttack: true });
    expect(before - a.hp).toBe(10); // resisted
    startTurn(s, b);
    expect(hasEffect(f, "ancestral-protectors")).toBe(false);
  });

  it("Spirit Shield (6th): a raging barbarian's reaction soaks 2d6 (3d6 at 10th, 4d6 at 14th) of damage to an ally", () => {
    const takenBy = (level: number) => {
      const s = state(15);
      const b = barb("ancestral-guardian-barbarian", level);
      const a = ally();
      put(s, b, a, foe());
      cast(s, b, "rage");
      const before = a.hp;
      applyDamage(s, a, 40, "slashing", {});
      return { taken: before - a.hp, reactionUsed: b.reactionUsed };
    };
    expect(takenBy(6)).toEqual({ taken: 40 - 12, reactionUsed: true });
    expect(takenBy(10).taken).toBe(40 - 18);
    expect(takenBy(14).taken).toBe(40 - 24);
    expect(takenBy(5).taken).toBe(40); // not yet
  });

  it("Spirit Shield needs the rage and a free reaction, and works once a round", () => {
    const s = state(15);
    const b = barb("ancestral-guardian-barbarian", 6);
    const a = ally();
    a.hp = a.maxHp = 1000;
    put(s, b, a, foe());
    const before = a.hp;
    applyDamage(s, a, 40, "slashing", {});
    expect(before - a.hp).toBe(40); // not raging
    cast(s, b, "rage");
    applyDamage(s, a, 20, "slashing", {});
    const afterFirst = a.hp;
    applyDamage(s, a, 20, "slashing", {});
    expect(afterFirst - a.hp).toBe(20); // the reaction is spent
  });

  it("Vengeful Ancestors (14th): the prevented damage comes back at the attacker as force damage", () => {
    const s = state(15);
    const b = barb("ancestral-guardian-barbarian", 14);
    const a = ally();
    const f = foe();
    put(s, b, a, f);
    cast(s, b, "rage");
    applyDamage(s, a, 20, "slashing", { sourceId: f.id, viaAttack: true });
    expect(f.maxHp - f.hp).toBe(20); // 4d6 (24) soaks all 20
  });
});

describe("Path of the Storm Herald", () => {
  it("Sea: on raging, one creature in the aura makes a Dexterity save (DC 8 + PB + Con) or takes 1d6 lightning — half on a save; 2d6 / 3d6 / 4d6 at 10th / 15th / 20th", () => {
    const hurt = (level: number, face: number) => {
      const s = state(face);
      const b = barb("storm-herald-barbarian", level);
      const f = foe({ dex: 1 });
      put(s, b, f);
      cast(s, b, "rage");
      return f.maxHp - f.hp;
    };
    expect(hurt(6, 5)).toBe(6); // failed: 1d6
    expect(hurt(6, 20)).toBe(3); // saved: half
    expect(hurt(10, 5)).toBe(12);
    expect(hurt(15, 5)).toBe(18);
    expect(hurt(20, 5)).toBe(24);
    expect(hurt(2, 5)).toBe(0); // no path yet
  });

  it("Desert: every OTHER creature in the aura takes fire damage (2 / 3 / 4 / 5 / 6) — allies included, the barbarian not", () => {
    const s = state(15);
    const b = barb("storm-herald-desert-barbarian", 5);
    const a = ally();
    const f = foe();
    put(s, b, a, f);
    cast(s, b, "rage");
    expect([f.maxHp - f.hp, a.maxHp - a.hp, b.maxHp - b.hp]).toEqual([3, 3, 0]);
    const dmg = (level: number) => {
      const t = state(15);
      const c = barb("storm-herald-desert-barbarian", level);
      const g = foe();
      put(t, c, g);
      cast(t, c, "rage");
      return g.maxHp - g.hp;
    };
    expect([dmg(3), dmg(5), dmg(10), dmg(15), dmg(20)]).toEqual([2, 3, 4, 5, 6]);
  });

  it("Tundra: creatures you choose in the aura gain temporary HP (2 / 3 / 4 / 5 / 6)", () => {
    const s = state(15);
    const b = barb("storm-herald-tundra-barbarian", 10);
    const a = ally();
    put(s, b, a, foe());
    cast(s, b, "rage");
    expect([b.tempHp, a.tempHp]).toEqual([4, 4]);
  });

  it("the aura fires again each turn as a bonus action, only while raging", () => {
    const c = makeTemplate("storm-herald-barbarian", 6);
    expect(c.ai.bonusRoutine).toEqual(["rage", "storm-aura"]);
    const s = state(5);
    const b = barb("storm-herald-barbarian", 6);
    const f = foe({ dex: 1 });
    put(s, b, f);
    act(s, b, "storm-aura");
    expect(f.hp).toBe(f.maxHp); // not raging
    cast(s, b, "rage");
    const after = f.hp;
    act(s, b, "storm-aura");
    expect(after - f.hp).toBe(6);
  });

  it("Storm Soul (6th): resistance to the environment's damage all the time; the sea also gives a 30-ft swim speed", () => {
    expect(makeTemplate("storm-herald-desert-barbarian", 5).resistances).toEqual([]);
    expect(makeTemplate("storm-herald-desert-barbarian", 6).resistances).toEqual(["fire"]);
    expect(makeTemplate("storm-herald-barbarian", 6).resistances).toEqual(["lightning"]);
    expect(makeTemplate("storm-herald-tundra-barbarian", 6).resistances).toEqual(["cold"]);
    expect(makeTemplate("storm-herald-barbarian", 6).speeds.swim).toBe(30);
    expect(makeTemplate("storm-herald-desert-barbarian", 6).speeds.swim).toBeUndefined();
  });

  it("Shielding Storm (10th): allies in the aura share the resistance", () => {
    const s = state(5);
    const b = barb("storm-herald-desert-barbarian", 10);
    const a = ally();
    put(s, b, a, foe());
    cast(s, b, "rage");
    expect(a.effects.find((e) => e.name === "shielding-storm")?.mods?.resistTypes).toEqual(["fire"]);
  });

  it("Raging Storm (14th), desert: a reaction fire-damage save against a melee attacker, half your level", () => {
    const c = makeTemplate("storm-herald-desert-barbarian", 14);
    expect(c.reactions.map((r) => r.id)).toEqual(["raging-storm-desert"]);
    expect(JSON.stringify(c.reactions[0].automation)).toContain('"amount":"7"');
    expect(makeTemplate("storm-herald-desert-barbarian", 13).reactions).toEqual([]);
  });

  it("Raging Storm (14th), sea: your hit knocks a creature in the aura prone with a Strength save — using your reaction, once", () => {
    const s = state(5);
    const b = barb("storm-herald-barbarian", 14);
    const f = foe({ str: 1 });
    put(s, b, f);
    startTurn(s, b);
    cast(s, b, "rage");
    act(s, b, "careful-attack");
    expect(f.conditions.has("prone")).toBe(true);
    expect(b.reactionUsed).toBe(true);
  });

  it("Raging Storm (14th), tundra: a creature in the aura makes a Strength save or its speed drops to 0", () => {
    const s = state(5);
    const b = barb("storm-herald-tundra-barbarian", 14);
    const f = foe({ str: 1 });
    put(s, b, f);
    cast(s, b, "rage");
    expect(f.effects.find((e) => e.name === "frozen")?.mods?.speedZero).toBe(true);
  });
});

describe("Path of the Zealot", () => {
  it("Divine Fury: 1d6 + half your level extra damage on the first creature you hit each turn while raging", () => {
    const total = (id: string) => {
      const s = state(15);
      const b = barb(id, 6);
      const f = foe();
      put(s, b, f);
      startTurn(s, b);
      cast(s, b, "rage");
      act(s, b, "careful-attack");
      return f.maxHp - f.hp;
    };
    expect(total("zealot-barbarian") - total("berserker-barbarian")).toBe(6 + 3); // 1d6 + 3, once, not on both swings
  });

  it("Divine Fury needs a rage", () => {
    const s = state(15);
    const b = barb("zealot-barbarian", 6);
    const f = foe();
    put(s, b, f);
    startTurn(s, b);
    act(s, b, "careful-attack");
    expect(f.maxHp - f.hp).toBe(2 * (12 + 4));
  });

  it("Fanatical Focus (6th): reroll a failed save while raging, once per rage", () => {
    const s = state([1, 20, 1, 1]);
    const b = barb("zealot-barbarian", 6);
    put(s, b, foe());
    cast(s, b, "rage");
    expect(rollSave(s, b, "wis", 15).passed).toBe(true); // failed with a 1, rerolled to a 20
    expect(rollSave(s, b, "wis", 15).passed).toBe(false); // once per rage
    const c = state([1, 20]);
    const d = barb("zealot-barbarian", 6);
    put(c, d, foe());
    expect(rollSave(c, d, "wis", 15).passed).toBe(false); // not raging
    expect(makeTemplate("zealot-barbarian", 5).specialRules.some((r) => r.rule === "rerollFailedSave")).toBe(false);
  });

  it("Zealous Presence (10th): allies get advantage on attack rolls and saves until your next turn, once per long rest", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const b = barb("zealot-barbarian", 10);
    const a = ally();
    const f = foe();
    put(s, b, a, f);
    cast(s, b, "zealous-presence");
    expect(b.resources.get("zealous_presence")).toBe(0);
    rollAttack(s, a, f, 0, undefined);
    rollSave(s, a, "wis", 10);
    expect(modes).toEqual(["adv", "adv"]);
    beginTurn(s, b);
    expect(hasEffect(a, "zealous-presence")).toBe(false);
    expect(makeTemplate("zealot-barbarian", 9).actions.some((x) => x.id === "zealous-presence")).toBe(false);
  });
});

describe("Path of the Battlerager", () => {
  it("Armor Spikes (3rd): a bonus-action 1d4 + Str piercing attack, only while raging", () => {
    const s = state(15);
    const b = barb("battlerager-barbarian", 5);
    const f = foe();
    put(s, b, f);
    act(s, b, "armor-spikes");
    expect(f.hp).toBe(f.maxHp);
    cast(s, b, "rage");
    act(s, b, "armor-spikes");
    expect(f.maxHp - f.hp).toBe(4 + 4 + 2);
    expect(makeTemplate("battlerager-barbarian", 5).ai.bonusAfterAttack).toEqual(["armor-spikes"]);
  });

  it("Reckless Abandon (6th): Reckless Attack while raging also gives temporary HP equal to your Con modifier", () => {
    const s = state(15);
    const b = barb("battlerager-barbarian", 6);
    put(s, b, foe());
    cast(s, b, "rage");
    act(s, b, "attack");
    expect(b.tempHp).toBe(4);
    const t = state(15);
    const c = barb("battlerager-barbarian", 5);
    put(t, c, foe());
    cast(t, c, "rage");
    act(t, c, "attack");
    expect(c.tempHp).toBe(0);
  });

  it("Spiked Retribution (14th): a creature that hits you in melee while you rage takes 3 piercing damage", () => {
    const s = state(15);
    const b = barb("battlerager-barbarian", 14);
    const f = foe();
    put(s, b, f);
    cast(s, b, "rage");
    hit(s, f, b);
    expect(f.maxHp - f.hp).toBe(3);
    const t = state(15);
    const c = barb("battlerager-barbarian", 13);
    const g = foe();
    put(t, c, g);
    cast(t, c, "rage");
    hit(t, g, c);
    expect(g.hp).toBe(g.maxHp);
  });
});

describe("Path of the Beast", () => {
  it("Form of the Beast: each rage picks claws, a bite or a tail; the natural weapon replaces the greataxe while raging", () => {
    const c = makeTemplate("beast-barbarian", 3);
    expect(c.actions.filter((a) => a.id.startsWith("rage-")).map((a) => a.id)).toEqual(["rage-claws", "rage-bite", "rage-tail"]);
    const s = state(15);
    const b = barb("beast-barbarian", 6);
    put(s, b, foe());
    cast(s, b, "rage-tail");
    expect(hasEffect(b, "form-tail")).toBe(true);
    expect(hasEffect(b, "rage")).toBe(true);
  });

  it("Claws: 1d6 slashing, and one extra claw attack with the Attack action", () => {
    const s = state(15);
    const b = barb("beast-barbarian", 6); // 2 attacks + 1 extra claw
    const f = foe();
    put(s, b, f);
    cast(s, b, "rage-claws");
    act(s, b, "attack-claws");
    expect(f.maxHp - f.hp).toBe(3 * (6 + 4 + 2));
  });

  it("Bite: 1d8 piercing; once a turn a hit while below half HP heals you for your proficiency bonus", () => {
    const heal = (hp: number) => {
      const s = state(15);
      const b = barb("beast-barbarian", 6);
      const f = foe();
      put(s, b, f);
      startTurn(s, b);
      cast(s, b, "rage-bite");
      b.hp = hp;
      act(s, b, "attack-bite");
      return b.hp - hp;
    };
    expect(heal(10)).toBe(3); // PB 3, once even though two swings hit
    expect(heal(b0().maxHp - 1)).toBe(0); // at more than half HP: nothing
  });

  it("Tail: 1d8 piercing, and a reaction d8 AC bonus that can turn a hit into a miss", () => {
    const attack = (form: "rage-tail" | "rage-bite") => {
      const s = state(10);
      const b = barb("beast-barbarian", 6);
      const f = foe();
      put(s, b, f);
      cast(s, b, form);
      return rollAttack(s, f, b, 9, undefined).hit; // 10 + 9 = 19 vs AC 16: a 3-point margin, under the d8
    };
    expect(attack("rage-tail")).toBe(false);
    expect(attack("rage-bite")).toBe(true);
  });

  it("Infectious Fury (10th): a natural-weapon hit forces a Wisdom save (DC 8 + Con + PB) or 2d12 psychic; PB uses per long rest", () => {
    const s = state(5);
    const b = barb("beast-barbarian", 10);
    const f = foe({ wis: 1 });
    put(s, b, f);
    expect(b.resources.get("infectious_fury")).toBe(4);
    cast(s, b, "rage-claws");
    act(s, b, "attack-claws");
    // three claw hits: each 1d6+4+3 slashing (rage +3 at 10th) = 13, plus 2d12 psychic (24) on each while uses last
    expect(f.maxHp - f.hp).toBe(3 * 13 + 3 * 24);
    expect(b.resources.get("infectious_fury")).toBe(1);
    expect(makeTemplate("beast-barbarian", 9).resources.infectious_fury).toBeUndefined();
  });

  it("Call the Hunt (14th): 5 temporary HP per companion who joins, and each adds a d6 to one hit per turn", () => {
    const s = state(15);
    const b = barb("beast-barbarian", 14);
    const a = ally(14);
    const f = foe();
    put(s, b, a, f);
    startTurn(s, a);
    cast(s, b, "rage-claws");
    expect(b.tempHp).toBe(5); // one companion
    expect(hasEffect(a, "call-the-hunt")).toBe(true);
    const before = f.maxHp - f.hp;
    act(s, a, "attack"); // three swings at 14th level (gwm-fighter: Extra Attack x2)
    const dealt = f.maxHp - f.hp - before;
    const perSwing = 12 + 4;
    expect(dealt).toBe(3 * perSwing + 6); // one d6 in total, not one per swing
    expect(b.resources.get("call_the_hunt")).toBe(4);
  });
});

describe("Path of the Giant", () => {
  it("Giant's Havoc: reach grows by 5 ft while raging (10 ft at 14th)", () => {
    const reach = (level: number, rage: boolean) => {
      const s = state(15);
      const b = barb("giant-barbarian", level);
      put(s, b, foe());
      if (rage) cast(s, b, "rage");
      return unitReachFt(b);
    };
    expect([reach(5, false), reach(5, true), reach(14, true), reach(2, true)]).toEqual([5, 10, 15, 5]);
  });

  it("Elemental Cleaver (6th): an extra 1d6 of the chosen type on each hit while raging; 2d6 at 14th", () => {
    const dealt = (level: number) => {
      const swing = (id: string) => {
        const s = state(15);
        const b = barb(id, level);
        const f = foe();
        put(s, b, f);
        cast(s, b, "rage");
        act(s, b, "careful-attack");
        return f.maxHp - f.hp;
      };
      return swing("giant-barbarian") - swing("berserker-barbarian");
    };
    expect(dealt(6)).toBe(2 * 6); // two swings, +1d6 each
    expect(dealt(14)).toBe(2 * 12);
    expect(dealt(5)).toBe(0);
  });
});

describe("Path of Wild Magic", () => {
  const surgeOptions = (level: number) => {
    const gate = makeTemplate("wild-magic-barbarian", level).actions.find((a) => a.id === "rage")!.automation[0];
    if (gate.type !== "branch" || gate.then[0].type !== "target") throw new Error("shape");
    const surge = gate.then[0].effects.find((n) => n.type === "randomEffect");
    if (!surge || surge.type !== "randomEffect") throw new Error("no surge");
    return surge.options;
  };
  const surgeAt = (n: number, level = 6) => {
    // n = which of the eight table results (1-based); an equal-weight d8 puts it at (n - 0.5) / 8
    const s = state(15);
    s.rng.next = () => (n - 0.5) / 8;
    const b = barb("wild-magic-barbarian", level);
    const a = ally();
    const f = foe({ con: 1, dex: 1 });
    put(s, b, a, f);
    cast(s, b, "rage");
    return { s, b, a, f };
  };

  it("Wild Surge: raging rolls on the eight-result table (uniform below 14th level)", () => {
    expect(surgeOptions(3)).toHaveLength(8);
    expect(surgeOptions(3).every((o) => o.weight === 1)).toBe(true);
    expect(makeTemplate("wild-magic-barbarian", 2).actions.find((a) => a.id === "rage")!.automation[0].type).toBe("branch");
  });

  it("1: foes within 30 ft make a Constitution save or take 1d12 necrotic, and you gain 1d12 temporary HP", () => {
    const { b, f } = surgeAt(1);
    expect(f.maxHp - f.hp).toBe(12);
    expect(b.tempHp).toBe(12);
  });

  it("3 and 8: a spirit's blast (Dex save, 1d6 force) / a light bolt (Con save, 1d6 radiant, blinded), repeatable as a bonus action", () => {
    const three = surgeAt(3);
    expect(three.f.maxHp - three.f.hp).toBe(6);
    const after = three.f.hp;
    act(three.s, three.b, "wild-spirit");
    expect(after - three.f.hp).toBe(6);
    const eight = surgeAt(8);
    expect(eight.f.maxHp - eight.f.hp).toBe(6);
    expect(eight.f.conditions.has("blinded")).toBe(true);
    act(eight.s, eight.b, "wild-bolt");
    expect(hasEffect(eight.b, "wild-bolt")).toBe(true);
  });

  it("5: whoever hits you takes 1d6 force damage; 6: +1 AC to you and allies within 10 ft", () => {
    const five = surgeAt(5);
    hit(five.s, five.f, five.b);
    expect(five.f.maxHp - five.f.hp).toBe(6);
    const six = surgeAt(6);
    expect([hasEffect(six.b, "wild-lights"), hasEffect(six.a, "wild-lights")]).toEqual([true, true]);
  });

  it("Controlled Surge (14th): roll twice and choose — the favorite comes up most, the least useful result never", () => {
    const options = surgeOptions(14);
    expect(options).toHaveLength(7); // the AI's least-favorite result can never be the better of two
    const total = options.reduce((n, o) => n + o.weight, 0);
    expect(total).toBe(64);
    expect(options.find((o) => o.note === "necrotic burst")!.weight).toBe(22);
  });

  it("Bolstering Magic (6th): a d3 on attack rolls for a creature you touch, PB times per long rest", () => {
    expect(makeTemplate("wild-magic-barbarian", 5).actions.some((a) => a.id === "bolstering-magic")).toBe(false);
    const c = makeTemplate("wild-magic-barbarian", 6);
    expect(c.resources.bolstering_magic).toEqual({ max: 3, recharge: "longRest" });
    const s = state(15);
    const b = barb("wild-magic-barbarian", 6);
    put(s, b, foe());
    act(s, b, "bolstering-magic");
    expect(b.effects.find((e) => e.name === "bolstering-magic")?.mods?.attackBonusDice).toBe("1d3");
  });

  it("Unstable Backlash (10th): a reaction that re-rolls the table after you take damage while raging", () => {
    expect(makeTemplate("wild-magic-barbarian", 9).reactions).toEqual([]);
    expect(makeTemplate("wild-magic-barbarian", 10).reactions.map((r) => r.id)).toEqual(["unstable-backlash"]);
  });
});

function b0(): CombatantState { return initCombatant(makeTemplate("beast-barbarian", 6), "party", "-x"); }

describe("whole fights run cleanly for every path at the levels where new features appear", () => {
  it("no crash, every fight reaches a result, and the barbarian rages", () => {
    for (const id of BARBARIAN_IDS) {
      for (const level of [3, 6, 10, 14, 20]) {
        const out = runBattle({
          party: [{ template: id, level, name: "Barb" }, { template: "gwm-fighter", level, name: "Ally" }],
          enemies: ["ogre x2"], seed: level, controlled: [], maxRounds: 6,
        } as never);
        expect(out.done, `${id} L${level}`).toBe(true);
        expect(out.frames.some((f) => /Barb uses Rage/.test(f.text ?? "")), `${id} L${level} rages`).toBe(true);
      }
    }
  });

  it("a Beast attacks with its claws in the same turn it rages", () => {
    const out = runBattle({
      party: [{ template: "beast-barbarian", level: 6, name: "Barb" }, { template: "gwm-fighter", level: 6, name: "Ally" }],
      enemies: ["ogre x2"], seed: 3, controlled: [], maxRounds: 3,
    } as never);
    const lines = out.frames.map((f) => f.text ?? "");
    const rageAt = lines.findIndex((l) => /Barb uses Rage/.test(l));
    expect(lines.slice(rageAt, rageAt + 3).some((l) => /Barb uses Claws/.test(l))).toBe(true);
  });
});
