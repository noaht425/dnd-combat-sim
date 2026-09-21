// The beasts (and, for the Moon druid, elementals) a druid can turn into with Wild Shape. Each is the 2014 SRD stat block, transcribed from the printed
// lines (armor class, hit points, speeds, ability scores, attack bonuses and damage; source: Open5e's `srd-2014` creature list, whose structured attack
// fields are unreliable, so the printed `desc` text is what was read). Riders that need a straight 20-ft run first — Pounce, Charge, Trampling Charge —
// are applied on the first round of a fight, when the beast is closing in, and not after; the bonus attack they grant (a bite, a stomp) is folded into the
// same action against a target that is prone.
//
// Not modeled: Relentless, Rampage, Keen senses, Hold Breath, Whirlwind and the other traits with no bearing on a fight in this engine; grapples are
// applied as the restrained condition with a Strength save to escape at the printed DC.

import { parseCombatant, type AutomationNode, type Combatant, type CreatureType, type DamageType, type Size } from "../schema";

export interface BeastForm {
  id: string;
  name: string;
  /** challenge rating as a number (1/4 = 0.25) */
  cr: number;
  fly: boolean;
  swim: boolean;
  ref: Combatant;
  /** run on the shape-shifter as it changes (Fire Form's burning aura) */
  onShape?: AutomationNode[];
}

const AI = { targetPriority: "lowestHp" as const, aoeMinTargets: 2, opener: [] as string[], saveLegendaryResistanceFor: [] as string[], keepDistance: false, neverRetreat: true, focusFire: true };

const atk = (bonus: number, amount: string, damageType: DamageType, riders: AutomationNode[] = []): AutomationNode => ({
  type: "attack", bonus, onHit: [{ type: "damage", amount, damageType }, ...riders],
});
const proneSave = (dc: number): AutomationNode => ({ type: "save", ability: "str", dc, onFail: [{ type: "applyCondition", condition: "prone", durationRounds: 1 }] });
/** a grapple: restrained until it makes a Strength check/save to escape at the printed DC */
const grapple = (dc: number): AutomationNode => ({ type: "applyCondition", condition: "restrained", durationRounds: 10, saveEnds: { ability: "str", dc, at: "endOfTurn" } });
/** a rider that only applies on the first round of a fight (the beast has room to run at its target) */
const firstRound = (nodes: AutomationNode[]): AutomationNode => ({ type: "branch", if: "round <= 1", then: nodes });
const onProne = (nodes: AutomationNode[]): AutomationNode => ({ type: "branch", if: "target.has('prone')", then: nodes });

const strike = (...effects: AutomationNode[]): Combatant["actions"] => [{
  id: "attack", name: "Attack", cost: { action: 1 }, recharge: "none",
  automation: [{ type: "target", who: { who: "aiChoice" }, effects }],
}];

interface FormSpec {
  id: string;
  name: string;
  cr: number;
  size: Size;
  type?: CreatureType;
  ac: number;
  hp: number;
  speeds: Record<string, number>;
  abilities: [number, number, number, number, number, number];
  attacks: AutomationNode[];
  packTactics?: boolean;
  resistances?: DamageType[];
  resistancesNonmagical?: DamageType[];
  immunities?: DamageType[];
  vulnerabilities?: DamageType[];
  conditionImmunities?: Combatant["conditionImmunities"];
  onShape?: AutomationNode[];
}

function form(s: FormSpec): BeastForm {
  const [str, dex, con, int, wis, cha] = s.abilities;
  const ref = parseCombatant({
    id: `form-${s.id}`, name: s.name, kind: "monster", size: s.size, creatureType: s.type ?? "beast", cr: String(s.cr),
    ac: s.ac, maxHp: s.hp, speeds: s.speeds, abilities: { str, dex, con, int, wis, cha }, pb: 2,
    proficientSaves: [], saveBonusAll: 0,
    resistances: s.resistances ?? [], resistancesNonmagical: s.resistancesNonmagical ?? [], immunities: s.immunities ?? [],
    vulnerabilities: s.vulnerabilities ?? [], conditionImmunities: s.conditionImmunities ?? [],
    specialRules: s.packTactics ? [{ rule: "packTactics" }] : [], resources: {}, traits: [], reactions: [], ai: AI,
    actions: strike(...s.attacks),
  });
  return { id: s.id, name: s.name, cr: s.cr, fly: "fly" in s.speeds, swim: "swim" in s.speeds, ref, onShape: s.onShape };
}

const ELEMENTAL_IMMUNE = ["exhaustion", "grappled", "paralyzed", "petrified", "poisoned", "prone", "restrained", "unconscious"] as const;
const BPS: DamageType[] = ["bludgeoning", "piercing", "slashing"];

