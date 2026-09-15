import { describe, expect, it } from "vitest";
import {
  loadCustomMonsters,
  exportCustomMonsters,
  draftToCombatant,
  emptyDraft,
  suggestedPb,
  parseStatblock,
  extractStatblockSection,
  npcNoteToMonster,
  pcNoteToCombatant,
  parseClassRefFeatures,
  applyRace,
  applyFeats,
  applyItems,
} from "../lib/sim/ui";
import { runScenarioOnce, runScenario, standardParty, buildParty } from "../lib/sim/engine/scenario";
import { parseCombatant, type Combatant } from "../lib/sim/schema";

const brute = (id: string): Combatant =>
  parseCombatant({
    id,
    name: `Brute ${id}`,
    kind: "monster",
    cr: "8",
    ac: 17,
    maxHp: "12d10+60",
    abilities: { str: 20, dex: 10, con: 20, int: 6, wis: 10, cha: 8 },
    pb: 3,
    actions: [
      {
        id: "smash",
        name: "Smash",
        cost: { action: 1 },
        recharge: "none",
        automation: [
          { type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 9, onHit: [{ type: "damage", amount: "2d10+5", damageType: "bludgeoning" }] }] },
        ],
      },
    ],
  });

const summoner = (): Combatant =>
  parseCombatant({
    id: "custom-summoner",
    name: "Custom Summoner",
    kind: "monster",
    cr: "12",
    ac: 18,
    maxHp: "16d10+96",
    abilities: { str: 16, dex: 14, con: 22, int: 16, wis: 14, cha: 18 },
    pb: 5,
    actions: [
      {
        id: "call",
        name: "Call the Brutes",
        cost: { action: 1 },
        recharge: "none",
        automation: [{ type: "summon", statBlock: "custom-add", count: "2", max: 4 }],
      },
      {
        id: "zap",
        name: "Zap",
        cost: { action: 1 },
        recharge: "none",
        automation: [
          { type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 10, onHit: [{ type: "damage", amount: "3d8+4", damageType: "force" }] }] },
        ],
      },
    ],
  });

describe("custom monster loading", () => {
  it("parses a { monsters: [...] } pack, a bare array, and reports junk", () => {
    const a = loadCustomMonsters({ monsters: [brute("a"), brute("b")] });
    expect(a.monsters.map((m) => m.id)).toEqual(["a", "b"]);
    expect(a.errors).toEqual([]);

    const b = loadCustomMonsters([brute("c")]);
    expect(b.monsters).toHaveLength(1);

    const c = loadCustomMonsters({ monsters: [brute("d"), { name: "broken", kind: "monster" }] });
    expect(c.monsters.map((m) => m.id)).toEqual(["d"]);
    expect(c.errors).toHaveLength(1);

    const d = loadCustomMonsters("not json{");
    expect(d.monsters).toEqual([]);
    expect(d.errors[0]).toMatch(/not valid JSON/);

    const e = loadCustomMonsters({ monsters: [brute("x"), brute("x")] });
    expect(e.monsters).toHaveLength(1);
    expect(e.errors[0]).toMatch(/duplicate id/);
  });

  it("round-trips through export", () => {
    const pack = [brute("a"), brute("b")];
    const back = loadCustomMonsters(exportCustomMonsters(pack));
    expect(back.monsters.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("resolves a custom monster as an enemy via extraById", () => {
    const extraById = { "custom-brute": brute("custom-brute") };
    const { result } = runScenarioOnce({ party: standardParty(10), enemies: ["custom-brute x2"], seed: 1, extraById });
    expect(["party", "monster", "draw"]).toContain(result.winner);
    expect(result.contributions.some((c) => c.name.startsWith("Brute custom-brute"))).toBe(true);
  });

  it("a custom summoner's summon node resolves against the same custom pack", () => {
    const extraById = { "custom-summoner": summoner(), "custom-add": brute("custom-add") };
    const { result, log } = runScenarioOnce({ party: standardParty(12), enemies: ["custom-summoner"], seed: 2, extraById });
    expect(["party", "monster", "draw"]).toContain(result.winner);
    expect(log.some((l) => /raises \d+× Brute custom-add/.test(l))).toBe(true);
  });

  it("a custom pack still runs a full Monte-Carlo", () => {
    const extraById = { "custom-brute": brute("custom-brute") };
    const mc = runScenario({ party: standardParty(10), enemies: ["custom-brute"], trials: 60, extraById });
    expect(mc.partyWinRate).toBeGreaterThanOrEqual(0);
    expect(mc.partyWinRate).toBeLessThanOrEqual(1);
  });

  it("a whenReducedToZero trait (a 'pops when killed' burst) actually fires on death", () => {
    const balloon = parseCombatant({
      id: "custom-balloon",
      name: "Balloon",
      kind: "monster",
      cr: "1",
      ac: 10,
      maxHp: 1, // dies to any hit — the burst should fire immediately
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      pb: 2,
      traits: [{
        id: "pop",
        name: "Pop",
        trigger: "whenReducedToZero",
        automation: [{ type: "target", who: { who: "eachEnemy" }, effects: [
          { type: "save", ability: "dex", dc: 20, onFail: [{ type: "damage", amount: "10d6", damageType: "acid" }] },
        ] }],
      }],
      actions: [{
        id: "poke", name: "Poke", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: 0, onHit: [{ type: "damage", amount: "1", damageType: "bludgeoning" }] }] }],
      }],
    });
    const { log } = runScenarioOnce({ party: standardParty(3), enemies: ["custom-balloon"], seed: 1, extraById: { "custom-balloon": balloon } });
    expect(log.some((l) => /Balloon is destroyed/.test(l))).toBe(true);
    // the trait fires as its own "(reaction) uses Pop" line, with a DC 20 save that
    // should fail for someone at this level — the burst's damage actually lands
    expect(log.some((l) => /\(reaction\) uses Pop ->.*FAIL/.test(l))).toBe(true);
  });

  it("a whenHitByAttack trait (a 'hurts you back' rider) hits the attacker, not the trait-bearer's own AI target", () => {
    const pricklyBrute = brute("prickly-brute");
    (pricklyBrute as any).traits = [{
      id: "spikes", name: "Spikes", trigger: "whenHitByAttack",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: "1d10", damageType: "piercing" }] }],
    }];
    const spiky = parseCombatant(pricklyBrute);
    const { log } = runScenarioOnce({ party: standardParty(10), enemies: ["custom-brute"], seed: 1, extraById: { "custom-brute": spiky } });
    // the retaliation is its own "(reaction) uses Spikes" line, and lands on whichever
    // PC actually landed the hit — never on Brute custom-add itself (there's only one enemy)
    expect(log.some((l) => /\(reaction\) uses Spikes ->/.test(l))).toBe(true);
    expect(log.some((l) => /Spikes -> Brute/.test(l))).toBe(false);
  });
});

