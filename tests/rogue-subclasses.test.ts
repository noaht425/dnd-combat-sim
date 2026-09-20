// Rogue and its subclasses, built from the printed text (dnd5e.wikidot.com/rogue and the subclass pages):
// Assassin, Thief, Swashbuckler, Mastermind, Inquisitive, Scout, Soulknife, Arcane Trickster. Every number and
// rule asserted here is one on those pages; the engine seams they use (a real second turn, once-per-turn Sneak
// Attack, contested checks, ...) are exercised directly with rigged dice.

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import type { BattleDecision } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { runAction } from "../lib/sim/engine/interpreter";
import { rollAttack } from "../lib/sim/engine/resolve";
import { spend } from "../lib/sim/engine/ai";
import { provokeOpportunityAttacks } from "../lib/sim/engine/reactions";
import {
  beginTurn, initCombatant, isExtraTurn, rollTurnOrder, turnOwner,
  type CombatState, type CombatantState,
} from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { ARCANE_TRICKSTER_LEARNED } from "../lib/sim/spells/casterTemplates";
import { SPELLS_BY_ID } from "../lib/sim/spells/catalog";
import { maxSlotLevel, slotRow } from "../lib/sim/spells/slots";
import type { Combatant } from "../lib/sim/schema";

const ROGUE_IDS = [
  "assassin-rogue", "thief-rogue", "swashbuckler-rogue", "mastermind-rogue", "inquisitive-rogue",
  "scout-rogue", "soulknife-rogue", "arcane-trickster-rogue",
];

/** a bare CombatState: d20s come from `faces` (the last one repeats), dice always roll their maximum */
function state(faces: number | number[], modes: string[] = []): CombatState {
  const rng = makeRng(1);
  let i = 0;
  const next = () => (Array.isArray(faces) ? faces[Math.min(i++, faces.length - 1)] : faces);
  rng.d20 = () => next();
  rng.d20mode = (m) => { modes.push(m); const f = next(); return { used: f, nat: f }; };
  rng.dice = (n, sides) => n * sides;
  return {
    round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [],
    maxRounds: 10, ended: false, verbose: false, summonCounter: 0,
  };
}
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));
const party = (id: string, level: number, suffix = "-p") => initCombatant(makeTemplate(id, level), "party", suffix);
/** a tough, low-AC dummy (so a d20 face of 15+ always hits a rogue, and nothing dies) */
function dummy(id = "d", over: Partial<Combatant["abilities"]> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const u = initCombatant({ ...base, ac: 10, abilities: { ...base.abilities, ...over } }, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const blind = (u: CombatantState) => u.conditions.set("blinded", { expiresRound: Infinity, sourceId: "x" }); // attacks against it have advantage
const act = (s: CombatState, u: CombatantState, id: string, geo?: Parameters<typeof runAction>[3]) =>
  runAction(s, u, u.ref.actions.find((a) => a.id === id)!, geo);
const sneaks = (u: CombatantState) => u.sneakSpent?.targets.length ?? 0;
const startTurn = (s: CombatState, u: CombatantState) => { beginTurn(s, u); u.actionUsedThisTurn = u.bonusUsedThisTurn = false; };

describe("rogue subclasses — validity and parsing", () => {
  it("every rogue template builds a schema-valid PC at levels 1, 3, 9, 13, 17, 20", () => {
    for (const id of ROGUE_IDS) {
      for (const lvl of [1, 3, 9, 13, 17, 20]) {
        const res = validateCombatant(makeTemplate(id, lvl));
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok).toBe(true);
      }
    }
  });

  it("free text resolves each subclass to its own template; bare 'rogue' is still Assassin", () => {
    for (const [text, id] of [
      ["thief rogue", "thief-rogue"], ["swashbuckler rogue", "swashbuckler-rogue"], ["mastermind rogue", "mastermind-rogue"],
      ["inquisitive rogue", "inquisitive-rogue"], ["scout rogue", "scout-rogue"], ["soulknife rogue", "soulknife-rogue"],
      ["arcane trickster rogue", "arcane-trickster-rogue"], ["rogue", "assassin-rogue"],
    ]) expect(findClassTemplate(text).match?.templateId).toBe(id);
  });
});

describe("the Rogue table: base-class features arrive at their printed levels", () => {
  it("Uncanny Dodge 5th, Evasion 7th, Slippery Mind 15th, Elusive 18th, Stroke of Luck 20th", () => {
    const at = (l: number) => makeTemplate("thief-rogue", l);
    expect(at(4).reactions.some((r) => r.id === "uncanny-dodge")).toBe(false);
    expect(at(5).reactions.some((r) => r.id === "uncanny-dodge")).toBe(true);
    expect(at(6).traits.some((t) => t.id === "evasion")).toBe(false);
    expect(at(7).traits.some((t) => t.id === "evasion")).toBe(true);
    expect(at(14).proficientSaves).not.toContain("wis");
    expect(at(15).proficientSaves).toContain("wis");
    expect(at(17).specialRules.some((r) => r.rule === "denyAdvantageToAttackers")).toBe(false);
    expect(at(18).specialRules.some((r) => r.rule === "denyAdvantageToAttackers")).toBe(true);
    expect(at(19).resources.stroke_of_luck).toBeUndefined();
    expect(at(20).resources.stroke_of_luck).toEqual({ max: 1, recharge: "shortRest" });
    expect(at(20).specialRules).toContainEqual({ rule: "turnMissIntoHit", resource: "stroke_of_luck" });
  });

  it("the Attack action is ONE swing; the off-hand weapon is a separate bonus action with no ability modifier", () => {
    const c = makeTemplate("thief-rogue", 5); // Dex +4
    const atk = JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation);
    expect((atk.match(/"type":"attack"/g) ?? []).length).toBe(1);
    expect(atk).toContain('"amount":"1d8+4"');
    expect(atk).toContain('"amount":"3d6"'); // 5th level: ceil(5/2) = 3d6 Sneak Attack
    const off = c.actions.find((a) => a.id === "offhand")!;
    expect(off.cost).toEqual({ bonus: 1 });
    expect(JSON.stringify(off.automation)).toContain('"amount":"1d6"');
    expect(JSON.stringify(off.automation)).not.toContain("1d6+");
    expect(c.ai.bonusAfterAttack).toEqual(["offhand"]);
  });

  it("Stroke of Luck turns a miss into a hit, once", () => {
    const s = state(2);
    const rogue = party("thief-rogue", 20);
    const t = dummy();
    put(s, rogue, t);
    expect(rollAttack(s, rogue, t, 5, undefined).hit).toBe(true);
    expect(rogue.resources.get("stroke_of_luck")).toBe(0);
    expect(rollAttack(s, rogue, t, 5, undefined).hit).toBe(false); // spent
  });
});

