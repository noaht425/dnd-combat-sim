// Spell-based PC templates. Each is a class + level + focus fed to `makeCaster`,
// which pulls a prepared / known list from the SRD catalog, wires real slot
// resources, and expands every prepared spell into its upcast Action variants.

import type { Action, Combatant } from "../schema";
import { eldritchCannonFor, houndOfIllOmenFor, steelDefenderFor, type CannonVariant } from "../engine/minions";
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

// ============================================================================ Sorcerer
// Every sorcerer feature below is built from the printed text of the Sorcerer class page and each
// Sorcerous Origin page (PHB / Xanathar's / Tasha's) on dnd5e.wikidot.com, read directly. Features
// the engine can't express are listed in the comment on each subclass (and in the commit message).

/** Font of Magic (2nd level): sorcery points equal to your sorcerer level. Metamagic (3rd level, two
 *  options; more at 10th and 17th): Twinned and Quickened are the two built — the two whose effects
 *  (a second target, a bonus-action cast) are visible in this engine. */
function withMetamagic(c: Combatant, level: number): Combatant {
  if (level < 2) return c;
  const resources = { ...c.resources, sorcery_points: { max: level, recharge: "longRest" as const } };
  if (level < 3) return { ...c, resources };
  const extra: Combatant["actions"] = [];
  for (const a of c.actions) {
    if (!a.isSpell) continue;
    // cantrips have no slot suffix in their id (level 0) — Twinned/Quickened both work on cantrips too
    const slotMatch = a.id.match(/-(\d+)$/);
    const slot = slotMatch ? Number(slotMatch[1]) : 0;
    // Quickened Spell: a spell with a casting time of 1 action becomes a bonus action, 2 sorcery points
    if ((a.cost.action ?? 0) > 0) {
      extra.push({
        ...a,
        id: `${a.id}-quickened`, name: `${a.name} (Quickened)`, cost: { bonus: 1 },
        automation: [{
          type: "branch", if: "self.resource('sorcery_points') >= 2",
          then: [{ type: "spendResource", resource: "sorcery_points", amount: 2 }, ...a.automation],
        }],
      });
    }
    // Twinned Spell: "a spell that targets only one creature and doesn't have a range of self ... a
    // spell must be incapable of targeting more than one creature at the spell's current level (magic
    // missile and scorching ray aren't eligible)". Costs the spell's level in sorcery points (1 for a cantrip).
    const top = a.automation[0];
    const beams = top?.type === "target" ? top.effects.filter((n) => n.type === "attack" || n.type === "damage").length : 0;
    if (top?.type === "target" && top.who.who === "aiChoice" && beams <= 1) {
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
  return { ...c, actions: [...c.actions, ...extra], resources };
}

/** the spells + cantrips a sorcerer gets: the class's own picks plus the origin's always-known spells
 *  (they "don't count against the number of sorcerer spells you know"). Ids missing from the spell
 *  catalog are skipped, not replaced. */
function sorcererSpells(level: number, cha: number, always: [number, string[]][] = []) {
  const base = autoPrepare("sorcerer", "full", level, cha, "blaster");
  const extra = always.filter(([l]) => level >= l).flatMap(([, ids]) => ids).filter((id) => SPELLS_BY_ID[id]);
  return { cantrips: base.cantrips, prepared: [...new Set([...extra, ...base.spells])] };
}

interface SorcererSpec {
  id: string;
  level: number;
  always?: [number, string[]][];
  ac?: number;
  hpBonus?: number;
  extraActions?: Combatant["actions"];
  extraReactions?: Combatant["reactions"];
  extraTraits?: Combatant["traits"];
  /** applied to the built spell list BEFORE Metamagic copies it, so Quickened/Twinned casts carry it too */
  pre?: (c: Combatant) => Combatant;
}

/** the shared sorcerer chassis (CHA casting, CON/CHA saves, Font of Magic + Metamagic) every origin builds on */
function sorcererBase(spec: SorcererSpec): { c: Combatant; pb: number; cha: number; dc: number } {
  const { level } = spec;
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const sp = sorcererSpells(level, cha, spec.always);
  const built = makeCaster({
    id: spec.id, name: `Sorcerer ${level}`, level, spellClass: "sorcerer", casterKind: "full", spellAbility: "cha",
    ac: spec.ac ?? 14, hp: between(level, 9, 7 * 20 + 12) + (spec.hpBonus ?? 0),
    abilities: { str: score(-1), dex: score(2), con: score(2), int: score(0), wis: score(0), cha: score(cha) },
    proficientSaves: ["con", "cha"], focus: "blaster",
    prepared: sp.prepared, cantrips: sp.cantrips,
    extraActions: [...stub(`1d10`, pb + cha), ...(spec.extraActions ?? [])],
    extraReactions: spec.extraReactions, extraTraits: spec.extraTraits,
    keepDistance: true, targetPriority: "lowestHp",
  });
  const c = withMetamagic(spec.pre ? spec.pre(built) : built, level);
  return { c, pb, cha, dc: 8 + pb + cha };
}

// ---- Draconic Bloodline (PHB) -----------------------------------------------------------------
// Draconic Resilience (1st): +1 HP per sorcerer level, and AC 13 + DEX without armor. Elemental
// Affinity (6th): +CHA to one damage roll of a spell of the ancestry's damage type, and 1 sorcery
// point buys resistance to that type for an hour (taken as paid, at the start). The ancestry is a
// choice; this build is a red dragon's (fire) — the app's own placeholder text elsewhere.
// NOT modeled: Dragon Wings (14th), Draconic Presence (18th).
function withElementalAffinity(c: Combatant, level: number, cha: number): Combatant {
  if (level < 6) return c;
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
  const dex = 2;
  const cha = pbFor(level) === 6 ? 5 : 4;
  const { c } = sorcererBase({ id: "draconic-sorcerer", level, ac: 13 + dex, hpBonus: level, pre: (b) => withElementalAffinity(b, level, cha) });
  return level >= 6
    ? { ...c, resistances: [...c.resistances, "fire"], resources: { ...c.resources, sorcery_points: { max: level, recharge: "longRest", start: level - 1 } } }
    : c;
}

// ---- Wild Magic (PHB) -------------------------------------------------------------------------
// Wild Magic Surge: "immediately after you cast a sorcerer spell of 1st level or higher. If you roll a
// 1 [on a d20], roll on the Wild Magic Surge table" — 1 in 20, once per turn, then the real d100 table
// (50 entries, each 2%). Entries the engine can model are; the rest announce themselves and do nothing
// (cosmetic ones — hair, beard, skin — need nothing). NOT modeled: Tides of Chaos (1st), Bend Luck (6th),
// Controlled Chaos (14th), Spell Bombardment (18th), and the surge entries flagged "not modeled".
const SURGE_TEXT = [
  "Roll on this table at the start of each of your turns for the next minute, ignoring this result on subsequent rolls.",
  "For the next minute, you can see any invisible creature if you have line of sight to it.",
  "A modron chosen and controlled by the DM appears in an unoccupied space within 5 feet of you, then disappears 1 minute later.",
  "You cast Fireball as a 3rd-level spell centered on yourself.",
  "You cast Magic Missile as a 5th-level spell.",
  "Roll a d10. Your height changes by a number of inches equal to the roll. If the roll is odd, you shrink. If the roll is even, you grow.",
  "You cast Confusion centered on yourself.",
  "For the next minute, you regain 5 hit points at the start of each of your turns.",
  "You grow a long beard made of feathers that remains until you sneeze, at which point the feathers explode out from your face.",
  "You cast Grease centered on yourself.",
  "Creatures have disadvantage on saving throws against the next spell you cast in the next minute that involves a saving throw.",
  "Your skin turns a vibrant shade of blue. A Remove Curse spell can end this effect.",
  "An eye appears on your forehead for the next minute. During that time, you have advantage on Wisdom (Perception) checks that rely on sight.",
  "For the next minute, all your spells with a casting time of 1 action have a casting time of 1 bonus action.",
  "You teleport up to 60 feet to an unoccupied space of your choice that you can see.",
  "You are transported to the Astral Plane until the end of your next turn, after which time you return to the space you previously occupied or the nearest unoccupied space if that space is occupied.",
  "Maximize the damage of the next damaging spell you cast within the next minute.",
  "Roll a d10. Your age changes by a number of years equal to the roll. If the roll is odd, you get younger (minimum 1 year old). If the roll is even, you get older.",
  "1d6 flumphs controlled by the DM appear in unoccupied spaces within 60 feet of you and are frightened of you. They vanish after 1 minute.",
  "You regain 2d10 hit points.",
  "You turn into a potted plant until the start of your next turn. While a plant, you are incapacitated and have vulnerability to all damage. If you drop to 0 hit points, your pot breaks, and your form reverts.",
  "For the next minute, you can teleport up to 20 feet as a bonus action on each of your turns.",
  "You cast Levitate on yourself.",
  "A unicorn controlled by the DM appears in a space within 5 feet of you, then disappears 1 minute later.",
  "You can't speak for the next minute. Whenever you try, pink bubbles float out of your mouth.",
  "A spectral shield hovers near you for the next minute, granting you a +2 bonus to AC and immunity to Magic Missile.",
  "You are immune to being intoxicated by alcohol for the next 5d6 days.",
  "Your hair falls out but grows back within 24 hours.",
  "For the next minute, any flammable object you touch that isn't being worn or carried by another creature bursts into flame.",
  "You regain your lowest-level expended spell slot.",
  "For the next minute, you must shout when you speak.",
  "You cast Fog Cloud centered on yourself.",
  "Up to three creatures you choose within 30 feet of you take 4d10 lightning damage.",
  "You are frightened by the nearest creature until the end of your next turn.",
  "Each creature within 30 feet of you becomes invisible for the next minute. The invisibility ends on a creature when it attacks or casts a spell.",
  "You gain resistance to all damage for the next minute.",
  "A random creature within 60 feet of you becomes poisoned for 1d4 hours.",
  "You glow with bright light in a 30-foot radius for the next minute. Any creature that ends its turn within 5 feet of you is blinded until the end of its next turn.",
  "You cast Polymorph on yourself. If you fail the saving throw, you turn into a sheep for the spell's duration.",
  "Illusory butterflies and flower petals flutter in the air within 10 feet of you for the next minute.",
  "You can take one additional action immediately.",
  "Each creature within 30 feet of you takes 1d10 necrotic damage. You regain hit points equal to the sum of the necrotic damage dealt.",
  "You cast Mirror Image.",
  "You cast Fly on a random creature within 60 feet of you.",
  "You become invisible for the next minute. During that time, other creatures can't hear you. The invisibility ends if you attack or cast a spell.",
  "If you die within the next minute, you immediately come back to life as if by the Reincarnate spell.",
  "Your size increases by one size category for the next minute.",
  "You and all creatures within 30 feet of you gain vulnerability to piercing damage for the next minute.",
  "You are surrounded by faint, ethereal music for the next minute.",
  "You regain all expended sorcery points.",
];

function wildMagicSurgeTable(level: number, cha: number, pb: number): { weight: number; then: import("../schema").AutomationNode[]; note: string }[] {
  const dc = 8 + pb + cha;
  type N = import("../schema").AutomationNode;
  const fireball = (who: "eachEnemy" | "eachAlly"): N => ({
    type: "target", who: { who, withinFt: 20 }, effects: [{
      type: "save", ability: "dex", dc,
      onFail: [{ type: "damage", amount: "8d6", damageType: "fire" }],
      onSuccess: [{ type: "damage", amount: "8d6", damageType: "fire", half: true }],
    }],
  });
  const self = (...effects: N[]): N => ({ type: "target", who: { who: "self" }, effects });
  const mirror = SPELLS_BY_ID["mirror-image"]?.build?.({ slotLevel: 2, casterLevel: level, spellMod: cha, dc, toHit: pb + cha, pb }) ?? [];
  // 0-based index i covers d100 rolls 2i+1 .. 2i+2
  const modeled: Record<number, N[]> = {
    3: [fireball("eachEnemy"), fireball("eachAlly")], // 07-08: Fireball as a 3rd-level spell centered on yourself
    4: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: 7 }, () => ({ type: "damage" as const, amount: "1d4+1", damageType: "force" as const })) }], // 09-10: Magic Missile as a 5th-level spell
    7: [self({ type: "applyEffect", name: "wild-regeneration", durationRounds: 10, tick: [{ type: "heal", amount: "5" }] })], // 15-16
    19: [self({ type: "heal", amount: "2d10" })], // 39-40
    20: [self({ type: "applyCondition", condition: "incapacitated", durationRounds: 1 }, { type: "applyEffect", name: "potted-plant", durationRounds: 1, mods: { damageTakenMultiplier: 2 } })], // 41-42
    25: [self({ type: "applyEffect", name: "spectral-shield", durationRounds: 10, mods: { acBonus: 2 } })], // 51-52
    29: [{ type: "restoreSlot" }], // 59-60
    32: [{ type: "target", who: { who: "chosenEnemies", upTo: 3 }, effects: [{ type: "damage", amount: "4d10", damageType: "lightning" }] }], // 65-66
    33: [self({ type: "applyCondition", condition: "frightened", durationRounds: 1 })], // 67-68
    35: [self({ type: "applyEffect", name: "wild-resistance", durationRounds: 10, mods: { damageTakenMultiplier: 0.5 } })], // 71-72
    42: mirror, // 85-86
    49: [{ type: "spendResource", resource: "sorcery_points", amount: -level }], // 99-00: regain all expended sorcery points
  };
  return SURGE_TEXT.map((text, i) => ({
    weight: 2,
    then: modeled[i] ?? [],
    note: modeled[i] && !(i === 42 && !mirror.length) ? `wild magic surge — ${text}` : `wild magic surge — ${text} (not modeled)`,
  }));
}