describe('"make a monster" builder', () => {
  it("suggestedPb follows the DMG CR table", () => {
    expect(suggestedPb("2")).toBe(2);
    expect(suggestedPb("10")).toBe(4);
    expect(suggestedPb("17")).toBe(6);
    expect(suggestedPb("30")).toBe(9);
    expect(suggestedPb("1/2")).toBe(2);
  });

  it("assembles the default draft into a schema-valid, fightable combatant", () => {
    const draft = { ...emptyDraft(), name: "Test Golem" };
    const { combatant, error, warnings } = draftToCombatant(draft);
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(combatant!.name).toBe("Test Golem");
    expect(combatant!.id).toMatch(/^test-golem-[a-z0-9]{4}$/);
    // 2× Strike ⇒ a multiattack plus the Strike action
    expect(combatant!.actions.map((a) => a.id)).toContain("multiattack");
    expect(combatant!.actions.map((a) => a.id)).toContain("strike");

    const extraById = { [combatant!.id]: combatant! };
    const { result } = runScenarioOnce({ party: standardParty(10), enemies: [combatant!.id], seed: 1, extraById });
    expect(["party", "monster", "draw"]).toContain(result.winner);
  });

  it("carries an AoE, defenses and legendary actions through", () => {
    const draft = {
      ...emptyDraft(),
      name: "Cinder Wyrm",
      cr: "13",
      attacks: [{ name: "Bite", toHit: 12, dice: "2d10+7", type: "piercing" as const, count: 1 }],
      aoe: { name: "Fire Breath", shape: "cone" as const, size: 30, ability: "dex" as const, dc: 18, dice: "12d6", type: "fire" as const, recharge: "roll:5-6" as const },
      damage: { ...emptyDraft().damage, fire: "immune" as const, cold: "vuln" as const },
      legendary: true,
      legendaryBudget: 3,
      legendaryAttacks: ["Bite"],
    };
    const { combatant, error } = draftToCombatant(draft);
    expect(error).toBeUndefined();
    expect(combatant!.immunities).toContain("fire");
    expect(combatant!.vulnerabilities).toContain("cold");
    expect(combatant!.actions.find((a) => a.id === "area")?.recharge).toBe("roll:5-6");
    expect(combatant!.legendaryActions?.budget).toBe(3);
    expect(combatant!.legendaryActions?.options.map((o) => o.action)).toEqual(["bite"]);
  });

  it("rejects an empty name or a monster with nothing to do", () => {
    expect(draftToCombatant({ ...emptyDraft(), name: "" }).error).toMatch(/name/i);
    expect(draftToCombatant({ ...emptyDraft(), name: "Blob", attacks: [], aoe: null }).error).toMatch(/attack|area/i);
  });

  it("a builder monster round-trips through export / load", () => {
    const { combatant } = draftToCombatant({ ...emptyDraft(), name: "Round Trip" });
    const back = loadCustomMonsters(exportCustomMonsters([combatant!]));
    expect(back.errors).toEqual([]);
    expect(back.monsters[0].name).toBe("Round Trip");
  });
});