describe("weapon loadout follows the subclass: melee up close, or a shortbow from range", () => {
  it("Swashbuckler, Thief and Inquisitive fight in melee (rapier + shortsword); Assassin, Mastermind, Scout and Arcane Trickster shoot", () => {
    for (const id of ["swashbuckler-rogue", "thief-rogue", "inquisitive-rogue"]) {
      const c = makeTemplate(id, 5);
      expect(c.ai.keepDistance, id).toBe(false);
      expect(JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation)).toContain('"amount":"1d8+4"');
      expect(c.actions.some((a) => a.id === "offhand"), id).toBe(true);
    }
    for (const id of ["assassin-rogue", "mastermind-rogue", "scout-rogue", "arcane-trickster-rogue", "soulknife-rogue"]) {
      const c = makeTemplate(id, 5);
      expect(c.ai.keepDistance, id).toBe(true);
    }
    for (const id of ["assassin-rogue", "mastermind-rogue", "scout-rogue"]) {
      const c = makeTemplate(id, 5); // a shortbow: 1d6 + Dex, and no off-hand attack
      expect(JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation)).toContain('"amount":"1d6+4"');
      expect(c.actions.some((a) => a.id === "offhand"), id).toBe(false);
      expect(c.ai.bonusAfterAttack).toEqual([]);
    }
  });
});

describe("Assassin: Assassinate (RAW)", () => {
  it("advantage against a creature that hasn't taken a turn yet — not after it has, and not before 3rd level", () => {
    const roll = (level: number, acted: boolean) => {
      const modes: string[] = [];
      const s = state(15, modes);
      const rogue = party("assassin-rogue", level);
      const foe = dummy();
      foe.hasTakenTurn = acted;
      put(s, rogue, foe);
      rollAttack(s, rogue, foe, 0, undefined);
      return modes[0];
    };
    expect(roll(5, false)).toBe("adv");
    expect(roll(5, true)).toBe("flat");
    expect(roll(2, false)).toBe("flat");
  });

  it("beginning a turn marks a creature as having acted", () => {
    const s = state(15);
    const foe = dummy();
    put(s, foe);
    expect(foe.hasTakenTurn).toBeUndefined();
    beginTurn(s, foe);
    expect(foe.hasTakenTurn).toBe(true);
  });

  it("gives no initiative jump and no automatic crit (nothing in the sim is surprised)", () => {
    const rogue = party("assassin-rogue", 5);
    expect(rogue.assassinateUntilRound).toBeUndefined();
    const s = state(15);
    const foe = dummy();
    put(s, rogue, foe);
    expect(rollAttack(s, rogue, foe, 0, undefined).crit).toBe(false);
  });
});

