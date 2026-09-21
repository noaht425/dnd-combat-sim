// The ranger and its conclaves, checked against the printed text (dnd5e.wikidot.com/ranger and each conclave's page). Numbers
// asserted here are the ones on those pages; the mechanics run through the real engine with rigged dice (every d20 lands on
// `faces`, every damage die rolls its maximum).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { fireEncounterStartTraits, runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollAttack } from "../lib/sim/engine/resolve";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { mayCounterspell } from "../lib/sim/engine/reactions";
import { commandOnlyPlan } from "../lib/sim/engine/ai";
import { PC_SUMMONS, drakeFor, primalBeastFor, rangerCompanionFor } from "../lib/sim/engine/minions";
import { beginTurn, initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { RANGER_LEARNED } from "../lib/sim/spells/rangerTemplates";
import { SPELLS_BY_ID } from "../lib/sim/spells/catalog";
import { maxSlotLevel, slotRow } from "../lib/sim/spells/slots";
import type { Action, AutomationNode, Combatant } from "../lib/sim/schema";

const RANGER_IDS = [
  "hunter-ranger", "beastmaster-ranger", "beastmaster-land-ranger", "beastmaster-sea-ranger", "beastmaster-sky-ranger",
  "gloom-stalker-ranger", "horizon-walker-ranger", "monster-slayer-ranger", "fey-wanderer-ranger", "swarmkeeper-ranger", "drakewarden-ranger",
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
const ranger = (id: string, level: number) => initCombatant(makeTemplate(id, level), "party", "-r");
const fighter = (level = 6) => initCombatant(makeTemplate("gwm-fighter", level), "party", "-a");
/** a big, low-AC dummy foe (every roll of 15+ hits a ranger; nothing dies) */
function foe(id = "f", over: Partial<Combatant["abilities"]> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const u = initCombatant({ ...base, ac: 8, abilities: { ...base.abilities, ...over } }, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, u.ref.actions.find((a) => a.id === id)!);
const cast = (s: CombatState, u: CombatantState, id: string) => { spend(u, u.ref.actions.find((a) => a.id === id)!); act(s, u, id); };
const startTurn = (s: CombatState, u: CombatantState) => { beginTurn(s, u); u.actionUsedThisTurn = u.bonusUsedThisTurn = false; u.reactionUsed = false; };
const lost = (u: CombatantState) => u.maxHp - u.hp;
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
const hit = (s: CombatState, attacker: CombatantState, target: CombatantState) =>
  runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "5", damageType: "bludgeoning" }] } as AutomationNode], { state: s, source: attacker, scope: [target], last: {}, depth: 0 });
const actionNames = (c: Combatant) => c.actions.map((a) => a.name);

describe("ranger — validity and parsing", () => {
  it("every ranger template builds a schema-valid PC at levels 1, 3, 6, 11, 15, 20", () => {
    for (const id of RANGER_IDS) {
      for (const lvl of [1, 3, 6, 11, 15, 20]) {
        const res = validateCombatant(makeTemplate(id, lvl));
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok, `${id} L${lvl}`).toBe(true);
      }
    }
  });

  it("free text resolves each conclave to its own template; bare 'ranger' is still the Hunter", () => {
    for (const [text, id] of [
      ["hunter ranger", "hunter-ranger"], ["beast master ranger", "beastmaster-ranger"], ["beast of the land ranger", "beastmaster-land-ranger"],
      ["beast of the sea ranger", "beastmaster-sea-ranger"], ["beast of the sky ranger", "beastmaster-sky-ranger"],
      ["gloom stalker ranger", "gloom-stalker-ranger"], ["horizon walker ranger", "horizon-walker-ranger"], ["monster slayer ranger", "monster-slayer-ranger"],
      ["fey wanderer ranger", "fey-wanderer-ranger"], ["swarmkeeper ranger", "swarmkeeper-ranger"], ["drakewarden ranger", "drakewarden-ranger"], ["ranger", "hunter-ranger"],
    ]) expect(findClassTemplate(text).match?.templateId, text).toBe(id);
  });
});

