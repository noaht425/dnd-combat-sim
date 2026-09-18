// Spell-based PC templates. Each is a class + level + focus fed to `makeCaster`,
// which pulls a prepared / known list from the SRD catalog, wires real slot
// resources, and expands every prepared spell into its upcast Action variants.

import type { Action, Combatant } from "../schema";
import { eldritchCannonFor, steelDefenderFor, type CannonVariant } from "../engine/minions";
import { makeCaster } from "./caster";
import { SPELLS_BY_ID } from "./catalog";
import { autoPrepare } from "./prepare";

/** "cast-fireball-3" -> "fireball"; "cast-fire-bolt" -> "fire-bolt" (cantrips
 *  have no trailing slot number) — the slot suffix is always a bare integer,
 *  which no catalog spell id ends in, so stripping it is unambiguous. */
function baseSpellId(actionId: string): string {
  return actionId.replace(/^cast-/, "").replace(/-\d+$/, "");
}

/** merges `bonus` into a dice-notation amount's existing flat modifier rather
 *  than appending a second one — the schema's amount regex allows only ONE
 *  flat modifier right after the first dice term (e.g. "1d4+1"), so naively
 *  producing "1d4+1+4" fails validation. A bare integer amount just adds. */
function addFlatBonus(amount: string, bonus: number): string {
  const pureNum = amount.match(/^\s*(\d+)\s*$/);
  if (pureNum) return String(parseInt(pureNum[1], 10) + bonus);
  const m = amount.match(/^(\s*-?\d*d\d+)([+-]\d+)?(.*)$/);
  if (!m) return `${amount}+${bonus}`;
  const [, dice, flatStr, rest] = m;
  const newFlat = (flatStr ? parseInt(flatStr, 10) : 0) + bonus;
  const flatPart = newFlat === 0 ? "" : newFlat > 0 ? `+${newFlat}` : `${newFlat}`;
  return `${dice}${flatPart}${rest}`;
}

/** finds the FIRST rolled node reachable from `nodes` — a damage node (optionally restricted to
 *  one or several `damageType`s) or, with `includeHeal`, a heal node — and adds `bonus` to its dice
 *  string. A number merges into the flat modifier; a string ("1d8") is appended as a dice term.
 *  Used for effects that boost "one roll" of a spell (Empowered Evocation, Elemental Affinity,
 *  Arcane Firearm, Alchemical Savant), which unlike Disciple of Life's flat-HP-node-per-heal only
 *  ever touch a single roll per cast, not every matching node. */
function injectFirstDamageBonus(
  nodes: import("../schema").AutomationNode[],
  bonus: number | string,
  damageType?: string | string[],
  includeHeal = false,
): { nodes: import("../schema").AutomationNode[]; applied: boolean } {
  type Rolled = Extract<import("../schema").AutomationNode, { type: "damage" | "heal" }>;
  const types = damageType === undefined ? undefined : Array.isArray(damageType) ? damageType : [damageType];
  const matches = (n: import("../schema").AutomationNode): n is Rolled =>
    (n.type === "damage" && (!types || types.includes(n.damageType))) || (includeHeal && n.type === "heal");
  const withBonus = (amount: string): string => (typeof bonus === "number" ? addFlatBonus(amount, bonus) : `${amount}+${bonus}`);
  const sameRoll = (a: Rolled, b: Rolled): boolean =>
    a.type === b.type && a.amount === b.amount && (a.type !== "damage" || a.damageType === (b as typeof a).damageType);
  let applied = false;
  const walk = (list: import("../schema").AutomationNode[]): import("../schema").AutomationNode[] => list.map((n) => {
    if (applied) return n;
    if (matches(n)) {
      applied = true;
      return { ...n, amount: withBonus(n.amount) };
    }
    if (n.type === "target") return { ...n, effects: walk(n.effects) };
    if (n.type === "attack") return { ...n, onHit: walk(n.onHit), onMiss: n.onMiss && walk(n.onMiss) };
    if (n.type === "save") {
      // onFail/onSuccess damage nodes for a save-for-half effect share one
      // rolled value across every target hit by the same cast (a Fireball's
      // sharedRolls cache keys on the exact amount string) — bumping only
      // onFail's string would split that into two independent rolls (one
      // pool for failed saves, a different one for halved successes).
      // Keeping both strings identical preserves the shared roll.
      const failIdx = n.onFail.findIndex(matches);
      if (!applied && failIdx !== -1) {
        applied = true;
        const original = n.onFail[failIdx] as Rolled;
        const amount = withBonus(original.amount);
        const onFail = n.onFail.map((x, i) => (i === failIdx ? { ...original, amount } : x));
        const onSuccess = n.onSuccess?.map((x) =>
          matches(x) && sameRoll(x, original) ? { ...x, amount } : x,
        );
        return { ...n, onFail, onSuccess };
      }
      return { ...n, onFail: walk(n.onFail), onSuccess: n.onSuccess && walk(n.onSuccess) };
    }
    if (n.type === "branch") return { ...n, then: walk(n.then), else: n.else && walk(n.else) };
    return n;
  });
  return { nodes: walk(nodes), applied };
}

/** Empowered Evocation: add INT to the damage of one Evocation spell you
 *  cast. Cross-references the catalog's own school tag, since the built
 *  Action doesn't carry it — only spells actually rolled as "evocation" in
 *  the catalog qualify, not a blanket bonus to every damage spell. */
function withEmpoweredEvocation(c: Combatant, int: number): Combatant {
  return {
    ...c,
    actions: c.actions.map((a) => {
      if (!a.isSpell) return a;
      const sp = SPELLS_BY_ID[baseSpellId(a.id)];
      if (!sp || sp.school !== "evocation" || sp.role !== "damage") return a;
      const { nodes, applied } = injectFirstDamageBonus(a.automation, int);
      return applied ? { ...a, automation: nodes } : a;
    }),
  };
}

const score = (mod: number) => 10 + mod * 2;
const between = (lvl: number, a: number, b: number) => Math.round(a + ((b - a) * (Math.max(1, Math.min(20, lvl)) - 1)) / 19);
const pbFor = (lvl: number) => 2 + Math.floor((Math.max(1, Math.min(20, lvl)) - 1) / 4);

/** a light weapon / unarmed fallback so opportunity attacks and `id:"attack"` lookups resolve */
function stub(dmg: string, bonus: number): Combatant["actions"] {
  return [{
    id: "attack", name: "Weapon", cost: { action: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus, onHit: [{ type: "damage", amount: dmg, damageType: "bludgeoning" }] }] }],
  }];
}

export function blasterWizard(level: number): Combatant {
  const pb = pbFor(level);
  const int = pb === 6 ? 5 : 4;
  return withEmpoweredEvocation(makeCaster({
    id: "blaster-wizard", name: `Wizard ${level}`, level, spellClass: "wizard", casterKind: "full", spellAbility: "int",
    ac: 15, hp: between(level, 8, 5 * 20 + 10),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(int), wis: score(1), cha: score(0) },
    proficientSaves: ["con", "int", "wis"], focus: "blaster",
    extraActions: stub(`1d4+${1}`, pb + 2), keepDistance: true, targetPriority: "squishiest",
  }), int);
}