describe("Sneak Attack — once per turn, and only with advantage or a flanking ally", () => {
  const setup = (faces = 15) => {
    const s = state(faces);
    const rogue = party("thief-rogue", 5);
    const t = dummy();
    put(s, rogue, t);
    startTurn(s, rogue);
    return { s, rogue, t };
  };

  it("does nothing without advantage or an adjacent ally", () => {
    const { s, rogue } = setup();
    act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
    expect(sneaks(rogue)).toBe(0);
  });

  it("works with advantage — but only once per turn, however many hits you make", () => {
    const { s, rogue, t } = setup();
    blind(t);
    act(s, rogue, "attack");
    act(s, rogue, "offhand");
    expect(sneaks(rogue)).toBe(1);
    startTurn(s, rogue); // a new turn: the budget resets
    act(s, rogue, "attack");
    expect(sneaks(rogue)).toBe(1);
    expect(rogue.sneakSpent!.serial).toBe(2);
  });

  it("works with an ally beside the target, unless you also have disadvantage", () => {
    const flank = { geo: { attackMods: () => ({ allyAdjacent: true }) } };
    const a = setup();
    act(a.s, a.rogue, "attack", flank);
    expect(sneaks(a.rogue)).toBe(1);
    const b = setup();
    act(b.s, b.rogue, "attack", { geo: { attackMods: () => ({ allyAdjacent: true, disadvantage: true }) } });
    expect(sneaks(b.rogue)).toBe(0);
  });

  it("advantage cancelled by disadvantage is no advantage", () => {
    const { s, rogue, t } = setup();
    blind(t);
    act(s, rogue, "attack", { geo: { attackMods: () => ({ disadvantage: true }) } });
    expect(sneaks(rogue)).toBe(0);
  });
});

describe("Thief: Thief's Reflexes — a real second turn in round 1", () => {
  const order = (id: string, level: number, monsterRules: Combatant["specialRules"] = []) => {
    const rogue = party(id, level);
    const ally = party("gwm-fighter", 17, "-a");
    const base = makeTemplate("gwm-fighter", 5);
    const mon = initCombatant({ ...base, specialRules: monsterRules }, "monster", "-m");
    return { rogue, order: rollTurnOrder([rogue, ally, mon], makeRng(3), () => 0) };
  };

  it("adds exactly one extra slot, only for a 17th-level Thief, and it comes after the first", () => {
    const { rogue, order: o } = order("thief-rogue", 17);
    const extras = o.filter(isExtraTurn);
    expect(extras).toHaveLength(1);
    expect(turnOwner(extras[0])).toBe(rogue.id);
    expect(o.indexOf(extras[0])).toBeGreaterThan(o.indexOf(rogue.id));
    expect(order("thief-rogue", 16).order.some(isExtraTurn)).toBe(false);
    expect(order("assassin-rogue", 17).order.some(isExtraTurn)).toBe(false);
  });

  it("is lost when the party is surprised (an ambushing monster)", () => {
    expect(order("thief-rogue", 17, [{ rule: "ambush" }]).order.some(isExtraTurn)).toBe(false);
  });

  it("the second turn actually happens in round 1 and never again", () => {
    let seconds = 0;
    let rogueTurns = 0;
    const out = runBattle({
      party: [{ template: "thief-rogue", level: 17, name: "Fingers" }],
      enemies: ["ogre x3"], seed: 5, controlled: [], maxRounds: 4,
    } as never);
    for (const f of out.frames) {
      if (/takes a second turn/.test(f.text ?? "")) seconds++;
      if (f.kind === "turn" && /Fingers ends its turn/.test(f.text ?? "")) rogueTurns++;
    }
    expect(seconds).toBe(1);
    expect(rogueTurns).toBeGreaterThanOrEqual(2); // first turn, second turn, then one per later round
  });

  it("a controlled Thief is asked twice in round 1 — the second decision is keyed apart from the first", () => {
    const setup = { party: [{ template: "thief-rogue", level: 17, name: "Fingers" }], enemies: ["ogre x3"], seed: 5, controlled: ["pc-1-thief-rogue"], maxRounds: 3 };
    const decisions: BattleDecision[] = [];
    const asked: { round: number; extra: boolean }[] = [];
    let run = runBattle({ ...setup, decisions } as never);
    let guard = 40;
    while (!run.done && run.awaiting && guard-- > 0) {
      asked.push({ round: run.awaiting.round, extra: !!run.awaiting.extraTurn });
      decisions.push({ round: run.awaiting.round, unitId: run.awaiting.unitId, extraTurn: run.awaiting.extraTurn, auto: true });
      run = runBattle({ ...setup, decisions } as never);
    }
    expect(asked.filter((a) => a.round === 1 && !a.extra)).toHaveLength(1);
    expect(asked.filter((a) => a.round === 1 && a.extra)).toHaveLength(1);
    expect(asked.filter((a) => a.round > 1 && a.extra)).toHaveLength(0);
  });
});

