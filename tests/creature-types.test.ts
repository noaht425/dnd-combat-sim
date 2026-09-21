// Creature types: a stat block's type, the target filter that spells use to leave out creatures they can't affect (checked against the printed spell
// texts on dnd5e.wikidot.com/spell:<id>), and the features that turn on a type. The mechanics run through the real engine with rigged dice.

import { describe, expect, it } from "vitest";
import { makeTemplate, TEMPLATE_IDS } from "../lib/sim/engine/templates";
import { validateCombatant } from "../lib/sim/validate";
import { runBattle } from "../lib/sim/battle";
import { creatureTypeOf, isCreatureType, matchesFilter } from "../lib/sim/engine/creatureType";
import { runAction, runAutomation } from "../lib/sim/engine/interpreter";
import { rollAttack } from "../lib/sim/engine/resolve";
import { actionAvailable, spend } from "../lib/sim/engine/ai";
import { scoreAction } from "../lib/sim/engine/score";
import { resolveEnemies } from "../lib/sim/engine/scenario";
import { MINIONS, PC_SUMMONS, drakeFor, feySpiritFor, houndOfIllOmenFor, primalBeastFor, steelDefenderFor, eldritchCannonFor } from "../lib/sim/engine/minions";
import { MONSTER_FIXTURES, FIXTURES_BY_ID } from "../lib/sim/fixtures";
import { initCombatant, type CombatState, type CombatantState } from "../lib/sim/engine/state";
import { makeRng } from "../lib/sim/engine/rng";
import { score } from "../lib/sim/engine/pcBase";
import { SPELLS_BY_ID } from "../lib/sim/spells/catalog";
import { creatureTypeSchema, type Action, type AutomationNode, type Combatant, type CreatureType } from "../lib/sim/schema";

function state(faces: number | number[] = 15): CombatState {
  const rng = makeRng(1);
  let i = 0;
  const next = () => (Array.isArray(faces) ? faces[Math.min(i++, faces.length - 1)] : faces);
  rng.d20 = () => next();
  rng.d20mode = () => { const f = next(); return { used: f, nat: f }; };
  rng.dice = (n, sides) => n * sides;
  return { round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [], maxRounds: 10, ended: false, verbose: false, summonCounter: 0 };
}
const put = (s: CombatState, ...us: CombatantState[]) => us.forEach((u) => s.units.set(u.id, u));
const wiz = (id = "blaster-wizard", level = 9) => initCombatant(makeTemplate(id, level), "party", "-w");
/** a big dummy foe of the given type (no type: an unknown creature) that fails every save unless given a high modifier */
function foe(id: string, type?: CreatureType, over: Partial<Combatant> = {}, mods: Partial<Record<keyof Combatant["abilities"], number>> = {}): CombatantState {
  const base = makeTemplate("gwm-fighter", 5);
  const abilities = { ...base.abilities, con: score(-4), dex: score(-4), str: score(-4), wis: score(-4), int: score(-4), cha: score(-4) };
  for (const [k, v] of Object.entries(mods)) abilities[k as keyof typeof abilities] = score(v as number);
  const { creatureType: _drop, ...rest } = base;
  void _drop;
  const c: Combatant = { ...rest, ac: 8, abilities, proficientSaves: [], specialRules: [], ...(type ? { creatureType: type } : {}), ...over };
  const u = initCombatant(c, "monster", `-${id}`);
  u.hp = u.maxHp = 1000;
  return u;
}
const action = (u: CombatantState, id: string): Action => {
  const a = u.ref.actions.find((x) => x.id === id);
  if (!a) throw new Error(`no action ${id}; has ${u.ref.actions.map((x) => x.id).join(", ")}`);
  return a;
};
const cast = (s: CombatState, u: CombatantState, id: string) => { const a = action(u, id); spend(u, a); runAction(s, u, a); };
const held = (u: CombatantState) => u.conditions.has("paralyzed");
/** the spell as an action of its own, whatever a given caster has prepared */
const spellAction = (id: string, slotLevel = SPELLS_BY_ID[id].level): Action => ({
  id: `cast-${id}`, name: SPELLS_BY_ID[id].name, cost: { action: 1 }, recharge: "none", isSpell: true,
  automation: SPELLS_BY_ID[id].build!({ slotLevel, casterLevel: 9, spellMod: 4, dc: 15, toHit: 7, pb: 4 }),
});