/** recursively finds every "heal" node reachable from `nodes` and adds a
 *  sibling "heal" node next to each one — Disciple of Life's flat bonus
 *  applies to the same target the original heal already resolved to. */
function injectHealBonus(nodes: import("../schema").AutomationNode[], amount: number): import("../schema").AutomationNode[] {
  const out: import("../schema").AutomationNode[] = [];
  for (const n of nodes) {
    if (n.type === "heal") {
      out.push(n, { type: "heal", amount: String(amount) });
      continue;
    }
    if (n.type === "target") out.push({ ...n, effects: injectHealBonus(n.effects, amount) });
    else if (n.type === "branch") out.push({ ...n, then: injectHealBonus(n.then, amount), else: n.else && injectHealBonus(n.else, amount) });
    else out.push(n);
  }
  return out;
}

/** Disciple of Life: a healing spell of 1st level+ restores 2 + the spell's
 *  slot level in additional HP. Applied per spell-slot variant (the bonus
 *  scales with the slot actually used, matching RAW), skipping cantrips
 *  (there are no healing cantrips, but the guard costs nothing). */
function withDiscipleOfLife(c: Combatant): Combatant {
  return {
    ...c,
    actions: c.actions.map((a) => {
      const slotMatch = a.id.match(/-(\d+)$/);
      if (!a.isSpell || !slotMatch) return a;
      const slot = Number(slotMatch[1]);
      const automation = injectHealBonus(a.automation, 2 + slot);
      return automation === a.automation ? a : { ...a, automation };
    }),
  };
}

export function lifeCleric(level: number): Combatant {
  const pb = pbFor(level);
  const wis = pb === 6 ? 5 : 4;
  return withDiscipleOfLife(makeCaster({
    id: "life-cleric", name: `Cleric ${level}`, level, spellClass: "cleric", casterKind: "full", spellAbility: "wis",
    ac: 19, hp: between(level, 10, 7 * 20 + 15),
    abilities: { str: score(1), dex: score(0), con: score(2), int: score(0), wis: score(wis), cha: score(1) },
    proficientSaves: ["con", "wis", "cha"], focus: "balanced",
    extraTraits: [{ id: "party-heal", name: "Healer", trigger: "always", automation: [], text: "the engine's healer role tops up the most-hurt ally" }],
    extraActions: [
      { id: "party-heal", name: "Healing Word (bonus)", cost: { bonus: 1 }, recharge: "none", automation: [{ type: "target", who: { who: "lowestHpAlly" }, effects: [] }], text: "AI applies to the most-hurt ally" },
      ...stub(`1d8+${1}`, pb + 1),
    ],
    keepDistance: true, targetPriority: "lowestHp",
  }));
}

export function vengeancePaladin(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const attacks = level >= 5 ? 2 : 1;
  const smite = `${Math.min(5, 2 + Math.floor(level / 5))}d8`;
  return makeCaster({
    id: "vengeance-paladin", name: `Paladin ${level}`, level, spellClass: "paladin", casterKind: "half", spellAbility: "cha",
    ac: 20, hp: between(level, 12, 8 * 20 + 18),
    abilities: { str: score(pb === 6 ? 5 : 4), dex: score(0), con: score(3), int: score(0), wis: score(1), cha: score(cha) },
    proficientSaves: ["wis", "cha"],
    saveBonusAll: level >= 6 ? cha : 0, // Aura of Protection (buildParty shares it)
    focus: "balanced",
    extraTraits: [{ id: "aura-of-protection", name: "Aura of Protection", trigger: "always", automation: [], text: "+CHA to saves, self + allies" }],
    extraActions: [{
      id: "attack", name: "Multiattack + Divine Smite", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [
        ...Array.from({ length: attacks }, () => ({ type: "attack" as const, bonus: pb + cha, adv: "adv" as const, onHit: [
          { type: "damage" as const, amount: `1d8+${cha}`, damageType: "slashing" as const },
          { type: "damage" as const, amount: "1d8", damageType: "radiant" as const },
        ] })),
        { type: "branch", if: "self.resource('slot2') > 0", then: [
          { type: "spendResource", resource: "slot2", amount: 1 },
          { type: "damage", amount: smite, damageType: "radiant" },
        ] },
      ] }],
    }],
    keepDistance: false, opener: ["attack"], targetPriority: "lowestHp",
  });
}

export function hunterRanger(level: number): Combatant {
  const pb = pbFor(level);
  const dex = pb === 6 ? 5 : 4;
  const attacks = (level >= 5 ? 2 : 1) + (level >= 11 ? 1 : 0);
  return makeCaster({
    id: "hunter-ranger", name: `Ranger ${level}`, level, spellClass: "ranger", casterKind: "half", spellAbility: "wis",
    ac: 18, hp: between(level, 11, 7 * 20 + 12),
    abilities: { str: score(0), dex: score(dex), con: score(2), int: score(0), wis: score(3), cha: score(0) },
    proficientSaves: ["str", "dex"], focus: "balanced",
    extraActions: [{
      id: "attack", name: "Multiattack (Longbow + Sharpshooter)", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attacks }, (_, i) => (
        {
          type: "attack" as const, bonus: pb + dex - 2, onHit: [
            { type: "damage" as const, amount: `1d8+${dex + 10}`, damageType: "piercing" as const },
            // Hunter's Prey: Colossus Slayer — once per turn (first hit
            // only, same convention as this session's other once-per-turn
            // riders), an extra 1d8 if the target is already wounded
            ...(i === 0 ? [{ type: "branch" as const, if: "target.hp < target.maxhp", then: [{ type: "damage" as const, amount: "1d8", damageType: "piercing" as const }] }] : []),
          ],
        }
      )) }],
    }],
    keepDistance: true, opener: ["attack"], targetPriority: "lowestHp",
  });
}

export function beastMasterRanger(level: number): Combatant {
  const pb = pbFor(level);
  const dex = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "beastmaster-ranger", name: `Ranger ${level}`, level, spellClass: "ranger", casterKind: "half", spellAbility: "wis",
    ac: 15, hp: between(level, 11, 7 * 20 + 12),
    abilities: { str: score(0), dex: score(dex), con: score(2), int: score(0), wis: score(3), cha: score(0) },
    proficientSaves: ["str", "dex"], focus: "balanced",
    extraActions: [
      {
        id: "attack", name: "Shortsword", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb + dex, onHit: [{ type: "damage", amount: `1d6+${dex}`, damageType: "piercing" }] }] }],
      },
      {
        // a real persistent ally, not a spell-slot summon — joins the roster
        // at the start of the fight and acts on its own turn order slot for
        // the whole encounter, the way an animal companion actually works
        id: "call-companion", name: "Call Companion", cost: { bonus: 1 }, recharge: "none",
        automation: [{ type: "summon", statBlock: "primal-companion", count: "1", max: 1 }],
      },
    ],
    keepDistance: false, opener: ["call-companion", "attack"], targetPriority: "lowestHp",
  });
}