describe("paste / import a statblock", () => {
  const DRAGON_MD = `## Adult Red Dragon
*Huge dragon, chaotic evil*
**Armor Class** 19 (natural armor)
**Hit Points** 256 (19d12 + 133)
| STR | DEX | CON | INT | WIS | CHA |
|---|---|---|---|---|---|
| 27 (+8) | 10 (+0) | 25 (+7) | 16 (+3) | 13 (+1) | 23 (+6) |
**Saving Throws** Dex +6, Con +13, Wis +7, Cha +11
**Damage Immunities** fire
**Condition Immunities** frightened
**Challenge** 17 (18,000 XP)   **Proficiency Bonus** +6
### Actions
***Multiattack.*** The dragon makes three attacks: one with its bite and two with its claws.
***Bite.*** *Melee Weapon Attack:* +14 to hit, reach 10 ft., one target. *Hit:* 19 (2d10 + 8) piercing damage plus 7 (2d6) fire damage.
***Claw.*** *Melee Weapon Attack:* +14 to hit, reach 5 ft., one target. *Hit:* 15 (2d6 + 8) slashing damage.
***Fire Breath (Recharge 5-6).*** The dragon exhales fire in a 60-foot cone. Each creature in that area must make a DC 21 Dexterity saving throw, taking 63 (18d6) fire damage on a failed save, or half as much damage on a successful one.
### Legendary Actions
The dragon can take 3 legendary actions.
***Tail Attack.*** The dragon makes a tail attack.`;

  it("reads a 2014-style markdown stat block into a valid, fightable draft", () => {
    const { draft, error } = parseStatblock(DRAGON_MD);
    expect(error).toBeUndefined();
    expect(draft!.name).toBe("Adult Red Dragon");
    expect(draft!.size).toBe("huge");
    expect(draft!.ac).toBe(19);
    expect(draft!.hp).toBe("19d12+133");
    expect(draft!.abilities).toEqual({ str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 23 });
    expect(draft!.proficientSaves.sort()).toEqual(["cha", "con", "dex", "wis"]);
    expect(draft!.damage.fire).toBe("immune");
    expect(draft!.conditionImmunities).toContain("frightened");
    expect(draft!.cr).toBe("17");
    expect(draft!.pb).toBe(6);
    const bite = draft!.attacks.find((a) => a.name === "Bite")!;
    expect(bite.toHit).toBe(14);
    expect(bite.dice).toBe("2d10+8");
    expect(bite.type).toBe("piercing");
    expect(bite.count).toBe(1);
    expect(draft!.attacks.find((a) => a.name === "Claw")!.count).toBe(2);
    expect(draft!.aoe?.dc).toBe(21);
    expect(draft!.aoe?.dice).toBe("18d6");
    expect(draft!.aoe?.size).toBe(60);
    expect(draft!.aoe?.recharge).toBe("roll:5-6");
    expect(draft!.legendary).toBe(true);
    expect(draft!.legendaryBudget).toBe(3);
    const { combatant, error: e2 } = draftToCombatant(draft!);
    expect(e2).toBeUndefined();
    expect(combatant!.actions.map((a) => a.id)).toContain("multiattack");
  });

  it("reads a compact inline-ability stat block", () => {
    const md = `**Goblin Boss**
**Armor Class** 17 (chain shirt, shield)
**Hit Points** 21 (6d6)
**STR** 10 **DEX** 14 **CON** 10 **INT** 10 **WIS** 8 **CHA** 10
**Challenge** 1 (200 XP)
### Actions
***Multiattack.*** The goblin boss makes two attacks with its scimitar.
***Scimitar.*** *Melee Weapon Attack:* +4 to hit, reach 5 ft., one target. *Hit:* 5 (1d6 + 2) slashing damage.`;
    const { draft, error } = parseStatblock(md);
    expect(error).toBeUndefined();
    expect(draft!.name).toBe("Goblin Boss");
    expect(draft!.ac).toBe(17);
    expect(draft!.abilities.dex).toBe(14);
    expect(draft!.cr).toBe("1");
    const sci = draft!.attacks.find((a) => a.name === "Scimitar")!;
    expect(sci.toHit).toBe(4);
    expect(sci.dice).toBe("1d6+2");
    expect(sci.count).toBe(2);
  });

  it("reads a 5e.tools bestiary JSON entry (with its @-tags)", () => {
    const json = JSON.stringify({
      name: "Ogre",
      size: ["L"],
      type: "giant",
      ac: [{ ac: 11, from: ["hide armor"] }],
      hp: { average: 59, formula: "7d10 + 21" },
      str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7,
      cr: "2",
      immune: ["fire"],
      action: [{ name: "Greatclub", entries: ["{@atk mw} {@hit 6} to hit, reach 5 ft., one target. {@h}13 ({@damage 2d8 + 4}) bludgeoning damage."] }],
    });
    const { draft, error } = parseStatblock(json);
    expect(error).toBeUndefined();
    expect(draft!.name).toBe("Ogre");
    expect(draft!.size).toBe("large");
    expect(draft!.ac).toBe(11);
    expect(draft!.hp).toBe("7d10+21");
    expect(draft!.abilities.str).toBe(19);
    expect(draft!.damage.fire).toBe("immune");
    const gc = draft!.attacks.find((a) => a.name === "Greatclub")!;
    expect(gc.toHit).toBe(6);
    expect(gc.dice).toBe("2d8+4");
    expect(gc.type).toBe("bludgeoning");
  });

  it("extracts a '## Stat Block' section (keeping its ### sub-headings)", () => {
    const body = `Prose about the villain.

## Stat Block

**Armor Class** 16
**Hit Points** 90 (12d10 + 24)
**STR** 18 **DEX** 12 **CON** 15 **INT** 10 **WIS** 12 **CHA** 14
**Challenge** 6
### Actions
***Longsword.*** *Melee Weapon Attack:* +7 to hit, reach 5 ft. *Hit:* 8 (1d8 + 4) slashing damage.

## Notes
He hates dogs.`;
    const section = extractStatblockSection(body)!;
    expect(section).toContain("### Actions");
    expect(section).not.toContain("hates dogs");

    const { combatant, error } = npcNoteToMonster({ title: "Sir Villain", body });
    expect(error).toBeUndefined();
    expect(combatant!.name).toBe("Sir Villain");
    expect(combatant!.ac).toBe(16);
    expect(combatant!.actions.some((a) => a.id === "longsword")).toBe(true);
  });

  it("falls back to frontmatter + a generic attack when a note has no stat block", () => {
    const { combatant, warnings } = npcNoteToMonster({
      title: "Random Bandit",
      body: "Just a guy.",
      frontmatter: { ac: 13, maxHp: 27, cr: "1/2", stats: { str: 13, dex: 12, con: 12, int: 10, wis: 10, cha: 10 } },
    });
    expect(combatant!.name).toBe("Random Bandit");
    expect(combatant!.ac).toBe(13);
    expect(combatant!.actions.length).toBeGreaterThan(0);
    expect(warnings.join(" ")).toMatch(/no "## Stat Block"|generic/i);
  });

  it("a parsed monster runs a fight", () => {
    const { draft } = parseStatblock(DRAGON_MD);
    const { combatant } = draftToCombatant(draft!);
    const extraById = { [combatant!.id]: combatant! };
    const { result } = runScenarioOnce({ party: standardParty(16), enemies: [combatant!.id], seed: 1, extraById });
    expect(["party", "monster", "draw"]).toContain(result.winner);
  });
});