function withWildMagicSurge(c: Combatant, level: number, cha: number, pb: number): Combatant {
  const table = wildMagicSurgeTable(level, cha, pb);
  return {
    ...c,
    // cast.ts ids leveled spells "cast-<id>-<slot>" and cantrips bare — only leveled spells surge
    actions: c.actions.map((a) => {
      if (!a.isSpell || !/-\d+$/.test(a.id)) return a;
      return { ...a, automation: [...a.automation, {
        type: "randomEffect" as const,
        options: [{ weight: 19, then: [] }, { weight: 1, then: [{ type: "randomEffect" as const, options: table }] }],
      }] };
    }),
  };
}

export function wildMagicSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  return sorcererBase({ id: "wild-magic-sorcerer", level, pre: (b) => withWildMagicSurge(b, level, cha, pb) }).c;
}

// ---- Divine Soul (Xanathar's) -----------------------------------------------------------------
// Favored by the Gods (1st): "If you fail a saving throw or miss with an attack roll, you can roll
// 2d4 and add it to the total ... until you finish a short or long rest." Unearthly Recovery (18th):
// bonus action below half HP, regain half your HP maximum, once per long rest. NOT modeled: Divine
// Magic (the cleric spell list and affinity spell), Empowered Healing (6th), Angelic Form (14th).
export function divineSoulSorcerer(level: number): Combatant {
  const hp = between(level, 9, 7 * 20 + 12);
  const recovery: Combatant["actions"] = level >= 18 ? [{
    id: "unearthly-recovery", name: "Unearthly Recovery", cost: { bonus: 1 }, recharge: "none",
    limitedUse: { resource: "unearthly_recovery", amount: 1 },
    text: "Bonus action, below half your hit points: regain half your hit point maximum (once per long rest).",
    automation: [{ type: "branch", if: "self.hp <= self.maxhp / 2", then: [{ type: "target", who: { who: "self" }, effects: [{ type: "heal", amount: String(Math.floor(hp / 2)) }] }] }],
  }] : [];
  const { c } = sorcererBase({ id: "divine-soul-sorcerer", level, extraActions: recovery });
  return {
    ...c,
    specialRules: [
      ...c.specialRules,
      { rule: "boostMissedAttack", bonusDice: "2d4", resource: "favored_by_gods" },
      { rule: "boostFailedSave", bonusDice: "2d4", resource: "favored_by_gods" },
    ],
    resources: {
      ...c.resources,
      favored_by_gods: { max: 1, recharge: "shortRest" },
      ...(level >= 18 ? { unearthly_recovery: { max: 1, recharge: "longRest" as const } } : {}),
    },
    ai: { ...c.ai, bonusRoutine: level >= 18 ? ["unearthly-recovery"] : [] },
  };
}

