// The bard and its colleges, checked against the printed text (dnd5e.wikidot.com/bard and each college's page). Numbers asserted here are the ones on those pages; the mechanics run through the real
// engine with rigged dice (every d20 lands on `faces`, every damage die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { fireEncounterStartTraits, runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollSave, saveModifierOf } from "../lib/sim/engine/resolve";
import { actionAvailable, spend, takePcTurn } from "../lib/sim/engine/ai";
import { applyRest } from "../lib/sim/engine/day";
import { heldDie } from "../lib/sim/engine/bardic";
import { beginTurn, effectiveAc, initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import { preparedCount } from "../lib/sim/spells/prepare";
import { BARD_BUILDERS } from "../lib/sim/spells/bardTemplates";
import { boxOfUnit } from "../lib/sim/battle/state";
import { feetBetweenBoxes } from "../lib/sim/battle/geometry";
import { battle, unitAt } from "./helpers/battle-state";
import type { Action, AutomationNode, Combatant, CreatureType, DamageType } from "../lib/sim/schema";

const COLLEGES = ["lore", "valor", "glamour", "swords", "whispers", "creation", "eloquence", "spirits"];
const IDS = COLLEGES.map((c) => `${c}-bard`);

function state(faces: number | number[] = 15, modes: string[] = []): CombatState {
  const rng = makeRng(1);
  let i = 0;
  const next = () => (Array.isArray(faces) ? faces[Math.min(i++, faces.length - 1)] : faces);
  rng.d20 = () => next();
  rng.d20mode = (m) => { modes.push(m); const f = next(); return { used: f, nat: f }; };
  rng.dice = (n, sides) => n * sides;
  return { round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [], maxRounds: 10, ended: false, verbose: true, summonCounter: 0 };
}
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));
const brd = (id: string, level = 5, suffix = "-b") => initCombatant(makeTemplate(id, level), "party", suffix);
const fighter = (level = 6, suffix = "-a") => initCombatant(makeTemplate("gwm-fighter", level), "party", suffix);
function foe(id: string, type?: CreatureType, mods: Partial<Record<keyof Combatant["abilities"], number>> = {}, over: Partial<Combatant> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4), cha: score(-4) };
  for (const [k, v] of Object.entries(mods)) abilities[k as keyof typeof abilities] = score(v as number);
  const { creatureType: _drop, ...rest } = base;
  void _drop;
  const c: Combatant = { ...rest, ac: 8, abilities, proficientSaves: [], specialRules: [], ...(type ? { creatureType: type } : {}), ...over };
  const u = initCombatant(c, "monster", `-m-${id}`); // (its own id space: `gwm-fighter-a` is also the ally fighter)
  u.hp = u.maxHp = 1000;
  return u;
}
const action = (u: CombatantState, id: string): Action => {
  const a = u.ref.actions.find((x) => x.id === id) ?? u.ref.reactions.find((x) => x.id === id);
  if (!a) throw new Error(`no action ${id}; has ${u.ref.actions.map((x) => x.id).filter((x) => !x.startsWith("cast-")).join(", ")}`);
  return a;
};
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, action(u, id));
const cast = (s: CombatState, u: CombatantState, id: string) => { spend(u, action(u, id)); act(s, u, id); };
const res = (u: CombatantState, name: string) => u.resources.get(name) ?? 0;
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
const hasCond = (u: CombatantState, c: string) => u.conditions.has(c as never);
const lost = (u: CombatantState) => u.maxHp - u.hp;
const swing = (s: CombatState, attacker: CombatantState, target: CombatantState, bonus = 99, dmg = "5", type: DamageType = "bludgeoning") =>
  runAutomation([{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: type }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });
const text = (s: CombatState) => s.log.map((l) => l.text).join("\n");
const attackNodes = (a: Action) => JSON.stringify(a.automation).match(/"type":"attack"/g)?.length ?? 0;

/** an inspired ally: the bard gives the sturdiest one a die */
function inspired(bardId: string, level: number, faces = 15) {
  const b = brd(bardId, level);
  const ally = fighter(6);
  const a = foe("a");
  const s = state(faces);
  put(s, b, ally, a);
  b.zone = ally.zone = a.zone = "melee";
  return { b, ally, a, s };
}

