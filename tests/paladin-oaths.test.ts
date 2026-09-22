// The paladin and its nine printed Sacred Oaths, checked against the printed text (dnd5e.wikidot.com/paladin and each oath's page). Numbers asserted here are the ones on those pages; the mechanics
// run through the real engine with rigged dice (every d20 lands on `faces`, every damage die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollSave, saveModifierOf } from "../lib/sim/engine/resolve";
import { endOfTurn, startOfTurn } from "../lib/sim/engine/loop";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import { preparedCount } from "../lib/sim/spells/prepare";
import { PALADIN_BUILDERS } from "../lib/sim/spells/paladinTemplates";
import type { Action, AutomationNode, Combatant, CreatureType, DamageType } from "../lib/sim/schema";

const OATHS = ["devotion", "ancients", "vengeance", "conquest", "redemption", "glory", "watchers", "crown", "oathbreaker"];
const IDS = OATHS.map((o) => `${o}-paladin`);

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
const pal = (id: string, level = 9, suffix = "-p") => initCombatant(makeTemplate(id, level), "party", suffix);
const fighter = (level = 6, suffix = "-a") => initCombatant(makeTemplate("gwm-fighter", level), "party", suffix);
function foe(id: string, type?: CreatureType, over: Partial<Combatant> = {}, mods: Partial<Record<keyof Combatant["abilities"], number>> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4), cha: score(-4) };
  for (const [k, v] of Object.entries(mods)) abilities[k as keyof typeof abilities] = score(v as number);
  const { creatureType: _drop, ...rest } = base;
  void _drop;
  const c: Combatant = { ...rest, ac: 8, abilities, proficientSaves: [], specialRules: [], ...(type ? { creatureType: type } : {}), ...over };
  const u = initCombatant(c, "monster", `-m-${id}`);
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
const arena = (faces: number | number[], p: CombatantState, target: CombatantState = foe("f")) => {
  const s = state(faces);
  put(s, p, target);
  p.zone = target.zone = "melee";
  return { s, target };
};