describe("import a PC from its note", () => {
  const pc = (over: Record<string, unknown>): { title: string; frontmatter: Record<string, unknown> } => ({
    title: String(over.name ?? "PC"),
    frontmatter: { type: "pc", level: 12, ac: 17, maxHp: 100, stats: { str: 16, dex: 14, con: 16, int: 10, wis: 12, cha: 10 }, ...over },
  });

  it("builds a martial PC from the note's real stats + class rules", () => {
    const r = pcNoteToCombatant(pc({ name: "Bront", class: "Battlemaster Fighter", level: 14, ac: 19, maxHp: 148, stats: { str: 20, dex: 14, con: 16, int: 10, wis: 12, cha: 8 } }));
    expect(r.error).toBeUndefined();
    const c = r.spec!.combatant;
    expect(c.kind).toBe("pc");
    expect(c.level).toBe(14);
    expect(c.ac).toBe(19);
    expect(c.maxHp).toBe(148);
    expect(c.abilities.str).toBe(20);
    expect(c.pb).toBe(5);
    expect(c.proficientSaves.sort()).toEqual(["con", "str"]);
    // Extra Attack 3 at fighter 11+: the attack action swings 3 times
    const atk = c.actions.find((a) => a.id === "attack")!;
    const effects = (atk.automation[0] as { effects: unknown[] }).effects;
    expect(effects.length).toBe(3);
    // to-hit uses the real STR mod (+5) + PB (+5)
    expect((effects[0] as { bonus: number }).bonus).toBe(10);
  });

  it("builds a real spellcaster with the note's casting stat", () => {
    const r = pcNoteToCombatant(pc({ name: "Ari", class: "Evocation Wizard", level: 15, ac: 15, maxHp: 92, stats: { str: 8, dex: 14, con: 14, int: 20, wis: 12, cha: 10 } }));
    expect(r.error).toBeUndefined();
    const c = r.spec!.combatant;
    expect(c.templateId).toBe("wizard");
    // real slot-backed spell actions
    expect(c.actions.filter((a) => a.isSpell && a.limitedUse?.resource.startsWith("slot")).length).toBeGreaterThan(15);
    expect(c.abilities.int).toBe(20);
  });

  it("a paladin keeps a weapon attack + spell slots and shares its aura", () => {
    const sera = pcNoteToCombatant(pc({ name: "Sera", class: "Devotion Paladin", level: 12, ac: 20, maxHp: 118, stats: { str: 18, dex: 10, con: 16, int: 8, wis: 12, cha: 18 } }));
    const c = sera.spec!.combatant;
    expect(c.templateId).toBe("paladin");
    expect(c.actions.some((a) => a.id === "attack")).toBe(true);
    expect(c.actions.some((a) => a.isSpell)).toBe(true);
    const bront = pcNoteToCombatant(pc({ name: "Bront", class: "Fighter", level: 12 })).spec!.combatant;
    const party = buildParty([
      { template: "x", level: 12, combatant: c, name: "Sera" },
      { template: "x", level: 12, combatant: bront, name: "Bront" },
    ]);
    const paladin = party.find((p) => p.templateId === "paladin")!;
    if (paladin.saveBonusAll > 0) {
      expect(party.find((p) => p.name === "Bront")!.saveBonusAll).toBeGreaterThanOrEqual(paladin.saveBonusAll);
    }
  });

  it("an unrecognised class falls back to a template with the PC's real stats", () => {
    const r = pcNoteToCombatant(pc({ name: "Nyx", class: "Blood Hunter", level: 10, ac: 16, maxHp: 84, stats: { str: 17, dex: 15, con: 14, int: 12, wis: 10, cha: 10 } }));
    expect(r.error).toBeUndefined();
    expect(r.spec!.combatant.ac).toBe(16);
    expect(r.spec!.combatant.abilities.str).toBe(17);
    expect(r.warnings.join(" ")).toMatch(/unrecognised class/i);
  });

  it("reads Extra Attack / a homebrew Sneak buff / Rage / Uncanny Dodge out of a class-reference body", () => {
    const body = `## Level 2
Cunning Action.
## Level 5 Extra Attack
You can attack twice.
## Level 11
You can attack three times when you take the Attack action.
## Level 3
Your Sneak Attack deals an extra 8d6 damage instead of the normal amount.
## Level 5 Uncanny Dodge
Use your reaction to halve an attack's damage.
## Level 6
Path of the Berserker. You gain Rage.`;
    const f6 = parseClassRefFeatures(body, 6);
    expect(f6.extraAttack).toBe(2);
    expect(f6.sneakDice).toBe(8); // above the by-level baseline -> an explicit override
    expect(f6.rage).toBe(true);
    expect(f6.uncannyDodge).toBe(true);
    const f12 = parseClassRefFeatures(body, 12);
    expect(f12.extraAttack).toBe(3);
    // a ref that only quotes the level-1 "1d6" is ignored (the by-level table wins)
    expect(parseClassRefFeatures("## Level 1 Sneak Attack\nyou deal an extra 1d6 damage; it increases per the table.", 13).sneakDice).toBeUndefined();
  });

  it("a class reference bumps the attack count on the built PC", () => {
    const classRefBody = "## Level 5\nExtra Attack.\n## Level 11\nYou can attack three times.\n## Level 20\nYou can attack four times.";
    const r = pcNoteToCombatant({ ...pc({ name: "Bront", class: "Fighter", level: 11 }), classRefBody });
    const atk = r.spec!.combatant.actions.find((a) => a.id === "attack")!;
    expect((atk.automation[0] as { effects: unknown[] }).effects.length).toBe(3);
    expect(r.warnings.join(" ")).toMatch(/class reference: .*Extra Attack \(3\)/);
  });

  it("an imported PC actually fights", () => {
    const c = pcNoteToCombatant(pc({ name: "Bront", class: "Fighter", level: 14, ac: 19, maxHp: 148, stats: { str: 20, dex: 12, con: 16, int: 10, wis: 12, cha: 8 } })).spec!.combatant;
    const { result } = runScenarioOnce({ party: [{ template: "x", level: 14, combatant: c, name: "Bront" }], enemies: ["gladiator"], seed: 3 });
    expect(["party", "monster", "draw"]).toContain(result.winner);
    expect(result.contributions.some((x) => x.name === "Bront")).toBe(true);
  });
});

