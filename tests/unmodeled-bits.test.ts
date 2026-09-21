// The features earlier class passes had left unmodeled, now built: Slayer's Counter, Supernatural Defense, Beguiling Twist, the Hound of
// Ill Omen's mark, Trance of Order, Clockwork Cavalcade, Draconic Presence, Umbral Form, Tides of Chaos, Bend Luck, Indomitable,
// Parry / Goading Attack / Distracting Strike, the Wolf / Elk / Eagle totems, Rage Beyond Death, Cunning Action Disengage, Psychic Veil,
// Dread Ambusher's speed, and the Scout's Skirmisher. Rigged dice as in the class tests (every d20 lands on `faces`, dice roll max).

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { runBattle } from "../lib/sim/battle";
import { runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { applyDamage, rollAttack, rollSave } from "../lib/sim/engine/resolve";
import { spend } from "../lib/sim/engine/ai";
import { endOfTurn, startOfTurn } from "../lib/sim/engine/loop";
import { provokeOpportunityAttacks } from "../lib/sim/engine/reactions";
import { beginTurn, initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { speedFt } from "../lib/sim/battle/state";
import type { AutomationNode, Combatant } from "../lib/sim/schema";

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
const pc = (id: string, level: number, suffix = "-p") => initCombatant(makeTemplate(id, level), "party", suffix);
function foe(id = "f", over: Partial<Combatant["abilities"]> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const u = initCombatant({ ...base, ac: 8, abilities: { ...base.abilities, ...over } }, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, u.ref.actions.find((a) => a.id === id)!);
const cast = (s: CombatState, u: CombatantState, id: string) => { spend(u, u.ref.actions.find((a) => a.id === id)!); act(s, u, id); };
const startTurn = (s: CombatState, u: CombatantState) => { beginTurn(s, u); u.actionUsedThisTurn = u.bonusUsedThisTurn = false; u.reactionUsed = false; };
const hasEffect = (u: CombatantState, name: string) => u.effects.some((e) => e.name === name);
/** `attacker` forces `target` to make a save (DC 99 unless said) with a 10-damage rider */
const forceSave = (s: CombatState, attacker: CombatantState, target: CombatantState, dc = 99, ability: "wis" | "str" = "wis") =>
  runAutomation([{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "save", ability, dc, onFail: [{ type: "damage", amount: "10", damageType: "psychic" }], onSuccess: [] }] } as AutomationNode],
    { state: s, source: attacker, scope: [], forceScope: [target], last: {}, depth: 0 });

describe("save hooks: who forced the save", () => {
  it("Slayer's Counter (15th): a hit on your prey before its save makes the save succeed — once, and only against the prey", () => {
    const run = (mark: boolean, level = 15) => {
      const s = state(15);
      const r = pc("monster-slayer-ranger", level);
      const f = foe();
      put(s, r, f);
      if (mark) act(s, r, "slayers-prey");
      forceSave(s, f, r);
      return { taken: r.maxHp - r.hp, reactionUsed: r.reactionUsed };
    };
    expect(run(true)).toEqual({ taken: 0, reactionUsed: true });
    expect(run(false).taken).toBe(10); // no prey designated
    expect(run(true, 14).taken).toBe(10); // no Slayer's Counter yet
  });

  it("Supernatural Defense (7th): + 1d6 on saves against your prey's effects", () => {
    const passes = (mark: boolean, level = 7) => {
      const s = state(5); // 5 + Wis 3 = 8; the d6 (6) makes it 14
      const r = pc("monster-slayer-ranger", level);
      const f = foe();
      put(s, r, f);
      if (mark) act(s, r, "slayers-prey");
      forceSave(s, f, r, 14);
      return r.hp === r.maxHp;
    };
    expect(passes(true)).toBe(true);
    expect(passes(false)).toBe(false);
    expect(passes(true, 6)).toBe(false);
  });

  it("Beguiling Twist (7th): a shrugged-off charm or fear can be turned on another creature (Wisdom save or frightened)", () => {
    const s = state([20, 1]);
    const fey = pc("fey-wanderer-ranger", 7);
    const a = foe("a");
    const b = foe("b", { wis: 1 });
    put(s, fey, a, b);
    rollSave(s, a, "wis", 10, { conditions: ["charmed"] }); // a shrugs off a charm...
    expect(b.conditions.has("frightened")).toBe(true); // ...and the fey ranger's reaction frightens b
    expect(fey.reactionUsed).toBe(true);
    const t = state([20, 1]);
    const fey6 = pc("fey-wanderer-ranger", 6);
    const c = foe("c"), d = foe("d", { wis: 1 });
    put(t, fey6, c, d);
    rollSave(t, c, "wis", 10, { conditions: ["charmed"] });
    expect(d.conditions.has("frightened")).toBe(false);
  });

  it("the Hound of Ill Omen's mark: the marked creature has disadvantage on saves against the sorcerer's spells", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const sorc = pc("shadow-magic-sorcerer", 6);
    const f = foe();
    put(s, sorc, f);
    cast(s, sorc, "hound-of-ill-omen");
    expect(hasEffect(f, "hound-of-ill-omen")).toBe(true);
    modes.length = 0;
    forceSave(s, sorc, f, 10, "str"); // from the sorcerer
    expect(modes.at(-1)).toBe("dis");
    forceSave(s, pc("gwm-fighter", 5, "-x"), f, 10, "str"); // from anyone else
    expect(modes.at(-1)).toBe("flat");
  });
});

