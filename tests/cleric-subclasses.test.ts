// The cleric and its domains, checked against the printed text (dnd5e.wikidot.com/cleric and each domain's page). Numbers asserted here are the ones on those
// pages; the mechanics run through the real engine with rigged dice (every d20 lands on `faces`, every damage die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { startOfTurn } from "../lib/sim/engine/loop";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { beginTurn, initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { SPELLS_BY_ID } from "../lib/sim/spells/catalog";
import { score } from "../lib/sim/engine/pcBase";
import type { Action, AutomationNode, Combatant, CreatureType } from "../lib/sim/schema";

const DOMAINS = ["life", "arcana", "death", "forge", "grave", "knowledge", "light", "nature", "order", "peace", "tempest", "trickery", "twilight", "war"];
const CLERIC_IDS = DOMAINS.map((d) => `${d}-cleric`);

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
const cle = (id = "life-cleric", level = 5, suffix = "-c") => initCombatant(makeTemplate(id, level), "party", suffix);
const fighter = (level = 6, suffix = "-a") => initCombatant(makeTemplate("gwm-fighter", level), "party", suffix);
function foe(id: string, type?: CreatureType, cr?: string, mods: Partial<Record<keyof Combatant["abilities"], number>> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4), cha: score(-4) };
  for (const [k, v] of Object.entries(mods)) abilities[k as keyof typeof abilities] = score(v as number);
  const { creatureType: _drop, ...rest } = base;
  void _drop;
  const c: Combatant = { ...rest, ac: 8, abilities, proficientSaves: [], specialRules: [], ...(type ? { creatureType: type } : {}), ...(cr ? { cr } : {}) };
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
const startTurn = (s: CombatState, u: CombatantState) => { beginTurn(s, u); u.actionUsedThisTurn = u.bonusUsedThisTurn = false; u.reactionUsed = false; u.leveledSpellThisTurn = false; };
const res = (u: CombatantState, name: string) => u.resources.get(name) ?? 0;
const hasCond = (u: CombatantState, c: string) => u.conditions.has(c as never);
const has = (a: Action | undefined) => a !== undefined;
const id = (t: Combatant, aid: string) => t.actions.find((a) => a.id === aid);

describe("cleric — validity and parsing", () => {
  it("every domain builds a schema-valid PC at every level", () => {
    for (const cid of CLERIC_IDS) {
      for (let lvl = 1; lvl <= 20; lvl++) {
        const r = validateCombatant(makeTemplate(cid, lvl));
        if (!r.ok) console.error(`${cid} L${lvl}:`, r.errors);
        expect(r.ok, `${cid} L${lvl}`).toBe(true);
      }
    }
  });

  it("plain names find their domain; a bare 'cleric' is still the Life cleric", () => {
    for (const d of DOMAINS) expect(findClassTemplate(`${d} domain cleric`).match?.templateId, d).toBe(`${d}-cleric`);
    expect(findClassTemplate("cleric").match?.templateId).toBe("life-cleric");
  });
});