// ============================================================================ Artificer
// Every feature below is built from the printed Tasha's Cauldron of Everything text (the Artificer
// class page and its four subclass pages on dnd5e.wikidot.com, read directly rather than recalled).
// Shared modeling assumptions carried over from the original Battle Smith template, NOT derived from
// the rules: AC 18, the HP curve, and ability scores (STR/DEX +1, CON +2, INT +4/+5), plus a 1d8
// piercing weapon for the Battle Smith's magic weapon. Where the engine can't express a feature
// exactly, the comment on that feature says what was simplified.

type SubclassSpells = [number, string[]][];

// "always prepared" spell tables from each subclass page — they don't count against the prepared limit
const ARTILLERIST_SPELLS: SubclassSpells = [
  [3, ["shield", "thunderwave"]], [5, ["scorching-ray", "shatter"]], [9, ["fireball", "wind-wall"]],
  [13, ["ice-storm", "wall-of-fire"]], [17, ["cone-of-cold", "wall-of-force"]],
];
const ALCHEMIST_SPELLS: SubclassSpells = [
  [3, ["healing-word", "ray-of-sickness"]], [5, ["flaming-sphere", "melfs-acid-arrow"]], [9, ["gaseous-form", "mass-healing-word"]],
  [13, ["blight", "death-ward"]], [17, ["cloudkill", "raise-dead"]],
];
const ARMORER_SPELLS: SubclassSpells = [
  [3, ["magic-missile", "thunderwave"]], [5, ["mirror-image", "shatter"]], [9, ["hypnotic-pattern", "lightning-bolt"]],
  [13, ["fire-shield", "greater-invisibility"]], [17, ["passwall", "wall-of-force"]],
];
const BATTLE_SMITH_SPELLS: SubclassSpells = [
  [3, ["heroism", "shield"]], [5, ["branding-smite", "warding-bond"]], [9, ["aura-of-vitality", "conjure-barrage"]],
  [13, ["aura-of-purity", "fire-shield"]], [17, ["banishing-smite", "mass-cure-wounds"]],
];

/** shared numbers + spell list every artificer subclass starts from */
function artificerParts(level: number, table: SubclassSpells) {
  const pb = pbFor(level);
  const int = pb === 6 ? 5 : 4; // INT modifier (the original artificer template's convention)
  // spells prepared = INT mod + half artificer level (verified against the class text); the subclass's
  // always-prepared spells come on top of that count
  const base = autoPrepare("artificer", "half", level, int, "balanced");
  const always = level >= 3 ? table.filter(([l]) => level >= l).flatMap(([, ids]) => ids) : [];
  return {
    pb, int, dex: 1,
    cantrips: base.cantrips,
    prepared: [...new Set([...always, ...base.spells])],
    abilities: { str: score(1), dex: score(1), con: score(2), int: score(int), wis: score(0), cha: score(0) } as Combatant["abilities"],
    hp: between(level, 11, 7 * 20 + 14),
  };
}

/** the artificer's starting weapon ("a light crossbow and 20 bolts"; light crossbow 1d8 piercing, range 80/320) */
const lightCrossbow = (pb: number, dex: number): Action => ({
  id: "attack", name: "Light Crossbow", cost: { action: 1 }, recharge: "none",
  text: "Ranged weapon attack, range 80/320 ft.",
  automation: [{ type: "target", who: { who: "aiChoice" }, effects: [
    { type: "attack", bonus: pb + dex, onHit: [{ type: "damage", amount: `1d8+${dex}`, damageType: "piercing" }] },
  ] }],
});

/** Flash of Genius (7th level): reaction, +INT to a save of you or a creature within 30 ft, INT-mod
 *  uses per long rest (min 1). Saving throws only — the sim rolls no ability checks. */
function withFlashOfGenius(c: Combatant, level: number, int: number): Combatant {
  if (level < 7) return c;
  return {
    ...c,
    specialRules: [...c.specialRules, { rule: "flashOfGenius", resource: "flash_of_genius", bonus: int, rangeFt: 30 }],
    resources: { ...c.resources, flash_of_genius: { max: Math.max(1, int), recharge: "longRest" } },
  };
}

/** Arcane Firearm (Artillerist, 5th): "roll a d8, and you gain a bonus to one of the spell's damage
 *  rolls" — applied to the first damage roll of every artificer spell (the firearm is assumed to be
 *  the casting focus every time). */
function withArcaneFirearm(c: Combatant, level: number): Combatant {
  if (level < 5) return c;
  return {
    ...c,
    actions: c.actions.map((a) => {
      if (!a.isSpell) return a;
      const r = injectFirstDamageBonus(a.automation, "1d8");
      return r.applied ? { ...a, automation: r.nodes } : a;
    }),
  };
}

/** Alchemical Savant (Alchemist, 5th): a bonus equal to INT (min +1) to one roll of a spell that
 *  restores hit points or deals acid, fire, necrotic, or poison damage (alchemist's supplies assumed
 *  to be the casting focus every time). */
function withAlchemicalSavant(c: Combatant, level: number, int: number): Combatant {
  if (level < 5) return c;
  const bonus = Math.max(1, int);
  return {
    ...c,
    actions: c.actions.map((a) => {
      if (!a.isSpell) return a;
      const r = injectFirstDamageBonus(a.automation, bonus, ["acid", "fire", "necrotic", "poison"], true);
      return r.applied ? { ...a, automation: r.nodes } : a;
    }),
  };
}