describe("sorcerer late features", () => {
  it("Trance of Order (14th): attack rolls against you can't have advantage; your d20s of 9 or lower count as 10", () => {
    const s = state(5);
    const sorc = pc("clockwork-soul-sorcerer", 14);
    const f = foe();
    put(s, sorc, f);
    cast(s, sorc, "trance-of-order");
    expect(hasEffect(sorc, "trance-of-order")).toBe(true);
    expect(sorc.resources.get("trance_of_order")).toBe(0);
    // a 5 counts as 10: 10 + 5 = 15 hits AC 15 — it would have missed
    f.ac = 15;
    expect(rollAttack(s, sorc, f, 5, undefined).hit).toBe(true);
    // ...and an attacker with advantage against you loses it
    const modes: string[] = [];
    const t = state(15, modes);
    const c = pc("clockwork-soul-sorcerer", 14);
    const g = foe("g");
    put(t, c, g);
    cast(t, c, "trance-of-order");
    c.conditions.set("blinded", { expiresRound: Infinity, sourceId: "x" }); // attackers would have advantage
    modes.length = 0;
    rollAttack(t, g, c, 0, undefined);
    expect(modes.at(-1)).toBe("flat");
    // again for 5 sorcery points once the free use is spent
    startTurn(t, c);
    c.effects = c.effects.filter((e) => e.name !== "trance-of-order");
    const points = c.resources.get("sorcery_points")!;
    act(t, c, "trance-of-order");
    expect(c.resources.get("sorcery_points")).toBe(points - 5);
    expect(makeTemplate("clockwork-soul-sorcerer", 13).actions.some((a) => a.id === "trance-of-order")).toBe(false);
  });

  it("Clockwork Cavalcade (18th): restores up to 100 hit points divided among allies — once, or for 7 sorcery points — when it's worth it", () => {
    const setup = (missing: number) => {
      const s = state(15);
      const sorc = pc("clockwork-soul-sorcerer", 18);
      const a = pc("gwm-fighter", 18, "-a");
      a.hp = a.maxHp - missing;
      put(s, sorc, a);
      return { s, sorc, a };
    };
    const { s, sorc, a } = setup(150);
    act(s, sorc, "clockwork-cavalcade");
    expect(a.maxHp - a.hp).toBe(50); // 100 restored
    expect(sorc.resources.get("clockwork_cavalcade")).toBe(0);
    const small = setup(20);
    act(small.s, small.sorc, "clockwork-cavalcade");
    expect(small.a.maxHp - small.a.hp).toBe(20); // the gate (60 missing) wasn't met: nothing happened
    expect(small.sorc.resources.get("clockwork_cavalcade")).toBe(1);
  });

  it("Draconic Presence (18th): 5 sorcery points, each hostile creature in 60 ft makes a Wisdom save or is frightened", () => {
    const s = state(1);
    const sorc = pc("draconic-sorcerer", 18);
    const f = foe("f", { wis: 1 });
    put(s, sorc, f);
    const points = sorc.resources.get("sorcery_points")!;
    act(s, sorc, "draconic-presence");
    expect(f.conditions.has("frightened")).toBe(true);
    expect(sorc.resources.get("sorcery_points")).toBe(points - 5);
    expect(makeTemplate("draconic-sorcerer", 17).actions.some((a) => a.id === "draconic-presence")).toBe(false);
    expect(makeTemplate("draconic-sorcerer", 18).ai.opener).toContain("draconic-presence");
  });

  it("Umbral Form (18th): 6 sorcery points for resistance to everything but force and radiant", () => {
    const taken = (type: "fire" | "force" | "radiant" | "necrotic") => {
      const s = state(15);
      const sorc = pc("shadow-magic-sorcerer", 18);
      put(s, sorc, foe());
      act(s, sorc, "umbral-form");
      const before = sorc.hp;
      applyDamage(s, sorc, 20, type, {});
      return before - sorc.hp;
    };
    expect([taken("fire"), taken("necrotic"), taken("force"), taken("radiant")]).toEqual([10, 10, 20, 20]);
  });

  it("Tides of Chaos: the first d20 roll of the fight has advantage, once", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const sorc = pc("wild-magic-sorcerer", 5);
    const f = foe();
    put(s, sorc, f);
    rollAttack(s, sorc, f, 0, undefined);
    rollAttack(s, sorc, f, 0, undefined);
    expect(modes).toEqual(["adv", "flat"]);
    expect(sorc.resources.get("tides_of_chaos")).toBe(0);
  });

  it("Bend Luck (6th): a d4 off an enemy's attack against an ally (2 sorcery points, a reaction); a d4 onto an ally's failed save", () => {
    const s = state(10);
    const sorc = pc("wild-magic-sorcerer", 6);
    const ally = pc("gwm-fighter", 6, "-a");
    ally.ac = 15;
    const f = foe();
    put(s, sorc, ally, f);
    const points = sorc.resources.get("sorcery_points")!;
    // 10 + 6 = 16 vs AC 15: a 1-point margin — a d4 (2.5 average) turns it into a miss
    expect(rollAttack(s, f, ally, 6, undefined).hit).toBe(false);
    expect(sorc.resources.get("sorcery_points")).toBe(points - 2);
    expect(sorc.reactionUsed).toBe(true);
    const t = state(8);
    const c = pc("wild-magic-sorcerer", 6);
    const d = pc("gwm-fighter", 6, "-d");
    put(t, c, d);
    d.ref.proficientSaves.splice(0); // a plain save: 8 + Con mod vs DC 12, a d4 (4 at max) would clear it
    expect(rollSave(t, d, "wis", 12).passed).toBe(true);
    expect(makeTemplate("wild-magic-sorcerer", 5).reactions.some((r) => r.id === "bend-luck")).toBe(false);
  });
});