describe("the Ranger table", () => {
  const KNOWN = [0, 0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11];

  it("spells known follow the Spells Known column, and each is of a level you have slots for", () => {
    for (let l = 2; l <= 20; l++) {
      const learned = RANGER_LEARNED.filter((x) => x.level <= l);
      expect(learned.length, `level ${l}`).toBe(KNOWN[l]);
    }
    for (const { level, spell } of RANGER_LEARNED) {
      const sp = SPELLS_BY_ID[spell];
      expect(sp, spell).toBeDefined();
      expect(sp.classes).toContain("ranger");
      expect(sp.level).toBeLessThanOrEqual(maxSlotLevel("half", level));
    }
  });

  it("half-caster slots, from 2nd level: 2 / 3 / 4+2 / 4+3 / ... / 4-3-3-3-2", () => {
    expect(slotRow("half", 1)).toEqual([]);
    expect(slotRow("half", 2)).toEqual([2]);
    expect(slotRow("half", 5)).toEqual([4, 2]);
    expect(slotRow("half", 13)).toEqual([4, 3, 3, 1]);
    expect(slotRow("half", 20)).toEqual([4, 3, 3, 3, 2]);
  });

  it("Extra Attack at 5th (two shots, never three); Archery +2; studded leather AC", () => {
    const plain = (l: number) => JSON.stringify(makeTemplate("swarmkeeper-ranger", l).actions.find((a) => a.id === "attack")!.automation).match(/"type":"attack"/g)!.length;
    expect([plain(4), plain(5), plain(20)]).toEqual([1, 2, 2]);
    const c = makeTemplate("hunter-ranger", 5); // PB 3, Dex +4
    expect(JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation)).toContain('"bonus":9'); // 3 + 4 + 2
    expect(c.ac).toBe(12 + 4);
  });

  it("no ranger cantrips of its own: every spell a ranger learns is 1st level or higher", () => {
    expect(RANGER_LEARNED.every((l) => SPELLS_BY_ID[l.spell].level >= 1)).toBe(true);
  });
});

describe("Hunter (PHB)", () => {
  it("Colossus Slayer: an extra 1d8 against a wounded creature, once per turn", () => {
    const dmg = (wounded: boolean, level = 5) => {
      const s = state(15);
      const r = ranger("hunter-ranger", level);
      const f = foe();
      if (wounded) f.hp -= 100;
      put(s, r, f);
      startTurn(s, r);
      const before = f.hp;
      act(s, r, "attack");
      return before - f.hp;
    };
    // one shot (4th level): a fresh target takes nothing extra, a wounded one takes the die
    expect(dmg(false, 4)).toBe(8 + 4);
    expect(dmg(true, 4)).toBe(8 + 4 + 8);
    // two shots: the first wound makes the second shot qualify — and the die lands once per turn either way
    expect(dmg(false)).toBe(2 * (8 + 4) + 8);
    expect(dmg(true)).toBe(2 * (8 + 4) + 8);
    expect(dmg(true, 2)).toBe(8 + 4); // no conclave yet
  });

  it("Multiattack Defense (7th): +4 AC against a creature that has hit you, until its next turn — and only against that creature", () => {
    const s = state(18);
    const r = ranger("hunter-ranger", 7); // AC 16
    const a = foe("a");
    const b = foe("b");
    put(s, r, a, b);
    expect(rollAttack(s, a, r, 0, undefined).hit).toBe(true); // 18 vs 16
    hit(s, a, r);
    expect(rollAttack(s, a, r, 0, undefined).hit).toBe(false); // 18 vs 20
    expect(rollAttack(s, b, r, 0, undefined).hit).toBe(true); // someone else is unaffected
    startTurn(s, a);
    expect(rollAttack(s, a, r, 0, undefined).hit).toBe(true); // a's next turn ends it
    expect(makeTemplate("hunter-ranger", 6).specialRules.some((x) => x.rule === "multiattackDefense")).toBe(false);
  });

  it("Volley (11th): a ranged attack against every creature in a 10-ft radius; Evasion at 15th", () => {
    expect(actionNames(makeTemplate("hunter-ranger", 10))).not.toContain("Volley");
    const volley = makeTemplate("hunter-ranger", 11).actions.find((a) => a.id === "volley")!;
    expect(JSON.stringify(volley.automation)).toContain('"who":"area"');
    expect(makeTemplate("hunter-ranger", 14).traits.some((t) => t.id === "evasion")).toBe(false);
    expect(makeTemplate("hunter-ranger", 15).traits.some((t) => t.id === "evasion")).toBe(true);
  });
});