// ---- Battle Smith -----------------------------------------------------------------------------
// Battle Ready: INT (not STR/DEX) on attack and damage with a magic weapon. The Enhanced Weapon
// infusion is what makes the weapon magic: +1 to attack and damage, +2 from 10th level (verified).
// Steel Defender: exists from the start of the fight (created at the end of a long rest) — an
// encounterStart trait raises it — and only Dodges unless the artificer spends a bonus action to
// command it (see minions.ts for its stat block). Arcane Jolt (9th): when the artificer hits with the
// weapon (first swing only — "no more than once on a turn") or the defender hits, spend one of INT-mod
// uses for +2d6 force damage (+4d6 at 15th); the healing mode of Arcane Jolt is NOT modeled.
export function battleSmithArtificer(level: number): Combatant {
  const p = artificerParts(level, BATTLE_SMITH_SPELLS);
  const attacks = level >= 5 ? 2 : 1;
  const infusion = level >= 10 ? 2 : 1;
  const joltDice = level >= 15 ? "4d6" : "2d6";
  const swing = (first: boolean) => ({
    type: "attack" as const, bonus: p.pb + p.int + infusion, onHit: [
      { type: "damage" as const, amount: `1d8+${p.int + infusion}`, damageType: "piercing" as const },
      ...(level >= 9 && first ? [{
        type: "branch" as const, if: "self.resource('arcane_jolt') > 0",
        then: [
          { type: "spendResource" as const, resource: "arcane_jolt" },
          { type: "damage" as const, amount: joltDice, damageType: "force" as const },
        ],
      }] : []),
    ],
  });
  const defenderId = level >= 3 ? steelDefenderFor(level, p.int, p.pb) : undefined;
  const commands: Combatant["actions"] = defenderId ? [
    {
      id: "command-rend", name: "Command Steel Defender: Rend", cost: { bonus: 1 }, recharge: "none",
      text: "Bonus action: the steel defender makes its Force-Empowered Rend attack.",
      automation: [{ type: "commandSummon", action: "rend" }],
    },
    {
      id: "command-repair", name: "Command Steel Defender: Repair", cost: { bonus: 1 }, recharge: "none",
      text: "Bonus action: the steel defender uses Repair (3/day) to heal itself.",
      automation: [{ type: "commandSummon", action: "repair" }],
    },
  ] : [];
  const c = makeCaster({
    id: "battlesmith-artificer", name: `Artificer ${level}`, level, spellClass: "artificer", casterKind: "half", spellAbility: "int",
    ac: 18, hp: p.hp, abilities: p.abilities, proficientSaves: ["con", "int"],
    prepared: p.prepared, cantrips: p.cantrips,
    extraTraits: defenderId ? [{
      id: "steel-defender", name: "Steel Defender", trigger: "encounterStart",
      automation: [{ type: "summon", statBlock: defenderId, count: "1", max: 1 }],
      text: "Created at the end of a long rest; present from the start of the fight.",
    }] : [],
    extraActions: [
      {
        id: "attack", name: "Infused Weapon Attack", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attacks }, (_, i) => swing(i === 0)) }],
      },
      ...commands,
    ],
    keepDistance: false, opener: [], targetPriority: "lowestHp",
  });
  return withFlashOfGenius({
    ...c,
    resources: level >= 9 ? { ...c.resources, arcane_jolt: { max: Math.max(1, p.int), recharge: "longRest" } } : c.resources,
    ai: { ...c.ai, bonusRoutine: defenderId ? ["command-rend"] : [] },
  }, level, p.int);
}

// ---- Artillerist ------------------------------------------------------------------------------
// Eldritch Cannon (3rd): an action creates it (once per long rest; the "or expend a spell slot"
// re-creation is NOT modeled), the artificer spends a bonus action to activate it each turn (see
// minions.ts). Explosive Cannon (9th): +1d8 to its damage and Detonate. Fortified Position (15th):
// two cannons at once; its half-cover aura is NOT modeled, and both cannons are the same type.
// The AI-run Artillerist opens with a Force Ballista — a choice the rules leave to the player.
export function artilleristArtificer(level: number): Combatant {
  const p = artificerParts(level, ARTILLERIST_SPELLS);
  const create = (variant: CannonVariant, label: string): Action => ({
    id: `cannon-${variant}`, name: `Eldritch Cannon: ${label}`, cost: { action: 1 }, recharge: "none",
    limitedUse: { resource: "eldritch_cannon", amount: 1 },
    text: "Action: creates a Small eldritch cannon within 5 feet (AC 18, HP 5 x level). Activate it with a bonus action.",
    automation: [{ type: "summon", statBlock: eldritchCannonFor(variant, level, p.int, p.pb), count: level >= 15 ? "2" : "1", max: level >= 15 ? 2 : 1 }],
  });
  const cannon: Combatant["actions"] = level >= 3 ? [
    create("ballista", "Force Ballista"),
    create("flamethrower", "Flamethrower"),
    create("protector", "Protector"),
    {
      id: "activate-cannon", name: "Activate Eldritch Cannon", cost: { bonus: 1 }, recharge: "none",
      text: "Bonus action: the cannon(s) within 60 feet activate.",
      automation: [{ type: "commandSummon", action: "activate", rangeFt: 60 }],
    },
    ...(level >= 9 ? [{
      id: "detonate-cannon", name: "Detonate Eldritch Cannon", cost: { action: 1 }, recharge: "none" as const,
      text: "Action: destroys a cannon; each creature within 20 feet of it makes a Dexterity save or takes 3d8 force damage (half on a success).",
      automation: [{ type: "commandSummon" as const, action: "detonate", limit: 1, rangeFt: 60 }],
    }] : []),
  ] : [];
  const c = makeCaster({
    id: "artillerist-artificer", name: `Artificer ${level}`, level, spellClass: "artificer", casterKind: "half", spellAbility: "int",
    ac: 18, hp: p.hp, abilities: p.abilities, proficientSaves: ["con", "int"],
    prepared: p.prepared, cantrips: p.cantrips,
    extraActions: [lightCrossbow(p.pb, p.dex), ...cannon],
    keepDistance: true, opener: level >= 3 ? ["cannon-ballista"] : [], targetPriority: "lowestHp",
  });
  return withFlashOfGenius(withArcaneFirearm({
    ...c,
    resources: level >= 3 ? { ...c.resources, eldritch_cannon: { max: 1, recharge: "longRest" } } : c.resources,
    ai: { ...c.ai, bonusRoutine: level >= 3 ? ["activate-cannon"] : [] },
  }, level), level, p.int);
}