describe("Swashbuckler (Xanathar's)", () => {
  it("Rakish Audacity: + Charisma to initiative from 3rd level", () => {
    expect(makeTemplate("swashbuckler-rogue", 2).initiativeBonus).toBeUndefined();
    expect(makeTemplate("swashbuckler-rogue", 5).initiativeBonus).toBe(4 + 2); // Dex +4, Cha +2
  });

  it("Rakish Audacity: Sneak Attack in a solo duel, without advantage — but not with disadvantage, and not for other rogues", () => {
    const run = (id: string, mods: object) => {
      const s = state(15);
      const rogue = party(id, 5);
      put(s, rogue, dummy());
      startTurn(s, rogue);
      act(s, rogue, "attack", { geo: { attackMods: () => mods } });
      return sneaks(rogue);
    };
    expect(run("swashbuckler-rogue", { soloDuel: true })).toBe(1);
    expect(run("swashbuckler-rogue", {})).toBe(0); // someone else within 5 ft of the rogue
    expect(run("swashbuckler-rogue", { soloDuel: true, disadvantage: true })).toBe(0);
    expect(run("thief-rogue", { soloDuel: true })).toBe(0);
  });

  it("Fancy Footwork: a creature you meleed this turn can't make an opportunity attack against you", () => {
    const swing = (id: string) => {
      const s = state(15);
      const rogue = party(id, 5);
      rogue.zone = "melee";
      const foe = dummy();
      put(s, rogue, foe);
      startTurn(s, rogue);
      act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
      provokeOpportunityAttacks(s, rogue);
      return foe.reactionUsed;
    };
    expect(swing("swashbuckler-rogue")).toBe(false);
    expect(swing("thief-rogue")).toBe(true); // control: anyone else provokes
  });

  it("Master Duelist (17th): a miss is rolled again with advantage, once per rest", () => {
    const modes: string[] = [];
    const s = state([2, 19], modes); // the first roll misses, the reroll hits
    const rogue = party("swashbuckler-rogue", 17);
    const t = dummy();
    put(s, rogue, t);
    expect(makeTemplate("swashbuckler-rogue", 16).specialRules.some((r) => r.rule === "rerollMissWithAdvantage")).toBe(false);
    expect(rollAttack(s, rogue, t, 0, undefined).hit).toBe(true); // 2 misses AC 10; the advantage reroll (19) hits
    expect(modes).toEqual(["flat", "adv"]);
    expect(rogue.resources.get("master_duelist")).toBe(0);
  });

  it("Panache (9th): a hostile creature that loses the contest has disadvantage against everyone but you, until an ally attacks it", () => {
    expect(makeTemplate("swashbuckler-rogue", 8).actions.some((a) => a.id === "panache")).toBe(false);
    const modes: string[] = [];
    const s = state([15, 3, 15], modes); // Persuasion beats Insight
    const rogue = party("swashbuckler-rogue", 9);
    const ally = party("gwm-fighter", 9, "-a");
    const foe = dummy("f");
    put(s, rogue, ally, foe);
    act(s, rogue, "panache");
    expect(foe.effects.some((e) => e.name === "panache")).toBe(true);
    rollAttack(s, foe, ally, 0, undefined);
    rollAttack(s, foe, rogue, 0, undefined);
    expect(modes).toEqual(["dis", "flat"]);
    rollAttack(s, ally, foe, 0, undefined); // a companion attacks it: the hold ends
    expect(foe.effects.some((e) => e.name === "panache")).toBe(false);
  });

  it("Panache does nothing when the target wins the contest", () => {
    const s = state([3, 15]);
    const rogue = party("swashbuckler-rogue", 9);
    const foe = dummy("f");
    put(s, rogue, foe);
    act(s, rogue, "panache");
    expect(foe.effects).toHaveLength(0);
  });
});