describe("Beast Master (PHB): the Ranger's Companion", () => {
  it("adds your proficiency bonus to the wolf's AC, attack and damage; HP is 4 x level (or the wolf's own, if higher)", () => {
    const at = (level: number, pb: number) => PC_SUMMONS[rangerCompanionFor(level, pb)];
    const w5 = at(5, 3);
    expect(w5.ac).toBe(13 + 3);
    expect(w5.maxHp).toBe(20);
    const bite = JSON.stringify(w5.actions.find((a) => a.id === "attack")!.automation);
    expect(bite).toContain('"bonus":7'); // +4 + PB 3
    expect(bite).toContain('"amount":"2d4+5"'); // +2 + PB 3
    expect(bite).toContain('"dc":11'); // its own Strength save DC to knock prone
    expect(at(3, 2).maxHp).toBe(12); // 4 x 3 beats the wolf's 11
    expect(w5.commandOnly).toBe(true);
    expect(w5.specialRules).toContainEqual({ rule: "packTactics" });
  });

  it("Bestial Fury (11th): two attacks when commanded to Attack", () => {
    const attacks = (level: number) => JSON.stringify(PC_SUMMONS[rangerCompanionFor(level, 4)].actions.find((a) => a.id === "attack")!.automation).match(/"type":"attack"/g)!.length;
    expect([attacks(10), attacks(11)]).toEqual([1, 2]);
  });

  it("the wolf is there from the start; it only Dodges unless commanded, and the command costs the ranger's ACTION", () => {
    const s = state(15);
    const r = ranger("beastmaster-ranger", 5);
    const f = foe();
    put(s, r, f);
    fireEncounterStartTraits(s);
    const wolf = [...s.units.values()].find((u) => u.summonerId === r.id)!;
    expect(wolf).toBeDefined();
    expect(commandOnlyPlan(s, wolf).dodge?.id).toBe("dodge");
    const cmd = r.ref.actions.find((a) => a.id === "command-attack")!;
    expect(cmd.cost).toEqual({ action: 1 });
    act(s, r, "command-attack");
    // the wolf's bite (2d4 + 2 + PB 3 = 13) and, with Extra Attack, ONE weapon attack of the ranger's own (1d8 + 4 = 12)
    expect(lost(f)).toBe(13 + 12);
    s.round = 1;
    wolf.commandedRound = 1;
    expect(commandOnlyPlan(s, wolf).dodge).toBeUndefined();
  });

  it("below 5th level the command is the whole action — the ranger doesn't attack too", () => {
    const s = state(15);
    const r = ranger("beastmaster-ranger", 3);
    const f = foe();
    put(s, r, f);
    fireEncounterStartTraits(s);
    act(s, r, "command-attack");
    expect(lost(f)).toBe(2 * 4 + 2 + 2); // just the wolf: 2d4 + 2 + PB 2
  });

  it("with the wolf alive the ranger commands it; without it the ranger shoots twice", () => {
    const s = state(15);
    const r = ranger("beastmaster-ranger", 5);
    put(s, r, foe());
    const shoot = r.ref.actions.find((a) => a.id === "attack")!;
    expect(actionAvailable(s, r, shoot)).toBe(true); // no companion yet
    fireEncounterStartTraits(s);
    expect(actionAvailable(s, r, shoot)).toBe(false);
    const wolf = [...s.units.values()].find((u) => u.summonerId === r.id)!;
    wolf.alive = false;
    expect(actionAvailable(s, r, shoot)).toBe(true);
  });

  it("Pack Tactics: the wolf has advantage when an ally of its own is beside the target", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const r = ranger("beastmaster-ranger", 5);
    const f = foe();
    put(s, r, f);
    fireEncounterStartTraits(s);
    const wolf = [...s.units.values()].find((u) => u.summonerId === r.id)!;
    wolf.zone = f.zone = "melee";
    r.zone = "ranged"; // the ranger is at a distance: not beside the target
    rollAttack(s, wolf, f, 0, undefined);
    expect(modes.at(-1)).toBe("flat");
    const ally = fighter();
    ally.zone = "melee";
    put(s, ally);
    rollAttack(s, wolf, f, 0, undefined);
    expect(modes.at(-1)).toBe("adv");
  });
});