// ---- Armorer ----------------------------------------------------------------------------------
// Arcane Armor (3rd): the armor's special weapon uses INT for attack and damage. Two models, chosen
// per rest, built as two templates. Extra Attack (5th). NOT modeled: Armor Modifications (9th,
// infusion slots) and Perfected Armor (15th — Guardian's reaction pull, Infiltrator's glimmer).
function armorerBase(level: number, model: "guardian" | "infiltrator") {
  const p = artificerParts(level, ARMORER_SPELLS);
  const attacks = level >= 5 ? 2 : 1;
  const armored = level >= 3;
  const swing = (first: boolean) =>
    model === "guardian"
      ? {
          // Thunder Gauntlets: 1d8 thunder; a creature hit has disadvantage on attack rolls against
          // targets other than you until the start of your next turn
          type: "attack" as const, bonus: p.pb + p.int, onHit: [
            { type: "damage" as const, amount: `1d8+${p.int}`, damageType: "thunder" as const },
            { type: "applyEffect" as const, name: "thunder-gauntlets", durationRounds: 1, mods: { disadvantageUnlessTargetingSource: true } },
          ],
        }
      : {
          // Lightning Launcher: 1d6 lightning, plus an extra 1d6 once on each of your turns
          type: "attack" as const, bonus: p.pb + p.int, onHit: [
            { type: "damage" as const, amount: `1d6+${p.int}`, damageType: "lightning" as const },
            ...(first ? [{ type: "damage" as const, amount: "1d6", damageType: "lightning" as const }] : []),
          ],
        };
  const weapon: Action = armored ? {
    id: "attack", cost: { action: 1 }, recharge: "none",
    ...(model === "guardian"
      ? { name: "Thunder Gauntlets", text: "Melee weapon attack with the armor's gauntlets." }
      : { name: "Lightning Launcher", text: "Ranged weapon attack, range 90/300 ft." }),
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attacks }, (_, i) => swing(i === 0)) }],
  } : lightCrossbow(p.pb, p.dex);
  const defensiveField: Combatant["actions"] = model === "guardian" && armored ? [{
    id: "defensive-field", name: "Defensive Field", cost: { bonus: 1 }, recharge: "none",
    limitedUse: { resource: "defensive_field", amount: 1 },
    text: "Bonus action: temporary hit points equal to your artificer level, replacing any you have (PB uses per long rest).",
    automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: String(level) }] }],
  }] : [];
  const c = makeCaster({
    id: model === "guardian" ? "armorer-guardian-artificer" : "armorer-infiltrator-artificer",
    name: `Artificer ${level}`, level, spellClass: "artificer", casterKind: "half", spellAbility: "int",
    ac: 18, hp: p.hp, abilities: p.abilities, proficientSaves: ["con", "int"],
    prepared: p.prepared, cantrips: p.cantrips,
    extraActions: [weapon, ...defensiveField],
    keepDistance: model === "infiltrator", opener: [], targetPriority: "lowestHp",
  });
  return withFlashOfGenius({
    ...c,
    // Powered Steps (Infiltrator): walking speed +5 feet
    speeds: model === "infiltrator" && armored ? { ...c.speeds, walk: 35 } : c.speeds,
    resources: defensiveField.length ? { ...c.resources, defensive_field: { max: p.pb, recharge: "longRest" } } : c.resources,
    ai: { ...c.ai, bonusRoutine: defensiveField.length ? ["defensive-field"] : [] },
  }, level, p.int);
}

export const armorerGuardianArtificer = (level: number): Combatant => armorerBase(level, "guardian");
export const armorerInfiltratorArtificer = (level: number): Combatant => armorerBase(level, "infiltrator");

// ---- Alchemist --------------------------------------------------------------------------------
// Experimental Elixir (3rd): at a long rest the Alchemist brews 1 elixir (2 at 6th, 3 at 15th), each
// rolled on the d6 table; at the start of a fight those are rolled with the fight's seeded dice and
// held as `elixir_*` resources. Every party member gets "Drink Elixir" actions (added in buildParty,
// see elixirDrinkActions) and spends their OWN action to drink, drawing from the Alchemist's stock.
// NOT modeled: making extra elixirs with a spell slot, Swiftness/Flight/Transformation effects (the
// flask is consumed), Restorative Reagents' free Lesser Restoration and Chemical Mastery's free
// Greater Restoration (neither spell has combat automation in this sim's catalog).
const ELIXIRS = [
  ["healing", "Healing"], ["swiftness", "Swiftness"], ["resilience", "Resilience"],
  ["boldness", "Boldness"], ["flight", "Flight"], ["transformation", "Transformation"],
] as const;

/** the "Drink Elixir" actions every party member gets when an Alchemist is present */
export function elixirDrinkActions(level: number, int: number): Combatant["actions"] {
  // Restorative Reagents (9th): whoever drinks also gains 2d6 + INT temporary hit points
  const reagents = level >= 9 ? [{ type: "tempHp" as const, amount: `2d6+${Math.max(1, int)}` }] : [];
  const effects: Record<string, import("../schema").AutomationNode[]> = {
    healing: [{ type: "heal", amount: `2d4+${int}` }],
    resilience: [{ type: "applyEffect", name: "elixir-resilience", durationRounds: 100, mods: { acBonus: 1 } }], // +1 AC for 10 minutes
    boldness: [{ type: "applyEffect", name: "elixir-boldness", durationRounds: 10, mods: { attackBonusDice: "1d4", saveBonusDice: "1d4" } }], // a d4 on every attack roll and save for a minute
    swiftness: [{ type: "note", text: "+10 ft walking speed for an hour (not modeled)" }],
    flight: [{ type: "note", text: "10 ft flying speed for 10 minutes (not modeled)" }],
    transformation: [{ type: "note", text: "Alter Self for 10 minutes (not modeled)" }],
  };
  const texts: Record<string, string> = {
    healing: `Regain 2d4 + ${int} hit points.`,
    resilience: "+1 bonus to AC for 10 minutes.",
    boldness: "Add a d4 to every attack roll and saving throw for a minute.",
    swiftness: "+10 feet walking speed for an hour (effect not modeled).",
    flight: "10 ft flying speed for 10 minutes (effect not modeled).",
    transformation: "Alter Self for 10 minutes (effect not modeled).",
  };
  return ELIXIRS.map(([id, label]) => ({
    id: `drink-elixir-${id}`, name: `Drink Elixir: ${label}`, cost: { action: 1 }, recharge: "none" as const,
    text: `Uses your action to drink an experimental elixir of ${label}. ${texts[id]}`,
    automation: [{
      type: "branch" as const, if: `party.resource('elixir_${id}') > 0`,
      then: [
        { type: "spendResource" as const, resource: `elixir_${id}`, from: "party" as const },
        { type: "target" as const, who: { who: "self" as const }, effects: [...effects[id], ...reagents] },
      ],
    }],
  }));
}

export function alchemistArtificer(level: number): Combatant {
  const p = artificerParts(level, ALCHEMIST_SPELLS);
  const flasks = level >= 15 ? 3 : level >= 6 ? 2 : 1;
  const brewing = level >= 3;
  // Chemical Mastery (15th): Heal without a slot or preparing it, once per long rest
  const freeHeal: Combatant["actions"] = level >= 15 && SPELLS_BY_ID["heal"]?.build ? [{
    id: "cast-heal-chemical-mastery", name: "Heal (Chemical Mastery)", cost: { action: 1 }, recharge: "none", isSpell: true,
    limitedUse: { resource: "chemical_mastery_heal", amount: 1 },
    automation: SPELLS_BY_ID["heal"].build!({ slotLevel: 6, casterLevel: level, spellMod: p.int, dc: 8 + p.pb + p.int, toHit: p.pb + p.int, pb: p.pb }),
  }] : [];
  const c = makeCaster({
    id: "alchemist-artificer", name: `Artificer ${level}`, level, spellClass: "artificer", casterKind: "half", spellAbility: "int",
    ac: 18, hp: p.hp, abilities: p.abilities, proficientSaves: ["con", "int"],
    prepared: p.prepared, cantrips: p.cantrips,
    extraTraits: brewing ? [{
      id: "experimental-elixir", name: "Experimental Elixir", trigger: "encounterStart",
      automation: Array.from({ length: flasks }, () => ({
        type: "randomEffect" as const,
        options: ELIXIRS.map(([id, label]) => ({
          weight: 1,
          then: [{ type: "spendResource" as const, resource: `elixir_${id}`, amount: -1 }],
          note: `has an experimental elixir of ${label}`,
        })),
      })),
      text: "Brewed at the last long rest; effects rolled on the d6 table.",
    }] : [],
    extraActions: [lightCrossbow(p.pb, p.dex), ...freeHeal],
    keepDistance: true, opener: [], targetPriority: "lowestHp",
  });
  const elixirPools = brewing
    ? Object.fromEntries(ELIXIRS.map(([id]) => [`elixir_${id}`, { max: 3, recharge: "longRest" as const, start: 0 }]))
    : {};
  const withKit: Combatant = {
    ...c,
    resources: { ...c.resources, ...elixirPools, ...(freeHeal.length ? { chemical_mastery_heal: { max: 1, recharge: "longRest" as const } } : {}) },
    // Chemical Mastery (15th): resistance to acid and poison damage, immunity to the poisoned condition
    resistances: level >= 15 ? [...c.resistances, "acid", "poison"] : c.resistances,
    conditionImmunities: level >= 15 ? [...c.conditionImmunities, "poisoned"] : c.conditionImmunities,
  };
  return withFlashOfGenius(withAlchemicalSavant(withKit, level, p.int), level, p.int);
}

