// Artificer subclasses (Tasha's Cauldron of Everything), built from the printed text read from
// dnd5e.wikidot.com/artificer and its subclass pages: Battle Smith (corrected), Artillerist,
// Armorer (Guardian + Infiltrator), Alchemist. Numbers asserted here are the ones on those pages.

import { describe, expect, it } from "vitest";
import { makeTemplate } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { findClassTemplate } from "../lib/combat/classTemplates";
import { parsePartyMember } from "../lib/combat/setupParser";
import { PC_SUMMONS, eldritchCannonFor, steelDefenderFor } from "../lib/sim/engine/minions";
import { rollAttack, rollSave, applyDamage, saveModifierOf } from "../lib/sim/engine/resolve";
import { initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { cantripsKnown } from "../lib/sim/spells/prepare";
import { buildParty } from "../lib/sim/engine/scenario";

const ARTIFICER_IDS = [
  "battlesmith-artificer", "artillerist-artificer", "armorer-guardian-artificer",
  "armorer-infiltrator-artificer", "alchemist-artificer",
];

/** a bare CombatState whose d20 always lands on `face`, recording the mode each roll was made with */
function state(face: number, modes: string[] = []): CombatState {
  const rng = makeRng(1);
  rng.d20mode = (m) => { modes.push(m); return { used: face, nat: face }; };
  return {
    round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [],
    maxRounds: 10, ended: false, verbose: false, summonCounter: 0,
  };
}
const unit = (id: string, level: number, side: "party" | "monster"): CombatantState => initCombatant(makeTemplate(id, level), side, `-${side}`);
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));

describe("artificer subclasses — schema validity and parsing", () => {
  it("every artificer template builds a schema-valid PC at levels 3, 5, 9, 15, 20", () => {
    for (const id of ARTIFICER_IDS) {
      for (const lvl of [3, 5, 9, 15, 20]) {
        const res = validateCombatant(makeTemplate(id, lvl));
        if (!res.ok) console.error(`${id} L${lvl}:`, res.errors);
        expect(res.ok).toBe(true);
      }
    }
  });

  it("free text resolves each subclass to its own template; bare 'artificer' stays Battle Smith", () => {
    expect(findClassTemplate("artillerist artificer").match?.templateId).toBe("artillerist-artificer");
    expect(findClassTemplate("alchemist").match?.templateId).toBe("alchemist-artificer");
    expect(findClassTemplate("armorer").match?.templateId).toBe("armorer-guardian-artificer");
    expect(findClassTemplate("infiltrator armorer").match?.templateId).toBe("armorer-infiltrator-artificer");
    expect(findClassTemplate("artificer").match?.templateId).toBe("battlesmith-artificer");
    // typing a registered name is not a substitution, so no "only X is built" note
    expect(parsePartyMember("armorer artificer level 5").subclassNote).toBeUndefined();
  });

  it("artificers know cantrips: 2 through 9th level, 3 at 10th, 4 at 14th (class table)", () => {
    expect(cantripsKnown("artificer", 5)).toBe(2);
    expect(cantripsKnown("artificer", 10)).toBe(3);
    expect(cantripsKnown("artificer", 14)).toBe(4);
    expect(makeTemplate("artillerist-artificer", 5).actions.filter((a) => a.isSpell && !/-\d+$/.test(a.id)).length).toBeGreaterThan(0);
  });

  it("each subclass's always-prepared spells are included (Artillerist: Shield + Thunderwave at 3rd, Fireball at 9th)", () => {
    const at3 = makeTemplate("artillerist-artificer", 3);
    expect(at3.reactions.some((r) => r.id === "shield")).toBe(true);
    expect(at3.actions.some((a) => a.name === "Thunderwave")).toBe(true);
    expect(makeTemplate("artillerist-artificer", 9).actions.some((a) => a.name === "Fireball")).toBe(true);
    expect(makeTemplate("alchemist-artificer", 3).actions.some((a) => a.name === "Healing Word")).toBe(true);
    expect(makeTemplate("armorer-guardian-artificer", 3).actions.some((a) => a.name === "Magic Missile")).toBe(true);
  });
});