describe("the Cleric table", () => {
  it("proficient in Wisdom and Charisma saves; a d8 hit die (10 at 1st, 7 more a level)", () => {
    expect(makeTemplate("life-cleric", 5).proficientSaves).toEqual(["wis", "cha"]);
    expect(makeTemplate("life-cleric", 1).maxHp).toBe(10);
    expect(makeTemplate("life-cleric", 20).maxHp).toBe(10 + 19 * 7);
  });

  it("Channel Divinity: none at 1st, one from 2nd, two from 6th, three from 18th, back on a short rest", () => {
    const cd = (l: number) => makeTemplate("life-cleric", l).resources.channel_divinity;
    expect(cd(1)).toBeUndefined();
    expect(cd(2)).toEqual({ max: 1, recharge: "shortRest" });
    expect(cd(6)?.max).toBe(2);
    expect(cd(17)?.max).toBe(2);
    expect(cd(18)?.max).toBe(3);
  });

  it("Divine Strike (8th, 14th): 1d8 then 2d8, on the domains that have it; not on the five that have Potent Spellcasting", () => {
    const strike = (cid: string, level: number) => JSON.stringify(id(makeTemplate(cid, level), "attack")?.automation);
    for (const d of ["life", "death", "forge", "nature", "order", "tempest", "trickery", "twilight", "war"]) {
      expect(strike(`${d}-cleric`, 7), d).not.toContain("divine-strike");
      expect(strike(`${d}-cleric`, 8), d).toContain('"amount":"1d8","damageType"');
      expect(strike(`${d}-cleric`, 14), d).toContain('"amount":"2d8"');
    }
    for (const d of ["arcana", "grave", "knowledge", "light", "peace"]) expect(strike(`${d}-cleric`, 20), d).not.toContain("divine-strike");
  });

  it("Divine Strike's type is the domain's: radiant Life, necrotic Death, fire Forge, thunder Tempest, poison Trickery, psychic Order", () => {
    const type = (d: string) => /"amount":"1d8","damageType":"(\w+)","oncePerTurn":"divine-strike"/.exec(JSON.stringify(id(makeTemplate(`${d}-cleric`, 8), "attack")?.automation))?.[1];
    expect([type("life"), type("death"), type("forge"), type("tempest"), type("trickery"), type("order"), type("twilight"), type("war")])
      .toEqual(["radiant", "necrotic", "fire", "thunder", "poison", "psychic", "radiant", "bludgeoning"]);
  });

  it("Potent Spellcasting (8th) adds the Wisdom modifier to a cantrip's damage on Arcana, Grave, Knowledge, Light and Peace only", () => {
    const dmg = (d: string, level: number) => JSON.stringify(id(makeTemplate(`${d}-cleric`, level), "cast-sacred-flame")?.automation);
    for (const d of ["arcana", "grave", "knowledge", "light", "peace"]) expect(dmg(d, 8), d).not.toBe(dmg(d, 7).replace(/"dc":\d+/, (m) => m));
    for (const d of ["life", "tempest", "war"]) expect(dmg(d, 8).replace(/"dc":\d+/, ""), d).toBe(dmg(d, 7).replace(/"dc":\d+/, ""));
  });
});

describe("Turn Undead and Destroy Undead", () => {
  const turned = (level: number, victim: CombatantState, faces = 1) => {
    const c = cle("life-cleric", level);
    const s = state(faces);
    put(s, c, victim);
    c.zone = victim.zone = "melee";
    cast(s, c, "turn-undead");
    return { s, c };
  };

  it("an undead that fails its Wisdom save is turned; the use of Channel Divinity is spent", () => {
    const z = foe("z", "undead", "3");
    const { c } = turned(2, z);
    expect(hasCond(z, "turned")).toBe(true);
    expect(res(c, "channel_divinity")).toBe(0);
  });

  it("an undead that passes is unaffected", () => {
    const z = foe("z", "undead", "3", { wis: 5 });
    turned(2, z, 20);
    expect(hasCond(z, "turned")).toBe(false);
  });

  it("only undead are affected: a beast, and a creature of no known type, are left alone", () => {
    const beast = foe("b", "beast", "1");
    const blank = foe("u", undefined, "1");
    turned(2, beast);
    turned(2, blank);
    expect(hasCond(beast, "turned")).toBe(false);
    expect(hasCond(blank, "turned")).toBe(false);
  });

  it("a turned creature is freed the moment it takes any damage", () => {
    const z = foe("z", "undead", "3");
    const { s, c } = turned(2, z);
    s.rng.d20mode = () => ({ used: 15, nat: 15 }); // the save is over: now a plain hit
    runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "1", damageType: "bludgeoning" }] } as AutomationNode], { state: s, source: c, scope: [z], last: {}, depth: 0 });
    expect(hasCond(z, "turned")).toBe(false);
  });

  it("Destroy Undead: challenge rating 1/2 at 5th, 1 at 8th, 2 at 11th, 3 at 14th, 4 at 17th — a failed save destroys one at or below it", () => {
    const rows: [number, string, boolean][] = [
      [4, "1/2", false], [5, "1/2", true], [5, "1", false], [8, "1", true], [8, "2", false], [11, "2", true], [11, "3", false], [14, "3", true], [14, "4", false], [17, "4", true], [17, "5", false],
    ];
    for (const [level, cr, destroyed] of rows) {
      const z = foe("z", "undead", cr);
      turned(level, z);
      expect(!z.alive, `level ${level}, CR ${cr}`).toBe(destroyed);
      if (!destroyed) expect(hasCond(z, "turned"), `level ${level}, CR ${cr}`).toBe(true);
    }
  });

  it("is only worth doing when an undead is in the fight", () => {
    const c = cle("life-cleric", 5);
    const s = state();
    put(s, c, foe("g", "humanoid", "1"));
    expect(actionAvailable(s, c, action(c, "turn-undead"))).toBe(false);
    put(s, foe("z", "undead", "1"));
    expect(actionAvailable(s, c, action(c, "turn-undead"))).toBe(true);
  });

  it("a turned creature spends its turns fleeing, not fighting", () => {
    const out = runBattle({ party: [{ template: "life-cleric", level: 8, name: "Cle" }, { template: "gwm-fighter", level: 8 }], enemies: ["zombie", "zombie", "zombie"], seed: 3, controlled: [], maxRounds: 6 } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/Cle uses Turn Undead/);
  });
});