// Metamagic: sorcery points (level 2+, one per sorcerer level) spent on top
// of the normal spell-slot cost. Twinned and Quickened are the two most
// mechanically distinct options (retargeting and action economy — visibly
// different from a plain cast, unlike e.g. Subtle/Distant which this engine
// has no way to make observable) so those are what's built; Empowered would
// need a new "reroll low dice" schema field this doesn't have yet.
function withMetamagic(c: Combatant, level: number): Combatant {
  const extra: Combatant["actions"] = [];
  for (const a of c.actions) {
    if (!a.isSpell) continue;
    // cantrips have no slot suffix in their id (level 0) — Twinned/Quickened
    // both work on cantrips too (RAW), and "Twinned Fire Bolt" every turn at
    // 1 sorcery point is the single most iconic sorcerer combo, so this
    // can't skip them the way the Wild Magic Surge check correctly does
    // (surge is genuinely leveled-spell-only).
    const slotMatch = a.id.match(/-(\d+)$/);
    const slot = slotMatch ? Number(slotMatch[1]) : 0;
    extra.push({
      ...a,
      id: `${a.id}-quickened`, name: `${a.name} (Quickened)`, cost: { bonus: 1 },
      automation: [{
        type: "branch", if: "self.resource('sorcery_points') >= 2",
        then: [{ type: "spendResource", resource: "sorcery_points", amount: 2 }, ...a.automation],
      }],
    });
    const top = a.automation[0];
    if (top?.type === "target" && top.who.who === "aiChoice") {
      const cost = Math.max(1, slot);
      extra.push({
        ...a,
        id: `${a.id}-twinned`, name: `${a.name} (Twinned)`,
        automation: [{
          type: "branch", if: `self.resource('sorcery_points') >= ${cost}`,
          then: [
            { type: "spendResource", resource: "sorcery_points", amount: cost },
            { type: "target", who: { who: "chosenEnemies", upTo: 2 }, effects: top.effects },
          ],
        }],
      });
    }
  }
  return {
    ...c,
    actions: [...c.actions, ...extra],
    resources: { ...c.resources, sorcery_points: { max: level >= 2 ? level : 0, recharge: "longRest" } },
  };
}

// Elemental Affinity: fire is the pick (a red dragon ancestry, matching the
// app's own placeholder text elsewhere) — add CHA to one damage roll of a
// spell dealing that type, same cross-reference-the-catalog approach as
// Empowered Evocation, just filtered by damage type instead of school.
function withElementalAffinity(c: Combatant, cha: number): Combatant {
  return {
    ...c,
    actions: c.actions.map((a) => {
      if (!a.isSpell) return a;
      const { nodes, applied } = injectFirstDamageBonus(a.automation, cha, "fire");
      return applied ? { ...a, automation: nodes } : a;
    }),
  };
}

export function draconicSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const dex = 2;
  const cha = pb === 6 ? 5 : 4;
  return withElementalAffinity(withMetamagic(makeCaster({
    id: "draconic-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 13 + dex, hp: between(level, 9, 7 * 20 + 12), // Draconic Resilience: natural armor 13+DEX
    abilities: { str: score(-1), dex: score(dex), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: stub(`1d10`, pb + cha), keepDistance: true, targetPriority: "lowestHp",
  }), level), cha);
}

// Wild Magic Surge: RAW is a natural 1 on a d20 after casting a sorcerer
// spell of 1st level or higher (~5%, rare enough to rarely show up in a
// short simulated fight) — weighted up to ~18% here for visibility/testing,
// noted so it's not mistaken for a mechanics error. The "nothing happens"
// branch carries the rest of the weight, same as most of the real d100
// table's harmless/flavor-only entries.
const WILD_MAGIC_TABLE: { weight: number; then: import("../schema").AutomationNode[]; note?: string }[] = [
  { weight: 82, then: [] },
  { weight: 4, then: [{ type: "target", who: { who: "self" }, effects: [{ type: "damage", amount: "2d10", damageType: "force" }] }], note: "wild magic surge — force energy crackles wildly" },
  { weight: 4, then: [{ type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: "3d6" }] }], note: "wild magic surge — restorative light washes over you" },
  { weight: 4, then: [{ type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: "2d6" }] }], note: "wild magic surge — a shimmering ward flickers into being" },
  { weight: 3, then: [{ type: "target", who: { who: "nearestEnemy" }, effects: [{ type: "applyCondition", condition: "frightened", durationRounds: 1 }] }], note: "wild magic surge — a wave of dread rolls outward" },
  { weight: 3, then: [{ type: "target", who: { who: "lowestHpAlly" }, effects: [{ type: "heal", amount: "2d8" }] }], note: "wild magic surge — healing energy leaps to whoever needs it most" },
];

/** appends a Wild Magic Surge check after every leveled spell-cast action.
 *  cast.ts ids leveled spells "cast-<id>-<slot>" (slot >= 1) and cantrips
 *  bare "cast-<id>" with no slot suffix — cantrips don't trigger a surge. */
function withWildMagicSurge(c: Combatant): Combatant {
  return {
    ...c,
    actions: c.actions.map((a) => {
      if (!a.isSpell || !/-\d+$/.test(a.id)) return a;
      return { ...a, automation: [...a.automation, { type: "randomEffect", options: WILD_MAGIC_TABLE }] };
    }),
  };
}

export function wildMagicSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  // Wild Magic Surge first, Metamagic second — withMetamagic derives its
  // Quickened/Twinned variants from whatever automation is already on each
  // base spell action, so this order makes those variants surge too
  // (correct: RAW surges on casting any leveled spell, however augmented).
  // The reverse order would miss them — their ids end in a word, not a
  // slot number, so withWildMagicSurge's own id filter wouldn't match them.
  return withMetamagic(withWildMagicSurge(makeCaster({
    id: "wild-magic-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 14, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: stub(`1d10`, pb + cha), keepDistance: true, targetPriority: "lowestHp",
  })), level);
}