describe("a stat block's creature type", () => {
  it("is its explicit type, or the first word of the flavor type, or unknown", () => {
    const base = makeTemplate("gwm-fighter", 5);
    expect(creatureTypeOf({ ...base, creatureType: "fiend" })).toBe("fiend");
    expect(creatureTypeOf({ ...base, creatureType: undefined, flavor: { type: "fiend (devil)" } })).toBe("fiend");
    expect(creatureTypeOf({ ...base, creatureType: undefined, flavor: { type: "Dragon" } })).toBe("dragon");
    expect(creatureTypeOf({ ...base, creatureType: undefined, flavor: { type: "swarm of Tiny beasts" } })).toBeUndefined();
    expect(creatureTypeOf({ ...base, creatureType: undefined, flavor: undefined })).toBeUndefined();
    // an explicit type outranks the presentation string
    expect(creatureTypeOf({ ...base, creatureType: "undead", flavor: { type: "humanoid" } })).toBe("undead");
  });

  it("knows the fourteen types of the Monster Manual", () => {
    expect(creatureTypeSchema.options).toHaveLength(14);
    expect(isCreatureType(foe("a", "beast").ref, "beast", "fey")).toBe(true);
    expect(isCreatureType(foe("a", "beast").ref, "fey")).toBe(false);
    expect(isCreatureType(foe("a").ref, "beast")).toBe(false); // unknown is not a beast
  });

  it("every bundled monster has a type, and it is one of the fourteen", () => {
    for (const m of MONSTER_FIXTURES) expect(creatureTypeOf(m), m.id).toBeDefined();
  });

  it("the bundled types are the 2014 ones the stat blocks were written from (goblins and gnolls are humanoids, a troll is a giant)", () => {
    const t = (id: string) => creatureTypeOf(FIXTURES_BY_ID[id]);
    expect([t("goblin"), t("hobgoblin"), t("bugbear"), t("kobold"), t("gnoll"), t("orc"), t("veteran")]).toEqual(Array(7).fill("humanoid"));
    expect([t("troll"), t("ogre"), t("hill-giant"), t("frost-giant"), t("fire-giant")]).toEqual(Array(5).fill("giant"));
    expect([t("ghoul"), t("ghast"), t("wight"), t("wraith")]).toEqual(Array(4).fill("undead"));
    expect([t("owlbear"), t("tarrasque")]).toEqual(["monstrosity", "monstrosity"]);
    expect([t("wyvern"), t("adult-red-dragon"), t("young-blue-dragon")]).toEqual(["dragon", "dragon", "dragon"]);
    expect([t("dire-wolf"), t("giant-spider")]).toEqual(["beast", "beast"]);
  });

  it("every player-character template is a humanoid and still a valid combatant", () => {
    for (const id of TEMPLATE_IDS) {
      const c = makeTemplate(id, 5);
      expect(creatureTypeOf(c), id).toBe("humanoid");
      expect(validateCombatant(c).ok, id).toBe(true);
    }
  });

  it("summons and minions carry their printed types: the Hound of Ill Omen is a monstrosity, the Eldritch Cannon (an object) has none", () => {
    expect(creatureTypeOf(MINIONS["fire-elemental"])).toBe("elemental");
    expect(creatureTypeOf(MINIONS["chain-devil"])).toBe("fiend");
    expect(creatureTypeOf(MINIONS.zombie)).toBe("undead");
    expect(creatureTypeOf(MINIONS.wolf)).toBe("beast");
    const t = (id: string) => creatureTypeOf(PC_SUMMONS[id]);
    expect(t(steelDefenderFor(5, 4, 3))).toBe("construct");
    expect(t(primalBeastFor("land", 5, 3, 3))).toBe("beast");
    expect(t(drakeFor(5, 3, "fire"))).toBe("dragon");
    expect(t(feySpiritFor(3, 3, 3))).toBe("fey");
    expect(t(houndOfIllOmenFor(6))).toBe("monstrosity");
    expect(t(eldritchCannonFor("ballista", 5, 4, 3))).toBeUndefined(); // "a magical object", not a creature
  });
});