describe("Mastermind: Master of Tactics (Help as a bonus action)", () => {
  it("is a bonus action from 3rd level, taken before the attack when there's an ally to help", () => {
    expect(makeTemplate("mastermind-rogue", 2).actions.some((a) => a.id === "master-of-tactics")).toBe(false);
    const c = makeTemplate("mastermind-rogue", 3);
    expect(c.actions.find((a) => a.id === "master-of-tactics")!.cost).toEqual({ bonus: 1 });
    expect(c.ai.bonusRoutine).toEqual(["master-of-tactics"]);
  });

  it("the first attack an ally makes against the creature has advantage; the second does not; it lapses at your next turn", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const rogue = party("mastermind-rogue", 5);
    const ally = party("gwm-fighter", 5, "-a");
    const foe = dummy();
    put(s, rogue, ally, foe);
    act(s, rogue, "master-of-tactics");
    expect(foe.effects.some((e) => e.name === "helped")).toBe(true);
    rollAttack(s, ally, foe, 0, undefined);
    rollAttack(s, ally, foe, 0, undefined);
    expect(modes).toEqual(["adv", "flat"]);

    act(s, rogue, "master-of-tactics");
    beginTurn(s, rogue);
    expect(foe.effects.some((e) => e.name === "helped")).toBe(false);
  });

  it("does nothing when the rogue has no ally", () => {
    const s = state(15);
    const rogue = party("mastermind-rogue", 5);
    const foe = dummy();
    put(s, rogue, foe);
    act(s, rogue, "master-of-tactics");
    expect(foe.effects).toHaveLength(0);
  });
});

describe("Inquisitive: Insightful Fighting", () => {
  const setup = (level: number, faces: number[]) => {
    const s = state(faces);
    const rogue = party("inquisitive-rogue", level);
    const foe = dummy();
    put(s, rogue, foe);
    startTurn(s, rogue);
    return { s, rogue, foe };
  };

  it("a won contest (Insight vs the target's Deception) lets Sneak Attack land without advantage", () => {
    const { s, rogue, foe } = setup(5, [15, 3, 15]);
    act(s, rogue, "insightful-fighting");
    expect(rogue.insightTargetId).toBe(foe.id);
    act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
    expect(sneaks(rogue)).toBe(1);
  });

  it("a lost contest reads nothing, so no Sneak Attack without advantage", () => {
    const { s, rogue } = setup(5, [3, 15, 15]);
    act(s, rogue, "insightful-fighting");
    expect(rogue.insightTargetId).toBeUndefined();
    act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
    expect(sneaks(rogue)).toBe(0);
  });

  it("disadvantage on the attack still forbids it", () => {
    const { s, rogue } = setup(5, [15, 3, 15]);
    act(s, rogue, "insightful-fighting");
    act(s, rogue, "attack", { geo: { attackMods: () => ({ disadvantage: true }) } });
    expect(sneaks(rogue)).toBe(0);
  });

  it("isn't wasted again on a creature already being read", () => {
    const { s, rogue } = setup(5, [15, 3, 15]);
    act(s, rogue, "insightful-fighting");
    const c = makeTemplate("inquisitive-rogue", 5);
    expect(c.ai.bonusRoutine).toEqual(["insightful-fighting"]);
    // the action is a single branch gated on "not already reading anyone" — the AI's availability check reads it
    expect(JSON.stringify(c.actions.find((a) => a.id === "insightful-fighting")!.automation)).toContain("self.not_reading");
    expect(rogue.insightTargetId).toBeDefined();
  });

  it("Eye for Weakness (17th): +3d6 against the creature you're reading — and only then", () => {
    const damage = (level: number, read: boolean) => {
      const { s, rogue, foe } = setup(level, read ? [15, 3, 15] : [15]);
      if (read) act(s, rogue, "insightful-fighting");
      else blind(foe); // advantage instead: Sneak Attack lands, but the foe isn't being read
      act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
      return foe.maxHp - foe.hp;
    };
    // Dex +5 at 17th: 1d8+5 (13) + 9d6 Sneak Attack (54)
    expect(damage(17, false)).toBe(13 + 54);
    expect(damage(17, true)).toBe(13 + 54 + 18);
  });
});