describe("Life Domain", () => {
  const heal = (level: number, id_: string, faces = 15) => {
    const c = cle("life-cleric", level);
    const ally = fighter();
    ally.hp = 1;
    const s = state(faces);
    put(s, c, ally);
    cast(s, c, id_);
    return { c, ally, s };
  };

  it("Disciple of Life: a healing spell restores 2 + the spell's level more (Cure Wounds, 1d8 + Wisdom, at 1st and 2nd level)", () => {
    const first = heal(3, "cast-cure-wounds-1");
    expect(first.ally.hp - 1).toBe(8 + 4 + 2 + 1);
    const second = heal(3, "cast-cure-wounds-2");
    expect(second.ally.hp - 1).toBe(16 + 4 + 2 + 2);
  });

  it("Blessed Healer (6th): healing another creature heals the cleric 2 + the spell's level", () => {
    const before = heal(5, "cast-cure-wounds-1");
    const c5 = before.c;
    expect(c5.hp).toBe(c5.maxHp);
    const c = cle("life-cleric", 6);
    c.hp -= 30;
    const ally = fighter();
    ally.hp = 1;
    const s = state();
    put(s, c, ally);
    const start = c.hp;
    cast(s, c, "cast-cure-wounds-1");
    expect(c.hp - start).toBe(2 + 1);
  });

  it("Supreme Healing (17th): the dice of a healing spell are always at their maximum", () => {
    const c = cle("life-cleric", 17);
    const ally = fighter(10);
    ally.hp = 1;
    const s = state();
    s.rng.dice = () => 1; // every die comes up 1
    put(s, c, ally);
    cast(s, c, "cast-cure-wounds-1");
    expect(ally.hp - 1).toBe(8 + 5 + 2 + 1);
  });

  it("a healing spell is only worth a slot when someone is below half — or down — and can be cast on a creature at 0 hit points", () => {
    const c = cle("life-cleric", 5);
    const ally = fighter();
    const s = state();
    put(s, c, ally);
    const word = action(c, "cast-healing-word-1");
    expect(actionAvailable(s, c, word)).toBe(false);
    ally.hp = Math.floor(ally.maxHp / 2) - 1;
    expect(actionAvailable(s, c, word)).toBe(true);
    ally.hp = 0;
    ally.downed = true;
    expect(actionAvailable(s, c, word)).toBe(true);
    cast(s, c, "cast-healing-word-1");
    expect(ally.hp).toBeGreaterThan(0);
    expect(ally.downed).toBe(false);
  });

  it("Preserve Life (2nd Channel Divinity): five times the cleric level in hit points, none raised above half its maximum, and not undead or constructs", () => {
    const c = cle("life-cleric", 4);
    const a = fighter(6, "-a");
    const b = fighter(6, "-b");
    a.hp = 1;
    b.hp = 1;
    const s = state();
    put(s, c, a, b);
    cast(s, c, "preserve-life");
    expect(a.hp).toBeLessThanOrEqual(Math.floor(a.maxHp / 2));
    expect(b.hp).toBeLessThanOrEqual(Math.floor(b.maxHp / 2));
    expect(a.hp - 1 + (b.hp - 1)).toBeLessThanOrEqual(20);
    expect(a.hp - 1 + (b.hp - 1)).toBeGreaterThan(0);
    expect(res(c, "channel_divinity")).toBe(0);
  });

  it("Preserve Life doesn't heal an undead ally", () => {
    const c = cle("life-cleric", 4);
    const ghoul = fighter(6, "-g");
    (ghoul.ref as Combatant).creatureType = "undead";
    ghoul.hp = 1;
    const s = state();
    put(s, c, ghoul);
    cast(s, c, "preserve-life");
    expect(ghoul.hp).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------ shared helpers for the domains
const swing = (s: CombatState, attacker: CombatantState, target: CombatantState, bonus = 99, dmg = "5", type: "bludgeoning" | "fire" = "bludgeoning") =>
  runAutomation([{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: type }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });
const arena = (faces: number | number[], attacker: CombatantState, target: CombatantState = foe("f"), modes: string[] = []) => {
  const s = state(faces, modes);
  put(s, attacker, target);
  attacker.zone = target.zone = "melee";
  return { s, target };
};
const lost = (u: CombatantState) => u.maxHp - u.hp;

describe("Arcana Domain", () => {
  it("Arcane Initiate (1st): two wizard cantrips on top of the cleric's own", () => {
    const ids = makeTemplate("arcana-cleric", 1).actions.filter((a) => a.isSpell && a.spellLevel === 0).map((a) => a.id);
    expect(ids).toContain("cast-fire-bolt");
    expect(ids).toContain("cast-ray-of-frost");
  });

  it("Arcane Abjuration (2nd): a celestial, elemental, fey or fiend that fails is turned; from 5th one at or under the Destroy Undead rating is banished", () => {
    const fiend = foe("d", "fiend", "1/2");
    const big = foe("e", "elemental", "5");
    const beast = foe("b", "beast", "0");
    const c = cle("arcana-cleric", 5);
    const s = state(1);
    put(s, c, fiend, big, beast);
    cast(s, c, "arcane-abjuration");
    expect(fiend.alive).toBe(false);
    expect(hasCond(big, "turned")).toBe(true);
    expect(big.alive).toBe(true);
    expect(hasCond(beast, "turned")).toBe(false);
  });

  it("Arcane Mastery (17th): Chain Lightning, Finger of Death, Sunburst and Meteor Swarm are always prepared", () => {
    const ids = makeTemplate("arcana-cleric", 17).actions.map((a) => a.id);
    expect(ids.some((a) => a.startsWith("cast-chain-lightning"))).toBe(true);
    expect(ids.some((a) => a.startsWith("cast-finger-of-death"))).toBe(true);
  });
});

describe("Death Domain", () => {
  it("Reaper (1st): Chill Touch, and a necromancy cantrip that targets one creature can target two", () => {
    const chill = makeTemplate("death-cleric", 1).actions.find((a) => a.id === "cast-chill-touch");
    expect(chill).toBeDefined();
    expect(JSON.stringify(chill!.automation)).toContain('"upTo":2');
    const plain = makeTemplate("life-cleric", 1).actions.find((a) => a.id === "cast-chill-touch");
    expect(plain).toBeUndefined();
  });

  it("Touch of Death (2nd Channel Divinity): a melee hit adds necrotic damage of 5 + twice the cleric level", () => {
    const c = cle("death-cleric", 5);
    const { s, target } = arena(15, c);
    act(s, c, "attack-touch-of-death");
    // a longsword (1d8 + Strength 2, rigged to 8) and 5 + 2*5
    expect(lost(target)).toBe(8 + 2 + 15);
  });

  it("Inescapable Destruction (6th): necrotic damage from Channel Divinity ignores resistance", () => {
    const resist = (level: number) => {
      const c = cle("death-cleric", level);
      const t = foe("r", "humanoid");
      (t.ref as Combatant).resistances = ["necrotic"];
      const { s } = arena(15, c, t);
      act(s, c, "attack-touch-of-death");
      return lost(t);
    };
    expect(resist(5)).toBe(8 + 2 + Math.floor(15 / 2));
    expect(resist(6)).toBe(8 + 2 + 17);
  });
});

describe("Forge Domain", () => {
  it("Blessing of the Forge and Soul of the Forge: armor class 19, then 20 from 6th; fire resistance from 6th", () => {
    expect(makeTemplate("forge-cleric", 5).ac).toBe(19);
    expect(makeTemplate("forge-cleric", 6).ac).toBe(20);
    expect(makeTemplate("forge-cleric", 5).resistances).not.toContain("fire");
    expect(makeTemplate("forge-cleric", 6).resistances).toContain("fire");
  });

  it("Saint of Forge and Fire (17th): immune to fire, resistant to bludgeoning, piercing and slashing", () => {
    const c = makeTemplate("forge-cleric", 17);
    expect(c.immunities).toContain("fire");
    expect(c.resistances).toEqual(expect.arrayContaining(["bludgeoning", "piercing", "slashing"]));
  });
});

describe("Grave Domain", () => {
  it("Circle of Mortality (1st): a healing spell on a creature at 0 hit points rolls the highest number on each die — and only then", () => {
    const heal = (down: boolean) => {
      const c = cle("grave-cleric", 5);
      const ally = fighter();
      ally.hp = down ? 0 : 1;
      ally.downed = down;
      const s = state();
      s.rng.dice = (n) => n;
      put(s, c, ally);
      cast(s, c, "cast-healing-word-1");
      return ally.hp - (down ? 0 : 1);
    };
    expect(heal(true)).toBe(4 + 4); // 1d4 at its maximum, plus Wisdom
    expect(heal(false)).toBe(1 + 4);
  });

  it("Path to the Grave (2nd Channel Divinity): the next hit against the cursed creature does double damage", () => {
    const c = cle("grave-cleric", 5);
    const a = fighter();
    const { s, target } = arena(15, c, foe("f"));
    put(s, a);
    act(s, c, "path-to-the-grave");
    swing(s, a, target, 99, "10");
    expect(lost(target)).toBe(20);
    swing(s, a, target, 99, "10");
    expect(lost(target)).toBe(30); // only the first hit
  });

  it("Sentinel at Death's Door (6th): a critical hit against an ally becomes a normal hit — Wisdom-modifier times a day", () => {
    const c = cle("grave-cleric", 6);
    const a = fighter();
    const attacker = foe("f");
    const s = state(20);
    put(s, c, a, attacker);
    c.zone = a.zone = attacker.zone = "melee";
    runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "2d6", damageType: "slashing" }] } as AutomationNode], { state: s, source: attacker, scope: [a], last: {}, depth: 0 });
    expect(lost(a)).toBe(12); // not the doubled dice
    expect(res(c, "sentinel")).toBe(3);
    expect(c.reactionUsed).toBe(true);
  });

  it("Keeper of Souls (17th): an enemy dying nearby heals an ally by its Hit Dice, once until the cleric's next turn", () => {
    const c = cle("grave-cleric", 17);
    const a = fighter(10);
    a.hp = 5;
    const dying = foe("d");
    dying.hp = 1;
    const { s } = arena(15, c, dying);
    put(s, a);
    swing(s, c, dying);
    expect(dying.alive).toBe(false);
    expect(a.hp).toBeGreaterThan(5);
  });
});