const FORMS: BeastForm[] = [
  // ---- CR 1/4
  form({ id: "wolf", name: "Wolf", cr: 0.25, size: "medium", ac: 13, hp: 11, speeds: { walk: 40 }, abilities: [12, 15, 12, 3, 12, 6], packTactics: true,
    attacks: [atk(4, "2d4+2", "piercing", [proneSave(11)])] }),
  form({ id: "panther", name: "Panther", cr: 0.25, size: "medium", ac: 12, hp: 13, speeds: { walk: 50, climb: 40 }, abilities: [14, 15, 10, 3, 14, 7],
    attacks: [{ type: "branch", if: "round <= 1", then: [atk(4, "1d4+2", "slashing", [proneSave(12)]), onProne([atk(4, "1d6+2", "piercing")])], else: [atk(4, "1d6+2", "piercing")] }] }),
  // ---- CR 1/2
  form({ id: "crocodile", name: "Crocodile", cr: 0.5, size: "large", ac: 12, hp: 19, speeds: { walk: 20, swim: 20 }, abilities: [15, 10, 13, 2, 10, 5],
    attacks: [atk(4, "1d10+2", "piercing", [grapple(12)])] }),
  // ---- CR 1
  form({ id: "brown-bear", name: "Brown Bear", cr: 1, size: "large", ac: 11, hp: 34, speeds: { walk: 40, climb: 30 }, abilities: [19, 10, 16, 2, 13, 7],
    attacks: [atk(6, "1d8+4", "piercing"), atk(6, "2d6+4", "slashing")] }),
  form({ id: "dire-wolf", name: "Dire Wolf", cr: 1, size: "large", ac: 14, hp: 37, speeds: { walk: 50 }, abilities: [17, 15, 15, 3, 12, 7], packTactics: true,
    attacks: [atk(5, "2d6+3", "piercing", [proneSave(13)])] }),
  form({ id: "giant-hyena", name: "Giant Hyena", cr: 1, size: "large", ac: 12, hp: 45, speeds: { walk: 50 }, abilities: [16, 14, 14, 2, 12, 7],
    attacks: [atk(5, "2d6+3", "piercing")] }),
  form({ id: "lion", name: "Lion", cr: 1, size: "large", ac: 12, hp: 26, speeds: { walk: 50 }, abilities: [17, 15, 13, 3, 12, 8], packTactics: true,
    attacks: [{ type: "branch", if: "round <= 1", then: [atk(5, "1d6+3", "slashing", [proneSave(13)]), onProne([atk(5, "1d8+3", "piercing")])], else: [atk(5, "1d8+3", "piercing")] }] }),
  form({ id: "tiger", name: "Tiger", cr: 1, size: "large", ac: 12, hp: 37, speeds: { walk: 40 }, abilities: [17, 15, 14, 3, 12, 8],
    attacks: [{ type: "branch", if: "round <= 1", then: [atk(5, "1d8+3", "slashing", [proneSave(13)]), onProne([atk(5, "1d10+3", "piercing")])], else: [atk(5, "1d10+3", "piercing")] }] }),
  // ---- CR 2
  form({ id: "polar-bear", name: "Polar Bear", cr: 2, size: "large", ac: 12, hp: 42, speeds: { walk: 40, swim: 30 }, abilities: [20, 10, 16, 2, 13, 7],
    attacks: [atk(7, "1d8+5", "piercing"), atk(7, "2d6+5", "slashing")] }),
  form({ id: "giant-boar", name: "Giant Boar", cr: 2, size: "large", ac: 12, hp: 42, speeds: { walk: 40 }, abilities: [17, 10, 16, 2, 7, 5],
    attacks: [atk(5, "2d6+3", "slashing", [firstRound([{ type: "damage", amount: "2d6", damageType: "slashing" }, proneSave(13)])])] }),
  form({ id: "rhinoceros", name: "Rhinoceros", cr: 2, size: "large", ac: 11, hp: 45, speeds: { walk: 40 }, abilities: [21, 8, 15, 2, 12, 6],
    attacks: [atk(7, "2d8+5", "bludgeoning", [firstRound([{ type: "damage", amount: "2d8", damageType: "bludgeoning" }, proneSave(15)])])] }),
  form({ id: "saber-toothed-tiger", name: "Saber-Toothed Tiger", cr: 2, size: "large", ac: 12, hp: 52, speeds: { walk: 40 }, abilities: [18, 14, 15, 3, 12, 8],
    attacks: [{ type: "branch", if: "round <= 1", then: [atk(6, "2d6+5", "slashing", [proneSave(14)]), onProne([atk(6, "1d10+5", "piercing")])], else: [atk(6, "1d10+5", "piercing")] }] }),
  // ---- CR 3
  form({ id: "giant-scorpion", name: "Giant Scorpion", cr: 3, size: "large", ac: 15, hp: 52, speeds: { walk: 40 }, abilities: [15, 13, 15, 1, 9, 3],
    attacks: [atk(4, "1d8+2", "bludgeoning", [grapple(12)]), atk(4, "1d8+2", "bludgeoning", [grapple(12)]),
      atk(4, "1d10+2", "piercing", [{ type: "save", ability: "con", dc: 12, onFail: [{ type: "damage", amount: "4d10", damageType: "poison" }], onSuccess: [{ type: "damage", amount: "4d10", damageType: "poison", half: true }] }])] }),
  // ---- CR 4
  form({ id: "elephant", name: "Elephant", cr: 4, size: "huge", ac: 12, hp: 76, speeds: { walk: 40 }, abilities: [22, 9, 17, 3, 11, 6],
    attacks: [atk(8, "3d8+6", "piercing", [firstRound([proneSave(12)])]), onProne([atk(8, "3d10+6", "bludgeoning")])] }),
  // ---- CR 5
  form({ id: "triceratops", name: "Triceratops", cr: 5, size: "huge", ac: 13, hp: 95, speeds: { walk: 50 }, abilities: [22, 9, 17, 2, 11, 5],
    attacks: [atk(9, "4d8+6", "piercing", [firstRound([proneSave(13)])]), onProne([atk(9, "3d10+6", "bludgeoning")])] }),
  form({ id: "giant-crocodile", name: "Giant Crocodile", cr: 5, size: "huge", ac: 14, hp: 85, speeds: { walk: 30, swim: 50 }, abilities: [21, 9, 17, 2, 10, 4],
    attacks: [atk(8, "3d10+5", "piercing", [grapple(16)]), atk(8, "2d8+5", "bludgeoning", [proneSave(16)])] }),
  // ---- CR 6
  form({ id: "mammoth", name: "Mammoth", cr: 6, size: "huge", ac: 13, hp: 126, speeds: { walk: 40 }, abilities: [24, 9, 21, 3, 11, 6],
    attacks: [atk(10, "4d8+7", "piercing", [firstRound([proneSave(18)])]), onProne([atk(10, "4d10+7", "bludgeoning")])] }),
  // ---- elementals (Moon druid, Elemental Wild Shape)
  form({ id: "air-elemental", name: "Air Elemental", cr: 5, size: "large", type: "elemental", ac: 15, hp: 90, speeds: { walk: 0, fly: 90 }, abilities: [14, 20, 14, 6, 10, 6],
    attacks: [atk(8, "2d8+5", "bludgeoning"), atk(8, "2d8+5", "bludgeoning")], resistances: ["lightning", "thunder"], resistancesNonmagical: BPS, immunities: ["poison"],
    conditionImmunities: [...ELEMENTAL_IMMUNE] }),
  form({ id: "earth-elemental", name: "Earth Elemental", cr: 5, size: "large", type: "elemental", ac: 17, hp: 126, speeds: { walk: 30 }, abilities: [20, 8, 20, 5, 10, 5],
    attacks: [atk(8, "2d8+5", "bludgeoning"), atk(8, "2d8+5", "bludgeoning")], resistancesNonmagical: BPS, immunities: ["poison"], vulnerabilities: ["thunder"],
    conditionImmunities: ["exhaustion", "paralyzed", "petrified", "poisoned", "unconscious"] }),
  form({ id: "fire-elemental", name: "Fire Elemental", cr: 5, size: "large", type: "elemental", ac: 13, hp: 102, speeds: { walk: 50 }, abilities: [10, 17, 16, 6, 10, 7],
    attacks: [atk(6, "2d6+3", "fire", [{ type: "applyEffect", name: "ignited", durationRounds: 3, tick: [{ type: "damage", amount: "1d10", damageType: "fire" }] }]),
      atk(6, "2d6+3", "fire", [{ type: "applyEffect", name: "ignited", durationRounds: 3, tick: [{ type: "damage", amount: "1d10", damageType: "fire" }] }])],
    resistancesNonmagical: BPS, immunities: ["fire", "poison"], conditionImmunities: [...ELEMENTAL_IMMUNE],
    // Fire Form: "A creature that touches the elemental or hits it with a melee attack while within 5 ft. of it takes 5 (1d10) fire damage."
    onShape: [{ type: "applyEffect", name: "fire-form", mods: { hitBackDamage: { amount: "1d10", damageType: "fire", meleeOnly: true } } }] }),
  form({ id: "water-elemental", name: "Water Elemental", cr: 5, size: "large", type: "elemental", ac: 14, hp: 114, speeds: { walk: 30, swim: 90 }, abilities: [18, 14, 18, 5, 10, 8],
    attacks: [atk(7, "2d8+4", "bludgeoning"), atk(7, "2d8+4", "bludgeoning")], resistances: ["acid"], resistancesNonmagical: BPS, immunities: ["poison"],
    conditionImmunities: [...ELEMENTAL_IMMUNE] }),
];