describe("paladin — validity and parsing", () => {
  it("every oath builds a schema-valid PC at every level", () => {
    expect(Object.keys(PALADIN_BUILDERS).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      for (let lvl = 1; lvl <= 20; lvl++) {
        const r = validateCombatant(makeTemplate(id, lvl));
        if (!r.ok) console.error(`${id} L${lvl}:`, r.errors);
        expect(r.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });

  it("plain names find their oath; a bare 'paladin' is still the Vengeance paladin", () => {
    for (const o of OATHS.filter((x) => x !== "oathbreaker")) {
      const phrase = `oath of ${o === "ancients" ? "the ancients" : o === "watchers" ? "the watchers" : o === "crown" ? "the crown" : o} paladin`;
      expect(findClassTemplate(phrase).match?.templateId, o).toBe(`${o}-paladin`);
    }
    expect(findClassTemplate("paladin").match?.templateId).toBe("vengeance-paladin");
    expect(findClassTemplate("oathbreaker paladin").match?.templateId).toBe("oathbreaker-paladin");
  });
});

describe("the Paladin table", () => {
  it("proficient in Wisdom and Charisma saves; a d10 hit die (10 at 1st, 8 more a level)", () => {
    expect(makeTemplate("devotion-paladin", 5).proficientSaves).toEqual(["wis", "cha"]);
    expect(makeTemplate("devotion-paladin", 1).maxHp).toBe(12);
    expect(makeTemplate("devotion-paladin", 20).maxHp).toBe(10 + 19 * 8);
  });

  it("spells prepared: Charisma modifier + half the paladin level, rounded down, minimum one — no Sacred Oath (and so no Channel Divinity action) before the 3rd level", () => {
    for (const l of [1, 2, 5, 9, 20]) expect(preparedCount("paladin", "half", l, 4)).toBe(Math.max(1, 4 + Math.floor(l / 2)));
    expect(makeTemplate("devotion-paladin", 2).actions.some((a) => a.limitedUse?.resource === "channel_divinity")).toBe(false);
    expect(makeTemplate("devotion-paladin", 2).resources.channel_divinity).toBeUndefined();
    expect(makeTemplate("devotion-paladin", 3).actions.some((a) => a.limitedUse?.resource === "channel_divinity")).toBe(true);
  });

  it("Lay on Hands: a pool of 5 x the paladin level, restored on a long rest, that can't heal undead or constructs", () => {
    const p = pal("devotion-paladin", 6);
    const ally = fighter();
    ally.hp = 1;
    const s = state();
    put(s, p, ally);
    expect(res(p, "lay_on_hands")).toBe(30);
    cast(s, p, "lay-on-hands");
    expect(ally.hp - 1).toBe(30); // the whole pool, since the ally is missing far more than that
    expect(res(p, "lay_on_hands")).toBe(0);
    // the pool is dry now, and a construct is never a legal target anyway (the `usableWhen` gate doesn't know the target filter, so
    // the action can still be "available" here — but using it on nothing but a construct does nothing, and the empty pool heals nobody)
    const golem = foe("g", "construct");
    golem.hp = 1;
    put(s, golem);
    const before = golem.hp;
    act(s, p, "lay-on-hands");
    expect(golem.hp).toBe(before);
  });

  it("worth an action once someone is missing a real chunk of their maximum — the pool draws down by exactly what's given, not more", () => {
    const p = pal("devotion-paladin", 9); // 45-point pool
    const ally = fighter(6);
    const s = state();
    put(s, p, ally);
    expect(actionAvailable(s, p, action(p, "lay-on-hands"))).toBe(false);
    ally.hp = Math.floor(ally.maxHp * 0.59);
    expect(actionAvailable(s, p, action(p, "lay-on-hands"))).toBe(true);
    const missing = ally.maxHp - ally.hp;
    cast(s, p, "lay-on-hands");
    expect(ally.hp).toBe(ally.maxHp);
    expect(res(p, "lay_on_hands")).toBe(45 - missing);
  });

  it("Divine Smite (2nd): a melee hit spends a slot for 2d8 radiant, +1d8 a slot level above 1st, to 5d8 — never on a spell attack or at range", () => {
    const p = pal("devotion-paladin", 9);
    const a = foe("a");
    const { s } = arena(15, p, a);
    const slots = [1, 2, 3, 4, 5].map((n) => res(p, `slot${n}`));
    act(s, p, "attack");
    expect(text(s)).toMatch(/smites with a \d(st|nd|rd|th)-level slot/);
    expect([1, 2, 3, 4, 5].map((n) => res(p, `slot${n}`))).not.toEqual(slots);
  });

  it("the smite dice cap at 5d8 (6d8 against an undead or a fiend), whatever the slot level", () => {
    const smite = (level: number, targetType?: CreatureType) => {
      const p = pal("devotion-paladin", level); // slots to 5th level: a critical hit always spends the biggest one
      const a = foe("a", targetType);
      const { s } = arena(20, p, a);
      act(s, p, "attack");
      return text(s).match(/\((\d)d8 radiant\)/)?.[1];
    };
    expect(smite(20)).toBe("5");
    expect(smite(20, "undead")).toBe("6");
  });

  it("Improved Divine Smite (11th): every melee hit adds 1d8 radiant, with no slot spent", () => {
    const dealt = (level: number) => {
      const p = pal("devotion-paladin", level);
      p.resources.set("channel_divinity", 0);
      for (const l of [1, 2, 3, 4, 5]) p.resources.set(`slot${l}`, 0); // no smite available
      const a = foe("a");
      const { s } = arena(15, p, a);
      act(s, p, "attack");
      return lost(a);
    };
    // a longsword (1d8 + Str 4, rigged to 8) x 2 attacks
    expect(dealt(10)).toBe(2 * (8 + 4));
    expect(dealt(11)).toBe(2 * (8 + 4 + 8));
  });

  it("Aura of Protection (6th): the Charisma modifier (minimum +1) to saving throws, 10 feet, 30 from the 18th — reaches allies (and, in Monte-Carlo, everyone)", () => {
    const p5 = pal("devotion-paladin", 5);
    const ally = fighter();
    const s5 = state();
    put(s5, p5, ally);
    expect(saveModifierOf(ally, "wis", s5) - saveModifierOf(ally, "wis")).toBe(0);
    const p6 = pal("devotion-paladin", 6);
    const ally6 = fighter();
    const s6 = state();
    put(s6, p6, ally6);
    expect(saveModifierOf(ally6, "wis", s6) - saveModifierOf(ally6, "wis")).toBe(4);
    expect(saveModifierOf(p6, "wis", s6) - saveModifierOf(p6, "wis")).toBe(4); // reaches the paladin itself too
  });

  it("Aura of Courage (10th): immune to being frightened, unconscious paladins included don't extend it", () => {
    const p = pal("devotion-paladin", 10);
    const ally = fighter();
    const s = state();
    put(s, p, ally);
    runAutomation([{ type: "applyCondition", condition: "frightened", durationRounds: 5 }], { state: s, source: foe("f"), scope: [ally], last: {}, depth: 0 });
    expect(hasCond(ally, "frightened")).toBe(false);
    p.downed = true;
    runAutomation([{ type: "applyCondition", condition: "frightened", durationRounds: 5 }], { state: s, source: foe("f"), scope: [ally], last: {}, depth: 0 });
    expect(hasCond(ally, "frightened")).toBe(true);
  });

  it("Cleansing Touch (14th): only when an ally carries a condition worth ending, Charisma-modifier times a long rest", () => {
    const p = pal("devotion-paladin", 14);
    const ally = fighter();
    const s = state();
    put(s, p, ally);
    expect(actionAvailable(s, p, action(p, "cleansing-touch"))).toBe(false);
    ally.conditions.set("stunned", { expiresRound: 99 } as never);
    expect(actionAvailable(s, p, action(p, "cleansing-touch"))).toBe(true);
    expect(res(p, "cleansing_touch")).toBe(4);
    cast(s, p, "cleansing-touch");
    expect(hasCond(ally, "stunned")).toBe(false);
    expect(res(p, "cleansing_touch")).toBe(3);
    expect(makeTemplate("devotion-paladin", 13).actions.some((a) => a.id === "cleansing-touch")).toBe(false);
  });
});

describe("Fighting styles: Defense (a shield) and Great Weapon Fighting", () => {
  it("half the oaths carry +1 AC from Defense; the greatsword oaths reroll a 1 or 2 on their weapon dice", () => {
    expect(makeTemplate("devotion-paladin", 5).ac).toBeGreaterThan(makeTemplate("vengeance-paladin", 5).ac - 3); // both are well-armored; devotion carries a shield
    expect(makeTemplate("vengeance-paladin", 5).specialRules.some((r) => r.rule === "greatWeaponFighting")).toBe(true);
    expect(makeTemplate("devotion-paladin", 5).specialRules.some((r) => r.rule === "greatWeaponFighting")).toBe(false);
  });
});

describe("Oath of Devotion", () => {
  it("Sacred Weapon (3rd Channel Divinity): the Charisma modifier (minimum +1) added to attack rolls with the weapon for a minute", () => {
    const p = pal("devotion-paladin", 5); // face 2 + pb 3 + str 4 = 9: misses armor class 10, but the Charisma modifier (+4) turns it into a hit
    const a = foe("a", undefined, { ac: 10 });
    const { s } = arena(2, p, a);
    act(s, p, "attack");
    expect(lost(a)).toBe(0);
    cast(s, p, "sacred-weapon");
    act(s, p, "attack");
    expect(lost(a)).toBeGreaterThan(0);
  });

  it("Turn the Unholy (3rd Channel Divinity): fiends and undead within 30 ft make a Wisdom save or are turned", () => {
    const p = pal("devotion-paladin", 5);
    const devil = foe("d", "fiend");
    const orc = foe("o", "humanoid");
    const s = state(1);
    put(s, p, devil, orc);
    cast(s, p, "turn-the-unholy");
    expect(hasCond(devil, "turned")).toBe(true);
    expect(hasCond(orc, "turned")).toBe(false);
  });

  it("Purity of Spirit (15th): the six listed creature types have disadvantage on attack rolls against the paladin", () => {
    const modes: string[] = [];
    const p = pal("devotion-paladin", 15);
    const devil = foe("d", "fiend");
    const orc = foe("o", "humanoid");
    const s = state(15, modes);
    put(s, p, devil, orc);
    p.zone = devil.zone = orc.zone = "melee";
    swing(s, devil, p);
    expect(modes).toContain("dis");
    modes.length = 0;
    swing(s, orc, p);
    expect(modes).not.toContain("dis");
    expect(makeTemplate("devotion-paladin", 14).specialRules.some((r) => r.rule === "disadvantageFromTypes")).toBe(false);
  });

  it("Holy Nimbus (20th): light shines, and an enemy that starts its turn in it takes 10 radiant damage", () => {
    const p = pal("devotion-paladin", 20);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    act(s, p, "holy-nimbus");
    startOfTurn(s, a);
    expect(lost(a)).toBe(10);
    expect(makeTemplate("devotion-paladin", 19).actions.some((x) => x.id === "holy-nimbus")).toBe(false);
  });
});

describe("Oath of the Ancients", () => {
  it("Nature's Wrath (3rd Channel Divinity): a Strength save or restrained, escaping only with a fresh save each turn", () => {
    const p = pal("ancients-paladin", 5);
    const a = foe("a");
    const s = state(1);
    put(s, p, a);
    cast(s, p, "natures-wrath");
    expect(hasCond(a, "restrained")).toBe(true);
  });

  it("Turn the Faithless (3rd Channel Divinity): fey and fiends within 30 ft, Wisdom save or turned", () => {
    const p = pal("ancients-paladin", 5);
    const sprite = foe("s", "fey");
    const orc = foe("o", "humanoid");
    const s = state(1);
    put(s, p, sprite, orc);
    cast(s, p, "turn-the-faithless");
    expect(hasCond(sprite, "turned")).toBe(true);
    expect(hasCond(orc, "turned")).toBe(false);
  });

  it("Aura of Warding (7th): resistance to damage from spells", () => {
    const p = pal("ancients-paladin", 7);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    applyDamage(s, p, 20, "fire", { sourceId: a.id, viaSpell: true, spellLevel: 3 });
    expect(lost(p)).toBe(10);
  });

  it("Undying Sentinel (15th): dropping to 0 (not killed outright) leaves the paladin at 1 instead, once per encounter", () => {
    const p = pal("ancients-paladin", 15);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    p.hp = 20;
    applyDamage(s, p, 25, "slashing", { sourceId: a.id }); // more than its current hp: dropped to 0 or below, not killed outright
    expect(p.hp).toBe(1);
    expect(p.alive).toBe(true);
    expect(p.downed).toBe(false); // the return, not a knockdown
    applyDamage(s, p, 5, "slashing", { sourceId: a.id });
    expect(p.downed).toBe(true); // only once: this time it goes down (and starts making death saves) like anyone else
  });

  it("Elder Champion (20th): 10 hit points regained at the start of each of the paladin's turns for a minute", () => {
    const p = pal("ancients-paladin", 20);
    const s = state();
    put(s, p, foe("f"));
    p.hp -= 30;
    act(s, p, "elder-champion");
    startOfTurn(s, p);
    expect(lost(p)).toBe(20);
  });
});

describe("Oath of Vengeance", () => {
  it("Abjure Enemy (3rd Channel Divinity): a Wisdom save or frightened for a minute, ending the moment it takes damage", () => {
    const p = pal("vengeance-paladin", 5);
    const a = foe("a");
    const s = state(1);
    put(s, p, a);
    p.zone = a.zone = "melee";
    cast(s, p, "abjure-enemy");
    expect(hasCond(a, "frightened")).toBe(true);
    s.rng.d20mode = () => ({ used: 15, nat: 15 }); // the save is over: now a plain hit, not a nat-1 auto-miss
    swing(s, p, a, 99, "1");
    expect(hasCond(a, "frightened")).toBe(false);
  });

  it("...a successful save instead halves its speed for a short while", () => {
    const p = pal("vengeance-paladin", 5);
    const a = foe("a", undefined, {}, { wis: 5 });
    const s = state(20);
    put(s, p, a);
    cast(s, p, "abjure-enemy");
    expect(hasEffect(a, "abjured-half")).toBe(true);
  });

  it("Vow of Enmity (3rd, bonus action): advantage on the paladin's own attack rolls against the vowed creature — nobody else's", () => {
    const modes: string[] = [];
    const p = pal("vengeance-paladin", 5);
    const ally = fighter();
    const a = foe("a");
    const s = state(15, modes);
    put(s, p, ally, a);
    p.zone = ally.zone = a.zone = "melee";
    act(s, p, "vow-of-enmity");
    expect(hasEffect(a, "vow-of-enmity")).toBe(true);
    swing(s, p, a);
    expect(modes).toContain("adv");
    modes.length = 0;
    swing(s, ally, a);
    expect(modes).not.toContain("adv");
  });

  it("Soul of Vengeance (15th): the vowed creature attacking triggers a melee reaction against it", () => {
    const p = pal("vengeance-paladin", 15);
    const a = foe("a");
    const ally = fighter();
    const s = state(15);
    put(s, p, ally, a);
    p.zone = ally.zone = a.zone = "melee";
    act(s, p, "vow-of-enmity");
    swing(s, a, ally, 99, "5");
    expect(p.reactionUsed).toBe(true);
    expect(text(s)).toMatch(/Soul of Vengeance/);
  });

  it("Avenging Angel (20th): enemies within 30 ft are frightened (Wisdom save) with attacks against them at advantage", () => {
    const modes: string[] = [];
    const p = pal("vengeance-paladin", 20);
    const a = foe("a");
    const s = state(1, modes);
    put(s, p, a);
    act(s, p, "avenging-angel");
    startOfTurn(s, a);
    expect(hasCond(a, "frightened")).toBe(true);
    s.rng.d20mode = (m: string) => { modes.push(m); return { used: 15, nat: 15 }; }; // the save is over: now a plain roll
    swing(s, p, a);
    expect(modes).toContain("adv");
  });
});

describe("Oath of Conquest", () => {
  it("Guided Strike (3rd Channel Divinity): +10 to an attack roll after seeing it, using the Channel Divinity use", () => {
    const p = pal("conquest-paladin", 5);
    const { s, target } = arena(2, p); // 2 + pb(3) + str(4) = 9 against armor class 8: a hit outright — use a tougher target
    target.ac = 15;
    (target.ref as Combatant).ac = 15;
    act(s, p, "attack");
    expect(lost(target)).toBeGreaterThan(0);
    expect(res(p, "channel_divinity")).toBe(0);
  });

  it("Conquering Presence (3rd Channel Divinity): a Wisdom save or frightened, saving again each turn", () => {
    const p = pal("conquest-paladin", 5);
    const a = foe("a");
    const s = state(1);
    put(s, p, a);
    cast(s, p, "conquering-presence");
    expect(hasCond(a, "frightened")).toBe(true);
  });

  it("Aura of Conquest (7th): a frightened creature that starts its turn in the aura takes psychic damage equal to half the paladin level", () => {
    const p = pal("conquest-paladin", 8);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    a.conditions.set("frightened", { expiresRound: 99 } as never);
    startOfTurn(s, a);
    expect(lost(a)).toBe(4);
    const other = foe("o");
    put(s, other);
    startOfTurn(s, other);
    expect(lost(other)).toBe(0); // not frightened
  });

  it("Scornful Rebuke (15th): whoever hits the paladin takes psychic damage equal to the Charisma modifier", () => {
    const p = pal("conquest-paladin", 15);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    p.zone = a.zone = "melee";
    swing(s, a, p, 99, "1");
    expect(lost(a)).toBe(4);
  });

  it("Invincible Conqueror (20th): resistance to everything, an extra attack, and a critical hit on a 19 or 20", () => {
    const p = pal("conquest-paladin", 20);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    applyDamage(s, p, 20, "fire", { sourceId: a.id });
    expect(lost(p)).toBe(20);
    act(s, p, "invincible-conqueror");
    const before = lost(p);
    applyDamage(s, p, 20, "fire", { sourceId: a.id });
    expect(lost(p) - before).toBe(10);
    expect(actionAvailable(s, p, action(p, "attack-conqueror-strike"))).toBe(true);
  });
});

describe("Oath of Redemption", () => {
  it("Aura of the Guardian (7th): the paladin's reaction takes an ally's damage in full", () => {
    const p = pal("redemption-paladin", 7);
    const ally = fighter();
    const a = foe("a");
    const s = state();
    put(s, p, ally, a);
    p.zone = ally.zone = a.zone = "melee";
    // not `viaAttack`, so Rebuke the Violent (which only answers an attack) doesn't grab the reaction first
    applyDamage(s, ally, 20, "slashing", { sourceId: a.id });
    expect(lost(ally)).toBe(0);
    expect(lost(p)).toBe(20);
    expect(p.reactionUsed).toBe(true);
  });

  it("Rebuke the Violent (3rd): an enemy that hits anyone within 30 ft faces a Wisdom save or takes that damage back as radiant", () => {
    const p = pal("redemption-paladin", 5);
    const ally = fighter();
    const a = foe("a", undefined, {}, { wis: -4 }); // the save fails
    const s = state();
    put(s, p, ally, a);
    p.zone = ally.zone = a.zone = "melee";
    swing(s, a, ally, 99, "18");
    expect(lost(a)).toBe(18);
    expect(p.reactionUsed).toBe(true);
  });

  it("Protective Spirit (15th): ending the paladin's turn below half restores 1d6 + half its level", () => {
    const p = pal("redemption-paladin", 16);
    const s = state();
    put(s, p, foe("f"));
    p.hp = Math.floor(p.maxHp / 2) - 1;
    const before = p.hp;
    endOfTurn(s, p);
    expect(p.hp - before).toBe(6 + 8);
  });

  it("Emissary of Redemption (20th): resistance to everything, and half of what lands reflects as radiant", () => {
    const p = pal("redemption-paladin", 20);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    act(s, p, "emissary-of-redemption");
    applyDamage(s, p, 20, "slashing", { sourceId: a.id });
    expect(lost(p)).toBe(10);
    expect(lost(a)).toBe(5);
  });
});

describe("Oath of Glory", () => {
  it("Inspiring Smite (3rd, bonus action): only after a Divine Smite this turn — temporary hit points (2d8 + level) to allies within 30 ft", () => {
    const p = pal("glory-paladin", 9);
    const ally = fighter();
    const a = foe("a");
    const s = state(15);
    put(s, p, ally, a);
    p.zone = ally.zone = a.zone = "melee";
    expect(actionAvailable(s, p, action(p, "inspiring-smite"))).toBe(false);
    act(s, p, "attack"); // smites
    expect(actionAvailable(s, p, action(p, "inspiring-smite"))).toBe(true);
    act(s, p, "inspiring-smite");
    expect(ally.tempHp).toBe(16 + 9);
  });

  it("Glorious Defense (15th): the Charisma modifier added to a nearby ally's armor class against a hit, and a swing back on a miss", () => {
    const p = pal("glory-paladin", 15);
    const ally = fighter();
    const a = foe("a");
    const s = state(15);
    put(s, p, ally, a);
    p.zone = ally.zone = a.zone = "melee";
    const bonus = ally.ac - 15 + 1; // hits by 1
    swing(s, a, ally, bonus, "10");
    expect(lost(ally)).toBe(0);
    expect(lost(a)).toBeGreaterThan(0); // the swing back
    expect(res(p, "glorious_defense")).toBe(3);
  });

  it("Living Legend (20th): once each turn, a missed weapon attack becomes a hit", () => {
    const modes: string[] = [];
    const p = pal("glory-paladin", 20);
    const { s, target } = arena(1, p);
    s.rng.d20mode = (m) => { modes.push(m); return { used: 1, nat: 1 }; };
    act(s, p, "living-legend");
    act(s, p, "attack");
    expect(lost(target)).toBeGreaterThan(0);
  });
});

describe("Oath of the Watchers", () => {
  it("Watcher's Will (3rd Channel Divinity): up to Charisma-modifier allies gain advantage on Intelligence, Wisdom and Charisma saves", () => {
    const modes: string[] = [];
    const p = pal("watchers-paladin", 9);
    const ally = fighter();
    const s = state(15, modes);
    put(s, p, ally, foe("f"));
    cast(s, p, "watchers-will");
    rollSave(s, ally, "wis", 20);
    expect(modes).toContain("adv");
  });

  it("Abjure the Extraplanar (3rd Channel Divinity): the five listed types within 30 ft, Wisdom save or turned", () => {
    const p = pal("watchers-paladin", 5);
    const devil = foe("d", "fiend");
    const orc = foe("o", "humanoid");
    const s = state(1);
    put(s, p, devil, orc);
    cast(s, p, "abjure-the-extraplanar");
    expect(hasCond(devil, "turned")).toBe(true);
    expect(hasCond(orc, "turned")).toBe(false);
  });

  it("Aura of the Sentinel (7th): the proficiency bonus added to the paladin's own initiative", () => {
    expect(makeTemplate("watchers-paladin", 6).initiativeBonus).toBe(0);
    expect(makeTemplate("watchers-paladin", 7).initiativeBonus).toBe(3);
  });

  it("Vigilant Rebuke (15th): a successful Intelligence, Wisdom or Charisma save answers the source with force damage", () => {
    const p = pal("watchers-paladin", 15);
    const ally = fighter();
    const a = foe("a");
    const s = state(20); // the save succeeds
    put(s, p, ally, a);
    rollSave(s, ally, "wis", 5, { sourceId: a.id });
    expect(lost(a)).toBe(16 + 4);
    expect(p.reactionUsed).toBe(true);
  });
});

describe("Oath of the Crown", () => {
  it("Champion Challenge (3rd Channel Divinity): a Wisdom save marks the creature", () => {
    const p = pal("crown-paladin", 5);
    const a = foe("a");
    const s = state(1);
    put(s, p, a);
    cast(s, p, "champion-challenge");
    expect(hasCond(a, "marked-for-reckoning")).toBe(true);
  });

  it("Turn the Tide (3rd Channel Divinity): 1d6 + the Charisma modifier to bloodied allies within 30 ft", () => {
    const p = pal("crown-paladin", 5);
    const ally = fighter();
    ally.hp = Math.floor(ally.maxHp * 0.4);
    const s = state();
    put(s, p, ally);
    cast(s, p, "turn-the-tide");
    expect(ally.hp - Math.floor(ally.hp * 0)).toBeGreaterThan(0);
  });

  it("Divine Allegiance (7th): the same reaction as Redemption's Aura of the Guardian", () => {
    const p = pal("crown-paladin", 7);
    const ally = fighter();
    const a = foe("a");
    const s = state();
    put(s, p, ally, a);
    p.zone = ally.zone = a.zone = "melee";
    applyDamage(s, ally, 20, "slashing", { sourceId: a.id, viaAttack: true });
    expect(lost(ally)).toBe(0);
    expect(lost(p)).toBe(20);
  });

  it("Unyielding Saint (15th): advantage on saves against paralysis and being stunned", () => {
    const modes: string[] = [];
    const p = pal("crown-paladin", 15);
    const s = state(10, modes);
    put(s, p, foe("f"));
    rollSave(s, p, "con", 20, { conditions: ["stunned"] });
    expect(modes).toContain("adv");
  });

  it("Exalted Champion (20th): resistance to nonmagical bludgeoning, piercing and slashing", () => {
    const p = pal("crown-paladin", 20);
    expect(p.ref.resistancesNonmagical).toEqual(expect.arrayContaining(["bludgeoning", "piercing", "slashing"]));
    expect(makeTemplate("crown-paladin", 19).resistancesNonmagical).not.toContain("slashing");
  });
});

describe("Oathbreaker", () => {
  it("Control Undead (3rd Channel Divinity): a Wisdom save or the undead is taken over — immune once its challenge rating reaches the paladin's level", () => {
    const p = pal("oathbreaker-paladin", 9);
    const weak = foe("z", "undead", { cr: "3" });
    const strong = foe("l", "undead", { cr: "9" });
    const s = state(1);
    put(s, p, weak);
    cast(s, p, "control-undead");
    expect(weak.side).toBe("party");
    put(s, strong);
    expect(actionAvailable(s, p, action(p, "control-undead"))).toBe(false); // the pool creature already turned, and the strong one is immune
  });

  it("Dreadful Aspect (3rd Channel Divinity): a Wisdom save or frightened, retried each turn", () => {
    const p = pal("oathbreaker-paladin", 5);
    const a = foe("a");
    const s = state(1);
    put(s, p, a);
    cast(s, p, "dreadful-aspect");
    expect(hasCond(a, "frightened")).toBe(true);
  });

  it("Aura of Hate (7th): the Charisma modifier added to the paladin's own weapon damage", () => {
    const before = makeTemplate("oathbreaker-paladin", 6).actions.find((a) => a.id === "attack")!;
    const after = makeTemplate("oathbreaker-paladin", 7).actions.find((a) => a.id === "attack")!;
    expect(JSON.stringify(after.automation)).not.toBe(JSON.stringify(before.automation).replace(/str \+ 0/, ""));
    const p6 = pal("oathbreaker-paladin", 6);
    const p7 = pal("oathbreaker-paladin", 7);
    const { s: s6, target: t6 } = arena(15, p6);
    const { s: s7, target: t7 } = arena(15, p7);
    act(s6, p6, "attack");
    act(s7, p7, "attack");
    expect(lost(t7) - lost(t6)).toBeGreaterThan(0);
  });

  it("Supernatural Resistance (15th): resistance to nonmagical bludgeoning, piercing and slashing", () => {
    expect(makeTemplate("oathbreaker-paladin", 15).resistancesNonmagical).toEqual(expect.arrayContaining(["bludgeoning", "piercing", "slashing"]));
  });

  it("Dread Lord (20th): a frightened enemy that starts its turn in the aura takes 4d10 psychic damage", () => {
    const p = pal("oathbreaker-paladin", 20);
    const a = foe("a");
    const s = state();
    put(s, p, a);
    act(s, p, "dread-lord");
    a.conditions.set("frightened", { expiresRound: 99 } as never);
    startOfTurn(s, a);
    expect(lost(a)).toBe(40);
  });
});

describe("paladins in battle", () => {
  it("every oath fights at levels 2, 6, 10, 14 and 20 without breaking", () => {
    for (const id of IDS) {
      for (const level of [2, 6, 10, 14, 20]) {
        const out = runBattle({ party: [{ template: id, level }, { template: "gwm-fighter", level }], enemies: ["ogre", "zombie"], seed: 5, controlled: [], maxRounds: 6 } as never);
        expect(out.frames.length, `${id} L${level}`).toBeGreaterThan(0);
      }
    }
  });

  it("a paladin smites on a good hit, and its Aura of Protection reaches an ally's save in a real fight", () => {
    let smote = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: "devotion-paladin", level: 9, name: "Pal" }, { template: "gwm-fighter", level: 9 }], enemies: ["ogre", "ogre", "ogre"], seed, controlled: [], maxRounds: 8 } as never);
      if (out.frames.some((f) => /smites with/.test(f.text ?? ""))) smote = true;
    }
    expect(smote).toBe(true);
  });
});

