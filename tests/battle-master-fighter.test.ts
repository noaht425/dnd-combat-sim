// Battle Master fighter: real maneuvers beyond Riposte (which already
// worked) — Trip Attack, Menacing Attack, Disarming Attack, and Rally, each
// spending a superiority die. A low-HP target (e.g. a kobold) dies from the
// base weapon damage before the maneuver's own extra die + save ever
// executes (applyDamage/rollSave no-op against an already-dead unit) — these
// use a troll specifically so the maneuver's own effect is observable.

import { describe, expect, it } from "vitest";
import { runBattle } from "../lib/sim/battle";
import { makeTemplate } from "../lib/sim/engine/templates";
import { runAction } from "../lib/sim/engine/interpreter";
import { rollAttack } from "../lib/sim/engine/resolve";
import { spend } from "../lib/sim/engine/ai";
import { initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { startOfTurn } from "../lib/sim/engine/loop";
import { fireEncounterStartTraits } from "../lib/sim/engine/interpreter";
import { makeRng } from "../lib/sim/engine/rng";

/** a bare CombatState: d20s come from `faces` (the last repeats), dice roll their maximum */
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
const bm = (level: number, suffix = "-p") => initCombatant(makeTemplate("battlemaster-fighter", level), "party", suffix);
function foe(size: "medium" | "huge" = "medium", ac = 10): CombatantState {
  const u = initCombatant({ ...makeTemplate("gwm-fighter", 5), ac, size }, "monster", "-m");
  u.hp = u.maxHp = 1000;
  return u;
}
const act = (s: CombatState, u: CombatantState, id: string) => runAction(s, u, u.ref.actions.find((a) => a.id === id)!);

describe("Battle Master fighter — the printed maneuver list", () => {
  it("knows three maneuvers at 3rd level, five at 7th, seven at 10th", () => {
    const ids = (l: number) => {
      const c = makeTemplate("battlemaster-fighter", l);
      return [
        ...c.actions.map((a) => a.id).filter((id) => ["attack-trip", "attack-menacing", "attack-disarming", "rally"].includes(id)),
        ...c.reactions.map((r) => r.id),
        ...(c.specialRules.some((r) => r.rule === "boostMissedAttack") ? ["precision-attack"] : []),
      ];
    };
    expect(ids(3).sort()).toEqual(["attack-trip", "precision-attack", "riposte"]);
    expect(ids(6).sort()).toEqual(["attack-trip", "precision-attack", "riposte"]);
    expect(ids(7).sort()).toEqual(["attack-menacing", "attack-trip", "precision-attack", "rally", "riposte"]);
    expect(ids(10).sort()).toEqual(["attack-disarming", "attack-menacing", "attack-trip", "precision-attack", "rally", "riposte"]);
  });

  it("superiority dice: four d8s, a fifth at 7th, a sixth at 15th; d10 at 10th, d12 at 18th; none before 3rd", () => {
    const dice = (l: number) => makeTemplate("battlemaster-fighter", l).resources.superiority?.max;
    expect([dice(2), dice(3), dice(7), dice(15)]).toEqual([undefined, 4, 5, 6]);
    const size = (l: number) => (makeTemplate("battlemaster-fighter", l).specialRules.find((r) => r.rule === "boostMissedAttack") as { bonusDice: string }).bonusDice;
    expect([size(3), size(10), size(18)]).toEqual(["1d8", "1d10", "1d12"]);
  });

  it("Trip Attack: the extra die always lands, but only a Large or smaller target makes the save", () => {
    const run = (size: "medium" | "huge") => {
      const s = state(15);
      const f = bm(5);
      const t = foe(size);
      t.ref.abilities.str = 1; // Str -5: fails the save
      put(s, f, t);
      act(s, f, "attack-trip");
      return { prone: t.conditions.has("prone"), dice: f.resources.get("superiority") };
    };
    expect(run("medium")).toEqual({ prone: true, dice: 3 });
    expect(run("huge")).toEqual({ prone: false, dice: 3 }); // the die is spent and adds damage; a Huge creature isn't knocked down
  });

  it("Rally: die + Charisma modifier (+0 here) as temporary HP for a companion — never for yourself", () => {
    const s = state(15);
    const f = bm(7);
    const ally = initCombatant(makeTemplate("gwm-fighter", 7), "party", "-a");
    ally.hp = 1;
    put(s, f, ally, foe());
    act(s, f, "rally");
    expect(ally.tempHp).toBe(8); // max of 1d8 + 0
    expect(f.tempHp).toBe(0);
    expect(f.resources.get("superiority")).toBe(4);

    const alone = state(15);
    const solo = bm(7);
    put(alone, solo, foe());
    act(alone, solo, "rally");
    expect(solo.tempHp).toBe(0);
    expect(solo.resources.get("superiority")).toBe(5); // no companion: nothing spent
  });

  it("Riposte is ONE melee attack (not the whole Multiattack) that adds the die to the damage", () => {
    const f = makeTemplate("battlemaster-fighter", 11); // three swings per Attack action
    const rip = f.reactions.find((r) => r.id === "riposte")!;
    const blob = JSON.stringify(rip.automation);
    expect((blob.match(/"type":"attack"/g) ?? []).length).toBe(1);
    expect(blob).toContain('"amount":"1d10"'); // the superiority die at 10th+
    expect(rip.limitedUse).toEqual({ resource: "superiority", amount: 1 });
  });

  it("Precision Attack adds the die to a roll that would miss, spent only if it turns the miss into a hit", () => {
    const s = state(5);
    const f = bm(3);
    const t = foe("medium", 20);
    put(s, f, t);
    expect(rollAttack(s, f, t, 8, undefined).hit).toBe(true); // 5 + 8 + 8 = 21 >= 20
    expect(f.resources.get("superiority")).toBe(3);
    t.ac = 30;
    expect(rollAttack(s, f, t, 8, undefined).hit).toBe(false);
    expect(f.resources.get("superiority")).toBe(3);
  });
});

describe("Fighter base (Player's Handbook): Fighting Style, Second Wind", () => {
  it("Great Weapon Fighting: a 1 or 2 on the weapon's damage dice is rerolled once — but not other dice", () => {
    for (const id of ["gwm-fighter", "battlemaster-fighter"]) {
      const s = state(15);
      const queue = [1, 6, 5]; // first weapon die: 1 -> rerolled to 6; second: 5 stays
      s.rng.dice = (n, sides) => (n === 1 && queue.length ? queue.shift()! : n * sides);
      const f = initCombatant(makeTemplate(id, 5), "party", "-p");
      const t = foe();
      put(s, f, t);
      act(s, f, "attack");
      // the first swing is 2d6+4 with the 1 rerolled to a 6: 6 + 5 + 4; the second swing (Extra Attack) rolls plain, at max: 12 + 4
      expect(t.maxHp - t.hp, id).toBe(6 + 5 + 4 + (2 * 6 + 4));
    }
  });

  it("the Champion has no Great Weapon Master effects: plain greatsword, +Str, no -5 / +10", () => {
    const c = makeTemplate("gwm-fighter", 5); // Str +4, PB +3
    const blob = JSON.stringify(c.actions.find((a) => a.id === "attack")!.automation);
    expect(blob).toContain('"bonus":7');
    expect(blob).toContain('"amount":"2d6+4"');
    expect((blob.match(/"type":"attack"/g) ?? []).length).toBe(2); // Extra Attack at 5th, and no bonus-action swing
  });

  it("Second Wind: 1d10 + fighter level as a bonus action, once per short rest — used once hurt, not before", () => {
    const heal = (hpFraction: number) => {
      const s = state(15);
      const f = initCombatant(makeTemplate("battlemaster-fighter", 5), "party", "-p");
      put(s, f, foe());
      f.hp = Math.floor(f.maxHp * hpFraction);
      const before = f.hp;
      spend(f, f.ref.actions.find((a) => a.id === "second-wind")!);
      act(s, f, "second-wind");
      return f.hp - before;
    };
    expect(heal(0.4)).toBe(10 + 5); // max of 1d10, + level 5
    expect(heal(0.9)).toBe(0);
    expect(makeTemplate("battlemaster-fighter", 5).ai.bonusRoutine).toEqual(["second-wind"]);
    expect(makeTemplate("gwm-fighter", 5).ai.bonusRoutine).toEqual(["second-wind"]);
  });
});

describe("Champion: Survivor (18th)", () => {
  it("regains 5 + Con at the start of a turn while at half HP or below — and not above half", () => {
    const heal = (hpFraction: number) => {
      const s = state(15);
      const f = initCombatant(makeTemplate("gwm-fighter", 18), "party", "-p");
      put(s, f, foe());
      fireEncounterStartTraits(s);
      f.hp = Math.floor(f.maxHp * hpFraction);
      const before = f.hp;
      startOfTurn(s, f);
      return f.hp - before;
    };
    expect(heal(0.5)).toBe(8); // Con +3
    expect(heal(0.9)).toBe(0);
    expect(makeTemplate("gwm-fighter", 17).traits.some((t) => t.id === "survivor")).toBe(false);
  });
});

describe("Battle Master fighter — maneuvers in a fight", () => {
  it("Trip Attack spends a die and knocks prone on a failed save", () => {
    const trip = makeTemplate("battlemaster-fighter", 5).actions.find((a) => a.id === "attack-trip")!;
    let sawProne = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const out = runBattle({
        party: [{ template: "battlemaster-fighter", level: 5 }],
        enemies: ["troll"],
        seed,
        controlled: ["pc-1-battlemaster-fighter"],
        maxRounds: 1,
        decisions: [{ round: 1, unitId: "pc-1-battlemaster-fighter", actionId: trip.id, targetId: "monster-1-troll" }],
      } as never);
      if (/[Pp]rone/.test(out.frames.map((f) => f.text ?? "").join("\n"))) sawProne++;
    }
    expect(sawProne).toBeGreaterThan(5);
  });

});