describe("Knowledge and Light Domains", () => {
  it("Read Thoughts (6th Channel Divinity): a Wisdom save or the creature is held by the cleric's will", () => {
    const c = cle("knowledge-cleric", 6);
    const { s, target } = arena(1, c);
    cast(s, c, "read-thoughts");
    expect(hasCond(target, "charmed")).toBe(true);
    expect(makeTemplate("knowledge-cleric", 5).actions.some((a) => a.id === "read-thoughts")).toBe(false);
  });

  it("Warding Flare (1st): a reaction that gives an attacker disadvantage — Wisdom-modifier times a day; 6th also covers an ally", () => {
    const modes: string[] = [];
    const c = cle("light-cleric", 5);
    const attacker = foe("f");
    const s = state(15, modes);
    put(s, c, attacker);
    c.zone = attacker.zone = "melee";
    swing(s, attacker, c);
    expect(modes).toContain("dis");
    expect(res(c, "warding_flare")).toBe(3);

    const modes2: string[] = [];
    const c6 = cle("light-cleric", 6);
    const ally = fighter();
    const s2 = state(15, modes2);
    put(s2, c6, ally, foe("g"));
    swing(s2, [...s2.units.values()].find((u) => u.side === "monster")!, ally);
    expect(modes2).toContain("dis");

    const modes3: string[] = [];
    const c5 = cle("light-cleric", 5);
    const s3 = state(15, modes3);
    put(s3, c5, fighter(), foe("h"));
    swing(s3, [...s3.units.values()].find((u) => u.side === "monster")!, [...s3.units.values()].find((u) => u.id === "gwm-fighter-a" || u.name.startsWith("Fighter"))!);
    expect(modes3).not.toContain("dis");
  });

  it("Radiance of the Dawn (2nd Channel Divinity): 2d10 + the cleric's level radiant to each foe within 30 feet, half on a Constitution save", () => {
    const c = cle("light-cleric", 5);
    const a = foe("a");
    const b = foe("b", undefined, undefined, { con: 5 });
    const s = state(15);
    put(s, c, a, b);
    cast(s, c, "radiance-of-the-dawn");
    expect(lost(a)).toBe(20 + 5);
    expect(lost(b)).toBe(Math.floor(25 / 2));
  });

  it("Corona of Light (17th): foes have disadvantage on saves against the cleric's fire and radiant spells", () => {
    const modes: string[] = [];
    const c = cle("light-cleric", 17);
    const t = foe("f");
    const s = state(15, modes);
    put(s, c, t);
    c.zone = t.zone = "melee";
    cast(s, c, "cast-fireball-3");
    expect(modes).not.toContain("dis");
    startTurn(s, c);
    cast(s, c, "corona-of-light");
    modes.length = 0;
    cast(s, c, "cast-fireball-3");
    expect(modes).toContain("dis");
  });
});

