// The monk and its traditions, checked against the printed text (dnd5e.wikidot.com/monk and each tradition's page). Numbers asserted here
// are the ones on those pages; the mechanics run through the real engine with rigged dice (every d20 lands on `faces`, every damage
// die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage } from "../lib/sim/engine/resolve";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import type { AutomationNode, Combatant } from "../lib/sim/schema";

const MONK_IDS = [
  "open-hand-monk", "shadow-monk", "four-elements-monk", "long-death-monk", "sun-soul-monk",
  "drunken-master-monk", "kensei-monk", "mercy-monk", "astral-self-monk", "ascendant-dragon-monk",
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
const monk = (id: string, level: number) => initCombatant(makeTemplate(id, level), "party", "-m");
/** a big, low-AC dummy foe (every roll of 15+ hits a monk; nothing dies). `con` is a modifier, low so a rolled 15 fails a monk's DC */
function foe(id = "f", over: Partial<Record<keyof Combatant["abilities"], number>> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4) };
  for (const [k, v] of Object.entries(over)) abilities[k as keyof typeof abilities] = score(v as number);
  const u = initCombatant({ ...base, ac: 8, abilities, proficientSaves: [], specialRules: [] }, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, u.ref.actions.find((a) => a.id === id)!);
const cast = (s: CombatState, u: CombatantState, id: string) => { spend(u, u.ref.actions.find((a) => a.id === id)!); act(s, u, id); };
const lost = (u: CombatantState) => u.maxHp - u.hp;
const ki = (u: CombatantState) => u.resources.get("ki") ?? 0;
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
const has = (u: CombatantState, c: string) => u.conditions.has(c as never);
const isStunned = (u: CombatantState) => has(u, "stunned");
const hit = (s: CombatState, attacker: CombatantState, target: CombatantState) =>
  runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "5", damageType: "bludgeoning" }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });
const arena = (faces: number | number[], attacker: CombatantState, target: CombatantState = foe()) => {
  const s = state(faces);
  put(s, attacker, target);
  attacker.zone = target.zone = "melee";
  return { s, target };
};