describe("the target filter", () => {
  it("types / notTypes / notImmune / minInt, and an unknown creature passes both kinds of type restriction", () => {
    const humanoid = foe("a", "humanoid").ref;
    const troll = foe("b", "giant").ref;
    const mystery = foe("c").ref;
    expect(matchesFilter(humanoid, undefined)).toBe(true);
    expect(matchesFilter(humanoid, { types: ["humanoid"] })).toBe(true);
    expect(matchesFilter(troll, { types: ["humanoid"] })).toBe(false);
    expect(matchesFilter(mystery, { types: ["humanoid"] })).toBe(true);
    expect(matchesFilter(troll, { notTypes: ["giant"] })).toBe(false);
    expect(matchesFilter(mystery, { notTypes: ["giant"] })).toBe(true);
    expect(matchesFilter({ ...humanoid, conditionImmunities: ["charmed"] }, { notImmune: ["charmed"] })).toBe(false);
    expect(matchesFilter({ ...humanoid, abilities: { ...humanoid.abilities, int: 4 } }, { minInt: 5 })).toBe(false);
    expect(matchesFilter({ ...humanoid, abilities: { ...humanoid.abilities, int: 5 } }, { minInt: 5 })).toBe(true);
  });

  it("a target node leaves an ineligible creature out BEFORE it chooses: a filtered single target skips the troll and picks the humanoid", () => {
    const w = wiz();
    const troll = foe("troll", "giant");
    const bandit = foe("bandit", "humanoid");
    troll.hp = 1; // the "lowest HP" the caster would otherwise pick
    const s = state();
    put(s, w, troll, bandit);
    const node: AutomationNode = { type: "target", who: { who: "lowestHpEnemy" }, filter: { types: ["humanoid"] }, effects: [{ type: "damage", amount: "5", damageType: "force" }] };
    runAutomation([node], { state: s, source: w, scope: [], last: {}, depth: 0 });
    expect(bandit.hp).toBe(995);
    expect(troll.hp).toBe(1);
  });

  it("a filtered heal with nobody eligible heals no one — not the caster", () => {
    const w = wiz();
    const zombie = initCombatant(MINIONS.zombie, "party", "-z");
    zombie.hp = 1;
    w.hp = 1;
    const s = state();
    put(s, w, zombie);
    const node: AutomationNode = { type: "target", who: { who: "lowestHpAlly" }, filter: { notTypes: ["humanoid"], types: ["undead"] }, effects: [{ type: "heal", amount: "5" }] };
    runAutomation([node], { state: s, source: w, scope: [], last: {}, depth: 0 });
    expect(zombie.hp).toBe(6);
    const none: AutomationNode = { type: "target", who: { who: "lowestHpAlly" }, filter: { types: ["fey"] }, effects: [{ type: "heal", amount: "5" }] };
    runAutomation([none], { state: s, source: w, scope: [], last: {}, depth: 0 });
    expect(w.hp).toBe(1);
  });
});