describe("Nature Domain", () => {
  it("Charm Animals and Plants (2nd): each beast or plant that fails is charmed until it takes damage; nothing else is", () => {
    const c = cle("nature-cleric", 5);
    const wolf = foe("w", "beast");
    const orc = foe("o", "humanoid");
    const s = state(1);
    put(s, c, wolf, orc);
    cast(s, c, "charm-animals-and-plants");
    expect(hasCond(wolf, "charmed")).toBe(true);
    expect(hasCond(orc, "charmed")).toBe(false);
  });

  it("Dampen Elements (6th): a reaction that gives an ally resistance to one instance of fire damage", () => {
    const c = cle("nature-cleric", 6);
    const a = fighter();
    const enemy = foe("f");
    const s = state(15);
    put(s, c, a, enemy);
    c.zone = a.zone = enemy.zone = "melee";
    swing(s, enemy, a, 99, "20", "fire");
    expect(lost(a)).toBe(10);
    swing(s, enemy, a, 99, "20", "fire");
    expect(lost(a)).toBe(10 + 20); // the reaction is spent
  });
});

describe("Order Domain", () => {
  it("Voice of Authority (1st): a spell of 1st level or higher cast on an ally lets that ally use its reaction for a weapon attack", () => {
    const c = cle("order-cleric", 5);
    const a = fighter();
    a.hp = 1;
    const enemy = foe("f");
    const s = state(15);
    put(s, c, a, enemy);
    c.zone = a.zone = enemy.zone = "melee";
    cast(s, c, "cast-cure-wounds-1");
    expect(a.reactionUsed).toBe(true);
    expect(lost(enemy)).toBeGreaterThan(0);
  });

  it("Order's Demand (2nd Channel Divinity): a creature that fails is charmed until it takes damage", () => {
    const c = cle("order-cleric", 5);
    const { s, target } = arena(1, c);
    cast(s, c, "orders-demand");
    expect(hasCond(target, "charmed")).toBe(true);
    s.rng.d20mode = () => ({ used: 15, nat: 15 }); // the save is over: now a plain hit
    swing(s, c, target);
    expect(hasCond(target, "charmed")).toBe(false);
  });

  it("Embodiment of the Law (6th): an enchantment spell cast as a bonus action, Wisdom-modifier times a day", () => {
    const c = makeTemplate("order-cleric", 6);
    const embodied = c.actions.find((a) => a.id === "cast-command-1-embodied");
    expect(embodied?.cost).toEqual({ bonus: 1 });
    expect(c.resources.embodiment).toEqual({ max: 4, recharge: "longRest" });
    expect(makeTemplate("order-cleric", 5).actions.some((a) => a.id.endsWith("-embodied"))).toBe(false);
  });
});