describe("Scout (Xanathar's)", () => {
  it("Superior Mobility (9th): +10 ft walking speed", () => {
    expect(makeTemplate("scout-rogue", 8).speeds.walk).toBe(30);
    expect(makeTemplate("scout-rogue", 9).speeds.walk).toBe(40);
  });

  it("Ambush Master (13th): advantage on initiative rolls", () => {
    expect(makeTemplate("scout-rogue", 12).specialRules.some((r) => r.rule === "initiativeAdvantage")).toBe(false);
    expect(makeTemplate("scout-rogue", 13).specialRules.some((r) => r.rule === "initiativeAdvantage")).toBe(true);
    const modes: string[] = [];
    const rng = makeRng(1);
    const real = rng.d20mode;
    rng.d20mode = (m) => { modes.push(m); return real(m); };
    rollTurnOrder([party("scout-rogue", 13), dummy()], rng, () => 0);
    expect(modes).toEqual(["adv"]); // only the scout rolls with advantage
  });

  it("Ambush Master: the first creature you hit in round 1 is easier for everyone to hit until your next turn", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const rogue = party("scout-rogue", 13);
    const ally = party("gwm-fighter", 13, "-a");
    const foe = dummy("a");
    const other = dummy("b");
    put(s, rogue, ally, foe, other);
    startTurn(s, rogue);
    act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
    const tagged = [foe, other].find((u) => u.effects.some((e) => e.name === "ambush-master"))!;
    expect(tagged).toBeDefined();
    rollAttack(s, ally, tagged, 0, undefined);
    expect(modes.at(-1)).toBe("adv");
    startTurn(s, rogue);
    expect(tagged.effects.some((e) => e.name === "ambush-master")).toBe(false);
    // only the FIRST creature, and only in round 1
    act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
    expect([foe, other].filter((u) => u.effects.some((e) => e.name === "ambush-master"))).toHaveLength(0);
  });

  it("Sudden Strike (17th): a bonus-action attack that may Sneak Attack again — but never the same target twice", () => {
    expect(makeTemplate("scout-rogue", 16).actions.some((a) => a.id === "sudden-strike")).toBe(false);
    expect(makeTemplate("scout-rogue", 17).actions.find((a) => a.id === "sudden-strike")!.cost).toEqual({ bonus: 1 });
    expect(makeTemplate("scout-rogue", 17).ai.bonusAfterAttack).toEqual(["sudden-strike"]);

    const two = (() => {
      const s = state(15);
      const rogue = party("scout-rogue", 17);
      const a = dummy("a"), b = dummy("b");
      blind(a); blind(b);
      put(s, rogue, a, b);
      startTurn(s, rogue);
      act(s, rogue, "attack");
      act(s, rogue, "sudden-strike");
      return { rogue, a, b };
    })();
    expect(sneaks(two.rogue)).toBe(2);
    expect(new Set(two.rogue.sneakSpent!.targets).size).toBe(2); // two different creatures

    const one = (() => {
      const s = state(15);
      const rogue = party("scout-rogue", 17);
      const a = dummy("a");
      blind(a);
      put(s, rogue, a);
      startTurn(s, rogue);
      act(s, rogue, "attack");
      act(s, rogue, "sudden-strike");
      return rogue;
    })();
    expect(sneaks(one)).toBe(1); // only one creature to hit: the second Sneak Attack is refused

    // and a rogue without Sudden Strike can't Sneak Attack twice even against different creatures
    const s = state(15);
    const plain = party("thief-rogue", 17);
    const a = dummy("a"), b = dummy("b");
    blind(a); blind(b);
    put(s, plain, a, b);
    startTurn(s, plain);
    act(s, plain, "attack");
    plain.actionUsedThisTurn = false;
    act(s, plain, "attack");
    expect(sneaks(plain)).toBe(1);
  });
});