describe("Battle Smith — Steel Defender per the printed stat block", () => {
  it("HP = 2 + INT + 5 x level, AC 15 (+2 at 15th), Rend = 1d8 + PB force, immune to poison", () => {
    const l5 = PC_SUMMONS[steelDefenderFor(5, 4, 3)];
    expect(l5.maxHp).toBe(2 + 4 + 25);
    expect(l5.ac).toBe(15);
    expect(l5.immunities).toContain("poison");
    expect(l5.conditionImmunities.sort()).toEqual(["charmed", "exhaustion", "poisoned"]);
    const rend = JSON.stringify(l5.actions.find((a) => a.id === "rend")!.automation);
    expect(rend).toContain('"amount":"1d8+3"'); // PB 3 at level 5
    expect(rend).toContain('"bonus":7'); // spell attack modifier: PB 3 + INT 4
    const l15 = PC_SUMMONS[steelDefenderFor(15, 4, 5)];
    expect(l15.ac).toBe(17);
    expect(l15.maxHp).toBe(2 + 4 + 75);
  });

  it("only Dodges on its own turn unless commanded; Rend and Repair aren't self-chosen actions", () => {
    const d = PC_SUMMONS[steelDefenderFor(5, 4, 3)];
    expect(d.commandOnly).toBe(true);
    const selfChosen = d.actions.filter((a) => (a.cost.action ?? 0) > 0).map((a) => a.id);
    expect(selfChosen).toEqual(["dodge"]);
    expect(d.resources.repair).toEqual({ max: 3, recharge: "longRest" });
  });

  it("Arcane Jolt (9th): INT-mod uses, +2d6 force (+4d6 at 15th); Enhanced Weapon is +1, +2 from 10th", () => {
    expect(makeTemplate("battlesmith-artificer", 8).resources.arcane_jolt).toBeUndefined();
    expect(makeTemplate("battlesmith-artificer", 9).resources.arcane_jolt).toEqual({ max: 4, recharge: "longRest" });
    const blob = (lvl: number) => JSON.stringify(makeTemplate("battlesmith-artificer", lvl).actions.find((a) => a.id === "attack")!.automation);
    expect(blob(9)).toContain('"amount":"2d6"');
    expect(blob(15)).toContain('"amount":"4d6"');
    expect(blob(9)).toContain('"amount":"1d8+5"'); // INT 4 + 1
    expect(blob(10)).toContain('"amount":"1d8+6"'); // INT 4 + 2
  });

  it("Deflect Attack imposes disadvantage on an attack against the artificer by a creature next to the defender", () => {
    const modes: string[] = [];
    const s = state(15, modes);
    const smith = unit("battlesmith-artificer", 5, "party");
    const defender = initCombatant(PC_SUMMONS[steelDefenderFor(5, 4, 3)], "party", "#1");
    defender.summonerId = smith.id;
    const foe = unit("gwm-fighter", 5, "monster");
    put(s, smith, defender, foe);
    rollAttack(s, foe, smith, 5, undefined);
    expect(modes).toEqual(["dis"]);
    expect(defender.reactionUsed).toBe(true);
    // an attack against the defender itself is not covered ("a creature other than the defender")
    const modes2: string[] = [];
    const s2 = state(15, modes2);
    const defender2 = initCombatant(PC_SUMMONS[steelDefenderFor(5, 4, 3)], "party", "#2");
    defender2.summonerId = smith.id;
    put(s2, smith, defender2, foe);
    rollAttack(s2, foe, defender2, 5, undefined);
    expect(modes2).toEqual(["flat"]);
  });

  it("a summoned party companion at 0 HP is destroyed, not knocked down to roll death saves", () => {
    const s = state(10);
    const smith = unit("battlesmith-artificer", 5, "party");
    const defender = initCombatant(PC_SUMMONS[steelDefenderFor(5, 4, 3)], "party", "#1");
    defender.summonerId = smith.id;
    put(s, smith, defender);
    applyDamage(s, defender, 999, "force", {});
    expect(defender.alive).toBe(false);
    expect(defender.downed).toBe(false);
  });
});