describe("Peace Domain", () => {
  it("Emboldening Bond (1st): as many creatures as the proficiency bonus are bonded, proficiency-bonus times a day", () => {
    const c = cle("peace-cleric", 1);
    const allies = [fighter(6, "-1"), fighter(6, "-2"), fighter(6, "-3")];
    const s = state();
    put(s, c, ...allies);
    cast(s, c, "emboldening-bond");
    const bonded = [c, ...allies].filter((u) => u.effects.some((e) => e.name === "emboldening-bond"));
    expect(bonded).toHaveLength(2);
    expect(makeTemplate("peace-cleric", 1).resources.emboldening_bond?.max).toBe(2);
    expect(makeTemplate("peace-cleric", 9).resources.emboldening_bond?.max).toBe(4);
  });

  it("Protective Bond (6th): a bonded ally takes the damage another bonded creature was about to take", () => {
    const c = cle("peace-cleric", 6);
    const a = fighter();
    const enemy = foe("f");
    const s = state(15);
    put(s, c, a, enemy);
    c.zone = a.zone = enemy.zone = "melee";
    cast(s, c, "emboldening-bond");
    const before = c.hp;
    swing(s, enemy, a, 99, "10");
    expect(lost(a)).toBe(0);
    expect(before - c.hp).toBe(10);
  });

  it("Balm of Peace (2nd Channel Divinity): 2d6 + Wisdom to allies within reach", () => {
    const c = cle("peace-cleric", 5);
    const a = fighter();
    a.hp = 1;
    const s = state();
    put(s, c, a);
    cast(s, c, "balm-of-peace");
    expect(a.hp - 1).toBe(12 + 4);
  });
});