describe("Beast Master: the Primal Companion (Tasha's, optional)", () => {
  it("Land / Sea / Sky: AC 13 + PB, HP 5 + 5 x level (4 + 4 x level for the Sky), attacks at your spell attack modifier", () => {
    const land = PC_SUMMONS[primalBeastFor("land", 5, 3, 3)];
    expect([land.ac, land.maxHp, land.size]).toEqual([16, 30, "medium"]);
    expect(land.speeds).toEqual({ walk: 40, climb: 40 });
    expect(JSON.stringify(land.actions.find((a) => a.id === "attack")!.automation)).toContain('"amount":"1d8+5"'); // 1d8 + 2 + PB
    expect(JSON.stringify(land.actions.find((a) => a.id === "attack")!.automation)).toContain('"bonus":6'); // PB 3 + Wis 3
    const sea = PC_SUMMONS[primalBeastFor("sea", 5, 3, 3)];
    expect(sea.speeds).toEqual({ walk: 5, swim: 60 });
    expect(JSON.stringify(sea.actions.find((a) => a.id === "attack")!.automation)).toContain('"amount":"1d6+5"');
    expect(JSON.stringify(sea.actions.find((a) => a.id === "attack")!.automation)).toContain('"condition":"grappled"');
    const sky = PC_SUMMONS[primalBeastFor("sky", 5, 3, 3)];
    expect([sky.maxHp, sky.size, sky.abilities.str, sky.abilities.dex]).toEqual([24, "small", 6, 16]);
    expect(JSON.stringify(sky.actions.find((a) => a.id === "attack")!.automation)).toContain('"amount":"1d4+6"'); // 1d4 + 3 + PB
    expect(land.saveBonusAll).toBe(3); // Primal Bond
  });

  it("is commanded with a bonus action, and attacks twice from 11th level", () => {
    const c = makeTemplate("beastmaster-land-ranger", 5);
    expect(c.actions.find((a) => a.id === "command-beast")!.cost).toEqual({ bonus: 1 });
    expect(c.ai.bonusRoutine).toEqual(["command-beast"]);
    const attacks = (l: number) => JSON.stringify(PC_SUMMONS[primalBeastFor("land", l, 4, 3)].actions.find((a) => a.id === "attack")!.automation).match(/"type":"attack"/g)!.length;
    expect([attacks(10), attacks(11)]).toEqual([1, 2]);
    const s = state(15);
    const r = ranger("beastmaster-land-ranger", 5);
    const f = foe();
    put(s, r, f);
    fireEncounterStartTraits(s);
    act(s, r, "command-beast");
    expect(lost(f)).toBe(8 + 5); // 1d8 + 2 + PB 3, and the ranger's own turn still comes
  });
});