export const BEAST_FORMS: Record<string, BeastForm> = Object.fromEntries(FORMS.map((f) => [f.id, f]));

/** the average damage of a form's attack action if everything hits: a rough measure to rank forms of the same CR */
function damagePerRound(f: BeastForm): number {
  const sum = (nodes: AutomationNode[]): number => nodes.reduce((n, x) => {
    if (x.type === "attack") return n + x.onHit.reduce((m, d) => m + (d.type === "damage" ? avg(d.amount) : 0), 0);
    if (x.type === "branch") return n + Math.max(sum(x.then), sum(x.else ?? []));
    if (x.type === "target") return n + sum(x.effects);
    return n;
  }, 0);
  return sum(f.ref.actions[0].automation);
}
function avg(dice: string): number {
  let total = 0;
  for (const t of dice.replace(/\s+/g, "").match(/\d*d\d+|\d+/g) ?? []) {
    const m = t.match(/^(\d*)d(\d+)$/);
    total += m ? (m[1] ? Number(m[1]) : 1) * (Number(m[2]) + 1) / 2 : Number(t);
  }
  return total;
}
const value = (f: BeastForm): number => f.ref.maxHp as number + 6 * damagePerRound(f);

/**
 * The best beast a druid can take: the highest-value form (hit points and damage per round) of challenge rating up to `maxCr`, without flying or
 * swimming forms unless allowed — Wild Shape's table: CR 1/4 with neither at 2nd level, 1/2 without flying at 4th, 1 with both at 8th.
 */