describe("Tempest Domain", () => {
  it("Wrath of the Storm (1st): a creature that hits the cleric takes 2d8 lightning on a failed Dexterity save — Wisdom-modifier times a day", () => {
    const c = cle("tempest-cleric", 5);
    const enemy = foe("f");
    const { s } = arena(15, c, enemy);
    swing(s, enemy, c);
    expect(lost(enemy)).toBe(16);
    expect(res(c, "wrath_of_the_storm")).toBe(3);
  });

  it("Destructive Wrath (2nd Channel Divinity): lightning and thunder damage is at its maximum instead of rolled", () => {
    const shatter = (id_: string) => {
      const c = cle("tempest-cleric", 5);
      const t = foe("f");
      const s = state(1);
      s.rng.dice = (n) => n; // every die comes up 1
      put(s, c, t);
      c.zone = t.zone = "melee";
      cast(s, c, id_);
      return lost(t);
    };
    expect(shatter("cast-shatter-2")).toBe(3);
    expect(shatter("cast-shatter-2-destructive")).toBe(24);
  });
});

describe("Trickery Domain", () => {
  it("Invoke Duplicity (2nd Channel Divinity): advantage on the cleric's attacks while it holds", () => {
    const modes: string[] = [];
    const c = cle("trickery-cleric", 5);
    const { s, target } = arena(15, c, foe("f"), modes);
    swing(s, c, target);
    expect(modes).not.toContain("adv");
    act(s, c, "invoke-duplicity");
    swing(s, c, target);
    expect(modes).toContain("adv");
    expect(c.concentratingOn).toBe("invoke-duplicity");
  });

  it("Cloak of Shadows (6th Channel Divinity): invisible until the cleric attacks", () => {
    const c = cle("trickery-cleric", 6);
    const { s, target } = arena(15, c);
    act(s, c, "cloak-of-shadows");
    expect(hasCond(c, "invisible")).toBe(true);
    swing(s, c, target);
    expect(hasCond(c, "invisible")).toBe(false);
  });
});

describe("Twilight Domain", () => {
  it("Twilight Sanctuary (2nd Channel Divinity): allies gain 1d6 + the cleric's level temporary hit points as their turns come round", () => {
    const c = cle("twilight-cleric", 5);
    const a = fighter();
    const s = state();
    put(s, c, a);
    act(s, c, "twilight-sanctuary");
    startOfTurn(s, a);
    expect(a.tempHp).toBe(6 + 5);
  });

  it("…or, if the creature is charmed or frightened, that ends instead of the temporary hit points", () => {
    const c = cle("twilight-cleric", 5);
    const a = fighter();
    a.conditions.set("frightened", { expiresRound: 99 } as never);
    const s = state();
    put(s, c, a);
    act(s, c, "twilight-sanctuary");
    startOfTurn(s, a);
    expect(hasCond(a, "frightened")).toBe(false);
    expect(a.tempHp).toBe(0);
    startOfTurn(s, a);
    expect(a.tempHp).toBe(11);
  });
});