describe("fighter additions", () => {
  it("Indomitable (9th): reroll a failed save — once (twice at 13th, three times at 17th), never before 9th", () => {
    const s = state([1, 20, 1, 1]);
    const f = pc("gwm-fighter", 9);
    put(s, f, foe());
    expect(rollSave(s, f, "wis", 15).passed).toBe(true); // failed with a 1, rerolled to a 20
    expect(f.resources.get("indomitable")).toBe(0);
    expect(rollSave(s, f, "wis", 15).passed).toBe(false); // used up
    const uses = (l: number) => makeTemplate("battlemaster-fighter", l).resources.indomitable?.max;
    expect([uses(8), uses(9), uses(13), uses(17)]).toEqual([undefined, 1, 2, 3]);
  });

  it("the Champion's additional Fighting Style (10th): Defense, +1 AC", () => {
    expect([makeTemplate("gwm-fighter", 9).ac, makeTemplate("gwm-fighter", 10).ac]).toEqual([19, 20]);
  });

  it("Parry (Battle Master): a superiority die + Dex off a melee attack's damage — not off a ranged attack", () => {
    const taken = (attackerZone: "melee" | "ranged") => {
      const s = state(15);
      const bm = pc("battlemaster-fighter", 10);
      const f = foe();
      f.zone = attackerZone;
      put(s, bm, f);
      const before = bm.hp;
      applyDamage(s, bm, 20, "slashing", { viaAttack: true, sourceId: f.id });
      return { taken: before - bm.hp, dice: bm.resources.get("superiority") };
    };
    expect(taken("melee")).toEqual({ taken: 20 - (10 + 1), dice: 4 }); // 1d10 + Dex +1
    expect(taken("ranged")).toEqual({ taken: 20, dice: 5 });
  });

  it("Goading Attack: a Wisdom save or the target has disadvantage on attacks against anyone but you", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const bm = pc("battlemaster-fighter", 15);
    const ally = pc("gwm-fighter", 15, "-a");
    const f = foe("f", { wis: 1 });
    put(s, bm, ally, f);
    startTurn(s, bm);
    act(s, bm, "attack-goading");
    expect(hasEffect(f, "goaded")).toBe(true);
    modes.length = 0;
    rollAttack(s, f, ally, 0, undefined);
    rollAttack(s, f, bm, 0, undefined);
    expect(modes).toEqual(["dis", "flat"]);
  });

  it("Distracting Strike: the next attack roll against the target by someone OTHER than you has advantage, once", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const bm = pc("battlemaster-fighter", 15);
    const ally = pc("gwm-fighter", 15, "-a");
    const f = foe();
    put(s, bm, ally, f);
    startTurn(s, bm);
    act(s, bm, "attack-distracting");
    expect(hasEffect(f, "distracted")).toBe(true);
    modes.length = 0;
    rollAttack(s, bm, f, 0, undefined); // your own swing doesn't use it up or benefit from it
    expect(modes.at(-1)).toBe("flat");
    expect(hasEffect(f, "distracted")).toBe(true);
    rollAttack(s, ally, f, 0, undefined);
    expect(modes.at(-1)).toBe("adv");
    rollAttack(s, ally, f, 0, undefined);
    expect(modes.at(-1)).toBe("flat");
  });
});