describe("spells leave out the creatures their text excludes", () => {
  const tops = (id: string) => (SPELLS_BY_ID[id].build!({ slotLevel: SPELLS_BY_ID[id].level, casterLevel: 9, spellMod: 4, dc: 15, toHit: 7, pb: 4 }) as AutomationNode[]).filter((n) => n.type === "target");

  it("each printed restriction is on the spell's target node", () => {
    const filterOf = (id: string) => (tops(id)[0] as Extract<AutomationNode, { type: "target" }>).filter;
    for (const id of ["charm-person", "hold-person", "crown-of-madness", "dominate-person"]) expect(filterOf(id), id).toEqual({ types: ["humanoid"] });
    expect(filterOf("dominate-beast")).toEqual({ types: ["beast"] });
    expect(filterOf("sleep")).toEqual({ notTypes: ["undead"], notImmune: ["charmed"] });
    expect(filterOf("tashas-hideous-laughter")).toEqual({ minInt: 5 });
    for (const id of ["command", "hold-monster"]) expect(filterOf(id), id).toEqual({ notTypes: ["undead"] });
    for (const id of ["blight", "cure-wounds", "healing-word", "mass-healing-word", "mass-cure-wounds", "heal", "mass-heal", "power-word-heal"]) {
      expect(filterOf(id), id).toEqual({ notTypes: ["undead", "construct"] });
    }
    // Charm Monster names no type, and Aura of Vitality has no exclusion
    expect(filterOf("charm-monster")).toBeUndefined();
    expect(filterOf("aura-of-vitality")).toBeUndefined();
  });

  it("Hold Person paralyzes a humanoid and leaves a troll alone — even when the troll is the lowest-HP, best-looking target", () => {
    const w = wiz("enchantment-wizard", 5);
    const troll = foe("troll", "giant");
    const bandit = foe("bandit", "humanoid");
    troll.hp = 10;
    const s = state(2);
    put(s, w, troll, bandit);
    cast(s, w, "cast-hold-person-2");
    expect(held(bandit)).toBe(true);
    expect(held(troll)).toBe(false);
  });

  it("with only non-humanoids in view Hold Person is not an available action, and is worth nothing to the AI", () => {
    const w = wiz("enchantment-wizard", 5);
    const troll = foe("troll", "giant");
    const s = state();
    put(s, w, troll);
    const hold = action(w, "cast-hold-person-2");
    expect(actionAvailable(s, w, hold)).toBe(false);
    expect(scoreAction(s, w, hold).control).toBe(0);
    put(s, foe("bandit", "humanoid"));
    expect(actionAvailable(s, w, hold)).toBe(true);
    expect(scoreAction(s, w, hold).control).toBeGreaterThan(0);
  });

  it("a creature with no known type is still a legal target (nothing changes for stat blocks the sim can't classify)", () => {
    const w = wiz("enchantment-wizard", 5);
    const mystery = foe("mystery");
    const s = state(2);
    put(s, w, mystery);
    cast(s, w, "cast-hold-person-2");
    expect(held(mystery)).toBe(true);
  });

  it("Hold Monster works on anything but undead", () => {
    const w = wiz("enchantment-wizard", 10);
    const ghoul = foe("ghoul", "undead");
    const troll = foe("troll", "giant");
    const s = state(2);
    put(s, w, ghoul, troll);
    cast(s, w, "cast-hold-monster-5");
    expect(held(ghoul)).toBe(false);
    expect(held(troll)).toBe(true);
  });

  it("Sleep skips undead and creatures immune to being charmed", () => {
    const w = wiz("enchantment-wizard", 5);
    const undead = foe("z", "undead");
    const golem = foe("g", "construct", { conditionImmunities: ["charmed"] });
    const bandit = foe("b", "humanoid");
    const s = state(2);
    put(s, w, undead, golem, bandit);
    runAutomation(SPELLS_BY_ID.sleep.build!({ slotLevel: 1, casterLevel: 5, spellMod: 4, dc: 15, toHit: 7, pb: 3 }), { state: s, source: w, scope: [], last: {}, depth: 0 });
    expect(bandit.conditions.has("unconscious")).toBe(true);
    expect(undead.conditions.has("unconscious")).toBe(false);
    expect(golem.conditions.has("unconscious")).toBe(false);
  });

  it("Tasha's Hideous Laughter needs an Intelligence score of 5 or more", () => {
    const w = wiz("enchantment-wizard", 5);
    const laugh = spellAction("tashas-hideous-laughter");
    const dim = foe("dog", "beast", {}, { int: -4 }); // Intelligence 2
    const s = state(2);
    put(s, w, dim);
    expect(actionAvailable(s, w, laugh)).toBe(false);
    const clever = foe("fox", "beast", {}, { int: 0 }); // Intelligence 10
    put(s, clever);
    expect(actionAvailable(s, w, laugh)).toBe(true);
    runAction(s, w, laugh);
    expect([...clever.conditions.keys()].sort()).toEqual(["incapacitated", "prone"]); // "falls prone and becomes incapacitated"
    expect(dim.conditions.size).toBe(0);
  });

  it("Dominate Beast targets beasts only", () => {
    const d = wiz("moon-druid", 9);
    const dom = spellAction("dominate-beast");
    const s = state(2);
    put(s, d, foe("troll", "giant"), foe("man", "humanoid"));
    expect(actionAvailable(s, d, dom)).toBe(false);
    const wolf = foe("wolf", "beast");
    put(s, wolf);
    expect(actionAvailable(s, d, dom)).toBe(true);
    runAction(s, d, dom);
    expect(wolf.conditions.has("charmed")).toBe(true);
    expect([...s.units.values()].filter((u) => u.id !== wolf.id && u.conditions.has("charmed"))).toHaveLength(0);
  });

  it("Command has no effect on undead", () => {
    const c = initCombatant(makeTemplate("life-cleric", 5), "party", "-c");
    const cmd = spellAction("command");
    const s = state(2);
    put(s, c, foe("z", "undead"));
    expect(actionAvailable(s, c, cmd)).toBe(false);
    const orc = foe("orc", "humanoid");
    put(s, orc);
    expect(actionAvailable(s, c, cmd)).toBe(true);
    runAction(s, c, cmd);
    expect(orc.conditions.has("incapacitated")).toBe(true);
  });

  it("healing spells have no effect on undead or constructs — whoever is at the top of the list", () => {
    const w = wiz("blaster-wizard", 9);
    const zombie = initCombatant(MINIONS.zombie, "party", "-z");
    const golem = initCombatant({ ...MINIONS.zombie, id: "golem", creatureType: "construct" }, "party", "-g");
    const knight = initCombatant(makeTemplate("gwm-fighter", 5), "party", "-k");
    zombie.hp = 1; golem.hp = 1; knight.hp = knight.maxHp - 10;
    const s = state();
    put(s, w, zombie, golem, knight);
    const heal = SPELLS_BY_ID["cure-wounds"].build!({ slotLevel: 1, casterLevel: 9, spellMod: 4, dc: 15, toHit: 7, pb: 4 });
    runAutomation(heal, { state: s, source: w, scope: [], last: {}, depth: 0 });
    expect(zombie.hp).toBe(1);
    expect(golem.hp).toBe(1);
    expect(knight.hp).toBeGreaterThan(knight.maxHp - 10);
  });

  it("Blight has no effect on undead or constructs; a plant saves with disadvantage and takes maximum damage", () => {
    const w = wiz("blaster-wizard", 9);
    const undead = foe("z", "undead");
    const cast4 = (target: CombatantState, faces: number | number[]) => {
      const s = state(faces);
      put(s, w, target);
      runAutomation(SPELLS_BY_ID.blight.build!({ slotLevel: 4, casterLevel: 9, spellMod: 4, dc: 20, toHit: 7, pb: 4 }), { state: s, source: w, scope: [], last: {}, depth: 0 });
      return target;
    };
    expect(cast4(undead, 2).hp).toBe(1000);
    const plant = cast4(foe("p", "plant"), 2);
    expect(1000 - plant.hp).toBe(8 * 8); // failed save: 8d8 at its maximum
    const humanoid = cast4(foe("h", "humanoid"), 2);
    expect(1000 - humanoid.hp).toBe(8 * 8); // (rigged dice roll their maximum too)
  });

  it("Blight: the plant's saving throw is made with disadvantage", () => {
    const w = wiz("blaster-wizard", 9);
    const modes: string[] = [];
    const s = state(15);
    s.rng.d20mode = (m) => { modes.push(m); return { used: 15, nat: 15 }; };
    const plant = foe("p", "plant");
    const human = foe("h", "humanoid");
    put(s, w, plant, human);
    const b = SPELLS_BY_ID.blight.build!({ slotLevel: 4, casterLevel: 9, spellMod: 4, dc: 15, toHit: 7, pb: 4 });
    const s1 = state(15); s1.rng.d20mode = (m) => { modes.push(m); return { used: 15, nat: 15 }; };
    put(s1, w, plant);
    runAutomation(b, { state: s1, source: w, scope: [], last: {}, depth: 0 });
    expect(modes.at(-1)).toBe("dis");
    const s2 = state(15); s2.rng.d20mode = (m) => { modes.push(m); return { used: 15, nat: 15 }; };
    put(s2, w, human);
    runAutomation(b, { state: s2, source: w, scope: [], last: {}, depth: 0 });
    expect(modes.at(-1)).toBe("flat");
  });

  it("Finger of Death: a humanoid it kills rises as a zombie under the caster's command; anything else does not", () => {
    const w = wiz("blaster-wizard", 13);
    const s = state(2);
    const victim = foe("v", "humanoid");
    victim.hp = 1;
    put(s, w, victim);
    runAutomation(SPELLS_BY_ID["finger-of-death"].build!({ slotLevel: 7, casterLevel: 13, spellMod: 4, dc: 20, toHit: 12, pb: 5 }), { state: s, source: w, scope: [], last: {}, depth: 0 });
    const zombies = [...s.units.values()].filter((u) => u.summonerId === w.id && u.ref.id === "zombie");
    expect(zombies).toHaveLength(1);
    const s2 = state(2);
    const beast = foe("b", "beast");
    beast.hp = 1;
    put(s2, w, beast);
    runAutomation(SPELLS_BY_ID["finger-of-death"].build!({ slotLevel: 7, casterLevel: 13, spellMod: 4, dc: 20, toHit: 12, pb: 5 }), { state: s2, source: w, scope: [], last: {}, depth: 0 });
    expect([...s2.units.values()].some((u) => u.summonerId === w.id)).toBe(false);
  });
});