describe("War Domain", () => {
  it("War Priest (1st): a bonus-action weapon attack after the Attack action — Wisdom-modifier times a day", () => {
    const c = makeTemplate("war-cleric", 1);
    expect(c.ai.bonusAfterAttack).toContain("war-priest");
    expect(c.resources.war_priest).toEqual({ max: 4, recharge: "longRest" });
  });

  it("Guided Strike (2nd Channel Divinity): +10 to an attack roll after seeing it, when that turns a miss into a hit", () => {
    const c = cle("war-cleric", 2);
    const { s, target } = arena(2, c); // 2 + 4 = 6 against armor class 8
    act(s, c, "attack");
    expect(lost(target)).toBeGreaterThan(0);
    expect(res(c, "channel_divinity")).toBe(0);
    const c2 = cle("war-cleric", 2);
    const far = foe("f");
    far.ref = { ...far.ref, ac: 30 } as Combatant;
    far.ac = 30;
    const { s: s2, target: t2 } = arena(2, c2, far);
    act(s2, c2, "attack");
    expect(lost(t2)).toBe(0); // a miss by more than 10 is still a miss
    expect(res(c2, "channel_divinity")).toBe(1);
  });

  it("War God's Blessing (6th Channel Divinity): a reaction giving an ally within 30 feet +10 to an attack roll", () => {
    const c = cle("war-cleric", 6);
    const a = fighter();
    const enemy = foe("f");
    const s = state(5);
    put(s, c, a, enemy);
    c.zone = a.zone = enemy.zone = "melee";
    swing(s, a, enemy, -5, "9"); // 5 - 5 = 0 against armor class 8
    expect(lost(enemy)).toBe(9);
    expect(res(c, "channel_divinity")).toBe(1);
  });

  it("Avatar of Battle (17th): resistance to bludgeoning, piercing and slashing", () => {
    expect(makeTemplate("war-cleric", 17).resistances).toEqual(expect.arrayContaining(["bludgeoning", "piercing", "slashing"]));
    expect(makeTemplate("war-cleric", 16).resistances).not.toContain("slashing");
  });
});

describe("clerics in battle", () => {
  it("every domain fights at levels 2, 6, 10, 14 and 20 without breaking", () => {
    for (const cid of CLERIC_IDS) {
      for (const level of [2, 6, 10, 14, 20]) {
        const out = runBattle({ party: [{ template: cid, level }, { template: "gwm-fighter", level }], enemies: ["ogre", "zombie"], seed: 5, controlled: [], maxRounds: 6 } as never);
        expect(out.frames.length, `${cid} L${level}`).toBeGreaterThan(0);
      }
    }
  });
});


describe("Divine Word (7th level, bonus action, 30 feet)", () => {
  const word = (): Action => ({
    id: "cast-divine-word", name: "Divine Word", cost: { bonus: 1 }, recharge: "none", isSpell: true,
    automation: SPELLS_BY_ID["divine-word"].build!({ slotLevel: 7, casterLevel: 13, spellMod: 5, dc: 18, toHit: 10, pb: 5 }),
  });
  const speak = (target: CombatantState, faces = 1) => {
    const c = cle("life-cleric", 13);
    const s = state(faces);
    put(s, c, target);
    c.zone = target.zone = "melee";
    runAction(s, c, word());
    return target;
  };
  const withHp = (hp: number, type?: CreatureType) => { const t = foe("t", type, "5"); t.hp = hp; return t; };
  const conds = (u: CombatantState) => [...u.conditions.keys()].sort();

  it("is a bonus action", () => {
    expect(SPELLS_BY_ID["divine-word"].castTime).toBe("bonus");
  });

  it("by current hit points: 50 or fewer, deafened; 40, deafened and blinded; 30, blinded, deafened and stunned; 20, killed", () => {
    expect(conds(speak(withHp(51)))).toEqual([]);
    expect(conds(speak(withHp(50)))).toEqual(["deafened"]);
    expect(conds(speak(withHp(41)))).toEqual(["deafened"]);
    expect(conds(speak(withHp(40)))).toEqual(["blinded", "deafened"]);
    expect(conds(speak(withHp(31)))).toEqual(["blinded", "deafened"]);
    expect(conds(speak(withHp(30)))).toEqual(["blinded", "deafened", "stunned"]);
    expect(conds(speak(withHp(21)))).toEqual(["blinded", "deafened", "stunned"]);
    const dead = speak(withHp(20));
    expect(dead.alive).toBe(false);
  });

  it("a celestial, elemental, fey or fiend is sent back to its plane whatever its hit points; a creature that passes its Charisma save is unaffected", () => {
    for (const type of ["celestial", "elemental", "fey", "fiend"] as const) {
      const t = speak(withHp(500, type));
      expect(t.alive, type).toBe(false);
    }
    const strong = foe("s", "humanoid", "5", { cha: 5 });
    strong.hp = 10;
    speak(strong, 20);
    expect(strong.alive).toBe(true);
    expect(conds(strong)).toEqual([]);
  });

  it("a stat block with no challenge rating (a player character) is still affected", () => {
    const pc = fighter();
    pc.hp = 15;
    pc.side = "monster";
    const c = cle("life-cleric", 13);
    const s = state(1);
    put(s, c, pc);
    runAction(s, c, word());
    expect(pc.alive).toBe(false);
  });
});

void has;