// ---- Shadow Magic (Xanathar's) ----------------------------------------------------------------
// Strength of the Grave (1st): when damage reduces you to 0, a Charisma save (DC 5 + the damage
// taken) to drop to 1 HP instead — not against radiant damage or a critical hit; only a success
// spends the once-per-long-rest use. Hound of Ill Omen (6th): a bonus action and 3 sorcery points
// summon a Medium hound (dire wolf statistics) with temporary HP equal to half your level.
// NOT modeled: the hound's forced target and its "target has disadvantage on saves against your
// spells while the hound is within 5 feet" aura, Eyes of the Dark's Darkness spell (3rd), Shadow
// Walk (14th), Umbral Form (18th). The hound can be raised once per fight here.
export function shadowMagicSorcerer(level: number): Combatant {
  const hound: Combatant["actions"] = level >= 6 ? [{
    id: "hound-of-ill-omen", name: "Hound of Ill Omen", cost: { bonus: 1 }, recharge: "none",
    limitedUse: { resource: "hound_of_ill_omen", amount: 1 },
    text: "Bonus action, 3 sorcery points: a hound of ill omen (dire wolf statistics, Medium) harries a foe. It has temporary hit points equal to half your sorcerer level.",
    automation: [{
      type: "branch", if: "self.resource('sorcery_points') >= 3",
      then: [
        { type: "spendResource", resource: "sorcery_points", amount: 3 },
        { type: "summon", statBlock: houndOfIllOmenFor(level), count: "1", max: 1, tempHp: String(Math.floor(level / 2)) },
      ],
    }],
  }] : [];
  const { c } = sorcererBase({ id: "shadow-magic-sorcerer", level, extraActions: hound });
  return {
    ...c,
    specialRules: [...c.specialRules, { rule: "surviveDrop", ability: "cha", baseDc: 5, resource: "strength_of_the_grave", excludeTypes: ["radiant"], excludeCrit: true }],
    resources: {
      ...c.resources,
      strength_of_the_grave: { max: 1, recharge: "longRest" },
      ...(level >= 6 ? { hound_of_ill_omen: { max: 1, recharge: "longRest" as const } } : {}),
    },
    ai: { ...c.ai, bonusRoutine: level >= 6 ? ["hound-of-ill-omen"] : [] },
  };
}