describe("Gloom Stalker (XGtE)", () => {
  it("Dread Ambusher: + Wisdom to initiative; on the first turn of a combat one extra shot with +1d8 (not on later turns)", () => {
    expect(makeTemplate("gloom-stalker-ranger", 2).initiativeBonus).toBeUndefined();
    expect(makeTemplate("gloom-stalker-ranger", 3).initiativeBonus).toBe(4 + 3);
    const total = (round: number) => {
      const s = state(15);
      s.round = round;
      const r = ranger("gloom-stalker-ranger", 5);
      const f = foe();
      put(s, r, f);
      act(s, r, "attack");
      return lost(f);
    };
    expect(total(1)).toBe(2 * 12 + (12 + 8)); // three shots, the third with +1d8
    expect(total(2)).toBe(2 * 12);
  });

  it("Iron Mind (7th): proficiency in Wisdom saves", () => {
    expect(makeTemplate("gloom-stalker-ranger", 6).proficientSaves).not.toContain("wis");
    expect(makeTemplate("gloom-stalker-ranger", 7).proficientSaves).toContain("wis");
  });

  it("Stalker's Flurry (11th): a miss earns another attack, once per turn", () => {
    const rolls = (level: number) => {
      const s = state(1); // every attack misses
      s.round = 2;
      const r = ranger("gloom-stalker-ranger", level);
      put(s, r, foe());
      startTurn(s, r);
      act(s, r, "attack");
      return s.attackLog?.length ?? 0;
    };
    expect(rolls(10)).toBe(2);
    expect(rolls(11)).toBe(3); // two shots plus one extra, not one extra per miss
  });

  it("Shadowy Dodge (15th): a reaction imposing disadvantage on an attack that has no advantage", () => {
    const roll = (level: number, blind = false) => {
      const modes: string[] = [];
      const s = state(15, modes);
      const r = ranger("gloom-stalker-ranger", level);
      const f = foe();
      put(s, r, f);
      if (blind) f.conditions.set("blinded", { expiresRound: Infinity, sourceId: "x" }); // the foe attacks at disadvantage already
      rollAttack(s, f, r, 0, undefined);
      return { mode: modes.at(-1), used: r.reactionUsed };
    };
    expect(roll(15)).toEqual({ mode: "dis", used: true });
    expect(roll(14)).toEqual({ mode: "flat", used: false });
    expect(roll(15, true).used).toBe(false); // already at disadvantage: no need
  });

  it("its spells are always known (Fear at 9th, Greater Invisibility at 13th)", () => {
    expect(actionNames(makeTemplate("gloom-stalker-ranger", 8))).not.toContain("Fear");
    expect(actionNames(makeTemplate("gloom-stalker-ranger", 9))).toContain("Fear");
    expect(actionNames(makeTemplate("gloom-stalker-ranger", 13))).toContain("Greater Invisibility");
  });
});

describe("Horizon Walker (XGtE)", () => {
  it("Planar Warrior: a bonus action marks a creature; its next hit that turn takes an extra 1d8 force (2d8 at 11th), once", () => {
    const extra = (level: number) => {
      const s = state(15);
      const r = ranger("horizon-walker-ranger", level);
      const f = foe();
      put(s, r, f);
      startTurn(s, r);
      act(s, r, "planar-warrior");
      const before = f.hp;
      act(s, r, "attack");
      return before - f.hp - (level >= 11 ? 3 : 2) * 12 + (level >= 11 ? 12 : 0);
    };
    expect(extra(5)).toBe(8);
    expect(makeTemplate("horizon-walker-ranger", 5).ai.bonusRoutine).toEqual(["planar-warrior"]);
    const s = state(15);
    const r = ranger("horizon-walker-ranger", 11);
    const f = foe();
    put(s, r, f);
    startTurn(s, r);
    act(s, r, "planar-warrior");
    const before = f.hp;
    act(s, r, "attack");
    expect(before - f.hp).toBe(2 * 12 + 16); // two shots and one 2d8 (not two)
  });

  it("Distant Strike (11th): three attacks against three different creatures — only with three foes alive", () => {
    const s = state(15);
    const r = ranger("horizon-walker-ranger", 11);
    const [a, b, c] = [foe("a"), foe("b"), foe("c")];
    b.ac = 9; c.ac = 10; // a is squishiest
    put(s, r, a, b, c);
    act(s, r, "distant-strike");
    expect([lost(a), lost(b), lost(c)].every((x) => x > 0)).toBe(true);
    const two = state(15);
    const r2 = ranger("horizon-walker-ranger", 11);
    put(two, r2, foe("a"), foe("b"));
    expect(actionAvailable(two, r2, r2.ref.actions.find((x) => x.id === "distant-strike")!)).toBe(false);
    expect(actionNames(makeTemplate("horizon-walker-ranger", 10))).not.toContain("Distant Strike");
  });

  it("Spectral Defense (15th): a reaction giving resistance to an attack's damage", () => {
    const taken = (level: number) => {
      const s = state(15);
      const r = ranger("horizon-walker-ranger", level);
      put(s, r, foe());
      const before = r.hp;
      applyDamage(s, r, 40, "slashing", { viaAttack: true });
      return before - r.hp;
    };
    expect(taken(15)).toBe(20);
    expect(taken(14)).toBe(40);
  });
});