export function bestBeast(maxCr: number, allow: { fly: boolean; swim: boolean }): BeastForm | undefined {
  return FORMS.filter((f) => f.ref.creatureType === "beast" && f.cr <= maxCr && (allow.fly || !f.fly) && (allow.swim || !f.swim))
    .sort((a, b) => value(b) - value(a))[0];
}

/** the best elemental (Elemental Wild Shape) */
export function bestElemental(): BeastForm {
  return FORMS.filter((f) => f.ref.creatureType === "elemental").sort((a, b) => value(b) - value(a))[0];
}

/**
 * The druid as the beast: "Your game statistics are replaced by the statistics of the beast, but you retain your alignment, personality, and
 * Intelligence, Wisdom, and Charisma scores. You also retain all of your skill and saving throw proficiencies, in addition to gaining those of the
 * creature." The beast's armor class, hit points, speeds, Strength / Dexterity / Constitution, attacks and resistances replace the druid's; what the
 * druid keeps is its proficiency bonus and saving-throw proficiencies, its mental scores, its resources (spell slots and the rest), and any action
 * flagged `keepInForm`. With Beast Spells (18th level) its spells come along; before then "You can't cast spells".
 */
export function shapedAs(druid: Combatant, f: BeastForm, beastSpells: boolean): Combatant {
  const keep = (a: Combatant["actions"][number]) => a.keepInForm === true || (beastSpells && a.isSpell === true);
  return {
    ...druid,
    ac: f.ref.ac,
    speeds: f.ref.speeds,
    abilities: { ...f.ref.abilities, int: druid.abilities.int, wis: druid.abilities.wis, cha: druid.abilities.cha },
    actions: [...f.ref.actions, ...druid.actions.filter(keep)],
    reactions: beastSpells ? druid.reactions : druid.reactions.filter((r) => r.keepInForm === true),
    resistances: [...new Set([...druid.resistances, ...f.ref.resistances])],
    resistancesNonmagical: [...new Set([...druid.resistancesNonmagical, ...f.ref.resistancesNonmagical])],
    immunities: [...new Set([...druid.immunities, ...f.ref.immunities])],
    vulnerabilities: [...new Set([...druid.vulnerabilities, ...f.ref.vulnerabilities])],
    conditionImmunities: [...new Set([...druid.conditionImmunities, ...f.ref.conditionImmunities])],
    specialRules: [...druid.specialRules.filter((r) => r.rule !== "arcaneRecovery"), ...f.ref.specialRules],
    creatureType: druid.creatureType,
  };
}