describe("Soulknife (Tasha's)", () => {
  it("Psionic Energy dice: twice the proficiency bonus, growing d6 / d8 / d10 / d12 at 5th / 11th / 17th", () => {
    const dice = (l: number) => makeTemplate("soulknife-rogue", l).resources.psi_die?.max;
    expect([dice(3), dice(5), dice(9), dice(13), dice(17)]).toEqual([4, 6, 8, 10, 12]);
    const size = (l: number) => (makeTemplate("soulknife-rogue", l).specialRules.find((r) => r.rule === "boostMissedAttack") as { bonusDice: string }).bonusDice;
    expect([size(9), size(11), size(17)]).toEqual(["1d8", "1d10", "1d12"]);
  });

  it("Psychic Blades: 1d6 + Dex psychic (Sneak Attack too); the second blade is a bonus action for 1d4 + Dex", () => {
    const c = makeTemplate("soulknife-rogue", 5);
    const atk = JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation);
    expect(atk).toContain('"amount":"1d6+4","damageType":"psychic"');
    expect(atk).toContain('"amount":"3d6","damageType":"psychic"');
    expect(atk).not.toContain("piercing");
    const second = c.actions.find((a) => a.id === "offhand")!;
    expect(second.name).toBe("Second Psychic Blade");
    expect(second.cost).toEqual({ bonus: 1 });
    expect(JSON.stringify(second.automation)).toContain('"amount":"1d4+4","damageType":"psychic"');
    // before 3rd level there are no blades
    expect(JSON.stringify(makeTemplate("soulknife-rogue", 2).actions.find((a) => a.id === "attack")!.automation)).toContain("piercing");
  });

  it("Homing Strikes (9th): a psionic die added to a miss is spent only if it turns the miss into a hit", () => {
    const s = state(5);
    const rogue = party("soulknife-rogue", 9); // d8 dice: max 8 added
    const t = dummy();
    t.ac = 20;
    put(s, rogue, t);
    const before = rogue.resources.get("psi_die")!;
    expect(rollAttack(s, rogue, t, 8, undefined).hit).toBe(true); // 5 + 8 + 8 = 21 >= 20
    expect(rogue.resources.get("psi_die")).toBe(before - 1);
    t.ac = 30;
    expect(rollAttack(s, rogue, t, 8, undefined).hit).toBe(false); // 21 < 30: not spent
    expect(rogue.resources.get("psi_die")).toBe(before - 1);
    expect(makeTemplate("soulknife-rogue", 8).specialRules.some((r) => r.rule === "boostMissedAttack")).toBe(false);
  });

  it("regain a Psionic Energy die (bonus action, once per short rest), never above the maximum", () => {
    const s = state(15);
    const rogue = party("soulknife-rogue", 5);
    put(s, rogue);
    rogue.resources.set("psi_die", 2);
    const recover = () => { spend(rogue, rogue.ref.actions.find((a) => a.id === "psionic-recovery")!); act(s, rogue, "psionic-recovery"); }; // the turn loops spend limitedUse before running an action
    recover();
    expect(rogue.resources.get("psi_die")).toBe(3);
    expect(rogue.resources.get("psi_recovery")).toBe(0);
    rogue.resources.set("psi_die", 6);
    rogue.resources.set("psi_recovery", 1);
    recover();
    expect(rogue.resources.get("psi_die")).toBe(6);
  });

  it("Rend Mind (17th): a Sneak Attack hit forces a Wisdom save (DC 8 + PB + Dex) or stuns; once, then three dice a time", () => {
    const c = makeTemplate("soulknife-rogue", 17); // PB 6, Dex +5: DC 19
    expect(JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation)).toContain('"dc":19');
    expect(makeTemplate("soulknife-rogue", 16).resources.rend_mind).toBeUndefined();

    const s = state(15);
    const rogue = party("soulknife-rogue", 17);
    const t = dummy("t", { wis: 1 }); // Wis -5: 15 - 5 = 10 < 19, always fails
    blind(t);
    put(s, rogue, t);
    startTurn(s, rogue);
    act(s, rogue, "attack");
    expect(t.conditions.has("stunned")).toBe(true);
    expect(rogue.resources.get("rend_mind")).toBe(0);
    expect(rogue.resources.get("psi_die")).toBe(12);

    t.conditions.delete("stunned");
    startTurn(s, rogue);
    act(s, rogue, "attack");
    expect(t.conditions.has("stunned")).toBe(true); // now paid for with three psionic dice
    expect(rogue.resources.get("psi_die")).toBe(9);
  });

  it("Rend Mind needs Sneak Attack damage to have landed", () => {
    const s = state(15);
    const rogue = party("soulknife-rogue", 17);
    const t = dummy("t", { wis: 1 });
    put(s, rogue, t);
    startTurn(s, rogue);
    act(s, rogue, "attack", { geo: { attackMods: () => ({}) } }); // no advantage, no flanker: no Sneak Attack
    expect(t.conditions.has("stunned")).toBe(false);
    expect(rogue.resources.get("rend_mind")).toBe(1);
  });
});