describe("subclass features from a class reference", () => {
  const pc = (cls: string, level: number, classRefBody: string, stats: Record<string, number>) =>
    pcNoteToCombatant({ title: "Subj", frontmatter: { type: "pc", class: cls, level, ac: 18, maxHp: 100, stats }, classRefBody });

  it("Channel Divinity: a Radiance-style burst becomes a real area action", () => {
    const ref = `## Level 2 Channel Divinity
you gain the ability to channel divine energy; finish a rest to use it again. At 6th level, twice.
## Level 2 Channel Divinity: Radiance of the Dawn
each hostile creature within 30 feet of you must make a Constitution saving throw. radiant damage equal to 2d10 + your cleric level on a failed save, half on a success.`;
    const f = parseClassRefFeatures(ref, 13);
    expect(f.channelDivinity).toBe(true);
    expect(f.cdBurst).toMatchObject({ dice: "2d10", ability: "con", type: "radiant", plusLevel: true });
    const c = pc("Light Domain Cleric", 13, ref, { str: 12, dex: 10, con: 16, int: 10, wis: 20, cha: 14 }).spec!.combatant;
    expect(c.resources.channel_divinity?.max).toBe(2);
    const burst = c.actions.find((a) => a.id === "channel-divinity-burst")!;
    expect(burst.limitedUse?.resource).toBe("channel_divinity");
    const save = (burst.automation[0] as { effects: { onFail: { amount: string }[] }[] }).effects[0];
    expect(save.onFail[0].amount).toBe("2d10+13");
  });

  it("Channel Divinity: Preserve Life becomes a heal action", () => {
    const ref = `## Level 2 Channel Divinity: Preserve Life
As an action, restore a number of hit points equal to five times your cleric level, divided among creatures within 30 feet.`;
    const c = pc("Life Domain Cleric", 12, ref, { str: 12, dex: 10, con: 16, int: 10, wis: 20, cha: 14 }).spec!.combatant;
    const heal = c.actions.find((a) => a.id === "channel-divinity-heal")!;
    expect((heal.automation[0] as { effects: { amount: string }[] }).effects[0].amount).toBe("60");
  });

  it("a Wildfire-style spirit summon costs a Wild Shape use and appears round 1", () => {
    const ref = `## Level 2 Summon Wildfire Spirit
As a bonus action, you can expend one use of your Wild Shape feature to summon your Wildfire Spirit.`;
    const c = pc("Wildfire Druid", 12, ref, { str: 8, dex: 14, con: 15, int: 12, wis: 20, cha: 10 }).spec!.combatant;
    expect(c.resources.wild_shape?.recharge).toBe("shortRest");
    const s = c.actions.find((a) => a.id === "summon-spirit")!;
    expect(s.limitedUse?.resource).toBe("wild_shape");
    expect(c.ai.opener[0]).toBe("summon-spirit");
    const { log } = runScenarioOnce({ party: [{ template: "x", level: 12, combatant: c, name: "Subj" }], enemies: ["gladiator"], seed: 3 });
    expect(log.some((l) => /raises 1× Primal Spirit/.test(l))).toBe(true);
  });

  it("a Beastmaster companion is called round 1 and fights", () => {
    const ref = `## Level 3 Primal Companion
You summon a primal beast that acts on your turn. You can command it to take the Attack action.`;
    const c = pc("Beast Master Ranger", 13, ref, { str: 12, dex: 20, con: 14, int: 10, wis: 16, cha: 10 }).spec!.combatant;
    expect(c.actions.some((a) => a.id === "call-companion")).toBe(true);
    const { result, log } = runScenarioOnce({ party: [{ template: "x", level: 13, combatant: c, name: "Subj" }], enemies: ["gladiator"], seed: 3 });
    expect(log.some((l) => /raises 1× Primal Companion/.test(l))).toBe(true);
    expect(log.some((l) => /Primal Companion 1 uses/.test(l))).toBe(true);
    expect(["party", "monster", "draw"]).toContain(result.winner);
  });
});