// ---- Storm Sorcery (Sword Coast Adventurer's Guide / Xanathar's) ------------------------------
// Heart of the Storm (6th): resistance to lightning and thunder, and whenever you START casting a spell
// of 1st level or higher that deals lightning or thunder damage, creatures of your choice within 10
// feet of you take lightning or thunder damage equal to half your sorcerer level (rounded down).
// Storm's Fury (14th): reaction when hit by a MELEE attack — lightning damage to the attacker equal to
// your sorcerer level (the Strength save and 20-foot push are not simulated). Wind Soul (18th):
// immunity to lightning and thunder. NOT modeled: Tempestuous Magic, Storm Guide, the rest of Wind Soul.
function withHeartOfTheStorm(c: Combatant, level: number): Combatant {
  if (level < 6) return c;
  const burst = Math.floor(level / 2);
  const findType = (nodes: import("../schema").AutomationNode[]): "lightning" | "thunder" | undefined => {
    for (const n of nodes) {
      if (n.type === "damage" && (n.damageType === "lightning" || n.damageType === "thunder")) return n.damageType;
      const inner = n.type === "target" ? n.effects : n.type === "attack" ? n.onHit : n.type === "save" ? [...n.onFail, ...(n.onSuccess ?? [])] : n.type === "branch" ? n.then : [];
      const found = findType(inner);
      if (found) return found;
    }
    return undefined;
  };
  return {
    ...c,
    actions: c.actions.map((a) => {
      if (!a.isSpell || !/-\d+$/.test(a.id)) return a;
      const type = findType(a.automation);
      if (!type) return a;
      const eruption: import("../schema").AutomationNode = {
        type: "target", who: { who: "eachEnemy", withinFt: 10 }, effects: [{ type: "damage", amount: String(burst), damageType: type }],
      };
      return { ...a, automation: [eruption, ...a.automation] };
    }),
    resistances: [...c.resistances, "lightning", "thunder"],
    immunities: level >= 18 ? [...c.immunities, "lightning", "thunder"] : c.immunities,
  };
}