describe("Monster Slayer (XGtE)", () => {
  it("Slayer's Prey: the designated creature takes an extra 1d6 once per turn; another creature doesn't; designating a new one ends the old", () => {
    const s = state(15);
    const r = ranger("monster-slayer-ranger", 5);
    const a = foe("a");
    const b = foe("b");
    put(s, r, a, b);
    startTurn(s, r);
    act(s, r, "slayers-prey");
    const marked = [a, b].find((u) => hasEffect(u, "slayers-prey"))!;
    const other = marked === a ? b : a;
    expect(hasEffect(other, "slayers-prey")).toBe(false);
    expect(makeTemplate("monster-slayer-ranger", 5).ai.bonusRoutine).toEqual(["slayers-prey"]);
    // the mark cashes in only on the marked creature — hitting it twice adds one die
    const runShots = (target: CombatantState) => {
      startTurn(s, r);
      const before = target.hp;
      runAutomation([{ type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "1", damageType: "piercing" }] } as AutomationNode,
                     { type: "attack", bonus: 99, onHit: [{ type: "damage", amount: "1", damageType: "piercing" }] } as AutomationNode],
        { state: s, source: r, scope: [target], last: {}, depth: 0 });
      return before - target.hp;
    };
    expect(runShots(marked)).toBe(2 + 6);
    expect(runShots(other)).toBe(2);
  });

  it("Magic-User's Nemesis (11th): a caster within 60 ft makes a Wisdom save against your spell DC or its spell fails; once per short rest", () => {
    const spell: Action = { id: "cast-hold", name: "Hold Person", cost: { action: 1 }, recharge: "none", isSpell: true,
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "applyCondition", condition: "paralyzed" }] }] };
    const run = (face: number, level = 11) => {
      const s = state(face);
      const r = ranger("monster-slayer-ranger", level);
      const caster = foe("c", { wis: 1 });
      put(s, r, caster);
      return { failed: mayCounterspell(s, caster, spell), left: r.resources.get("magic_users_nemesis") };
    };
    expect(run(5)).toEqual({ failed: true, left: 0 }); // 5 - 5 = 0 against DC 8 + 4 + 3
    expect(run(20).failed).toBe(false); // it saved — but the reaction is spent
    expect(run(5, 10).failed).toBe(false); // not yet
    expect(makeTemplate("monster-slayer-ranger", 11).resources.magic_users_nemesis).toEqual({ max: 1, recharge: "shortRest" });
  });
});

describe("Fey Wanderer (Tasha's)", () => {
  it("Dreadful Strikes: an extra 1d4 psychic (1d6 at 11th) once per turn on a weapon hit", () => {
    const total = (level: number) => {
      const s = state(15);
      const r = ranger("fey-wanderer-ranger", level);
      const f = foe();
      put(s, r, f);
      startTurn(s, r);
      act(s, r, "attack");
      return lost(f);
    };
    expect(total(5)).toBe(2 * 12 + 4);
    expect(total(11)).toBe(2 * 12 + 6);
  });

  it("Beguiling Twist (7th): advantage on saves against being charmed or frightened; Misty Wanderer (15th): Wisdom-modifier Misty Steps", () => {
    expect(makeTemplate("fey-wanderer-ranger", 6).specialRules.some((r) => r.rule === "advantageOnSavesAgainst")).toBe(false);
    expect(makeTemplate("fey-wanderer-ranger", 7).specialRules).toContainEqual({ rule: "advantageOnSavesAgainst", conditions: ["charmed", "frightened"] });
    expect(makeTemplate("fey-wanderer-ranger", 14).resources.misty_wanderer).toBeUndefined();
    expect(makeTemplate("fey-wanderer-ranger", 15).resources.misty_wanderer).toEqual({ max: 3, recharge: "longRest" });
  });
});