describe("barbarian additions", () => {
  const barb = (id: string, level: number) => pc(id, level, "-b");

  it("Wolf totem: while raging, allies have advantage on melee attacks against creatures beside the barbarian", () => {
    const roll = (rage: boolean, id = "totem-wolf-barbarian") => {
      const modes: string[] = [];
      const s = state(15, modes);
      const b = barb(id, 3);
      const ally = pc("gwm-fighter", 3, "-a");
      const f = foe();
      put(s, b, ally, f);
      if (rage) cast(s, b, "rage");
      rollAttack(s, ally, f, 0, undefined);
      return modes.at(-1);
    };
    expect(roll(true)).toBe("adv");
    expect(roll(false)).toBe("flat");
    expect(roll(true, "totem-barbarian")).toBe("flat"); // the bear doesn't
  });

  it("Wolf totem (14th): a bonus action to knock a Large or smaller creature prone when you hit it — once", () => {
    const s = state(15);
    const b = barb("totem-wolf-barbarian", 14);
    const f = foe();
    put(s, b, f);
    startTurn(s, b);
    cast(s, b, "rage");
    b.bonusUsedThisTurn = false; // (rage was the bonus action; a later turn has it free)
    act(s, b, "careful-attack");
    expect(f.conditions.has("prone")).toBe(true);
    expect(b.bonusUsedThisTurn).toBe(true);
  });

  it("Elk totem: +15 ft of speed while raging; Eagle totem: opportunity attacks against you have disadvantage", () => {
    const s = state(15);
    const elk = barb("totem-elk-barbarian", 5);
    put(s, elk, foe());
    expect(speedFt(elk)).toBe(40);
    cast(s, elk, "rage");
    expect(speedFt(elk)).toBe(55);
    const oa = (id: string) => {
      const modes: string[] = [];
      const t = state(15, modes);
      const b = barb(id, 3);
      const f = foe();
      f.zone = "melee";
      put(t, b, f);
      cast(t, b, "rage");
      provokeOpportunityAttacks(t, b);
      return modes.at(-1);
    };
    expect(oa("totem-eagle-barbarian")).toBe("dis");
    expect(oa("totem-barbarian")).toBe("flat");
  });

  it("Rage Beyond Death (14th): at 0 HP while raging you stay on your feet, can't die until the rage ends, and die then only if still at 0", () => {
    const s = state(15);
    const z = barb("zealot-barbarian", 14);
    put(s, z, foe());
    startTurn(s, z);
    cast(s, z, "rage");
    z.relentlessUses = 99; // (Relentless Rage, which a 14th-level Zealot also has, would otherwise catch the fall first)
    z.hp = 10;
    applyDamage(s, z, 30, "force", {});
    expect(z.hp).toBe(0);
    expect(z.downed).toBe(false);
    expect(z.zeroHpRaging).toBe(true);
    for (let i = 0; i < 3; i++) applyDamage(s, z, 5, "force", {}); // three failed death saves
    expect(z.alive).toBe(true);
    expect(z.deathPending).toBe(true);
    z.effects = z.effects.filter((e) => e.name !== "rage"); // the rage ends
    endOfTurn(s, z);
    expect(z.alive).toBe(false);

    // healed before it ends: fine
    const t = state(15);
    const w = barb("zealot-barbarian", 14);
    put(t, w, foe());
    startTurn(t, w);
    cast(t, w, "rage");
    w.relentlessUses = 99;
    w.hp = 5;
    applyDamage(t, w, 30, "force", {});
    w.hp = 12; // healed
    w.zeroHpRaging = false;
    endOfTurn(t, w);
    expect(w.alive).toBe(true);

    // without the feature you simply drop
    const u = state(15);
    const plain = barb("zealot-barbarian", 13);
    put(u, plain, foe());
    cast(u, plain, "rage");
    plain.relentlessUses = 99;
    plain.hp = 5;
    applyDamage(u, plain, 30, "force", {});
    expect(plain.downed).toBe(true);
  });

  it("Rage Beyond Death: death saves still come at the start of each turn, and a killing blow still kills", () => {
    const s = state(1); // natural 1s: two failures a save
    const z = barb("zealot-barbarian", 14);
    put(s, z, foe());
    startTurn(s, z);
    cast(s, z, "rage");
    z.relentlessUses = 99;
    z.hp = 1;
    applyDamage(s, z, 10, "force", {});
    startOfTurn(s, z);
    expect(z.deathSaves.fail).toBeGreaterThanOrEqual(2);
    expect(z.alive).toBe(true);
    const massive = barb("zealot-barbarian", 14);
    put(s, massive);
    massive.effects.push({ name: "rage", expiresRound: 99, sourceId: massive.id });
    massive.zeroHpRaging = true;
    massive.hp = 0;
    applyDamage(s, massive, massive.maxHp + 5, "force", {});
    expect(massive.alive).toBe(false);
  });
});