describe("racial traits, feats, and magic items", () => {
  const pc = (over: Record<string, unknown>): Parameters<typeof pcNoteToCombatant>[0] => ({
    title: String(over.name ?? "PC"),
    body: String(over.body ?? ""),
    frontmatter: {
      type: "pc",
      class: String(over.class ?? "Fighter"),
      level: Number(over.level ?? 12),
      ac: 18,
      maxHp: 110,
      stats: { str: 18, dex: 12, con: 16, int: 10, wis: 12, cha: 10 },
      ...over,
    },
  });
  const swings = (c: { actions: { id: string; automation: unknown[] }[] }) =>
    ((c.actions.find((a) => a.id === "attack")!.automation[0] as { effects: { type: string; bonus: number; onHit: { type: string; amount: string; damageType: string }[] }[] }).effects).filter(
      (e) => e.type === "attack",
    );
  const fighter = (level = 12): Combatant => pcNoteToCombatant(pc({ class: "Fighter", level })).spec!.combatant;

  // --- racial traits ---
  it("applyRace: a dragonborn gains a scaling breath weapon + damage resistance", () => {
    const lo = applyRace(fighter(4), "Gold Dragonborn", 4);
    const hi = applyRace(fighter(16), "Gold Dragonborn", 16);
    const bw = lo.c.actions.find((a) => a.id === "breath-weapon")!;
    expect(bw).toBeDefined();
    expect(bw.limitedUse?.resource).toBe("breath_weapon");
    const dmgLo = ((bw.automation[0] as { effects: { onFail: { amount: string }[] }[] }).effects[0].onFail[0]).amount;
    const dmgHi = ((hi.c.actions.find((a) => a.id === "breath-weapon")!.automation[0] as { effects: { onFail: { amount: string }[] }[] }).effects[0].onFail[0]).amount;
    expect(dmgLo).toBe("2d6");
    expect(dmgHi).toBe("5d6");
    expect(lo.c.resistances).toContain("fire");
    expect(lo.c.ai.opener).toContain("breath-weapon");
  });

  it("applyRace: a half-orc gets Relentless Endurance (undyingReturn)", () => {
    const { c, notes } = applyRace(fighter(), "Half-Orc", 12);
    expect(c.specialRules.some((r) => r.rule === "undyingReturn")).toBe(true);
    expect(notes.join(" ")).toMatch(/Relentless Endurance/);
  });

  it("pcNoteToCombatant reads frontmatter.race", () => {
    const r = pcNoteToCombatant(pc({ name: "Rhogar", class: "Fighter", level: 10, race: "Red Dragonborn" }));
    expect(r.spec!.combatant.actions.some((a) => a.id === "breath-weapon")).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/race: Dragonborn/);
  });

  // --- feats ---
  it("applyFeats: Great Weapon Master is −5 to hit / +10 damage on every swing", () => {
    const base = fighter();
    const before = swings(base);
    const { c } = applyFeats(base, "Great Weapon Master", 12, "picker");
    const after = swings(c);
    expect(after[0].bonus).toBe(before[0].bonus - 5);
    expect(after[0].onHit.some((h) => h.type === "damage" && h.amount === "10")).toBe(true);
  });

  it("GWM comes through a note's ## Feats section", () => {
    const r = pcNoteToCombatant(pc({ class: "Fighter", level: 12, body: "## Feats\n- Great Weapon Master\n- Alert\n" }));
    const c = r.spec!.combatant;
    expect(swings(c)[0].onHit.some((h) => h.amount === "10")).toBe(true);
    expect(c.specialRules.some((x) => x.rule === "cannotBeSurprised")).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/feat: Great Weapon Master/);
  });

  it("Polearm Master adds one bonus-action 1d4 swing", () => {
    const base = fighter();
    const n = swings(base).length;
    const { c } = applyFeats(base, "Polearm Master", 12, "picker");
    const after = swings(c);
    expect(after.length).toBe(n + 1);
    expect(after[after.length - 1].onHit[0].amount).toMatch(/^1d4/);
  });

  it("Tough is reported on note import (HP baked) but applied by the picker", () => {
    const noteR = applyFeats(fighter(12), "Tough", 12, "note");
    expect(noteR.c.maxHp).toBe(110);
    expect(noteR.notes.join(" ")).toMatch(/already in your sheet/);
    const pickR = applyFeats(fighter(12), "Tough", 12, "picker");
    expect(pickR.c.maxHp).toBe(110 + 24);
  });

  it("Resilient adds the save proficiency even on note import", () => {
    const { c } = applyFeats(fighter(), "Resilient (Wisdom)", 12, "note");
    expect(c.proficientSaves).toContain("wis");
  });

  // --- magic items ---
  it("applyItems: a +2 weapon bumps to-hit and the first damage die", () => {
    const base = fighter();
    const b = swings(base)[0];
    const { c } = applyItems(base, "- +2 longsword", "picker");
    const a = swings(c)[0];
    expect(a.bonus).toBe(b.bonus + 2);
    expect(a.onHit[0].amount).toMatch(/\+\d+$/);
    expect(Number(a.onHit[0].amount.split("+")[1])).toBe(Number(b.onHit[0].amount.split("+")[1] ?? 0) + 2);
  });

  it("+1 plate is reported-not-applied on note import; a +1 sword still applies", () => {
    const base = fighter();
    const b = swings(base)[0].bonus;
    const { c, notes } = applyItems(base, "## Equipment\n- +1 plate armor\n- +1 longsword\n", "note");
    expect(c.ac).toBe(18); // plate not re-added
    expect(swings(c)[0].bonus).toBe(b + 1); // sword applied
    expect(notes.join(" ")).toMatch(/assumed already in your sheet/);
  });

  it("Flame Tongue adds a 2d6 fire rider", () => {
    const { c } = applyItems(fighter(), "- Flame Tongue", "picker");
    expect(swings(c)[0].onHit.some((h) => h.type === "damage" && h.amount === "2d6" && h.damageType === "fire")).toBe(true);
  });

  it("Cloak of Protection: +1 to all saves on note import, AC untouched", () => {
    const base = fighter();
    const { c } = applyItems(base, "- Cloak of Protection", "note");
    expect(c.saveBonusAll).toBe(base.saveBonusAll + 1);
    expect(c.ac).toBe(base.ac);
  });

  it("Gauntlets of Ogre Power is baked on note import, applied by the picker", () => {
    const base = pcNoteToCombatant(pc({ class: "Fighter", level: 12, stats: { str: 14, dex: 12, con: 16, int: 10, wis: 12, cha: 10 } })).spec!.combatant;
    expect(applyItems(base, "- Gauntlets of Ogre Power", "note").c.abilities.str).toBe(14);
    expect(applyItems(base, "- Gauntlets of Ogre Power", "picker").c.abilities.str).toBe(19);
  });

  it("Wand of the War Mage +2 bumps a caster's spell attack rolls only; the Rod also bumps DCs", () => {
    const wiz = pcNoteToCombatant(pc({ class: "Evocation Wizard", level: 12, stats: { str: 8, dex: 14, con: 14, int: 20, wis: 12, cha: 10 } })).spec!.combatant;
    const nums = (x: Combatant, re: RegExp) => (JSON.stringify(x.actions.filter((a) => a.isSpell).map((a) => a.automation)).match(re) ?? []).map((s) => Number(s.match(/-?\d+$/)![0]));
    const ATK = /"type":"attack","bonus":-?\d+/g;
    const DC = /"dc":-?\d+/g;
    const atkBefore = nums(wiz, ATK);
    const dcBefore = nums(wiz, DC);
    const wand = applyItems(wiz, "- Wand of the War Mage, +2", "picker").c;
    expect(nums(wand, ATK)).toEqual(atkBefore.map((n) => n + 2));
    expect(nums(wand, DC)).toEqual(dcBefore); // DC untouched by the wand
    const rod = applyItems(wiz, "- Rod of the Pact Keeper, +2", "picker").c;
    expect(nums(rod, DC)).toEqual(dcBefore.map((n) => n + 2));
  });

  // --- the per-PC picker (buildParty, "picker" mode) ---
  it("buildParty applies race / feats / items picks onto a template PC", () => {
    const [plain] = buildParty([{ template: "gwm-fighter", level: 12, name: "P" }]);
    const [kitted] = buildParty([
      { template: "gwm-fighter", level: 12, name: "P", race: "Dragonborn (Red)", feats: ["Polearm Master", "Alert"], items: ["+2 weapon", "+1 armor", "Cloak of Protection"] },
    ]);
    // race: a breath weapon action + fire resistance
    expect(kitted.actions.some((a) => a.id === "breath-weapon")).toBe(true);
    expect(kitted.resistances).toContain("fire");
    // feat: Alert -> cannotBeSurprised; PAM -> one more swing than plain
    expect(kitted.specialRules.some((r) => r.rule === "cannotBeSurprised")).toBe(true);
    const nSw = (c: Combatant) => ((c.actions.find((a) => a.id === "attack")!.automation[0] as { effects: { type: string }[] }).effects).filter((e) => e.type === "attack").length;
    expect(nSw(kitted)).toBe(nSw(plain) + 1);
    // item: picker mode DOES move AC — +1 armour and Cloak of Protection (+1) — and saves (Cloak +1)
    expect(kitted.ac).toBe(plain.ac + 2);
    expect(kitted.saveBonusAll).toBe(plain.saveBonusAll + 1);
  });

  it("picker items and the legacy numeric loadout stack", () => {
    const [c] = buildParty([{ template: "gwm-fighter", level: 12, name: "P", loadout: { acItem: 1 }, items: ["+1 armor"] }]);
    const [plain] = buildParty([{ template: "gwm-fighter", level: 12, name: "P" }]);
    expect(c.ac).toBe(plain.ac + 2);
  });

  it("a PC with a race, a feat, and an item still fights", () => {
    const r = pcNoteToCombatant(
      pc({
        name: "Kr?usk",
        class: "Fighter",
        level: 14,
        race: "Half-Orc",
        body: "## Feats\n- Great Weapon Master\n## Equipment\n- +1 greatsword\n- Cloak of Protection\n",
      }),
    );
    expect(r.error).toBeUndefined();
    const c = r.spec!.combatant;
    expect(c.specialRules.some((x) => x.rule === "undyingReturn")).toBe(true);
    const { result } = runScenarioOnce({ party: [{ template: "x", level: 14, combatant: c, name: "K" }], enemies: ["gladiator"], seed: 5 });
    expect(["party", "monster", "draw"]).toContain(result.winner);
  });
});