export function stormSorcerer(level: number): Combatant {
  const fury: Combatant["reactions"] = level >= 14 ? [{
    id: "storms-fury", name: "Storm's Fury", cost: { reaction: 1 }, recharge: "none",
    trigger: "self.wasHitByMeleeAttack",
    text: "Reaction when hit by a melee attack: lightning damage to the attacker equal to your sorcerer level (it must also save against being pushed 20 feet — not simulated).",
    automation: [{ type: "target", who: { who: "aiChoice" }, effects: [{ type: "damage", amount: String(level), damageType: "lightning" }] }],
  }] : [];
  return sorcererBase({ id: "storm-sorcerer", level, extraReactions: fury, pre: (b) => withHeartOfTheStorm(b, level) }).c;
}

// ---- Aberrant Mind (Tasha's) ------------------------------------------------------------------
// Psionic Spells (1st+): always-known Arms of Hadar, Dissonant Whispers (1st); Calm Emotions,
// Detect Thoughts (3rd); Hunger of Hadar, Sending (5th); Evard's Black Tentacles, Summon Aberration
// (7th); Rary's Telepathic Bond, Telekinesis (9th) — Mind Sliver, Summon Aberration are missing from
// the spell catalog. Psychic Defenses (6th): resistance to psychic damage, advantage on saves against
// being charmed or frightened. Warping Implosion (18th): 3d10 force to creatures within 30 feet
// (Strength save for half), once per long rest or for 5 sorcery points — the teleport and the pull are
// not simulated. NOT modeled: Telepathic Speech, Psionic Sorcery (6th), Revelation in Flesh (14th).
const ABERRANT_SPELLS: [number, string[]][] = [
  [1, ["arms-of-hadar", "dissonant-whispers", "mind-sliver"]], [3, ["calm-emotions", "detect-thoughts"]],
  [5, ["hunger-of-hadar", "sending"]], [7, ["evards-black-tentacles", "summon-aberration"]],
  [9, ["rarys-telepathic-bond", "telekinesis"]],
];
export function aberrantMindSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const cha = pb === 6 ? 5 : 4;
  const dc = 8 + pb + cha;
  const burst: import("../schema").AutomationNode = {
    type: "target", who: { who: "eachEnemy", withinFt: 30 }, effects: [{
      type: "save", ability: "str", dc,
      onFail: [{ type: "damage", amount: "3d10", damageType: "force" }],
      onSuccess: [{ type: "damage", amount: "3d10", damageType: "force", half: true }],
    }],
  };
  const text = "You teleport, then creatures within 30 feet of where you were make a Strength save or take 3d10 force damage (half on a success) and are pulled toward it — the teleport and pull aren't simulated.";
  const warping: Combatant["actions"] = level >= 18 ? [
    { id: "warping-implosion", name: "Warping Implosion", cost: { action: 1 }, recharge: "none", limitedUse: { resource: "warping_implosion", amount: 1 }, text, automation: [burst] },
    {
      id: "warping-implosion-sp", name: "Warping Implosion (5 sorcery points)", cost: { action: 1 }, recharge: "none", text,
      automation: [{ type: "branch", if: "self.resource('sorcery_points') >= 5", then: [{ type: "spendResource", resource: "sorcery_points", amount: 5 }, burst] }],
    },
  ] : [];
  const { c } = sorcererBase({ id: "aberrant-mind-sorcerer", level, always: ABERRANT_SPELLS, extraActions: warping });
  if (level < 6) return { ...c, resources: level >= 18 ? { ...c.resources, warping_implosion: { max: 1, recharge: "longRest" } } : c.resources };
  return {
    ...c,
    resistances: [...c.resistances, "psychic"],
    specialRules: [...c.specialRules, { rule: "advantageOnSavesAgainst", conditions: ["charmed", "frightened"] }],
    resources: level >= 18 ? { ...c.resources, warping_implosion: { max: 1, recharge: "longRest" } } : c.resources,
  };
}