describe("rogue additions", () => {
  it("Cunning Action: Disengage (from 2nd level) is a bonus action, and a disengaged creature provokes no opportunity attacks", () => {
    expect(makeTemplate("thief-rogue", 1).actions.some((a) => a.id === "cunning-disengage")).toBe(false);
    const c = makeTemplate("thief-rogue", 2);
    expect(c.actions.find((a) => a.id === "cunning-disengage")!.cost).toEqual({ bonus: 1 });
    const swing = (disengage: boolean) => {
      const s = state(15);
      const r = pc("assassin-rogue", 5);
      const f = foe();
      f.zone = "melee";
      put(s, r, f);
      startTurn(s, r);
      if (disengage) act(s, r, "cunning-disengage");
      provokeOpportunityAttacks(s, r);
      return f.reactionUsed;
    };
    expect(swing(false)).toBe(true);
    expect(swing(true)).toBe(false);
  });

  it("Psychic Veil (13th): invisible for an hour — attacks from it have advantage, and it ends the moment you deal damage; once, or a psionic die", () => {
    expect(makeTemplate("soulknife-rogue", 12).actions.some((a) => a.id === "psychic-veil")).toBe(false);
    const modes: string[] = [];
    const s = state(15, modes);
    const r = pc("soulknife-rogue", 13);
    const f = foe();
    put(s, r, f);
    startTurn(s, r);
    cast(s, r, "psychic-veil");
    expect(r.conditions.has("invisible")).toBe(true);
    expect(r.resources.get("psychic_veil")).toBe(0);
    modes.length = 0;
    act(s, r, "attack");
    expect(modes[0]).toBe("adv"); // an unseen attacker
    expect(r.conditions.has("invisible")).toBe(false); // it dealt damage
    expect(hasEffect(r, "psychic-veil")).toBe(false);
    // the second time costs a psionic die
    const dice = r.resources.get("psi_die")!;
    startTurn(s, r);
    act(s, r, "psychic-veil");
    expect(r.resources.get("psi_die")).toBe(dice - 1);
  });

  it("Dread Ambusher (Gloom Stalker): +10 ft of speed on the first turn of a combat only", () => {
    const s = state(15);
    const r = pc("gloom-stalker-ranger", 3);
    put(s, r, foe());
    expect(speedFt(r)).toBe(30);
    startTurn(s, r);
    expect(speedFt(r)).toBe(40);
    startTurn(s, r);
    expect(speedFt(r)).toBe(30);
  });

  it("Skirmisher (Scout, 3rd): an AI scout steps away when an enemy ends its turn beside it; no scout reaction before 3rd level", () => {
    expect(makeTemplate("scout-rogue", 2).reactions.some((r) => r.id === "skirmisher")).toBe(false);
    const out = runBattle({
      party: [{ template: "scout-rogue", level: 5, name: "Scout" }],
      enemies: ["ogre"], seed: 4, controlled: [], maxRounds: 4,
    } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(out.done).toBe(true);
    expect(text).toMatch(/Scout (slips away \(Skirmisher\)|disengages \(Cunning Action\)|moves)/);
  });
});

describe("whole fights still run for the changed templates", () => {
  it("no crash", () => {
    for (const id of ["totem-wolf-barbarian", "totem-elk-barbarian", "totem-eagle-barbarian", "zealot-barbarian", "battlemaster-fighter", "gwm-fighter",
      "clockwork-soul-sorcerer", "draconic-sorcerer", "shadow-magic-sorcerer", "wild-magic-sorcerer", "soulknife-rogue", "scout-rogue",
      "monster-slayer-ranger", "fey-wanderer-ranger", "gloom-stalker-ranger"]) {
      for (const level of [3, 9, 14, 18]) {
        const out = runBattle({
          party: [{ template: id, level, name: "X" }, { template: "gwm-fighter", level, name: "Ally" }],
          enemies: ["ogre x2"], seed: level, controlled: [], maxRounds: 5,
        } as never);
        expect(out.done, `${id} L${level}`).toBe(true);
      }
    }
  });
});