describe("artificer", () => {
  const arti = (cls: string, level: number, classRefBody?: string) =>
    pcNoteToCombatant({
      title: cls,
      frontmatter: { type: "pc", class: cls, level, ac: 18, maxHp: 110, stats: { str: 10, dex: 16, con: 16, int: 20, wis: 12, cha: 8 } },
      classRefBody,
    });

  it("a bare artificer is an INT half-caster with real spells", () => {
    const r = arti("Artificer", 13);
    expect(r.error).toBeUndefined();
    const c = r.spec!.combatant;
    expect(c.templateId).toBe("artificer");
    expect(c.proficientSaves.sort()).toEqual(["con", "int"]);
    expect(c.actions.filter((a) => a.isSpell && a.limitedUse?.resource.startsWith("slot")).length).toBeGreaterThan(10);
    expect(r.warnings.join(" ")).toMatch(/rounds-up half caster/);
  });

  it("Battle Smith: Battle Ready + Steel Defender + Extra Attack", () => {
    const ref = `## Level 3 Battle Ready
you can use your Intelligence modifier for the attack and damage rolls of a magic weapon.
## Level 3 Steel Defender
a mechanical companion that acts on your turn.
## Level 5 Extra Attack
you can attack twice.`;
    const f = parseClassRefFeatures(ref, 13);
    expect(f.intWeapon).toBe(true);
    expect(f.companion).toBe(true);
    expect(f.extraAttack).toBe(2);
    const c = arti("Battle Smith Artificer", 13, ref).spec!.combatant;
    const atk = (c.actions.find((a) => a.id === "attack")!.automation[0] as { effects: { bonus: number }[] }).effects;
    expect(atk).toHaveLength(2);
    expect(atk[0].bonus).toBe(10); // pb 5 + INT mod 5 (Battle Ready), not DEX mod 3
    expect(c.actions.some((a) => a.id === "call-companion")).toBe(true);
  });

  it("Artillerist: Eldritch Cannon fields a construct with no Wild Shape cost", () => {
    const ref = `## Level 3 Eldritch Cannon
create a magical cannon: a Flamethrower (2d8 fire) or a Force Ballista (ranged spell attack, 2d8 force).`;
    const f = parseClassRefFeatures(ref, 13);
    expect(f.spiritSummon).toBe(true);
    expect(f.spiritViaWildShape).toBeUndefined();
    const c = arti("Artillerist Artificer", 13, ref).spec!.combatant;
    const deploy = c.actions.find((a) => a.id === "summon-spirit")!;
    expect(deploy.limitedUse).toBeUndefined();
    expect(c.resources.wild_shape).toBeUndefined();
    const { log } = runScenarioOnce({ party: [{ template: "x", level: 13, combatant: c, name: "A" }], enemies: ["gladiator"], seed: 3 });
    expect(log.some((l) => /raises 1× Primal Spirit/.test(l))).toBe(true);
  });

  it("infusions bump the weapon and AC but not spells", () => {
    const ref = `## Level 2 Infuse Items
Enhanced Weapon: +1 bonus to attack and damage rolls. Enhanced Defense: +1 bonus to AC.
## Level 10 Upgrade
The bonus increases to +2.`;
    expect(parseClassRefFeatures(ref, 6).infusionBonus).toBe(1);
    expect(parseClassRefFeatures(ref, 13).infusionBonus).toBe(2);
    const c = arti("Artificer", 13, ref).spec!.combatant;
    expect(c.ac).toBe(20); // 18 + 2
    const eff = (c.actions.find((a) => a.id === "attack")!.automation[0] as { effects: { bonus: number; onHit: { amount?: string }[] }[] }).effects[0];
    expect(eff.bonus).toBe(10); // pb 5 + DEX 3 + infusion 2
    expect(eff.onHit[0].amount).toBe("1d8+5"); // 1d8+3 + infusion 2
    // spell actions still parse (no mangled damage strings)
    expect(c.actions.filter((a) => a.isSpell).every((a) => a.automation != null)).toBe(true);
  });
});

describe("per-PC spell picker", () => {
  it("replaces a caster's spell list with the chosen ids", async () => {
    const { buildParty } = await import("../lib/sim/engine/scenario");
    const pc = buildParty([
      { template: "blaster-wizard", name: "Cy", level: 9, spells: ["fire-bolt", "fireball", "shield", "counterspell"] },
    ])[0];
    const ids = pc.actions.map((a) => a.id);
    expect(ids).toContain("cast-fire-bolt");
    expect(ids.some((x) => x.startsWith("cast-fireball"))).toBe(true);
    expect(pc.reactions.map((r) => r.id)).toEqual(expect.arrayContaining(["shield", "counterspell"]));
    // auto-prepared staples that weren't picked are gone
    expect(ids.some((x) => x.startsWith("cast-magic-missile"))).toBe(false);
    // the weapon fallback survives
    expect(ids).toContain("attack");
  });

  it("stamps caster metadata so an imported PC can be re-spelled", async () => {
    const { CASTER_BUILDERS } = await import("../lib/sim/spells/casterTemplates");
    const w = CASTER_BUILDERS["blaster-wizard"](9);
    expect(w.spellClass).toBe("wizard");
    expect(w.casterKind).toBe("full");
    expect(w.spellAbility).toBe("int");
  });

  it("ignores spell picks on a non-caster", async () => {
    const { buildParty } = await import("../lib/sim/engine/scenario");
    const a = buildParty([{ template: "gwm-fighter", name: "Bt", level: 9 }])[0];
    const b = buildParty([{ template: "gwm-fighter", name: "Bt", level: 9, spells: ["fireball"] }])[0];
    expect(b.actions.map((x) => x.id)).toEqual(a.actions.map((x) => x.id));
  });
});