// ---- Clockwork Soul (Tasha's) -----------------------------------------------------------------
// Clockwork Magic (1st+): always-known Alarm, Protection from Evil and Good (1st); Aid, Lesser
// Restoration (3rd); Dispel Magic, Protection from Energy (5th); Freedom of Movement, Summon Construct
// (7th); Greater Restoration, Wall of Force (9th) — Summon Construct is missing from the catalog.
// Restore Balance (1st): reaction, PB uses per long rest, cancel advantage/disadvantage on a d20 rolled by
// a creature within 60 feet. Bastion of Law (6th): an ACTION spending 1-5 sorcery points to ward a
// creature within 30 feet with that many d8s; when the warded creature takes damage it expends dice,
// rolls them, and reduces the damage by the total (until a long rest or a new ward). Built as three
// buttons (1, 3, 5 points). NOT modeled: Trance of Order (14th), Clockwork Cavalcade (18th).
const CLOCKWORK_SPELLS: [number, string[]][] = [
  [1, ["alarm", "protection-from-evil-and-good"]], [3, ["aid", "lesser-restoration"]],
  [5, ["dispel-magic", "protection-from-energy"]], [7, ["freedom-of-movement", "summon-construct"]],
  [9, ["greater-restoration", "wall-of-force"]],
];
export function clockworkSoulSorcerer(level: number): Combatant {
  const pb = pbFor(level);
  const bastion = (points: number): Combatant["actions"][number] => ({
    id: `bastion-of-law-${points}`, name: `Bastion of Law (${points} sorcery point${points === 1 ? "" : "s"})`, cost: { action: 1 }, recharge: "none",
    text: `Action: spend ${points} sorcery point${points === 1 ? "" : "s"} to ward yourself or a creature within 30 feet with ${points}d8 that reduce damage it takes (until a long rest or a new ward).`,
    automation: [{
      type: "branch", if: `self.resource('sorcery_points') >= ${points}`,
      then: [
        { type: "spendResource", resource: "sorcery_points", amount: points },
        { type: "target", who: { who: "lowestHpAlly" }, effects: [{ type: "ward", dice: points }] },
      ],
    }],
  });
  const { c } = sorcererBase({
    id: "clockwork-soul-sorcerer", level, always: CLOCKWORK_SPELLS,
    extraActions: level >= 6 ? [bastion(1), bastion(3), bastion(5)] : [],
  });
  return {
    ...c,
    specialRules: [...c.specialRules, { rule: "restoreBalance", resource: "restore_balance", rangeFt: 60 }],
    resources: { ...c.resources, restore_balance: { max: pb, recharge: "longRest" } },
  };
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
