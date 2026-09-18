// Spell-based PC templates. Each is a class + level + focus fed to `makeCaster`,
// which pulls a prepared / known list from the SRD catalog, wires real slot
// resources, and expands every prepared spell into its upcast Action variants.

import type { Combatant } from "../schema";
import { makeCaster } from "./caster";
import { SPELLS_BY_ID } from "./catalog";

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

/** finds the FIRST damage node reachable from `nodes` (optionally restricted
 *  to `damageType`) and adds `bonus` to its dice string — used for effects
 *  that boost "one damage roll" of a spell (Empowered Evocation, Elemental
 *  Affinity), which unlike Disciple of Life's flat-HP-node-per-heal only
 *  ever touch a single roll per cast, not every matching node. */
function injectFirstDamageBonus(nodes: import("../schema").AutomationNode[], bonus: number, damageType?: string): { nodes: import("../schema").AutomationNode[]; applied: boolean } {
  type DamageNode = Extract<import("../schema").AutomationNode, { type: "damage" }>;
  const matches = (n: import("../schema").AutomationNode): n is DamageNode => n.type === "damage" && (!damageType || n.damageType === damageType);
  let applied = false;
  const walk = (list: import("../schema").AutomationNode[]): import("../schema").AutomationNode[] => list.map((n) => {
    if (applied) return n;
    if (matches(n)) {
      applied = true;
      return { ...n, amount: addFlatBonus(n.amount, bonus) };
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
        const original = n.onFail[failIdx] as DamageNode;
        const amount = addFlatBonus(original.amount, bonus);
        const onFail = n.onFail.map((x, i) => (i === failIdx ? { ...original, amount } : x));
        const onSuccess = n.onSuccess?.map((x) =>
          matches(x) && x.amount === original.amount && x.damageType === original.damageType ? { ...x, amount } : x,
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

export function battleSmithArtificer(level: number): Combatant {
  const pb = pbFor(level);
  const int = pb === 6 ? 5 : 4;
  const attacks = level >= 5 ? 2 : 1;
  return makeCaster({
    id: "battlesmith-artificer", name: `Artificer ${level}`, level, spellClass: "artificer", casterKind: "half", spellAbility: "int",
    ac: 18, hp: between(level, 11, 7 * 20 + 14),
    abilities: { str: score(1), dex: score(1), con: score(2), int: score(int), wis: score(0), cha: score(0) },
    proficientSaves: ["con", "int"], focus: "balanced",
    extraActions: [
      {
        id: "attack", name: "Infused Weapon Attack", cost: { action: 1 }, recharge: "none",
        automation: [{ type: "target", who: { who: "aiChoice" }, effects: Array.from({ length: attacks }, () => (
          // +1 infusion folded into to-hit/damage, per the "Infuse an item" note elsewhere
          { type: "attack" as const, bonus: pb + int + 1, onHit: [{ type: "damage" as const, amount: `1d8+${int + 1}`, damageType: "piercing" as const }] }
        )) }],
      },
      {
        // a real persistent ally, not a spell-slot summon — joins the
        // roster at the start of the fight and acts on its own turn order
        // slot for the whole encounter
        id: "call-companion", name: "Steel Defender: Activate", cost: { bonus: 1 }, recharge: "none",
        automation: [{ type: "summon", statBlock: "steel-defender", count: "1", max: 1 }],
      },
    ],
    keepDistance: false, opener: ["call-companion", "attack"], targetPriority: "lowestHp",
  });
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
  "draconic-sorcerer": draconicSorcerer,
  "wild-magic-sorcerer": wildMagicSorcerer,
  "moon-druid": moonDruid,
  "lore-bard": loreBard,
  "warlock": warlock,
};