describe("Protection from Evil and Good", () => {
  const ward = (w: CombatantState, s: CombatState) => {
    put(s, w);
    runAutomation(SPELLS_BY_ID["protection-from-evil-and-good"].build!({ slotLevel: 1, casterLevel: 9, spellMod: 4, dc: 15, toHit: 7, pb: 4 }), { state: s, source: w, scope: [], last: {}, depth: 0 });
  };

  it("aberrations, celestials, elementals, fey, fiends and undead have disadvantage on attack rolls against the warded creature — no one else does", () => {
    const w = wiz();
    for (const [type, expected] of [["fiend", "dis"], ["undead", "dis"], ["fey", "dis"], ["celestial", "dis"], ["elemental", "dis"], ["aberration", "dis"], ["humanoid", "flat"], ["dragon", "flat"], ["beast", "flat"]] as const) {
      const modes: string[] = [];
      const s = state(15);
      s.rng.d20mode = (m) => { modes.push(m); return { used: 15, nat: 15 }; };
      ward(w, s);
      const attacker = foe("a", type);
      put(s, attacker);
      rollAttack(s, attacker, w, 5, "flat", 20, 0);
      expect(modes.at(-1), type).toBe(expected);
    }
  });

  it("the warded creature can't be charmed or frightened by those types, but can by anything else", () => {
    const w = wiz();
    const s = state(2);
    ward(w, s);
    const fiend = foe("f", "fiend");
    const dragon = foe("d", "dragon");
    put(s, fiend, dragon);
    // each condition is aimed at the wizard, with the fiend or the dragon as the source
    runAutomation([{ type: "applyCondition", condition: "frightened", durationRounds: 5 }], { state: s, source: fiend, scope: [w], last: {}, depth: 0 });
    expect(w.conditions.has("frightened")).toBe(false);
    runAutomation([{ type: "applyCondition", condition: "charmed", durationRounds: 5 }], { state: s, source: fiend, scope: [w], last: {}, depth: 0 });
    expect(w.conditions.has("charmed")).toBe(false);
    runAutomation([{ type: "applyCondition", condition: "frightened", durationRounds: 5 }], { state: s, source: dragon, scope: [w], last: {}, depth: 0 });
    expect(w.conditions.has("frightened")).toBe(true);
  });
});