describe("Artillerist — Eldritch Cannon", () => {
  it("cannon: AC 18, HP 5 x level, immune to poison and psychic; damage +1d8 from 9th (Explosive Cannon)", () => {
    const c5 = PC_SUMMONS[eldritchCannonFor("ballista", 5, 4, 3)];
    expect(c5.ac).toBe(18);
    expect(c5.maxHp).toBe(25);
    expect(c5.immunities.sort()).toEqual(["poison", "psychic"]);
    expect(JSON.stringify(c5.actions.find((a) => a.id === "activate")!.automation)).toContain('"amount":"2d8"');
    const c9 = PC_SUMMONS[eldritchCannonFor("ballista", 9, 4, 4)];
    expect(JSON.stringify(c9.actions.find((a) => a.id === "activate")!.automation)).toContain('"amount":"3d8"');
    expect(c9.actions.some((a) => a.id === "detonate")).toBe(true);
    expect(c5.actions.some((a) => a.id === "detonate")).toBe(false);
  });

  it("Flamethrower is a 15-ft cone Dex save (DC 8 + PB + INT); Protector gives 1d8 + INT temp HP within 10 ft", () => {
    const flame = JSON.stringify(PC_SUMMONS[eldritchCannonFor("flamethrower", 5, 4, 3)].actions.find((a) => a.id === "activate")!.automation);
    expect(flame).toContain('"shape":"cone","size":15');
    expect(flame).toContain('"dc":15'); // 8 + 3 + 4
    const prot = JSON.stringify(PC_SUMMONS[eldritchCannonFor("protector", 5, 4, 3)].actions.find((a) => a.id === "activate")!.automation);
    expect(prot).toContain('"who":"eachAlly","withinFt":10');
    expect(prot).toContain('"amount":"1d8+4"');
  });

  it("creating a cannon is an action (once per long rest); activating it is a bonus action within 60 ft", () => {
    const c = makeTemplate("artillerist-artificer", 5);
    expect(c.resources.eldritch_cannon).toEqual({ max: 1, recharge: "longRest" });
    expect(c.actions.find((a) => a.id === "cannon-ballista")!.cost).toEqual({ action: 1 });
    const activate = c.actions.find((a) => a.id === "activate-cannon")!;
    expect(activate.cost).toEqual({ bonus: 1 });
    expect(JSON.stringify(activate.automation)).toContain('"rangeFt":60');
  });

  it("Arcane Firearm (5th): a d8 added to one damage roll of a spell; not before", () => {
    const fire = (lvl: number) => JSON.stringify(makeTemplate("artillerist-artificer", lvl).actions.find((a) => a.name === "Fire Bolt")?.automation);
    expect(fire(4)).not.toContain("+1d8");
    expect(fire(5)).toContain("+1d8");
  });

  it("Fortified Position (15th): two cannons at once", () => {
    const create = (lvl: number) => JSON.stringify(makeTemplate("artillerist-artificer", lvl).actions.find((a) => a.id === "cannon-ballista")!.automation);
    expect(create(14)).toContain('"count":"1","max":1');
    expect(create(15)).toContain('"count":"2","max":2');
  });

  it("in a real fight: the cannon appears next to the artificer, is activated each turn, and hits", () => {
    const out = runBattle({
      party: [{ template: "artillerist-artificer", level: 5, name: "Gunner" }],
      enemies: ["owlbear"], seed: 3, controlled: [], maxRounds: 3,
    } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect(text).toMatch(/Gunner raises 1× Eldritch Cannon \(Force Ballista\)/);
    expect(text).toMatch(/Eldritch Cannon \(Force Ballista\) 1 \(commanded\) uses Force Ballista/);
    // it was placed on the grid beside the artificer, not left in the top-left corner
    const last = out.frames.at(-1)!.units;
    const cannon = last.find((u) => u.name.startsWith("Eldritch Cannon"))!;
    expect(cannon.x === 0 && cannon.y === 0).toBe(false);
  });
});

describe("Armorer", () => {
  it("Guardian: Thunder Gauntlets 1d8 thunder + INT; Extra Attack at 5th; Defensive Field = level temp HP, PB uses", () => {
    const g = makeTemplate("armorer-guardian-artificer", 5);
    const atk = JSON.stringify(g.actions.find((a) => a.id === "attack")!.automation);
    expect(atk).toContain('"amount":"1d8+4","damageType":"thunder"');
    expect((atk.match(/"type":"attack"/g) ?? []).length).toBe(2);
    expect(JSON.stringify(makeTemplate("armorer-guardian-artificer", 4).actions.find((a) => a.id === "attack")!.automation).match(/"type":"attack"/g)?.length).toBe(1);
    expect(JSON.stringify(g.actions.find((a) => a.id === "defensive-field")!.automation)).toContain('"amount":"5"');
    expect(g.resources.defensive_field).toEqual({ max: 3, recharge: "longRest" });
  });

  it("Thunder Gauntlets: a creature hit has disadvantage on attacks against anyone but the armorer", () => {
    const armorer = unit("armorer-guardian-artificer", 5, "party");
    const ally = unit("gwm-fighter", 5, "party");
    const foe = unit("gwm-fighter", 5, "monster");
    foe.effects.push({ name: "thunder-gauntlets", mods: { disadvantageUnlessTargetingSource: true }, expiresRound: 2, sourceId: armorer.id });
    const vsAlly: string[] = [];
    const s1 = state(15, vsAlly);
    put(s1, armorer, ally, foe);
    rollAttack(s1, foe, ally, 5, undefined);
    expect(vsAlly).toEqual(["dis"]);
    const vsArmorer: string[] = [];
    const s2 = state(15, vsArmorer);
    put(s2, armorer, ally, foe);
    rollAttack(s2, foe, armorer, 5, undefined);
    expect(vsArmorer).toEqual(["flat"]);
  });

  it("Infiltrator: Lightning Launcher 1d6 lightning + INT with an extra 1d6 once per turn; speed +5 ft", () => {
    const i = makeTemplate("armorer-infiltrator-artificer", 3);
    const atk = JSON.stringify(i.actions.find((a) => a.id === "attack")!.automation);
    expect(atk).toContain('"amount":"1d6+4","damageType":"lightning"');
    expect(atk).toContain('"amount":"1d6","damageType":"lightning"');
    expect(i.speeds.walk).toBe(35);
    expect(makeTemplate("armorer-guardian-artificer", 3).speeds.walk).toBe(30);
  });
});

describe("Alchemist — Experimental Elixir", () => {
  it("brews 1 elixir at 3rd level, 2 at 6th, 3 at 15th (each rolled on the d6 table)", () => {
    const flasks = (lvl: number) => makeTemplate("alchemist-artificer", lvl).traits.find((t) => t.id === "experimental-elixir")!.automation.length;
    expect(flasks(3)).toBe(1);
    expect(flasks(6)).toBe(2);
    expect(flasks(15)).toBe(3);
    const table = makeTemplate("alchemist-artificer", 3).traits[0].automation[0];
    expect(table.type === "randomEffect" && table.options.length).toBe(6);
  });

  it("elixirs are rolled with the fight's dice at the start, announced, and held by the Alchemist", () => {
    const out = runBattle({
      party: [{ template: "alchemist-artificer", level: 6, name: "Alch" }, { template: "gwm-fighter", level: 6, name: "Bront" }],
      enemies: ["kobold"], seed: 4, controlled: [], maxRounds: 1,
    } as never);
    const text = out.frames.map((f) => f.text ?? "").join("\n");
    expect((text.match(/has an experimental elixir of/g) ?? []).length).toBe(2);
  });

  it("every party member (not just the Alchemist) gets Drink Elixir actions", () => {
    const party = buildParty([{ template: "alchemist-artificer", level: 5 }, { template: "gwm-fighter", level: 5 }]);
    for (const m of party) expect(m.actions.some((a) => a.id === "drink-elixir-healing")).toBe(true);
    // ...but only when an Alchemist is in the party
    expect(buildParty([{ template: "gwm-fighter", level: 5 }])[0].actions.some((a) => a.id === "drink-elixir-healing")).toBe(false);
  });

  it("an ally drinks a Boldness elixir with their OWN action, drawing from the Alchemist's stock", () => {
    let found = false;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const setup = {
        party: [{ template: "alchemist-artificer", level: 6, name: "Alch" }, { template: "gwm-fighter", level: 6, name: "Bront" }],
        enemies: ["troll"], seed, controlled: ["pc-2-gwm-fighter"], maxRounds: 1,
        decisions: [{ round: 1, unitId: "pc-2-gwm-fighter", actionId: "drink-elixir-boldness" }],
      };
      const text = runBattle(setup as never).frames.map((f) => f.text ?? "").join("\n");
      if (/has an experimental elixir of Boldness/.test(text) && /Bront uses Drink Elixir: Boldness/.test(text)) {
        expect(text).toMatch(/Elixir Boldness/);
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("Boldness adds a d4 to attack rolls and saving throws while it lasts", () => {
    const drinker = unit("gwm-fighter", 5, "party");
    drinker.effects.push({ name: "elixir-boldness", mods: { attackBonusDice: "1d4", saveBonusDice: "1d4" }, expiresRound: 11, sourceId: "x" });
    const foe = unit("gwm-fighter", 5, "monster");
    // with a natural 10 and +0 vs AC 19, the attack only lands if the d4 can lift it — over many rolls it sometimes does
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const s = state(10);
      s.rng = { ...makeRng(i + 1), d20mode: () => ({ used: 10, nat: 10 }) } as never;
      put(s, drinker, foe);
      if (rollAttack(s, drinker, foe, foe.ac - 13, undefined).hit) hits++;
    }
    expect(hits).toBeGreaterThan(50); // needs the d4 to roll 3+
    expect(hits).toBeLessThan(350);
  });

  it("Alchemical Savant (5th): +INT to one healing or acid/fire/necrotic/poison roll; Chemical Mastery (15th): resistances + immunity", () => {
    const heal = (lvl: number) => JSON.stringify(makeTemplate("alchemist-artificer", lvl).actions.find((a) => a.name === "Healing Word")?.automation);
    // Healing Word already carries the spellcasting modifier (1d4 + 4); Savant adds INT again on top
    expect(heal(3)).toContain('"heal","amount":"1d4+4"');
    expect(heal(5)).toContain('"heal","amount":"1d4+8"');
    const c15 = makeTemplate("alchemist-artificer", 15);
    expect(c15.resistances).toEqual(expect.arrayContaining(["acid", "poison"]));
    expect(c15.conditionImmunities).toContain("poisoned");
    expect(makeTemplate("alchemist-artificer", 14).resistances).not.toContain("acid");
  });
});

describe("Flash of Genius (7th level, all artificers)", () => {
  it("turns an ally's failed save into a success when +INT is enough, spending the reaction and a use", () => {
    const smith = unit("armorer-guardian-artificer", 7, "party");
    const ally = unit("gwm-fighter", 7, "party");
    const s = state(9);
    put(s, smith, ally);
    const total = 9 + saveModifierOf(ally, "wis");
    // the ally misses the DC by 3; the artificer's +4 INT turns it around
    expect(rollSave(s, ally, "wis", total + 3).passed).toBe(true);
    expect(smith.reactionUsed).toBe(true);
    expect(smith.resources.get("flash_of_genius")).toBe(3); // INT +4 uses, one spent
  });

  it("does nothing below 7th level or when +INT wouldn't change the result", () => {
    const low = unit("armorer-guardian-artificer", 6, "party");
    expect(low.ref.specialRules.some((r) => r.rule === "flashOfGenius")).toBe(false);
    const smith = unit("armorer-guardian-artificer", 7, "party");
    const ally = unit("gwm-fighter", 7, "party");
    const s = state(2);
    put(s, smith, ally);
    expect(rollSave(s, ally, "wis", 30).passed).toBe(false);
    expect(smith.reactionUsed).toBe(false);
  });
});