describe("Arcane Trickster: the printed spell table", () => {
  const KNOWN = { 3: 3, 4: 4, 5: 4, 6: 4, 7: 5, 8: 6, 9: 6, 10: 7, 11: 8, 12: 8, 13: 9, 14: 10, 15: 10, 16: 11, 17: 11, 18: 11, 19: 12, 20: 13 } as Record<number, number>;

  it("spells known follow the Spells Known column at every level", () => {
    for (let l = 3; l <= 20; l++) expect(ARCANE_TRICKSTER_LEARNED.filter((x) => x.level <= l).length).toBe(KNOWN[l]);
  });

  it("every spell is a wizard spell of a level you have slots for when you learn it", () => {
    for (const { level, spell } of ARCANE_TRICKSTER_LEARNED) {
      const sp = SPELLS_BY_ID[spell];
      expect(sp, spell).toBeDefined();
      expect(sp.classes).toContain("wizard");
      expect(sp.level).toBeLessThanOrEqual(maxSlotLevel("third", level));
    }
  });

  it("all but the 8th / 14th / 20th-level picks and one of the three first-level spells are enchantment or illusion", () => {
    const anySchool = ARCANE_TRICKSTER_LEARNED.filter((x) => !["enchantment", "illusion"].includes(SPELLS_BY_ID[x.spell].school));
    expect(anySchool.every((x) => [3, 8, 14, 20].includes(x.level))).toBe(true);
    expect(anySchool.filter((x) => x.level === 3)).toHaveLength(1);
    expect(anySchool.length).toBeLessThanOrEqual(4);
  });

  it("slots are the third-caster row: two 1st-level at 3rd, a 2nd-level at 7th, 3rd at 13th, 4th at 19th", () => {
    expect(slotRow("third", 3)).toEqual([2]);
    expect(slotRow("third", 7)).toEqual([4, 2]);
    expect(slotRow("third", 13)).toEqual([4, 3, 2]);
    expect(slotRow("third", 19)).toEqual([4, 3, 3, 1]);
    expect(makeTemplate("arcane-trickster-rogue", 2).resources.slot1?.max ?? 0).toBe(0);
  });

  it("no spells before 3rd level; Hypnotic Pattern only once 3rd-level slots exist (13th)", () => {
    expect(makeTemplate("arcane-trickster-rogue", 2).actions.filter((a) => a.isSpell)).toHaveLength(0);
    expect(makeTemplate("arcane-trickster-rogue", 12).actions.some((a) => a.name === "Hypnotic Pattern")).toBe(false);
    expect(makeTemplate("arcane-trickster-rogue", 13).actions.some((a) => a.name === "Hypnotic Pattern")).toBe(true);
    expect(makeTemplate("arcane-trickster-rogue", 3).reactions.some((r) => r.id === "shield")).toBe(true);
  });

  it("carries the rogue base at the printed levels", () => {
    const c = makeTemplate("arcane-trickster-rogue", 7);
    expect(c.traits.some((t) => t.id === "evasion")).toBe(true);
    expect(c.reactions.some((r) => r.id === "uncanny-dodge")).toBe(true);
    expect(makeTemplate("arcane-trickster-rogue", 6).traits.some((t) => t.id === "evasion")).toBe(false);
    expect(c.actions.some((a) => a.id === "offhand")).toBe(false); // it shoots a bow: no off-hand weapon
  });

  it("Versatile Trickster (13th): a bonus action giving advantage until your next turn, which lets Sneak Attack land", () => {
    expect(makeTemplate("arcane-trickster-rogue", 12).actions.some((a) => a.id === "versatile-trickster")).toBe(false);
    const s = state(15);
    const rogue = party("arcane-trickster-rogue", 13);
    const foe = dummy();
    put(s, rogue, foe);
    startTurn(s, rogue);
    act(s, rogue, "versatile-trickster");
    act(s, rogue, "attack", { geo: { attackMods: () => ({}) } });
    expect(sneaks(rogue)).toBe(1);
    beginTurn(s, rogue);
    expect(rogue.effects.some((e) => e.name === "versatile-trickster")).toBe(false);
  });
});

describe("whole fights run cleanly for every rogue at the levels where new features appear", () => {
  it("no crash, and every fight reaches a result", () => {
    for (const id of ROGUE_IDS) {
      for (const level of [3, 9, 13, 17]) {
        const out = runBattle({
          party: [{ template: id, level, name: "Rogue" }, { template: "gwm-fighter", level, name: "Bruiser" }],
          enemies: ["ogre x2"], seed: level, controlled: [], maxRounds: 6,
        } as never);
        expect(out.done, `${id} L${level}`).toBe(true);
        expect(out.frames.length).toBeGreaterThan(2);
      }
    }
  });
});