// Favored by the Gods (Divine Soul, 1st level): once per long rest, add a
// fixed bonus die to a roll that would otherwise miss and recheck it — the
// actual reroll/boost logic lives in resolve.ts's rollAttackImpl (reads the
// `boostMissedAttack` specialRule and spends the resource it names); this
// just declares both. RAW also covers saving throws and ability checks —
// scoped to attack rolls only here, the one this combat sim actually models.
export function divineSoulSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const c = withMetamagic(makeCaster({
    id: "divine-soul-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 14, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: stub(`1d10`, pb + cha), keepDistance: true, targetPriority: "lowestHp",
  }), level);
  return {
    ...c,
    specialRules: [...c.specialRules, { rule: "boostMissedAttack", bonusDice: "2d4", resource: "favored_by_gods" }],
    resources: { ...c.resources, favored_by_gods: { max: 1, recharge: "longRest" } },
  };
}

// Strength of the Grave (Shadow Magic, 1st level): once per long rest, a hit
// that would drop the sorcerer to 0 HP instead leaves them at 1 — reuses the
// engine's existing undyingReturn specialRule verbatim (already dispatched
// by handleDropToZero in resolve.ts for monster "refuses to die" traits).
// RAW gates this behind a CHA save the engine has no generic hook for;
// treating it as unconditional matches every other undyingReturn user here.
export function shadowMagicSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const c = withMetamagic(makeCaster({
    id: "shadow-magic-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 14, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: stub(`1d10`, pb + cha), keepDistance: true, targetPriority: "lowestHp",
  }), level);
  return { ...c, specialRules: [...c.specialRules, { rule: "undyingReturn", returnHp: 1, oncePer: "encounter" }] };
}

// Heart of the Storm (Storm Sorcery, 6th level): casting a lightning- or
// thunder-damage spell of 1st level+ also deals thunder damage to nearby
// creatures equal to half your sorcerer level (rounded up) — simplified,
// like Elemental Affinity, into a flat bonus folded onto the spell's own
// roll rather than a separate near-caster burst (the engine has no
// positional "creatures near me, distinct from my target" targeting).
function withHeartOfTheStorm(c: Combatant, level: number): Combatant {
  if (level < 6) return c;
  const bonus = Math.ceil(level / 2);
  return {
    ...c,
    actions: c.actions.map((a) => {
      if (!a.isSpell || !/-\d+$/.test(a.id)) return a;
      const lightning = injectFirstDamageBonus(a.automation, bonus, "lightning");
      if (lightning.applied) return { ...a, automation: lightning.nodes };
      const thunder = injectFirstDamageBonus(a.automation, bonus, "thunder");
      return thunder.applied ? { ...a, automation: thunder.nodes } : a;
    }),
  };
}

export function stormSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  // Storm's Fury (18th level): retaliate with lightning when hit in melee —
  // reuses the same whenHitByAttack trait dispatch as monster "hits back"
  // traits (Corrosive Form), scoped onto the attacker via forceScope.
  return withHeartOfTheStorm(withMetamagic(makeCaster({
    id: "storm-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 14, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: stub(`1d10`, pb + cha), keepDistance: true, targetPriority: "lowestHp",
    extraTraits: level >= 18 ? [{
      id: "storms-fury", name: "Storm's Fury", trigger: "whenHitByAttack",
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: "2d8", damageType: "lightning" }] }],
    }] : [],
  }), level), level);
}

// Psychic Defenses (Aberrant Mind, 6th level): resistance to psychic damage,
// immune to being frightened.
export function aberrantMindSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const c = withMetamagic(makeCaster({
    id: "aberrant-mind-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 14, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: stub(`1d10`, pb + cha), keepDistance: true, targetPriority: "lowestHp",
  }), level);
  if (level < 6) return c;
  return { ...c, resistances: [...c.resistances, "psychic"], conditionImmunities: [...c.conditionImmunities, "frightened"] };
}

// Bastion of Law (Clockwork Soul, 6th level): bonus action, spend sorcery
// points (up to CHA mod) to grant temp HP = 2x points spent to an ally —
// simplified to always spending the full CHA-mod amount on the lowest-HP
// ally, the same "spend a resource, grant tempHp to lowestHpAlly" shape as
// Battle Master's Rally.
export function clockworkSoulSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const bastion: Combatant["actions"] = level >= 6 ? [{
    id: "bastion-of-law", name: "Bastion of Law", cost: { bonus: 1 }, recharge: "none",
    automation: [{
      type: "branch", if: `self.resource('sorcery_points') >= ${cha}`,
      then: [
        { type: "spendResource", resource: "sorcery_points", amount: cha },
        { type: "target", who: { who: "lowestHpAlly" }, effects: [{ type: "tempHp", amount: `${2 * cha}` }] },
      ],
    }],
  }] : [];
  return withMetamagic(makeCaster({
    id: "clockwork-soul-sorcerer", name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: 14, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    extraActions: [...stub(`1d10`, pb + cha), ...bastion], keepDistance: true, targetPriority: "lowestHp",
  }), level);
}

// Arcane Trickster: a third-caster rogue (spell slots at Eldritch Knight's
// rate) whose spell list is mostly illusion/enchantment off the wizard list
// (Mage Hand Legerdemain, Shield, Invisibility) — `spellClass: "wizard"` just
// borrows the wizard spell-list plumbing already built (this sim has no
// separate "rogue" spell list of its own), with an explicit `prepared` list
// so autoPrepare's per-class scoring never has to know what a rogue caster
// is. The Sneak Attack chassis (attack action, Evasion, Uncanny Dodge) is
// bolted on the same way the martial-only rogues build it in templates.ts —
// duplicated rather than imported, since templates.ts already imports THIS
// file (importing back would be circular).
export function arcaneTricksterRogue(level: number): Combatant {
  const pb = pbFor(level);
  const dex = pb === 6 ? 5 : 4;
  const int = pb === 6 ? 3 : 2;
  const sneak = `${Math.ceil(level / 2)}d6`;
  return makeCaster({
    id: "arcane-trickster-rogue", name: `Rogue ${level}`, level, spellClass: "wizard", casterKind: "third", spellAbility: "int",
    ac: 18, hp: between(level, 10, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(dex), con: score(2), int: score(int), wis: score(1), cha: score(1) },
    proficientSaves: ["dex", "int"], focus: "balanced",
    cantrips: ["mage-hand", "minor-illusion"],
    prepared: ["shield", "invisibility"],
    extraTraits: [{ id: "evasion", name: "Evasion", trigger: "always", automation: [], text: "half on a failed Dex save, none on a success (engine hook)" }],
    extraReactions: [{
      id: "uncanny-dodge", name: "Uncanny Dodge", cost: { reaction: 1 }, recharge: "none",
      trigger: "self.wasHitByAttack", automation: [{ type: "note", text: "halves the triggering attack's damage (engine hook)" }],
    }],
    extraActions: [{
      id: "attack", name: "Attack + Sneak Attack", cost: { action: 1 }, recharge: "none",
      automation: [{ type: "target", who: { who: "squishiestEnemy" }, effects: [
        { type: "attack", bonus: pb + dex, onHit: [
          { type: "damage", amount: `1d8+${dex}`, damageType: "piercing" },
          { type: "damage", amount: sneak, damageType: "piercing", requiresSneakAttack: true },
        ] },
        { type: "attack", bonus: pb + dex, onHit: [{ type: "damage", amount: `1d8+${dex}`, damageType: "piercing" }] },
      ] }],
    }],
    keepDistance: true, opener: [], targetPriority: "squishiest",
  });
}