describe("Swarmkeeper (Tasha's)", () => {
  it("Gathered Swarm: 1d6 piercing once per turn after a hit (1d8 at 11th)", () => {
    const total = (level: number) => {
      const s = state(15);
      const r = ranger("swarmkeeper-ranger", level);
      const f = foe();
      put(s, r, f);
      startTurn(s, r);
      act(s, r, "attack");
      return lost(f);
    };
    expect(total(5)).toBe(2 * 12 + 6);
    expect(total(11)).toBe(2 * 12 + 8);
    expect(total(2)).toBe(12);
  });

  it("Swarming Dispersal (15th): a reaction giving resistance to damage, proficiency-bonus times per long rest", () => {
    const taken = (level: number) => {
      const s = state(15);
      const r = ranger("swarmkeeper-ranger", level);
      put(s, r, foe());
      const before = r.hp;
      applyDamage(s, r, 40, "fire", {}); // any damage, not only an attack
      return before - r.hp;
    };
    expect(taken(15)).toBe(20);
    expect(taken(14)).toBe(40);
    expect(makeTemplate("swarmkeeper-ranger", 15).resources.swarming_dispersal).toEqual({ max: 5, recharge: "longRest" });
  });
});

describe("Drakewarden (Fizban's)", () => {
  it("Drake Companion: AC 14 + PB, HP 5 + 5 x level, bite +3 + PB for 1d6 + PB, immune to its essence, proficient in Dex and Wis saves", () => {
    const d = PC_SUMMONS[drakeFor(5, 3, "fire")];
    expect([d.ac, d.maxHp, d.size]).toEqual([17, 30, "small"]);
    expect(d.immunities).toEqual(["fire"]);
    expect(d.proficientSaves.sort()).toEqual(["dex", "wis"]);
    expect(d.abilities).toMatchObject({ str: 16, dex: 12, con: 15, wis: 14 });
    const bite = JSON.stringify(d.actions.find((a) => a.id === "bite")!.automation);
    expect(bite).toContain('"bonus":6');
    expect(bite).toContain('"amount":"1d6+3"');
    expect(bite).not.toContain('"damageType":"fire"');
  });

  it("Bond of Fang and Scale (7th): wings and Medium, Magic Fang +1d6 on the bite; Perfected Bond (15th): Large, 2d6", () => {
    const d7 = PC_SUMMONS[drakeFor(7, 3, "fire")];
    expect([d7.size, d7.speeds.fly]).toEqual(["medium", 40]);
    expect(JSON.stringify(d7.actions.find((a) => a.id === "bite")!.automation)).toContain('{"type":"damage","amount":"1d6","damageType":"fire"}');
    const d15 = PC_SUMMONS[drakeFor(15, 5, "fire")];
    expect(d15.size).toBe("large");
    expect(JSON.stringify(d15.actions.find((a) => a.id === "bite")!.automation)).toContain('"amount":"2d6"');
  });

  it("is summoned with an action once per long rest, then commanded with a bonus action; the ranger resists the essence from 7th level", () => {
    const c = makeTemplate("drakewarden-ranger", 7);
    expect(c.actions.find((a) => a.id === "summon-drake")!.cost).toEqual({ action: 1 });
    expect(c.actions.find((a) => a.id === "command-drake")!.cost).toEqual({ bonus: 1 });
    expect(c.resources.drake_summon).toEqual({ max: 1, recharge: "longRest" });
    expect(c.ai.opener).toEqual(["summon-drake"]);
    const s = state(15);
    const r = ranger("drakewarden-ranger", 7);
    const f = foe();
    put(s, r, f);
    cast(s, r, "summon-drake");
    const drake = [...s.units.values()].find((u) => u.summonerId === r.id)!;
    expect(drake.ref.name).toBe("Drake Companion");
    expect(hasEffect(r, "drake-resistance")).toBe(true);
    act(s, r, "command-drake");
    expect(lost(f)).toBe(6 + 3 + 6); // 1d6 + PB 3, and Magic Fang's 1d6 fire
    const t = state(15);
    const low = ranger("drakewarden-ranger", 6);
    put(t, low, foe());
    cast(t, low, "summon-drake");
    expect(hasEffect(low, "drake-resistance")).toBe(false);
  });

  it("Infused Strikes: the drake's reaction adds 1d6 of its essence to another creature's weapon hit, once per round", () => {
    const s = state(15);
    const r = ranger("drakewarden-ranger", 5);
    const ally = fighter();
    const f = foe();
    put(s, r, ally, f);
    cast(s, r, "summon-drake");
    const drake = [...s.units.values()].find((u) => u.summonerId === r.id)!;
    hit(s, ally, f);
    expect(lost(f)).toBe(5 + 6);
    expect(drake.reactionUsed).toBe(true);
    const after = f.hp;
    hit(s, ally, f);
    expect(after - f.hp).toBe(5); // the reaction is spent
  });

  it("Drake's Breath (11th): a 30-ft cone, Dexterity save, 8d6 (10d6 at 15th), half on a save; once per long rest", () => {
    expect(actionNames(makeTemplate("drakewarden-ranger", 10))).not.toContain("Drake's Breath");
    const breath = (level: number, face: number) => {
      const s = state(face);
      const r = ranger("drakewarden-ranger", level);
      const f = foe("f", { dex: 1 });
      put(s, r, f);
      cast(s, r, "drakes-breath");
      return lost(f);
    };
    expect(breath(11, 5)).toBe(48);
    expect(breath(11, 20)).toBe(24);
    expect(breath(15, 5)).toBe(60);
    expect(makeTemplate("drakewarden-ranger", 11).resources.drakes_breath).toEqual({ max: 1, recharge: "longRest" });
  });

  it("Reflexive Resistance (15th): a reaction, proficiency-bonus times per long rest", () => {
    expect(makeTemplate("drakewarden-ranger", 14).reactions).toEqual([]);
    const c = makeTemplate("drakewarden-ranger", 15);
    expect(c.reactions.map((r) => r.id)).toEqual(["reflexive-resistance"]);
    expect(c.resources.reflexive_resistance).toEqual({ max: 5, recharge: "longRest" });
  });
});

describe("whole fights run cleanly for every conclave", () => {
  it("no crash, and every fight reaches a result", () => {
    for (const id of RANGER_IDS) {
      for (const level of [3, 6, 11, 15]) {
        const out = runBattle({
          party: [{ template: id, level, name: "Rng" }, { template: "gwm-fighter", level, name: "Ally" }],
          enemies: ["ogre x2"], seed: level, controlled: [], maxRounds: 5,
        } as never);
        expect(out.done, `${id} L${level}`).toBe(true);
      }
    }
  });

  it("a companion ranger's companion actually fights", () => {
    for (const [id, name] of [["beastmaster-ranger", "Wolf"], ["beastmaster-land-ranger", "Beast of the Land"], ["drakewarden-ranger", "Drake Companion"]] as const) {
      const out = runBattle({
        party: [{ template: id, level: 5, name: "Rng" }, { template: "gwm-fighter", level: 5, name: "Ally" }],
        enemies: ["ogre x2"], seed: 3, controlled: [], maxRounds: 4,
      } as never);
      const text = out.frames.map((f) => f.text ?? "").join("\n");
      expect(text, id).toMatch(new RegExp(`${name}[^\\n]*\\(commanded\\) uses`));
    }
  });
});