describe("more races + flight", () => {
  it("Fairy: fly speed + Faerie Fire from level 3", async () => {
    const { applyRace } = await import("../lib/sim/engine/pc-extras");
    const { makeTemplate } = await import("../lib/sim/engine/templates");
    const lo = applyRace(makeTemplate("blaster-wizard", 2), "Fairy", 2);
    expect(lo.c.speeds?.fly).toBe(lo.c.speeds?.walk);
    expect(lo.c.actions.some((a) => a.id === "racial-faerie-fire")).toBe(false);
    const hi = applyRace(makeTemplate("blaster-wizard", 8), "Fairy", 8);
    expect(hi.c.actions.some((a) => a.id === "racial-faerie-fire")).toBe(true);
  });

  it("Genasi: subrace resistances + Fire Genasi's Produce Flame / Burning Hands", async () => {
    const { applyRace } = await import("../lib/sim/engine/pc-extras");
    const { makeTemplate } = await import("../lib/sim/engine/templates");
    const t = () => makeTemplate("gwm-fighter", 6);
    expect(applyRace(t(), "Fire Genasi", 6).c.resistances).toContain("fire");
    expect(applyRace(t(), "Water Genasi", 6).c.resistances).toContain("acid");
    expect(applyRace(t(), "Air Genasi", 6).c.resistances).toContain("lightning");
    const fire = applyRace(t(), "Fire Genasi", 6).c;
    expect(fire.actions.map((a) => a.id)).toEqual(expect.arrayContaining(["racial-produce-flame", "racial-burning-hands"]));
  });

  it("Tiefling gets Hellish Rebuke as a racial reaction from level 3", async () => {
    const { applyRace } = await import("../lib/sim/engine/pc-extras");
    const { makeTemplate } = await import("../lib/sim/engine/templates");
    const r = applyRace(makeTemplate("gwm-fighter", 5), "Tiefling", 5).c;
    const hr = r.reactions.find((x) => x.id === "racial-hellish-rebuke");
    expect(hr).toBeDefined();
    expect(JSON.stringify(hr!.automation)).toMatch(/"damageType":"fire"/);
  });

  it("a flyer ignores difficult terrain in Battle mode", async () => {
    const { runBattle } = await import("../lib/sim/battle");
    const { gridFromDef } = await import("../lib/sim/battle/grid");
    // a 20-wide corridor of difficult terrain between the sides
    const w = 20, h = 6;
    let tiles = "";
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles += x > 3 && x < 16 ? "~" : ".";
    const grid = gridFromDef({ width: w, height: h, tiles, placements: {} });
    const run = (race?: string) =>
      runBattle({
        party: [{ template: "gwm-fighter", name: "F", level: 5, race }],
        enemies: ["owlbear"],
        seed: 3,
        grid,
        placements: { "pc-1-gwm-fighter": { x: 1, y: 2 } },
      });
    const posAfterR1 = (race?: string) => {
      const out = run(race);
      const mv = out.frames.filter((f) => f.kind === "move" && f.actorId === "pc-1-gwm-fighter");
      const last = mv.at(0);
      const u = last?.units.find((x) => x.id === "pc-1-gwm-fighter");
      return u ? u.x : 1;
    };
    // the fairy fighter (fly speed) covers more ground through the ~ than a walker
    expect(posAfterR1("Fairy")).toBeGreaterThan(posAfterR1(undefined));
  });
});

describe("spell picker — class resolution", () => {
  it("resolves cleric / artificer from a templateId even without stamped caster metadata", async () => {
    const { pcSpellClass } = await import("../lib/sim/ui");
    const { applyPickedSpells } = await import("../lib/sim/spells/pick");
    const { makeTemplate } = await import("../lib/sim/engine/templates");
    // a PC restored from a setup saved before makeCaster stamped spellClass:
    // templateId = the class key, no spellClass/casterKind/spellAbility
    const staleCleric = { ...makeTemplate("life-cleric", 8), templateId: "cleric" };
    delete (staleCleric as Record<string, unknown>).spellClass;
    delete (staleCleric as Record<string, unknown>).casterKind;
    delete (staleCleric as Record<string, unknown>).spellAbility;
    expect(pcSpellClass({ template: "cleric", combatant: staleCleric })).toBe("cleric");
    const r = applyPickedSpells(staleCleric, ["guiding-bolt", "spirit-guardians"], 8);
    expect(r.notes).toEqual([]);
    expect(r.c.actions.some((a) => a.id.startsWith("cast-guiding-bolt"))).toBe(true);

    const staleArti = { ...makeTemplate("blaster-wizard", 8), templateId: "artificer" };
    delete (staleArti as Record<string, unknown>).spellClass;
    delete (staleArti as Record<string, unknown>).casterKind;
    expect(pcSpellClass({ template: "artificer", combatant: staleArti })).toBe("artificer");
    expect(applyPickedSpells(staleArti, ["fire-bolt"], 8).c.actions.some((a) => a.id === "cast-fire-bolt")).toBe(true);
  });
});

describe("weapon selector", () => {
  it("rebuilds the base attack routine around the chosen weapon", async () => {
    const { buildParty } = await import("../lib/sim/engine/scenario");
    const swings = (c: { actions: { id: string; automation: unknown[] }[] }) => {
      const atk = c.actions.find((a) => a.id === "attack")!;
      const eff = (atk.automation[0] as { effects: { type: string; bonus: number; onHit: { type: string; amount: string; damageType: string }[] }[] }).effects;
      return eff.filter((e) => e.type === "attack");
    };
    const F = (weapon?: string, feats?: string[]) =>
      buildParty([{ template: "gwm-fighter", name: "B", level: 11, weapon, feats }])[0];

    const axe = swings(F("Greataxe"))[0];
    expect(axe.onHit.find((h) => h.type === "damage")!.amount).toMatch(/^1d12[+-]/);
    expect(axe.onHit.find((h) => h.type === "damage")!.damageType).toBe("slashing");

    // a ranged weapon flips the AI to keep distance
    expect(F("Longbow").ai.keepDistance).toBe(true);
    expect(swings(F("Longbow"))[0].onHit.find((h) => h.type === "damage")!.damageType).toBe("piercing");

    // a reach weapon tags the action so Battle mode gives it 10 ft
    expect(F("Glaive").actions.find((a) => a.id === "attack")!.text ?? "").toMatch(/reach 10/i);

    // GWM still layers on top (weapon runs first)
    const gwmAxe = swings(F("Greataxe", ["Great Weapon Master"]))[0];
    expect(gwmAxe.onHit.some((h) => h.type === "damage" && h.amount === "10")).toBe(true);

    // rogue sneak dice survive a weapon swap
    const rogue = buildParty([{ template: "assassin-rogue", name: "S", level: 9, weapon: "Shortsword" }])[0];
    expect(swings(rogue)[0].onHit.some((h) => h.type === "damage" && /d6$/.test(h.amount))).toBe(true);
  });
});