export function moonDruid(level: number): Combatant {
  const pb = pbFor(level);
  const wis = pb === 6 ? 5 : 4;
  const beastDie = level >= 8 ? 10 : level >= 6 ? 8 : 6; // rough CR-appropriate beast form scaling
  const c = makeCaster({
    id: "moon-druid", name: `Druid ${level}`, level, spellClass: "druid", casterKind: "full", spellAbility: "wis",
    ac: 15, hp: between(level, 10, 8 * 20 + 16), // a little extra cushion on top of Wild Shape's own temp HP
    abilities: { str: score(1), dex: score(1), con: score(3), int: score(0), wis: score(wis), cha: score(0) },
    proficientSaves: ["con", "int", "wis"], focus: "controller",
    extraActions: [
      {
        // Combat Wild Shape — the actual signature feature; a bonus action
        // (not the action cost non-Moon druids pay), matching RAW. This isn't
        // a real transformation (the engine has no way to gate a follow-up
        // action behind "currently wild-shaped," so an immediate claw swing
        // is folded into the same activation instead of unlocking a separate
        // beast-form action) — but it captures Wild Shape's real combat
        // impact: a temp-HP buffer plus a hard-hitting extra attack.
        id: "wild-shape", name: "Wild Shape (Bear)", cost: { bonus: 1 }, recharge: "none",
        limitedUse: { resource: "wild_shape", amount: 1 },
        automation: [
          { type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: `4d${beastDie}` }] },
          { type: "target", who: { who: "aiChoice" }, effects: [{ type: "attack", bonus: pb + 4, onHit: [{ type: "damage", amount: `2d${beastDie}+4`, damageType: "bludgeoning" }] }] },
        ],
      },
      ...stub(`2d6+3`, pb + 4),
    ],
    keepDistance: false, opener: ["wild-shape"], targetPriority: "lowestHp",
  });
  return { ...c, resources: { ...c.resources, wild_shape: { max: 2, recharge: "shortRest" } } };
}

export function loreBard(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const c = makeCaster({
    id: "lore-bard", name: `Bard ${level}`, level, spellClass: "bard", casterKind: "full", spellAbility: "cha",
    ac: 16, hp: between(level, 9, 6 * 20 + 12),
    abilities: { str: score(0), dex: score(2), con: score(2), int: score(1), wis: score(1), cha: score(cha) },
    proficientSaves: ["con", "dex", "cha"], focus: "balanced",
    // Cutting Words: when an attack roll against an ally is seen, spend a use
    // of Bardic Inspiration to subtract the die from it — modeled at the
    // reaction-decision point in reactions.ts (the only reaction here that
    // reads from an ALLY's reaction list rather than the target's own).
    extraReactions: [{
      id: "cutting-words", name: "Cutting Words", cost: { reaction: 1 }, recharge: "none",
      trigger: "ally.aboutToBeHitByAttack", limitedUse: { resource: "bardic_inspiration", amount: 1 },
      automation: [{ type: "note", text: "subtracts a Bardic Inspiration die from the triggering attack roll (engine hook)" }],
    }],
    extraActions: stub(`1d8+${2}`, pb + 2), keepDistance: true, targetPriority: "squishiest",
  });
  // Bardic Inspiration uses = CHA mod (min 1), short-rest recharge.
  return { ...c, resources: { ...c.resources, bardic_inspiration: { max: Math.max(1, cha), recharge: "shortRest" } } };
}

export function warlock(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  return makeCaster({
    id: "warlock", name: `Warlock ${level}`, level, spellClass: "warlock", casterKind: "warlock", spellAbility: "cha",
    ac: 16, hp: between(level, 9, 7 * 20 + 12),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(1), wis: score(1), cha: score(cha) },
    proficientSaves: ["con", "wis", "cha"], focus: "blaster",
    // Dark One's Blessing (Fiend Patron): temp HP = CHA mod + level (min 1)
    // on reducing a hostile creature to 0 HP — the "onKill" trigger was
    // declared in the schema from the start but never actually dispatched
    // by the engine until now.
    extraTraits: [{
      id: "dark-ones-blessing", name: "Dark One's Blessing", trigger: "onKill",
      automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "tempHp", amount: `${Math.max(1, cha + level)}` }] }],
    }],
    // Eldritch Blast is the workhorse — make it the fallback `attack` too
    extraActions: [{
      id: "attack", name: "Eldritch Blast (Agonizing)", cost: { action: 1 }, recharge: "none", isSpell: true,
      automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from(
        { length: level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1 },
        () => ({ type: "attack" as const, bonus: pb + cha, onHit: [{ type: "damage" as const, amount: `1d10+${cha}`, damageType: "force" as const }] }),
      ) }],
    }],
    keepDistance: true, opener: [], targetPriority: "lowestHp",
  });
}

export const CASTER_BUILDERS: Record<string, (level: number) => Combatant> = {
  "blaster-wizard": blasterWizard,
  "life-cleric": lifeCleric,
  "vengeance-paladin": vengeancePaladin,
  "hunter-ranger": hunterRanger,
  "beastmaster-ranger": beastMasterRanger,
  "battlesmith-artificer": battleSmithArtificer,
  "artillerist-artificer": artilleristArtificer,
  "armorer-guardian-artificer": armorerGuardianArtificer,
  "armorer-infiltrator-artificer": armorerInfiltratorArtificer,
  "alchemist-artificer": alchemistArtificer,
  "arcane-trickster-rogue": arcaneTricksterRogue,
  "draconic-sorcerer": draconicSorcerer,
  "wild-magic-sorcerer": wildMagicSorcerer,
  "divine-soul-sorcerer": divineSoulSorcerer,
  "shadow-magic-sorcerer": shadowMagicSorcerer,
  "storm-sorcerer": stormSorcerer,
  "aberrant-mind-sorcerer": aberrantMindSorcerer,
  "clockwork-soul-sorcerer": clockworkSoulSorcerer,
  "moon-druid": moonDruid,
  "lore-bard": loreBard,
  "warlock": warlock,
};