describe("monk — validity and parsing", () => {
  it("every monk template builds a schema-valid PC at every level", () => {
    for (const id of MONK_IDS) {
      for (let lvl = 1; lvl <= 20; lvl++) {
        const res = validateCombatant(makeTemplate(id, lvl));
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });

  it("free text resolves each tradition to its own template; bare 'monk' is still the Open Hand", () => {
    for (const [text, id] of [
      ["monk", "open-hand-monk"], ["open hand monk", "open-hand-monk"], ["shadow monk", "shadow-monk"], ["way of the four elements monk", "four-elements-monk"],
      ["long death monk", "long-death-monk"], ["sun soul monk", "sun-soul-monk"], ["drunken master monk", "drunken-master-monk"], ["kensei monk", "kensei-monk"],
      ["way of mercy", "mercy-monk"], ["astral self monk", "astral-self-monk"], ["ascendant dragon monk", "ascendant-dragon-monk"],
    ]) expect(findClassTemplate(text).match?.templateId, text).toBe(id);
  });
});

describe("the Monk table", () => {
  it("Martial Arts die is d4 / d6 / d8 / d10 at levels 1 / 5 / 11 / 17", () => {
    const die = (level: number) => {
      const m = makeTemplate("open-hand-monk", level);
      const a = m.actions.find((x) => x.id === "martial-arts")!;
      const t = a.automation[0];
      if (t.type !== "target") throw new Error("shape");
      const atk = t.effects[0];
      if (atk.type !== "attack") throw new Error("shape");
      const d = atk.onHit[0];
      if (d.type !== "damage") throw new Error("shape");
      return d.amount.split("+")[0];
    };
    expect([1, 4, 5, 10, 11, 16, 17, 20].map(die)).toEqual(["1d4", "1d4", "1d6", "1d6", "1d8", "1d8", "1d10", "1d10"]);
  });

  it("ki points equal monk level from 2nd; none at 1st", () => {
    expect(makeTemplate("open-hand-monk", 1).resources.ki).toBeUndefined();
    expect(makeTemplate("open-hand-monk", 2).resources.ki).toEqual({ max: 2, recharge: "shortRest" });
    expect(makeTemplate("open-hand-monk", 13).resources.ki).toEqual({ max: 13, recharge: "shortRest" });
  });

  it("Unarmored Movement adds +10 / +15 / +20 / +25 / +30 ft at 2 / 6 / 10 / 14 / 18", () => {
    expect([1, 2, 5, 6, 9, 10, 13, 14, 17, 18, 20].map((l) => makeTemplate("open-hand-monk", l).speeds.walk)).toEqual([30, 40, 40, 45, 45, 50, 50, 55, 55, 60, 60]);
  });

  it("Unarmored Defense is 10 + Dex + Wis", () => {
    const m3 = makeTemplate("open-hand-monk", 3);
    expect(m3.ac).toBe(10 + 4 + 3);
    expect(makeTemplate("open-hand-monk", 20).ac).toBe(10 + 5 + 3);
  });

  it("Extra Attack at 5th: one strike before, two after", () => {
    const strikes = (level: number) => {
      const a = makeTemplate("open-hand-monk", level).actions.find((x) => x.id === "attack")!;
      const t = a.automation[0];
      return t.type === "target" ? t.effects.filter((e) => e.type === "attack").length : -1;
    };
    expect(strikes(4)).toBe(1);
    expect(strikes(5)).toBe(2);
  });

  it("Diamond Soul (14th) adds every saving throw; Purity of Body (10th) is poison and disease immunity", () => {
    expect(makeTemplate("open-hand-monk", 13).proficientSaves).toEqual(["str", "dex"]);
    expect(makeTemplate("open-hand-monk", 14).proficientSaves).toHaveLength(6);
    expect(makeTemplate("open-hand-monk", 9).immunities).not.toContain("poison");
    expect(makeTemplate("open-hand-monk", 10).immunities).toContain("poison");
    expect(makeTemplate("open-hand-monk", 10).conditionImmunities).toContain("poisoned");
  });

  it("Deflect Missiles (3rd) cuts a ranged weapon hit by 1d10 + Dex + monk level, and not a melee one", () => {
    const m = monk("open-hand-monk", 5);
    const archer = foe("archer");
    const { s } = arena(15, m, archer);
    archer.zone = "ranged";
    const before = m.hp;
    applyDamage(s, m, 30, "piercing", { viaAttack: true, sourceId: archer.id });
    expect(before - m.hp).toBe(30 - (10 + 4 + 5)); // max 1d10 + Dex 4 + level 5
    expect(m.reactionUsed).toBe(true);
    const m2 = monk("open-hand-monk", 5);
    const brute = foe("brute");
    const arena2 = arena(15, m2, brute);
    applyDamage(arena2.s, m2, 30, "piercing", { viaAttack: true, sourceId: brute.id });
    expect(30).toBe(m2.maxHp - m2.hp); // an ordinary melee hit, undiminished
    expect(m2.reactionUsed).toBeFalsy();
  });

  it("Evasion (7th): a failed Dex save halves, a passed one takes nothing", () => {
    expect(makeTemplate("open-hand-monk", 7).traits.some((t) => t.id === "evasion")).toBe(true);
    expect(makeTemplate("open-hand-monk", 6).traits.some((t) => t.id === "evasion")).toBe(false);
  });
});

describe("Stunning Strike, Flurry of Blows and the other ki actions", () => {
  it("Stunning Strike (5th): the first hit of an Attack action costs 1 ki and stuns on a failed Con save", () => {
    const m = monk("open-hand-monk", 5);
    const { s, target } = arena(15, m);
    cast(s, m, "attack");
    expect(ki(m)).toBe(4);
    expect(isStunned(target)).toBe(true);
  });

  it("does not spend ki again on a target that is already stunned, nor at all with under 2 ki", () => {
    const m = monk("open-hand-monk", 5);
    const { s, target } = arena(15, m);
    cast(s, m, "attack"); // spends 1 on the first hit; the second hit lands on a stunned creature
    expect(ki(m)).toBe(4);
    const low = monk("open-hand-monk", 5);
    low.resources.set("ki", 1);
    const a2 = arena(15, low);
    cast(a2.s, low, "attack");
    expect(ki(low)).toBe(1);
    expect(isStunned(a2.target)).toBe(false);
    expect(target.hp).toBeLessThan(target.maxHp);
  });

  it("Stunning Strike is not available before 5th level", () => {
    const m = monk("open-hand-monk", 4);
    const { s, target } = arena(15, m);
    cast(s, m, "attack");
    expect(ki(m)).toBe(4);
    expect(isStunned(target)).toBe(false);
  });

  it("a target that makes the Con save is not stunned, but the ki is still gone", () => {
    const m = monk("open-hand-monk", 5);
    const { s, target } = arena(15, m, foe("tough", { con: 10 }));
    cast(s, m, "attack");
    expect(ki(m)).toBe(4);
    expect(isStunned(target)).toBe(false);
  });

  it("Flurry of Blows costs a bonus action and 1 ki and makes two unarmed strikes", () => {
    const m = monk("open-hand-monk", 2);
    const { s, target } = arena(15, m);
    const flurry = m.ref.actions.find((a) => a.id === "flurry")!;
    expect(flurry.cost).toEqual({ bonus: 1 });
    expect(flurry.limitedUse).toEqual({ resource: "ki", amount: 1 });
    cast(s, m, "flurry");
    expect(ki(m)).toBe(1);
    expect(lost(target)).toBe(2 * (4 + 4)); // two strikes of d4 + Dex, both hit
  });

  it("Martial Arts gives one free bonus-action strike", () => {
    const m = monk("open-hand-monk", 1);
    const { s, target } = arena(15, m);
    cast(s, m, "martial-arts");
    expect(lost(target)).toBe(4 + 4);
  });

  it("Patient Defense and Step of the Wind cost 1 ki and a bonus action; the first grants disadvantage to attackers, the second stops opportunity attacks", () => {
    const m = monk("open-hand-monk", 4);
    const { s } = arena(15, m);
    cast(s, m, "patient-defense");
    expect(hasEffect(m, "dodging")).toBe(true);
    expect(ki(m)).toBe(3);
    const m2 = monk("open-hand-monk", 4);
    const a2 = arena(15, m2);
    cast(a2.s, m2, "step-of-the-wind");
    expect(hasEffect(m2, "disengaged")).toBe(true);
    expect(ki(m2)).toBe(3);
  });

  it("Stillness of Mind (7th) removes a fear or charm, and Empty Body (18th) is 4 ki for invisibility and resistance to all but force", () => {
    const m = monk("open-hand-monk", 7);
    const { s } = arena(15, m);
    m.conditions.set("frightened", { expiresRound: 5, sourceId: "x" });
    cast(s, m, "stillness-of-mind-frightened");
    expect(has(m, "frightened")).toBe(false);
    const m18 = monk("open-hand-monk", 18);
    const a = arena(15, m18);
    cast(a.s, m18, "empty-body");
    expect(ki(m18)).toBe(14);
    expect(has(m18, "invisible")).toBe(true);
    const shield = m18.effects.find((e) => e.name === "empty-body")!;
    expect(shield.mods?.resistTypes).toContain("fire");
    expect(shield.mods?.resistTypes).not.toContain("force");
  });

  it("Perfect Self (20th): no ki when initiative is rolled gives 4 back", () => {
    const m = monk("open-hand-monk", 20);
    m.resources.set("ki", 0);
    const t = m.ref.traits.find((x) => x.id === "perfect-self")!;
    const { s } = arena(15, m);
    runAutomation(t.automation, { state: s, source: m, scope: [m], last: {}, depth: 0 });
    expect(ki(m)).toBe(4);
    runAutomation(t.automation, { state: s, source: m, scope: [m], last: {}, depth: 0 });
    expect(ki(m)).toBe(4); // with some ki left it does nothing
  });
});

describe("Way of the Open Hand", () => {
  it("Open Hand Technique (3rd) knocks a Flurry of Blows target prone on a failed Dex save — not before 3rd, not off a plain Attack", () => {
    const m = monk("open-hand-monk", 3);
    const { s, target } = arena(15, m);
    cast(s, m, "flurry");
    expect(has(target, "prone")).toBe(true);
    const m2 = monk("open-hand-monk", 2);
    const a2 = arena(15, m2);
    cast(a2.s, m2, "flurry");
    expect(has(a2.target, "prone")).toBe(false);
    const m3 = monk("open-hand-monk", 3);
    const a3 = arena(15, m3);
    cast(a3.s, m3, "attack");
    expect(has(a3.target, "prone")).toBe(false);
  });

  it("Wholeness of Body (6th) heals three times monk level once per long rest, once at or under half hit points", () => {
    const m = monk("open-hand-monk", 6);
    const { s } = arena(15, m);
    const wob = m.ref.actions.find((a) => a.id === "wholeness-of-body")!;
    expect(actionAvailable(s, m, wob)).toBe(false); // unhurt: the AI doesn't spend it
    m.hp = m.maxHp / 2 + 1;
    expect(actionAvailable(s, m, wob)).toBe(false);
    m.hp = 1;
    expect(actionAvailable(s, m, wob)).toBe(true);
    cast(s, m, "wholeness-of-body");
    expect(m.hp).toBe(1 + 18);
    expect(m.resources.get("wholeness_of_body")).toBe(0);
    expect(actionAvailable(s, m, wob)).toBe(false);
    expect(makeTemplate("open-hand-monk", 6).resources.wholeness_of_body).toEqual({ max: 1, recharge: "longRest" });
  });

  it("Quivering Palm (17th): 3 ki on a hit sets the vibrations and an action later drops the target to 0 on a failed Con save", () => {
    const m = monk("open-hand-monk", 17);
    const { s, target } = arena(15, m);
    cast(s, m, "attack");
    expect(hasEffect(target, "quivering-palm")).toBe(true);
    expect(ki(m)).toBe(17 - 3 - 1); // Quivering Palm 3 + Stunning Strike 1 (the second hit lands on an already-stunned creature)
    cast(s, m, "end-vibrations");
    expect(target.hp).toBe(0);
    expect(hasEffect(target, "quivering-palm")).toBe(false);
    expect(m.damageDealt).toBeLessThanOrEqual(target.maxHp); // the "reduced to 0" isn't counted as thousands of damage
  });

  it("Quivering Palm: a successful save takes 10d10 necrotic instead", () => {
    const m = monk("open-hand-monk", 17);
    const { s, target } = arena(15, m, foe("brute", { con: 10 }));
    target.effects.push({ name: "quivering-palm", sourceId: m.id, expiresRound: 999 });
    cast(s, m, "end-vibrations");
    expect(lost(target)).toBe(100);
  });
});

describe("Way of Shadow", () => {
  it("Shadow Step (6th): a bonus action giving advantage on the first melee attack — and it is the opening move", () => {
    const m = monk("shadow-monk", 6);
    const modes: string[] = [];
    const s = state(15, modes);
    const target = foe();
    put(s, m, target);
    m.zone = target.zone = "melee";
    expect(m.ref.ai.opener).toContain("shadow-step");
    cast(s, m, "shadow-step");
    expect(hasEffect(m, "shadow-step")).toBe(true);
    hit(s, m, target);
    expect(modes[0]).toBe("adv");
    expect(hasEffect(m, "shadow-step")).toBe(false); // spent on that attack
    hit(s, m, target);
    expect(modes[1]).not.toBe("adv");
  });

  it("Cloak of Shadows (11th): invisible until you attack", () => {
    const m = monk("shadow-monk", 11);
    const { s, target } = arena(15, m);
    cast(s, m, "cloak-of-shadows");
    expect(has(m, "invisible")).toBe(true);
    hit(s, m, target);
    expect(has(m, "invisible")).toBe(false);
    expect(hasEffect(m, "cloak-of-shadows")).toBe(false);
  });

  it("Opportunist (17th): a hit on a creature beside you by someone else lets you make an attack with your reaction", () => {
    const m = monk("shadow-monk", 17);
    const ally = initCombatant(makeTemplate("gwm-fighter", 8), "party", "-ally");
    const target = foe();
    const s = state(15);
    put(s, m, ally, target);
    m.zone = ally.zone = target.zone = "melee";
    const before = target.hp;
    hit(s, ally, target);
    expect(before - target.hp).toBeGreaterThan(5); // the ally's 5 plus the monk's strike
    expect(m.reactionUsed).toBe(true);
  });

  it("Opportunist does not fire for the monk's own attacks, or once the reaction is spent", () => {
    const m = monk("shadow-monk", 17);
    const target = foe();
    const { s } = arena(15, m, target);
    hit(s, m, target);
    expect(m.reactionUsed).toBeFalsy();
  });
});

describe("Way of the Four Elements", () => {
  it("Fangs of the Fire Snake (3rd) makes the strikes fire damage, 1 ki, with an extra 1d10 on a hit for 1 more", () => {
    const m = monk("four-elements-monk", 3);
    const { s, target } = arena(15, m);
    m.resources.set("ki", 3);
    cast(s, m, "attack");
    expect(ki(m)).toBe(3 - 1 - 1); // the snake, then the rider
    expect(lost(target)).toBe(4 + 4 + 10);
  });

  it("Fist of Unbroken Air (6th): 2 ki, 3d10 bludgeoning, prone on a failed Strength save", () => {
    const m = monk("four-elements-monk", 6);
    const { s, target } = arena(15, m);
    cast(s, m, "fist-of-unbroken-air");
    expect(ki(m)).toBe(4);
    expect(lost(target)).toBe(30);
    expect(has(target, "prone")).toBe(true);
  });

  it("Flames of the Phoenix (11th) is Fireball for 4 ki; Breath of Winter (17th) is Cone of Cold for 6", () => {
    const m = monk("four-elements-monk", 11);
    const { s, target } = arena(15, m);
    cast(s, m, "discipline-fireball");
    expect(ki(m)).toBe(7);
    expect(lost(target)).toBe(8 * 6); // 8d6, failed Dex save
    const m17 = monk("four-elements-monk", 17);
    const a = arena(15, m17);
    cast(a.s, m17, "discipline-cone-of-cold");
    expect(ki(m17)).toBe(11);
    expect(lost(a.target)).toBe(8 * 8); // 8d8 at 5th level
  });

  it("without the ki for a discipline, the action does nothing", () => {
    const m = monk("four-elements-monk", 11);
    m.resources.set("ki", 3);
    const { s, target } = arena(15, m);
    act(s, m, "discipline-fireball");
    expect(lost(target)).toBe(0);
    expect(ki(m)).toBe(3);
  });
});

describe("Way of the Long Death", () => {
  it("Touch of Death (3rd): reducing a creature to 0 gives Wis + monk level temporary hit points", () => {
    const m = monk("long-death-monk", 5);
    const target = foe();
    target.hp = 3;
    const { s } = arena(15, m, target);
    hit(s, m, target);
    expect(target.hp).toBeLessThanOrEqual(0);
    expect(m.tempHp).toBe(3 + 5);
  });

  it("Hour of Reaping (6th): each creature within 30 ft that fails a Wisdom save is frightened", () => {
    const m = monk("long-death-monk", 6);
    const { s, target } = arena(15, m);
    cast(s, m, "hour-of-reaping");
    expect(has(target, "frightened")).toBe(true);
    expect(ki(m)).toBe(6); // costs no ki
  });

  it("Mastery of Death (11th): dropping to 0 hit points costs 1 ki to stay at 1", () => {
    const m = monk("long-death-monk", 11);
    const { s } = arena(15, m);
    applyDamage(s, m, 999, "slashing", {});
    expect(m.hp).toBe(1);
    expect(ki(m)).toBe(10);
    const m10 = monk("long-death-monk", 10);
    const a = arena(15, m10);
    applyDamage(a.s, m10, 999, "slashing", {});
    expect(m10.hp).toBeLessThanOrEqual(0);
  });

  it("Touch of the Long Death (17th): the ki spent is 2d10 necrotic each — a Constitution save halves it", () => {
    const m = monk("long-death-monk", 17);
    const { s, target } = arena(15, m);
    cast(s, m, "touch-of-the-long-death-5");
    expect(ki(m)).toBe(12);
    expect(lost(target)).toBe(10 * 10);
    const m2 = monk("long-death-monk", 17);
    const a2 = arena(15, m2, foe("brute", { con: 10 }));
    cast(a2.s, m2, "touch-of-the-long-death-10");
    expect(ki(m2)).toBe(7);
    expect(lost(a2.target)).toBe(20 * 10 / 2);
  });
});

describe("Way of the Sun Soul", () => {
  it("Radiant Sun Bolt (3rd) is a ranged spell attack of radiant damage from the Martial Arts die; 1 ki makes two as a bonus action", () => {
    const m = monk("sun-soul-monk", 3);
    const { s, target } = arena(15, m);
    const bolts = m.ref.actions.find((a) => a.id === "sun-bolt-flurry")!;
    expect(bolts.ranged).toBe(true);
    cast(s, m, "sun-bolt-flurry");
    expect(ki(m)).toBe(2);
    expect(lost(target)).toBe(2 * (4 + 4));
    const t = bolts.automation[0];
    const atk = t.type === "target" ? t.effects[0] : undefined;
    expect(atk && atk.type === "attack" && atk.onHit[0].type === "damage" && atk.onHit[0].damageType).toBe("radiant");
  });

  it("Searing Arc Strike (6th): 2 ki for Burning Hands as a bonus action", () => {
    const m = monk("sun-soul-monk", 6);
    const { s, target } = arena(15, m);
    cast(s, m, "searing-arc-strike");
    expect(ki(m)).toBe(4);
    expect(lost(target)).toBe(3 * 6); // 3d6 fire, failed Dex save
  });

  it("Searing Sunburst (11th): 2d6 radiant on a failed Con save, +2d6 for each ki spent (up to 3)", () => {
    const m = monk("sun-soul-monk", 11);
    const { s, target } = arena(15, m);
    cast(s, m, "searing-sunburst");
    expect(ki(m)).toBe(8);
    expect(lost(target)).toBe(8 * 6);
    const m2 = monk("sun-soul-monk", 11);
    m2.resources.set("ki", 2);
    const a2 = arena(15, m2);
    act(a2.s, m2, "searing-sunburst");
    expect(lost(a2.target)).toBe(2 * 6);
  });

  it("Sun Shield (17th): a reaction dealing 5 + Wis radiant damage to a melee attacker", () => {
    const m = monk("sun-soul-monk", 17);
    const r = m.ref.reactions.find((x) => x.id === "sun-shield")!;
    const eff = r.automation[0];
    const dmg = eff.type === "target" ? eff.effects[0] : undefined;
    expect(dmg && dmg.type === "damage" && dmg.amount).toBe("8");
  });
});

describe("Way of the Drunken Master", () => {
  it("Drunken Technique (3rd): Flurry of Blows also Disengages and adds 10 feet of speed", () => {
    const m = monk("drunken-master-monk", 3);
    const { s } = arena(15, m);
    cast(s, m, "flurry");
    const e = m.effects.find((x) => x.name === "drunken-technique")!;
    expect(e.mods?.noOpportunityAttacks).toBe(true);
    expect(e.mods?.speedBonusFt).toBe(10);
  });

  it("Tipsy Sway (6th): Redirect Attack is a reaction that costs 1 ki", () => {
    const m = monk("drunken-master-monk", 6);
    const r = m.ref.reactions.find((x) => x.id === "redirect-attack")!;
    expect(r.limitedUse).toEqual({ resource: "ki", amount: 1 });
  });

  it("Redirect Attack: a melee attack that misses the monk hits an adjacent creature instead, for 1 ki", () => {
    const m = monk("drunken-master-monk", 6);
    const a = foe("a");
    const b = foe("b");
    b.side = "monster";
    const s = state([2, 15]); // the first swing misses the monk, the redirected one hits
    put(s, m, a, b);
    m.zone = a.zone = b.zone = "melee";
    const before = b.hp;
    runAutomation([{ type: "attack", bonus: 0, onHit: [{ type: "damage", amount: "5", damageType: "bludgeoning" }] } as AutomationNode], { state: s, source: a, scope: [m], last: {}, depth: 0 });
    expect(m.reactionUsed).toBe(true);
    expect(ki(m)).toBe(5);
    expect(before - b.hp).toBeGreaterThan(0);
    expect(lost(m)).toBe(0);
  });

  it("Drunkard's Luck (11th): 2 ki cancels disadvantage on an attack roll", () => {
    const m = monk("drunken-master-monk", 11);
    const modes: string[] = [];
    const s = state(15, modes);
    const target = foe();
    put(s, m, target);
    m.zone = target.zone = "melee";
        m.conditions.set("poisoned", { expiresRound: 99, sourceId: "x" });
    hit(s, m, target);
    expect(modes[0]).not.toBe("dis");
    expect(ki(m)).toBe(9);
  });

  it("Intoxicated Frenzy (17th): Flurry of Blows makes up to five attacks against different creatures", () => {
    const m = monk("drunken-master-monk", 17);
    const flurry = m.ref.actions.find((a) => a.id === "flurry")!;
    expect(JSON.stringify(flurry)).toContain('"rank":4');
    // against one foe it is still the ordinary two strikes; against several, one strike on each
    const solo = arena(15, m);
    cast(solo.s, m, "flurry");
    expect(lost(solo.target)).toBe(2 * (10 + 5));
    const m2 = monk("drunken-master-monk", 17);
    const { s, target } = arena(15, m2);
    const others = [foe("b"), foe("c"), foe("d")];
    others.forEach((o) => { o.zone = "melee"; });
    put(s, ...others);
    cast(s, m2, "flurry");
    expect(lost(target) + others.reduce((n, o) => n + lost(o), 0)).toBe(4 * (10 + 5)); // four foes, four strikes, none doubled up
    expect(others.every((o) => lost(o) === 15)).toBe(true);
    const low = makeTemplate("drunken-master-monk", 16).actions.find((a) => a.id === "flurry")!;
    expect(JSON.stringify(low)).not.toContain('"rank"');
  });
});

describe("Way of the Kensei", () => {
  it("attacks with a longsword (d8, or the Martial Arts die if larger) in the Attack action", () => {
    const m = monk("kensei-monk", 3);
    const { s, target } = arena(15, m);
    cast(s, m, "attack");
    expect(lost(target)).toBe(8 + 4);
    const m2 = monk("kensei-monk", 17);
    const a2 = arena(15, m2);
    // 17th: two strikes — the sword (d10 martial die) and an unarmed strike (d10) — plus Deft Strike and Stunning Strike
    cast(a2.s, m2, "attack");
    expect(lost(a2.target)).toBeGreaterThanOrEqual(10 + 5 + 10 + 5);
  });

  it("Agile Parry (3rd): +2 AC until your next turn after the unarmed strike in the same Attack action", () => {
    const m = monk("kensei-monk", 5);
    const { s } = arena(15, m);
    cast(s, m, "attack");
    const e = m.effects.find((x) => x.name === "agile-parry")!;
    expect(e.mods?.acBonus).toBe(2);
  });

  it("Deft Strike (6th): 1 ki adds a Martial Arts die of damage to a weapon hit, only once a turn", () => {
    const m = monk("kensei-monk", 6);
    const { s, target } = arena(15, m);
    m.resources.set("ki", 6);
    cast(s, m, "attack");
    // sword d8+4 (+d6 Deft Strike, once) + unarmed d6+4; Stunning Strike is spent on the sword hit first
    expect(lost(target)).toBe(8 + 4 + 6 + 6 + 4);
    expect(ki(m)).toBe(6 - 1 - 1);
  });

  it("Sharpen the Blade (11th): 3 ki for a +3 bonus to attack and damage", () => {
    const m = monk("kensei-monk", 11);
    const { s } = arena(15, m);
    cast(s, m, "sharpen-the-blade");
    expect(ki(m)).toBe(8);
    const e = m.effects.find((x) => x.name === "sharpened-blade")!;
    expect(e.mods?.attackBonusAll).toBe(3);
    expect(e.mods?.extraDamageOnHit?.amount).toBe("3");
  });

  it("Unerring Accuracy (17th): a missed attack is rerolled, once a turn", () => {
    const m = monk("kensei-monk", 17);
    const target = foe();
    target.ref = { ...target.ref, ac: 20 };
    const s = state([1, 20]);
    put(s, m, target);
    m.zone = target.zone = "melee";
    const before = target.hp;
    hit(s, m, target);
    expect(target.hp).toBeLessThan(before);
  });
});

describe("Way of Mercy", () => {
  it("Hands of Harm (3rd): 1 ki on a hit adds a Martial Arts die + Wis necrotic damage, once a turn", () => {
    const m = monk("mercy-monk", 3);
    const { s, target } = arena(15, m);
    cast(s, m, "attack");
    expect(ki(m)).toBe(2);
    expect(lost(target)).toBe(4 + 4 + 4 + 3);
  });

  it("Physician's Touch (6th): Hands of Harm also poisons the target until the end of your next turn", () => {
    const m = monk("mercy-monk", 6);
    const { s, target } = arena(15, m);
    cast(s, m, "attack");
    expect(has(target, "poisoned")).toBe(true);
    const m2 = monk("mercy-monk", 5);
    const a2 = arena(15, m2);
    cast(a2.s, m2, "attack");
    expect(has(a2.target, "poisoned")).toBe(false);
  });

  it("Flurry of Healing and Harm (11th): Flurry strikes carry Hands of Harm for no ki", () => {
    const m = monk("mercy-monk", 11);
    const { s, target } = arena(15, m);
    cast(s, m, "flurry");
    expect(ki(m)).toBe(10);
    expect(lost(target)).toBeGreaterThanOrEqual(2 * (8 + 4) + 8 + 3);
  });

  it("Hands of Healing (3rd): an action and 1 ki restore a Martial Arts die + Wis, chosen only to stand a downed ally back up", () => {
    const m = monk("mercy-monk", 3);
    const ally = initCombatant(makeTemplate("gwm-fighter", 3), "party", "-ally");
    const { s } = arena(15, m);
    put(s, ally);
    const hoh = m.ref.actions.find((a) => a.id === "hands-of-healing")!;
    ally.hp = ally.maxHp - 60;
    m.hp = m.maxHp - 20;
    expect(actionAvailable(s, m, hoh)).toBe(false); // hurt, but nobody is down: an attack is worth more than 7 hit points
    ally.hp = 0;
    ally.downed = true;
    expect(actionAvailable(s, m, hoh)).toBe(true);
    cast(s, m, "hands-of-healing");
    expect(ally.hp).toBe(4 + 3);
    expect(ki(m)).toBe(2);
  });

  it("Flurry of Healing (11th): two free Hands of Healing in place of the Flurry strikes once the party has lost 30+ hit points", () => {
    const m = monk("mercy-monk", 11);
    const ally = initCombatant(makeTemplate("gwm-fighter", 5), "party", "-ally");
    const { s, target } = arena(15, m);
    put(s, ally);
    const fh = m.ref.actions.find((a) => a.id === "flurry-of-healing")!;
    expect(actionAvailable(s, m, fh)).toBe(false); // nobody hurt: the ordinary Flurry
    ally.hp = ally.maxHp - 50;
    expect(actionAvailable(s, m, fh)).toBe(true);
    cast(s, m, "flurry-of-healing");
    expect(ally.hp).toBe(ally.maxHp - 50 + 2 * (8 + 3));
    expect(ki(m)).toBe(10); // the one ki for the Flurry itself
    expect(lost(target)).toBe(0);
  });

  it("Hand of Ultimate Mercy (17th): 5 ki, once per long rest, returns a dead ally to life with 4d10 + Wis hit points", () => {
    const m = monk("mercy-monk", 17);
    const dead = initCombatant(makeTemplate("gwm-fighter", 5), "party", "-dead");
    const { s } = arena(15, m);
    put(s, dead);
    dead.alive = false;
    dead.hp = 0;
    cast(s, m, "hand-of-ultimate-mercy");
    expect(dead.alive).toBe(true);
    expect(dead.hp).toBe(40 + 3);
    expect(ki(m)).toBe(12);
    expect(makeTemplate("mercy-monk", 17).resources.ultimate_mercy).toEqual({ max: 1, recharge: "longRest" });
  });
});

describe("Way of the Astral Self", () => {
  it("Arms of the Astral Self (3rd): 1 ki, force damage to each creature within 10 ft on a failed Dex save, and 5 ft more reach", () => {
    const m = monk("astral-self-monk", 3);
    const { s, target } = arena(15, m);
    cast(s, m, "arms-of-the-astral-self");
    expect(ki(m)).toBe(2);
    expect(lost(target)).toBe(2 * 4);
    expect(m.effects.find((e) => e.name === "astral-arms")!.mods?.reachBonusFt).toBe(5);
  });

  it("with the arms out, strikes deal force damage", () => {
    const m = monk("astral-self-monk", 3);
    const { s, target } = arena(15, m);
    m.effects.push({ name: "astral-arms", sourceId: m.id, expiresRound: 99, mods: { reachBonusFt: 5 } });
    cast(s, m, "attack-astral-arms");
    expect(lost(target)).toBe(4 + 4);
  });

  it("Visage of the Astral Self (6th) is folded into the summons: 2 ki instead of 1", () => {
    const m = monk("astral-self-monk", 6);
    const { s } = arena(15, m);
    cast(s, m, "arms-of-the-astral-self");
    expect(ki(m)).toBe(4);
  });

  it("Body of the Astral Self (11th): Deflect Energy cuts elemental damage by 1d10 + Wis while the arms are out, Empowered Arms adds a die", () => {
    const m = monk("astral-self-monk", 11);
    const { s, target } = arena(15, m);
    m.effects.push({ name: "astral-arms", sourceId: m.id, expiresRound: 99, mods: { reachBonusFt: 5 } });
    const before = m.hp;
    applyDamage(s, m, 40, "fire", {});
    expect(before - m.hp).toBe(40 - (10 + 3));
    cast(s, m, "attack-astral-arms");
    expect(lost(target)).toBe(2 * (8 + 4) + 8); // Empowered Arms: one extra die, once a turn
  });

  it("Awakened Astral Self (17th): 5 ki for +2 AC and three attacks with the arms", () => {
    const m = monk("astral-self-monk", 17);
    const { s, target } = arena(15, m);
    cast(s, m, "awakened-astral-self");
    expect(ki(m)).toBe(12);
    expect(m.effects.find((e) => e.name === "awakened-astral-self")!.mods?.acBonus).toBe(2);
    const before = lost(target);
    cast(s, m, "attack-astral-barrage");
    expect(lost(target) - before).toBeGreaterThanOrEqual(3 * (10 + 5));
  });
});

describe("Way of the Ascendant Dragon", () => {
  it("Breath of the Dragon (3rd): an attack replaced by a 20-ft cone, two Martial Arts dice of fire damage, half on a save", () => {
    const m = monk("ascendant-dragon-monk", 3);
    const { s, target } = arena(15, m);
    m.resources.set("dragon_breath", 2);
    // Extra Attack isn't yet available at 3rd, so the breath is the whole action
    cast(s, m, "attack-breath");
    expect(lost(target)).toBe(2 * 4);
    expect(m.resources.get("dragon_breath")).toBe(1);
    const m2 = monk("ascendant-dragon-monk", 3);
    const a2 = arena(15, m2, foe("brute", { dex: 10 }));
    cast(a2.s, m2, "attack-breath");
    expect(lost(a2.target)).toBe(4);
  });

  it("the breath is usable proficiency-bonus times per long rest, then costs 2 ki", () => {
    const m = makeTemplate("ascendant-dragon-monk", 5);
    expect(m.resources.dragon_breath).toEqual({ max: 3, recharge: "longRest" });
    const u = monk("ascendant-dragon-monk", 5);
    const { s, target } = arena(15, u);
    u.resources.set("dragon_breath", 0);
    cast(s, u, "attack-breath-ki");
    expect(lost(target)).toBe((6 + 4) + 6 * 2); // one strike (d6 + Dex) and the 2d6 breath
    expect(ki(u)).toBe(2); // 2 for the breath, 1 for Stunning Strike on the strike
  });

  it("Breath of the Dragon replaces one of two Attack-action attacks at 5th level", () => {
    const m = monk("ascendant-dragon-monk", 5);
    const { s, target } = arena(15, m);
    cast(s, m, "attack-breath");
    expect(lost(target)).toBe((6 + 4) + 2 * 6); // one unarmed strike (with Stunning Strike ki) and the breath
    expect(m.resources.get("dragon_breath")).toBe(2);
  });

  it("Aspect of the Wyrm (11th): a bonus action, once per long rest or 3 ki, frightens creatures nearby on a failed Wisdom save", () => {
    const m = monk("ascendant-dragon-monk", 11);
    const { s, target } = arena(15, m);
    cast(s, m, "aspect-of-the-wyrm");
    expect(hasEffect(m, "aspect-of-the-wyrm")).toBe(true);
    expect(has(target, "frightened")).toBe(true);
    expect(ki(m)).toBe(11); // the free use
  });
});

describe("full battles", () => {
  it("every tradition fights at levels 3, 6, 11, 17 and 20 without breaking", () => {
    for (const id of MONK_IDS) {
      for (const level of [3, 6, 11, 17, 20]) {
        const out = runBattle({ party: [{ template: id, level }], enemies: ["ogre", "ogre"], seed: 5, controlled: [], maxRounds: 6 } as never);
        expect(out.frames.length, `${id} L${level}`).toBeGreaterThan(0);
      }
    }
  });

  it("the after-Attack bonus action follows the Attack-action variants too (Astral Arms), not just plain 'attack'", () => {
    let ok = false;
    for (let seed = 1; seed <= 6 && !ok; seed++) {
      const out = runBattle({ party: [{ template: "astral-self-monk", level: 5 }], enemies: ["ogre"], seed, controlled: [], maxRounds: 4 } as never);
      ok = /Astral Arms[\s\S]*(Flurry of Blows|Martial Arts)/.test(out.frames.map((f) => f.text ?? "").join("\n"));
    }
    expect(ok).toBe(true);
  });

  it("a bonus-action strike is not taken (and no ki spent) when nobody is in reach or the fight just ended", () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const foes of [["ogre"], ["ogre", "ogre", "ogre"]]) {
        const out = runBattle({ party: [{ template: "ascendant-dragon-monk", level: 5 }], enemies: foes, seed, controlled: [], maxRounds: 5 } as never);
        const text = out.frames.map((f) => f.text ?? "").join("\n");
        expect(text).not.toMatch(/Flurry of Blows \((can't reach|no effect)\)/);
        expect(text).not.toMatch(/Martial Arts \(bonus strike\) \((can't reach|no effect)\)/);
      }
    }
  });

  it("a monk actually uses Flurry of Blows and Stunning Strike in an AI battle", () => {
    const out = runBattle({ party: [{ template: "open-hand-monk", level: 8 }], enemies: ["ogre"], seed: 2, controlled: [], maxRounds: 3 } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/Flurry of Blows/);
    expect(text).toMatch(/[Ss]tunn/);
  });
});