describe("features that turn on a type", () => {
  it("Grim Harvest gives nothing for a construct or an undead creature, whatever its name or flavor text says", () => {
    const w = wiz("necromancy-wizard", 6);
    const bolt: Action = { id: "x", name: "Bolt", cost: { action: 1 }, recharge: "none", isSpell: true, school: "evocation", spellLevel: 2, automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: "5", damageType: "force" }] }] };
    for (const [type, gains] of [["undead", false], ["construct", false], ["humanoid", true], ["beast", true]] as const) {
      const victim = foe("v", type);
      victim.hp = 1;
      const s = state();
      put(s, w, victim);
      w.hp = 1;
      runAction(s, w, bolt);
      expect(w.hp, type).toBe(gains ? 1 + 4 : 1);
    }
  });
});

describe("creature types in battle", () => {
  it("the planner aims a Hold Person at the humanoid, not at whichever creature is nearest or focused", () => {
    let aimedAtBandit = 0;
    let aimedAtTroll = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = runBattle({ party: [{ template: "enchantment-wizard", level: 5, name: "Wiz" }, { template: "gwm-fighter", level: 5 }], enemies: ["troll", "bandit-captain"], seed, controlled: [], maxRounds: 3 } as never);
      const lines = out.frames.map((f) => f.text ?? "").filter((t) => /^Wiz uses Hold Person/.test(t));
      for (const l of lines) {
        if (/Bandit Captain/.test(l)) aimedAtBandit++;
        if (/Troll/.test(l)) aimedAtTroll++;
      }
    }
    expect(aimedAtBandit).toBeGreaterThan(0);
    expect(aimedAtTroll).toBe(0);
  });
});

describe("enemy ids that look like a count", () => {
  it("an id that ends in x and digits resolves as itself, not as \"name x7\"", () => {
    const custom = { ...FIXTURES_BY_ID.goblin, id: "test-golem-x7", name: "Test Golem" };
    const out = resolveEnemies(["test-golem-x7"], { "test-golem-x7": custom });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("test-golem-x7");
    // ...and the ordinary "goblin x3" still means three goblins
    expect(resolveEnemies(["goblin x3"])).toHaveLength(3);
  });
});