describe("bard — validity and parsing", () => {
  it("every college builds a schema-valid PC at every level", () => {
    expect(Object.keys(BARD_BUILDERS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      for (let lvl = 1; lvl <= 20; lvl++) {
        const r = validateCombatant(makeTemplate(id, lvl));
        if (!r.ok) console.error(`${id} L${lvl}:`, r.errors);
        expect(r.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });

  it("plain names find their college; a bare 'bard' is still the Lore bard", () => {
    for (const c of COLLEGES) expect(findClassTemplate(`college of ${c} bard`).match?.templateId, c).toBe(`${c}-bard`);
    expect(findClassTemplate("bard").match?.templateId).toBe("lore-bard");
  });
});

describe("the Bard table", () => {
  it("proficient in Dexterity and Charisma saves; a d8 hit die (10 at 1st, 7 more a level)", () => {
    expect(makeTemplate("lore-bard", 5).proficientSaves).toEqual(["dex", "cha"]);
    expect(makeTemplate("lore-bard", 1).maxHp).toBe(10);
    expect(makeTemplate("lore-bard", 20).maxHp).toBe(10 + 19 * 7);
  });

  it("spells known are the table's 4 rising to 22 — the Magical Secrets cantrip from 10th counts among them — and Lore's extra pair from 6th comes on top", () => {
    const distinct = (id: string, l: number) => {
      const c = makeTemplate(id, l);
      const ids = new Set<string>();
      for (const a of [...c.actions, ...c.reactions]) if (a.isSpell && (a.spellLevel ?? 0) > 0) ids.add(a.id.replace(/^cast-/, "").replace(/-\d+$/, ""));
      return ids.size;
    };
    for (let l = 1; l <= 20; l++) {
      const table = preparedCount("bard", "full", l, 4);
      expect(distinct("valor-bard", l), `valor ${l}`).toBe(table - (l >= 10 ? 1 : 0));
      expect(distinct("lore-bard", l), `lore ${l}`).toBe(table - (l >= 10 ? 1 : 0) + (l >= 6 ? 2 : 0));
    }
  });

  it("Magical Secrets (10th): Eldritch Blast and Counterspell are the first pair, from another class's list", () => {
    const c10 = makeTemplate("valor-bard", 10);
    expect(c10.actions.some((a) => a.id === "cast-eldritch-blast")).toBe(true);
    expect(c10.reactions.some((a) => a.id === "counterspell")).toBe(true);
    const c9 = makeTemplate("valor-bard", 9);
    expect(c9.actions.some((a) => a.id === "cast-eldritch-blast")).toBe(false);
    expect(c9.reactions.some((a) => a.id === "counterspell")).toBe(false);
  });

  it("Bardic Inspiration: Charisma-modifier uses, on a LONG rest until Font of Inspiration (5th) makes it a short rest", () => {
    expect(makeTemplate("lore-bard", 1).resources.bardic_inspiration).toEqual({ max: 4, recharge: "longRest" });
    expect(makeTemplate("lore-bard", 4).resources.bardic_inspiration).toEqual({ max: 4, recharge: "longRest" });
    expect(makeTemplate("lore-bard", 5).resources.bardic_inspiration).toEqual({ max: 4, recharge: "shortRest" });
    expect(makeTemplate("lore-bard", 17).resources.bardic_inspiration?.max).toBe(5); // Charisma 20
  });

  it("the die is a d6, d8 from 5th, d10 from 10th, d12 from 15th", () => {
    const die = (l: number) => {
      const { b, ally, s } = inspired("lore-bard", l);
      cast(s, b, "bardic-inspiration");
      return heldDie(ally)?.mods?.inspirationDie;
    };
    expect([1, 4, 5, 9, 10, 14, 15, 20].map(die)).toEqual(["1d6", "1d6", "1d8", "1d8", "1d10", "1d10", "1d12", "1d12"]);
  });

  it("Jack of All Trades (2nd): half the proficiency bonus on initiative", () => {
    const init = (l: number) => makeTemplate("lore-bard", l).initiativeBonus;
    expect([1, 2, 5, 9, 13, 17].map(init)).toEqual([2, 3, 3, 4, 4, 5]);
  });

  it("Song of Rest (2nd): an extra die on a short rest for whoever spends Hit Dice — d6, d8 at 9th, d10 at 13th, d12 at 17th", () => {
    const faces = (l: number) => { const r = makeTemplate("lore-bard", l).specialRules.find((x) => x.rule === "songOfRest"); return r && r.rule === "songOfRest" ? r.faces : 0; };
    expect([1, 2, 8, 9, 13, 17].map(faces)).toEqual([0, 6, 6, 8, 10, 12]);
    const heal = (withBard: boolean) => {
      const f = fighter(6);
      f.hp = 5;
      const others = withBard ? [brd("lore-bard", 6, "-song")] : [];
      applyRest([f, ...others], "short", new Map([[f.id, 6], ...others.map((o) => [o.id, 6] as [string, number])]), 6);
      return f.hp;
    };
    expect(heal(true) - heal(false)).toBe(Math.round(7 / 2)); // a d6's average
  });

  it("Countercharm (6th): an action — advantage on saves against being frightened or charmed for the bard and friends within 30 feet — taken on the first round against a foe that can do either", () => {
    expect(makeTemplate("lore-bard", 5).actions.some((a) => a.id === "countercharm")).toBe(false);
    const b = brd("lore-bard", 6);
    const ally = fighter(6);
    const scary = foe("s", undefined, {}, { actions: [{ id: "roar", name: "Frightful Roar", cost: { action: 1 }, recharge: "none", automation: [{ type: "target", who: { who: "eachEnemy" }, effects: [{ type: "applyCondition", condition: "frightened", durationRounds: 5 }] }] }] });
    const s = state();
    put(s, b, ally, scary);
    expect(makeTemplate("lore-bard", 6).ai.opener).toContain("countercharm");
    expect(actionAvailable(s, b, action(b, "countercharm"))).toBe(true);
    const plain = foe("p");
    const s2 = state();
    put(s2, brd("lore-bard", 6), fighter(6), plain);
    expect(actionAvailable(s2, [...s2.units.values()][0], action([...s2.units.values()][0], "countercharm"))).toBe(false); // nothing to be afraid of
    act(s, b, "countercharm");
    expect(hasEffect(ally, "countercharm")).toBe(true);
    const modes: string[] = [];
    s.rng.d20mode = (m) => { modes.push(m); return { used: 12, nat: 12 }; };
    rollSave(s, ally, "wis", 15, { conditions: ["frightened"] });
    expect(modes).toContain("adv");
    modes.length = 0;
    rollSave(s, ally, "wis", 15, { conditions: ["poisoned"] });
    expect(modes).not.toContain("adv");
  });

  it("Superior Inspiration (20th): rolling initiative with no uses left gives one back", () => {
    const b = brd("lore-bard", 20);
    const s = state();
    put(s, b, foe("f"));
    b.resources.set("bardic_inspiration", 0);
    fireEncounterStartTraits(s);
    expect(res(b, "bardic_inspiration")).toBe(1);
    fireEncounterStartTraits(s);
    expect(res(b, "bardic_inspiration")).toBe(1); // only when it has none
  });
});

describe("Bardic Inspiration in play", () => {
  it("a bonus action gives the sturdiest ally without a die one — never the bard itself, never twice to the same creature", () => {
    const b = brd("valor-bard", 5);
    const tank = fighter(9, "-tank");
    const light = fighter(3, "-light");
    const s = state();
    put(s, b, tank, light, foe("f"));
    cast(s, b, "bardic-inspiration");
    expect(heldDie(tank)).toBeDefined();
    expect(heldDie(light)).toBeUndefined();
    expect(heldDie(b)).toBeUndefined();
    cast(s, b, "bardic-inspiration");
    expect(heldDie(light)).toBeDefined(); // the next one who hasn't a die
    expect(actionAvailable(s, b, action(b, "bardic-inspiration"))).toBe(false); // everyone has one
    expect(res(b, "bardic_inspiration")).toBe(2);
  });

  it("a Lore bard keeps its last use back for Cutting Words; a Valor bard gives it away", () => {
    const grantable = (id: string) => {
      const b = brd(id, 5);
      const s = state();
      put(s, b, fighter(6), foe("f"));
      b.resources.set("bardic_inspiration", 1);
      return actionAvailable(s, b, action(b, "bardic-inspiration"));
    };
    expect(grantable("lore-bard")).toBe(false);
    expect(grantable("valor-bard")).toBe(true);
  });

  it("an attack roll that falls short by no more than the die is turned into a hit — after the d20 is seen — and the die is spent", () => {
    const { b, ally, a, s } = inspired("valor-bard", 5); // a d8
    cast(s, b, "bardic-inspiration");
    // 15 + (-10) = 5 against armor class 8: three short; the die is rigged to its maximum
    swing(s, ally, a, -10, "5");
    expect(lost(a)).toBeGreaterThanOrEqual(5);
    expect(heldDie(ally)).toBeUndefined();
    expect(text(s)).toMatch(/adds their Bardic Inspiration \(\+8\)/);
  });

  it("...and not when the die couldn't turn it: it stays for later", () => {
    const { b, ally, a, s } = inspired("valor-bard", 5);
    cast(s, b, "bardic-inspiration");
    swing(s, ally, a, -20, "5"); // 15 - 20 = -5: thirteen short of armor class 8, and a d8 is 8 at most
    expect(lost(a)).toBe(0);
    expect(heldDie(ally)).toBeDefined();
  });

  it("a saving throw that falls short by no more than the die is turned into a success", () => {
    const { b, ally, s } = inspired("lore-bard", 5);
    cast(s, b, "bardic-inspiration");
    const total = 15 + saveModifierOf(ally, "wis");
    expect(rollSave(s, ally, "wis", total + 4).passed).toBe(true); // 4 short; a d8 (8)
    expect(heldDie(ally)).toBeUndefined();
    expect(rollSave(s, ally, "wis", total + 4).passed).toBe(false); // no die left
  });

  it("the die is only worth spending when it can help: a save that already passes doesn't use it", () => {
    const { b, ally, s } = inspired("lore-bard", 5);
    cast(s, b, "bardic-inspiration");
    rollSave(s, ally, "wis", 5);
    expect(heldDie(ally)).toBeDefined();
  });
});

describe("College of Lore", () => {
  it("Cutting Words (3rd): a reaction and a use — subtract the die from an attack roll against an ally that would just hit", () => {
    const b = brd("lore-bard", 3);
    const ally = fighter(6);
    const a = foe("a");
    const s = state(10);
    put(s, b, ally, a);
    b.zone = ally.zone = a.zone = "melee";
    const bonus = ally.ac - 10 + 1; // it hits by 1
    swing(s, a, ally, bonus, "10");
    expect(lost(ally)).toBe(0);
    expect(b.reactionUsed).toBe(true);
    expect(res(b, "bardic_inspiration")).toBe(3);
    expect(makeTemplate("lore-bard", 2).reactions.some((r) => r.id === "cutting-words")).toBe(false);
  });

  it("...or from a damage roll: a big blow that has already hit loses a die of damage", () => {
    const b = brd("lore-bard", 5);
    const ally = fighter(6);
    const a = foe("a");
    const s = state(15);
    put(s, b, ally, a);
    b.zone = ally.zone = a.zone = "melee";
    applyDamage(s, ally, 30, "slashing", { sourceId: a.id, viaAttack: true, attackerMagical: true });
    expect(lost(ally)).toBe(30 - 8); // a d8 at 5th level, rigged to 8
    expect(b.reactionUsed).toBe(true);
    b.reactionUsed = false;
    const small = fighter(6, "-b2");
    put(s, small);
    applyDamage(s, small, 5, "slashing", { sourceId: a.id, viaAttack: true, attackerMagical: true });
    expect(lost(small)).toBe(5); // not worth a die
  });

  it("Additional Magical Secrets (6th): two more spells from any class, on top of the known total", () => {
    const names = (l: number) => makeTemplate("lore-bard", l).actions.filter((a) => a.isSpell).map((a) => a.id);
    expect(names(6).some((id) => id.startsWith("cast-fireball"))).toBe(true);
    expect(names(5).some((id) => id.startsWith("cast-fireball"))).toBe(false);
    expect(makeTemplate("valor-bard", 6).actions.some((a) => a.id.startsWith("cast-fireball"))).toBe(false);
  });
});

describe("College of Valor", () => {
  it("Bonus Proficiencies (3rd): medium armor and a shield — armor class 18", () => {
    expect(makeTemplate("valor-bard", 2).ac).toBe(14);
    expect(makeTemplate("valor-bard", 3).ac).toBe(18);
  });

  it("Combat Inspiration (3rd), defense: hit, the holder's reaction adds the die to its armor class — after seeing the roll — and turns the hit into a miss", () => {
    const { b, ally, a, s } = inspired("valor-bard", 5);
    cast(s, b, "bardic-inspiration");
    swing(s, a, ally, ally.ac - 15 + 2, "20"); // it hits by 2
    expect(lost(ally)).toBe(0);
    expect(ally.reactionUsed).toBe(true);
    expect(heldDie(ally)).toBeUndefined();
    expect(text(s)).toMatch(/to their armor class/);
  });

  it("Combat Inspiration, damage: a weapon damage roll it just made gains the die", () => {
    const { b, ally, a, s } = inspired("valor-bard", 5);
    cast(s, b, "bardic-inspiration");
    swing(s, ally, a, 99, "5");
    expect(lost(a)).toBe(5 + 8);
    expect(heldDie(ally)).toBeUndefined();
  });

  it("...kept for armor class when the holder is hurt; and not on the other colleges' dice", () => {
    const { b, ally, a, s } = inspired("valor-bard", 5);
    cast(s, b, "bardic-inspiration");
    ally.hp = Math.floor(ally.maxHp / 2) - 1;
    swing(s, ally, a, 99, "5");
    expect(lost(a)).toBe(5);
    expect(heldDie(ally)).toBeDefined();
    const other = inspired("lore-bard", 5);
    cast(other.s, other.b, "bardic-inspiration");
    swing(other.s, other.ally, other.a, 99, "5");
    expect(lost(other.a)).toBe(5); // Combat Inspiration is Valor's
  });

  it("Extra Attack (6th)", () => {
    const weapon = (l: number) => makeTemplate("valor-bard", l).actions.find((a) => a.id === "attack")!;
    expect(attackNodes(weapon(5))).toBe(1);
    expect(attackNodes(weapon(6))).toBe(2);
  });

  it("Battle Magic (14th): casting a bard spell with the action allows a weapon attack as a bonus action", () => {
    const c = makeTemplate("valor-bard", 14);
    expect(c.ai.bonusAfterSpell).toEqual(["battle-magic"]);
    expect(makeTemplate("valor-bard", 13).ai.bonusAfterSpell).toBeUndefined();
    // a bard with nobody to inspire has its bonus action free: after a spell with its action it attacks with a weapon
    const b = brd("valor-bard", 14);
    const a = foe("a");
    const s = state();
    s.rng.next = () => 0.9; // (no hesitation this turn)
    put(s, b, a);
    takePcTurn(s, b, 14);
    const log = text(s);
    expect(log).toMatch(/Bard 14-b uses (?!Battle Magic)[^\n]*/);
    expect(log).toMatch(/uses Battle Magic/);
    expect(b.actionUsedThisTurn && b.bonusUsedThisTurn).toBe(true);
  });
});

describe("College of Glamour", () => {
  it("Mantle of Inspiration (3rd): a bonus action and a use — up to Charisma-modifier creatures gain 5 temporary hit points (8 at 5th, 11 at 10th, 14 at 15th)", () => {
    const temp = (l: number) => {
      const b = brd("glamour-bard", l);
      const allies = [1, 2, 3, 4, 5, 6].map((n) => fighter(6, `-a${n}`));
      const s = state();
      put(s, b, ...allies, foe("f"));
      cast(s, b, "mantle-of-inspiration");
      return [...allies, b].filter((u) => u.tempHp > 0).map((u) => u.tempHp);
    };
    expect(temp(3)).toEqual([5, 5, 5, 5]); // Charisma modifier 4 creatures
    expect(temp(5)[0]).toBe(8);
    expect(temp(10)[0]).toBe(11);
    expect(temp(15)[0]).toBe(14);
  });

  it("Mantle of Majesty (6th): once a long rest — for a minute (concentration) Command as a bonus action each turn without a slot", () => {
    const b = brd("glamour-bard", 6);
    const a = foe("a");
    const s = state(1);
    put(s, b, a);
    expect(actionAvailable(s, b, action(b, "command-majesty"))).toBe(false); // not yet
    cast(s, b, "mantle-of-majesty");
    expect(b.concentratingOn).toBe("mantle-of-majesty");
    expect(actionAvailable(s, b, action(b, "command-majesty"))).toBe(true);
    const slots = [1, 2, 3].map((n) => res(b, `slot${n}`));
    act(s, b, "command-majesty");
    expect(hasCond(a, "incapacitated") || hasCond(a, "prone") || a.effects.length > 0 || a.conditions.size > 0).toBe(true);
    expect([1, 2, 3].map((n) => res(b, `slot${n}`))).toEqual(slots);
    expect(actionAvailable(s, b, action(b, "mantle-of-majesty"))).toBe(false); // once a long rest
  });

  it("Unbreakable Majesty (14th): the first attack against the bard each turn needs a Charisma save — a failure wastes it; a success gives the bard's spells disadvantage on that creature's saves", () => {
    const b = brd("glamour-bard", 14);
    const a = foe("a");
    const s = state(1); // the save fails
    put(s, b, a);
    b.zone = a.zone = "melee";
    cast(s, b, "unbreakable-majesty");
    swing(s, a, b, 99, "30");
    expect(lost(b)).toBe(0);
    expect(text(s)).toMatch(/Unbreakable Majesty/);
    swing(s, a, b, 99, "30");
    expect(lost(b)).toBe(0); // "it can't attack you on this turn"
    const b2 = brd("glamour-bard", 14, "-b2");
    const a2 = foe("a2", undefined, { cha: 5 });
    const s2 = state(20); // the save succeeds
    put(s2, b2, a2);
    b2.zone = a2.zone = "melee";
    cast(s2, b2, "unbreakable-majesty");
    swing(s2, a2, b2, 99, "30");
    expect(lost(b2)).toBe(30);
    expect(hasEffect(a2, "majesty-shaken")).toBe(true);
  });
});

describe("College of Swords", () => {
  it("Bonus Proficiencies and Fighting Style (3rd): medium armor (AC 16), a scimitar, Dueling's +2 to damage", () => {
    const c = makeTemplate("swords-bard", 3);
    expect(c.ac).toBe(16);
    expect(JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation)).toContain('"amount":"1d6+4"');
    expect(makeTemplate("swords-bard", 2).actions.find((a) => a.id === "attack")!.name).toBe("Rapier");
  });

  it("Blade Flourish (3rd): the Attack action gives 10 feet of speed, and a hit may use ONE flourish that spends a use of Bardic Inspiration", () => {
    const c = makeTemplate("swords-bard", 5);
    for (const id of ["attack-defensive-flourish", "attack-slashing-flourish", "attack-mobile-flourish"]) {
      const a = c.actions.find((x) => x.id === id)!;
      expect(a.limitedUse).toEqual({ resource: "bardic_inspiration", amount: 1 });
      expect(JSON.stringify(a.automation)).toContain('"speedBonusFt":10');
    }
    expect(makeTemplate("swords-bard", 2).actions.some((a) => a.id.includes("flourish"))).toBe(false);
  });

  it("Defensive Flourish: the die as extra damage, and its number added to armor class until the start of the bard's next turn", () => {
    const b = brd("swords-bard", 5);
    const a = foe("a");
    const s = state();
    put(s, b, a);
    b.zone = a.zone = "melee";
    const ac = effectiveAc(b);
    cast(s, b, "attack-defensive-flourish");
    // a scimitar (1d6 + Dex 2 + Dueling 2 = 10) and a d8 flourish at its maximum
    expect(lost(a)).toBe(10 + 8);
    expect(effectiveAc(b)).toBe(ac + 4); // the die's average: 4 on a d8
    expect(res(b, "bardic_inspiration")).toBe(3);
    beginTurn(s, b);
    expect(effectiveAc(b)).toBe(ac);
  });

  it("Slashing Flourish: the die as damage to the target and another creature; Mobile Flourish pushes the target 5 feet plus the die", () => {
    const b = brd("swords-bard", 5);
    const a = foe("a");
    const other = foe("o");
    const s = state();
    put(s, b, a, other);
    b.zone = a.zone = other.zone = "melee";
    cast(s, b, "attack-slashing-flourish");
    expect(lost(a) + lost(other)).toBe(10 + 8 + 8);
    const g = battle();
    const b2 = unitAt(g, "b", "party", 5, 5, {}, "swords-bard", 5);
    const t = unitAt(g, "t", "monster", 6, 5, { ac: 8 });
    t.hp = t.maxHp = 1000;
    runAction(g, b2, action(b2, "attack-mobile-flourish"));
    expect(g.pos.get(t.id)).toEqual({ x: 7, y: 5 }); // 5 + 4 (the die's average) = 9 feet: one whole square
  });

  it("Extra Attack (6th); Master's Flourish (14th): a d6 in place of the die, spending nothing", () => {
    expect(attackNodes(makeTemplate("swords-bard", 5).actions.find((a) => a.id === "attack")!)).toBe(1);
    expect(attackNodes(makeTemplate("swords-bard", 6).actions.find((a) => a.id === "attack")!)).toBe(2);
    const b = brd("swords-bard", 14);
    const a = foe("a");
    const s = state();
    put(s, b, a);
    b.zone = a.zone = "melee";
    const uses = res(b, "bardic_inspiration");
    cast(s, b, "attack-defensive-flourish-master");
    expect(res(b, "bardic_inspiration")).toBe(uses);
    expect(lost(a)).toBe(2 * 10 + 6); // two scimitar hits, and the d6 once
    expect(makeTemplate("swords-bard", 13).actions.some((x) => x.id.endsWith("-master"))).toBe(false);
  });
});

describe("College of Whispers", () => {
  it("Psychic Blades (3rd): a weapon hit spends a use for extra psychic damage — 2d6, 3d6 at 5th, 5d6 at 10th, 8d6 at 15th — once", () => {
    const dealt = (l: number) => {
      const b = brd("whispers-bard", l);
      const a = foe("a");
      const s = state();
      put(s, b, a);
      b.zone = a.zone = "melee";
      const uses = res(b, "bardic_inspiration");
      cast(s, b, "attack-psychic-blades");
      expect(res(b, "bardic_inspiration")).toBe(uses - 1);
      return lost(a) - 8; // less the rapier's 1d8 (rigged to 8) + Dex 2... the weapon damage below
    };
    const weapon = 8 + 2;
    expect([3, 5, 10, 15].map((l) => dealt(l) + 8 - weapon)).toEqual([12, 18, 30, 48]);
  });

  it("Shadow Lore (14th): once a long rest, a creature makes a Wisdom save or is charmed until it is hurt", () => {
    const b = brd("whispers-bard", 14);
    const a = foe("a");
    const s = state(1);
    put(s, b, a);
    cast(s, b, "shadow-lore");
    expect(hasCond(a, "charmed")).toBe(true);
    expect(actionAvailable(s, b, action(b, "shadow-lore"))).toBe(false);
    s.rng.d20mode = () => ({ used: 15, nat: 15 });
    swing(s, b, a);
    expect(hasCond(a, "charmed")).toBe(false);
  });
});

describe("College of Creation", () => {
  it("Mote of Potential (3rd), attack roll: the die also makes the target save (Constitution) or take thunder damage equal to the number rolled", () => {
    const { b, ally, a, s } = inspired("creation-bard", 5);
    cast(s, b, "bardic-inspiration");
    swing(s, ally, a, -10, "5"); // the die turns the miss into a hit
    expect(lost(a)).toBe(5 + 8); // the blow, and the mote's thunder damage (the save fails)
    expect(heldDie(ally)).toBeUndefined();
  });

  it("Mote of Potential, saving throw: the die is joined by temporary hit points equal to it plus Charisma", () => {
    const { b, ally, s } = inspired("creation-bard", 5);
    cast(s, b, "bardic-inspiration");
    const total = 15 + saveModifierOf(ally, "wis");
    expect(rollSave(s, ally, "wis", total + 3).passed).toBe(true);
    expect(ally.tempHp).toBe(8 + 4);
  });

  it("Animating Performance (6th): an action — once a long rest, or a 3rd-level slot again — animates a Dancing Item: armor class 16, 10 + 5 x the level hit points, fly 30", () => {
    const b = brd("creation-bard", 6);
    const a = foe("a");
    const s = state();
    put(s, b, a);
    expect(makeTemplate("creation-bard", 5).actions.some((x) => x.id === "animating-performance")).toBe(false);
    cast(s, b, "animating-performance");
    const item = [...s.units.values()].find((u) => u.summonerId === b.id)!;
    expect([item.ref.creatureType, item.ac, item.maxHp, item.ref.speeds.fly, item.ref.abilities.str]).toEqual(["construct", 16, 10 + 5 * 6, 30, 18]);
    expect(item.ref.immunities).toEqual(expect.arrayContaining(["poison", "psychic"]));
    expect(actionAvailable(s, b, action(b, "animating-performance"))).toBe(false);
    expect(actionAvailable(s, b, action(b, "animating-performance-slot"))).toBe(false); // it is already out
  });

  it("the Dancing Item Dodges on its own and slams when the bard spends a bonus action: 1d10 + the proficiency bonus force, at the bard's spell attack", () => {
    const b = brd("creation-bard", 6);
    const a = foe("a");
    const s = state();
    put(s, b, a);
    cast(s, b, "animating-performance");
    const item = [...s.units.values()].find((u) => u.summonerId === b.id)!;
    const slam = item.ref.actions.find((x) => x.id === "slam")!;
    expect(JSON.stringify(slam.automation)).toContain('"bonus":7'); // proficiency 3 + Charisma 4
    cast(s, b, "command-dancing-item");
    expect(lost(a)).toBe(10 + 3);
    expect(item.commandedRound).toBe(1);
  });
});

describe("College of Eloquence", () => {
  it("Unsettling Words (3rd): a bonus action and a use — the target subtracts the die from the next saving throw it makes, and only that one", () => {
    const b = brd("eloquence-bard", 5);
    const a = foe("a");
    const s = state(10);
    put(s, b, a);
    cast(s, b, "unsettling-words");
    expect(hasEffect(a, "unsettling-words")).toBe(true);
    expect(rollSave(s, a, "wis", 8).passed).toBe(false); // 10 + (-4) - 8 (the die, rigged to 8)
    expect(hasEffect(a, "unsettling-words")).toBe(false);
    expect(rollSave(s, a, "con", 6).passed).toBe(true); // 10 - 4 = 6, no malus now
  });

  it("Unsettling Words isn't repeated on a creature it is already on, and keeps a use back", () => {
    const b = brd("eloquence-bard", 5);
    const a = foe("a");
    const s = state();
    put(s, b, a);
    cast(s, b, "unsettling-words");
    expect(actionAvailable(s, b, action(b, "unsettling-words"))).toBe(false);
    const b2 = brd("eloquence-bard", 5, "-b2");
    b2.resources.set("bardic_inspiration", 1);
    const s2 = state();
    put(s2, b2, foe("f"));
    expect(actionAvailable(s2, b2, action(b2, "unsettling-words"))).toBe(false);
  });

  it("Unfailing Inspiration (6th): a die spent on a roll that still fails isn't lost", () => {
    const keep = (level: number) => {
      const { b, ally, a, s } = inspired("eloquence-bard", level);
      cast(s, b, "bardic-inspiration");
      s.rng.dice = () => 1; // the die comes up 1: not enough
      swing(s, ally, a, -10, "5"); // three short: a die of 1 can't do it
      return heldDie(ally) !== undefined;
    };
    expect(keep(6)).toBe(true);
    expect(keep(5)).toBe(false);
  });

  it("Infectious Inspiration (14th): a die that makes a roll succeed gives another creature a die, by reaction, Charisma-modifier times a long rest", () => {
    const b = brd("eloquence-bard", 14);
    const one = fighter(6, "-one");
    const two = fighter(6, "-two");
    const a = foe("a");
    const s = state();
    put(s, b, one, two, a);
    b.zone = one.zone = two.zone = a.zone = "melee";
    cast(s, b, "bardic-inspiration");
    expect(heldDie(one) ?? heldDie(two)).toBeDefined();
    const holder = heldDie(one) ? one : two;
    const other = holder === one ? two : one;
    expect(heldDie(other)).toBeUndefined();
    swing(s, holder, a, -10, "5"); // the die turns a miss into a hit
    expect(heldDie(other)).toBeDefined();
    expect(b.reactionUsed).toBe(true);
    expect(res(b, "infectious_inspiration")).toBe(3);
    expect(makeTemplate("eloquence-bard", 13).reactions.some((r) => r.id === "infectious-inspiration")).toBe(false);
  });
});

describe("College of Spirits", () => {
  const setTale = (b: CombatantState, n: number) => { b.effects.push({ name: `tale-${n}`, expiresRound: 99, sourceId: b.id }, { name: "tale-held", expiresRound: 99, sourceId: b.id }); };

  it("Tales from Beyond (3rd): a bonus action and a use roll a tale, which the bard keeps until it tells it — and only one at a time", () => {
    const b = brd("spirits-bard", 5);
    const s = state();
    s.rng.next = () => 0; // the first option
    put(s, b, foe("f"));
    cast(s, b, "spirit-tale-roll");
    expect(hasEffect(b, "tale-held")).toBe(true);
    expect(b.effects.filter((e) => /^tale-\d$/.test(e.name))).toHaveLength(1);
    expect(actionAvailable(s, b, action(b, "spirit-tale-roll"))).toBe(false);
  });

  it("Mystical Connection (14th): the better of two rolls — the weights favor the strongest tales", () => {
    const weights = (l: number) => (JSON.stringify(action(brd("spirits-bard", l), "spirit-tale-roll").automation).match(/"weight":(\d+)/g) ?? []).map((w) => Number(w.slice(9)));
    expect(weights(5)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(weights(14)).toEqual([11, 9, 7, 5, 3, 1]);
  });

  it("Tale of the Renowned Duelist: a melee spell attack — two dice of the Bardic Inspiration die plus Charisma, force", () => {
    const b = brd("spirits-bard", 5);
    const a = foe("a");
    const s = state();
    put(s, b, a);
    b.zone = a.zone = "melee";
    setTale(b, 2);
    act(s, b, "tell-tale");
    expect(lost(a)).toBe(16 + 4);
    expect(hasEffect(b, "tale-held")).toBe(false);
  });

  it("Tale of the Beloved Friends: the target and one other gain a die plus Charisma in temporary hit points", () => {
    const b = brd("spirits-bard", 5);
    const ally = fighter(6);
    const s = state();
    put(s, b, ally, foe("f"));
    setTale(b, 3);
    act(s, b, "tell-tale");
    expect([b.tempHp, ally.tempHp]).toEqual([8 + 4, 8 + 4]);
  });

  it("Tale of the Avenger: for a minute whoever hits the target in melee takes a die of force damage", () => {
    const b = brd("spirits-bard", 5);
    const ally = fighter(9);
    const a = foe("a");
    const s = state();
    put(s, b, ally, a);
    b.zone = ally.zone = a.zone = "melee";
    setTale(b, 5);
    act(s, b, "tell-tale");
    swing(s, a, ally, 99, "5");
    expect(lost(a)).toBe(8);
  });

  it("Tale of the Traveler: a die plus the bard level in temporary hit points, +10 feet of speed and +1 armor class", () => {
    const b = brd("spirits-bard", 5);
    const ally = fighter(9);
    const s = state();
    put(s, b, ally, foe("f"));
    setTale(b, 6);
    const ac = effectiveAc(ally);
    act(s, b, "tell-tale");
    expect(ally.tempHp).toBe(8 + 5);
    expect(effectiveAc(ally)).toBe(ac + 1);
  });

  it("Tale of the Runaway: a teleport up to 30 feet", () => {
    const g = battle(40, 20);
    const b = unitAt(g, "b", "party", 10, 10, {}, "spirits-bard", 5);
    const o = unitAt(g, "o", "monster", 11, 10, { ac: 8 });
    setTale(b, 4);
    runAction(g, b, action(b, "tell-tale"));
    expect(feetBetweenBoxes(boxOfUnit(g, b), boxOfUnit(g, o))).toBeGreaterThanOrEqual(25);
  });

  it("Spiritual Focus (6th): a d6 added to one damage or healing roll of a bard spell", () => {
    const heal = (l: number) => JSON.stringify(action(brd("spirits-bard", l), "cast-cure-wounds-1").automation);
    expect(heal(5)).not.toContain("+1d6");
    expect(heal(6)).toContain("+1d6");
    expect(JSON.stringify(action(brd("lore-bard", 6), "cast-cure-wounds-1").automation)).not.toContain("+1d6");
  });
});

describe("bards in battle", () => {
  it("every college fights at levels 2, 6, 10, 14 and 20 without breaking", () => {
    for (const id of IDS) {
      for (const level of [2, 6, 10, 14, 20]) {
        const out = runBattle({ party: [{ template: id, level }, { template: "gwm-fighter", level }], enemies: ["ogre", "ghoul"], seed: 5, controlled: [], maxRounds: 6 } as never);
        expect(out.frames.length, `${id} L${level}`).toBeGreaterThan(0);
      }
    }
  });

  it("a bard inspires its allies, and they spend the die", () => {
    let granted = false;
    let spent = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: "valor-bard", level: 5, name: "Brd" }, { template: "gwm-fighter", level: 5 }], enemies: ["ogre", "ogre", "ogre"], seed, controlled: [], maxRounds: 8 } as never);
      const log = out.frames.map((f) => f.text ?? "").join("\n");
      if (/Brd uses Bardic Inspiration/.test(log)) granted = true;
      if (/adds their Bardic Inspiration/.test(log)) spent = true;
    }
    expect(granted).toBe(true);
    expect(spent).toBe(true);
  });
});
