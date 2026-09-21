// ---------------------------------------------------------------------------
// Combat-simulator data format — Phase 0 (shapes only, no engine yet).
//
// The whole design in one sentence: a *combatant* (monster OR player character)
// is HP + defenses + a list of *things it can do*, and each "thing it can do"
// is a short list of *steps* (an "automation tree").
//
// A dragon's breath weapon and a wizard's Fireball are the SAME shape here:
//   target: everyone in a cone  ->  they roll a Dex save  ->  on a fail take
//   NdX fire, on a success take half.
// That sameness is why adding a PC is the same job as adding a monster.
//
// Built on pieces already in this repo (shared with the desktop app):
//   - src/lib/dice.ts        rolls "3d10+8" style strings, injectable RNG
//   - src/lib/conditions.ts  the canonical 5e condition list
//   - src/lib/initiative.ts  the existing lightweight combatant/encounter model
// This schema is the richer superset the simulator needs.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ------------------------------- primitives --------------------------------

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export const abilitySchema = z.enum(ABILITIES);
export type Ability = (typeof ABILITIES)[number];

export const DAMAGE_TYPES = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
  "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
] as const;
export const damageTypeSchema = z.enum(DAMAGE_TYPES);
export type DamageType = (typeof DAMAGE_TYPES)[number];

// Condition ids. The first block mirrors src/lib/conditions.ts (lowercased);
// the second block is the custom riders our stat blocks can introduce.
export const CONDITIONS = [
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated",
  "invisible", "paralyzed", "petrified", "poisoned", "prone", "restrained",
  "stunned", "unconscious", "exhaustion",
  "burning", "transfixed", "doomed", "marked-for-reckoning", "concussed",
] as const;
export const conditionSchema = z.enum(CONDITIONS);
export type Condition = (typeof CONDITIONS)[number];

/** Dice notation the engine will roll ("22d6", "3d10+8", "2d8+1d6"), or a plain number as a string ("10"). */
export const diceSchema = z
  .string()
  .regex(/^\s*\d+\s*$|^\s*-?\d*d\d+([+-]\d+)?(\s*[+-]\s*\d+d\d+)*\s*$/i, "expected dice notation or a number");

/**
 * A tiny formula the engine evaluates at run time (Phase 2). Phase 0 just stores the text.
 * Examples:
 *   "self.hp <= self.maxHp / 2"      "round >= 3"
 *   "target.has('frightened')"        "lastSave.passed"
 *   "self.resource('endurance') > 0"
 */
export const exprSchema = z.string().min(1);

export const advModeSchema = z.enum(["adv", "dis", "flat"]);
export type AdvMode = z.infer<typeof advModeSchema>;

export const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const;
export const sizeSchema = z.enum(SIZES);
export type Size = (typeof SIZES)[number];

// ------------------------------- targeting ---------------------------------

export const targetSpecSchema = z.discriminatedUnion("who", [
  z.object({ who: z.literal("self") }),
  z.object({ who: z.literal("aiChoice") }),         // let this combatant's ai.targetPriority pick
  z.object({ who: z.literal("marked") }),           // the creature this combatant has sworn vengeance on / chosen
  // `withinFt` narrows to enemies within that many feet of the caster (battle mode's real grid only —
  // the Monte-Carlo engine has no distances, so there it keeps its abstract "who's caught" pick)
  z.object({ who: z.literal("eachEnemy"), withinFt: z.number().positive().optional() }),
  // `withinFt` narrows to allies within that many feet of the caster (battle mode's real grid
  // only — the Monte-Carlo engine has no distances, so there it still means the whole side)
  z.object({ who: z.literal("eachAlly"), withinFt: z.number().positive().optional(), excludeSelf: z.boolean().optional() }),
  z.object({ who: z.literal("lowestHpAlly") }),      // the most-hurt ally (healing spells)
  z.object({ who: z.literal("nearestEnemy") }),
  z.object({ who: z.literal("lowestHpEnemy") }),
  // lowest AC / lowest effective HP. `preferFresh`: skip a creature this one has already Sneak-Attacked this turn when
  // any other is available (Scout's Sudden Strike may Sneak Attack again, but never the same target twice)
  z.object({ who: z.literal("squishiestEnemy"), preferFresh: z.boolean().optional() }),
  // the enemy at this rank when sorted weakest first (0 = squishiest); the last enemy if there are fewer (Distant Strike's three targets)
  z.object({ who: z.literal("enemyRank"), rank: z.number().int().min(0) }),
  z.object({ who: z.literal("chosenEnemies"), upTo: z.number().int().positive(), withinFt: z.number().positive().optional() }),
  z.object({
    who: z.literal("area"),
    shape: z.enum(["cone", "line", "sphere", "cube", "emanation"]),
    size: z.number().int().positive(),             // feet (radius for sphere/emanation, length for cone/line)
  }),
]);
export type TargetSpec = z.infer<typeof targetSpecSchema>;

// ------------------------- persistent-effect mods -------------------------

/** While an "effect" (aura, curse, rider) is on a combatant, these modifiers apply. */
export const effectModsSchema = z.object({
  acBonus: z.number().int().optional(),
  saveBonusAll: z.number().int().optional(),        // e.g. Aura of Protection
  attackBonusAll: z.number().int().optional(),      // flat bonus to every attack roll (e.g. Bless)
  attackAdvantage: advModeSchema.optional(),        // advantage/disadvantage on the affected creature's attacks
  attacksAgainstItAdvantage: advModeSchema.optional(),
  damageTakenMultiplier: z.number().optional(),     // 0.5 = resistance-like, 2 = vulnerability, 1 = none
  extraDamageOnHit: z.object({ amount: diceSchema, damageType: damageTypeSchema }).optional(),
  attackDiceMultiplier: z.number().int().optional(),// a "doubled dice" phase buff
  cannotHeal: z.boolean().optional(),               // a "can't be healed" aura (wight-style)
  maxHpReduction: diceSchema.optional(),            // a max-HP-drain rider
  speedZero: z.boolean().optional(),
  noReactions: z.boolean().optional(),              // Concussed
  disadvantageOnFirstD20EachRound: z.boolean().optional(), // "doomed"
  saveAdvantage: advModeSchema.optional(),          // the affected creature's own saves (foresight = adv)
  checkAdvantage: advModeSchema.optional(),         // the affected creature's own ability checks
  attackBonusDice: diceSchema.optional(),           // a die rolled and added to each of the holder's attack rolls (Boldness elixir: d4)
  saveBonusDice: diceSchema.optional(),             // ...and to each of its saving throws
  /** the holder has disadvantage on attack rolls against anyone EXCEPT the creature that applied
   *  this effect (Armorer Guardian's Thunder Gauntlets) */
  disadvantageUnlessTargetingSource: z.boolean().optional(),
  /** the holder has disadvantage on attack rolls against the creature that applied this effect
   *  (Armorer Infiltrator's Perfected Armor glimmer) */
  disadvantageOnlyTargetingSource: z.boolean().optional(),
  /** attack rolls against the holder gain advantage / spend `consumeOnAttacked` only for attackers OTHER than the creature that applied it (Distracting Strike) */
  advantageToOthersOnly: z.boolean().optional(),
  /** opportunity attacks against the holder are made with disadvantage (an eagle totem's rage) */
  disadvantageOnOpportunityAttacks: z.boolean().optional(),
  /** the holder provokes no opportunity attacks while the effect lasts (Disengage) */
  noOpportunityAttacks: z.boolean().optional(),
  /** the effect ends — and invisibility with it — the moment the holder deals damage to a creature or forces a saving throw (Psychic Veil) */
  endsOnDealingDamage: z.boolean().optional(),
  /** the holder has disadvantage on saving throws against effects the creature that applied this came from (the Hound of Ill Omen's mark) */
  saveDisadvantageAgainstSource: z.boolean().optional(),
  /** a natural d20 lower than this counts as this (Trance of Order: 10) on the holder's attack rolls, saving throws and checks */
  d20Floor: z.number().int().optional(),
  /** attack rolls against the holder can't have advantage (Trance of Order) */
  denyAdvantageToAttackers: z.boolean().optional(),
  /** extra walking speed in feet while the effect lasts (an elk totem's +15, a gloom stalker's first turn) */
  speedBonusFt: z.number().int().optional(),
  /** a mark on the holder: whenever the creature that applied this effect hits the holder with an attack, the holder takes this extra
   *  damage (Slayer's Prey, Planar Warrior); `oncePerTurn` = at most once each turn */
  extraDamageWhenHitBySource: z.object({ amount: diceSchema, damageType: damageTypeSchema, oncePerTurn: z.boolean().optional() }).optional(),
  /** the holder's AC is this much higher against attacks by the creature that applied the effect (Multiattack Defense) */
  acBonusAgainstSource: z.number().int().optional(),
  /** temporary resistance to these damage types while the effect lasts (Rage: bludgeoning / piercing / slashing) */
  resistTypes: z.array(damageTypeSchema).optional(),
  /** advantage on saving throws with these abilities (Rage: Strength) */
  saveAdvantageOn: z.array(abilitySchema).optional(),
  /** the holder can't gain these conditions while the effect lasts (Mindless Rage) */
  immuneConditions: z.array(conditionSchema).optional(),
  /** whoever hits the holder takes this damage back (a wild-magic surge, Spiked Retribution); `meleeOnly` = only from a melee attack */
  hitBackDamage: z.object({ amount: diceSchema, damageType: damageTypeSchema, meleeOnly: z.boolean().optional() }).optional(),
  /** extra reach in feet (Path of the Giant) */
  reachBonusFt: z.number().int().optional(),
  /** the holder's attacks deal resisted damage to anyone but the creature that applied this effect (Ancestral Protectors) */
  halveDamageToOthers: z.boolean().optional(),
  /** extraDamageOnHit lands at most once on each of the holder's turns (Call the Hunt) */
  extraDamageOncePerTurn: z.boolean().optional(),
  /** spent by the first attack roll made against the holder (the Help action) */
  consumeOnAttacked: z.boolean().optional(),
  /** ends the moment a creature on the applier's side (other than the applier) attacks the holder (Panache) */
  endOnAllyAttack: z.boolean().optional(),
  /** ends at the start of the turn of the creature that applied it ("until the start of your next turn") */
  untilSourceNextTurn: z.boolean().optional(),
});
export type EffectMods = z.infer<typeof effectModsSchema>;

export const saveEndsSchema = z.object({
  ability: abilitySchema,
  dc: z.union([z.number().int(), exprSchema]),
  at: z.enum(["endOfTurn", "startOfTurn"]),
});

// --------------------------- the automation tree -------------------------
// A recursive list of steps. Nodes that make a decision (attack / save /
// branch) carry child step-lists for each outcome.

export type AutomationNode =
  | { type: "note"; text: string }
  | { type: "target"; who: TargetSpec; effects: AutomationNode[] }
  | { type: "attack"; bonus: number | string; adv?: AdvMode; critRange?: number; onHit: AutomationNode[]; onMiss?: AutomationNode[] }
  | { type: "save"; ability: Ability; dc: number | string; adv?: AdvMode; onFail: AutomationNode[]; onSuccess?: AutomationNode[] }
  | { type: "damage"; amount: string; damageType: DamageType; half?: boolean; ignoreResistances?: boolean; diceMultiplier?: number; requiresSneakAttack?: boolean; weaponDice?: boolean; oncePerTurn?: string }
  | { type: "heal"; amount: string; oncePerTurn?: string }
  /** `perAlly`: instead of `amount`, `each` temp HP for every other living ally within 30 ft (up to `max` of them) — Call the Hunt */
  | { type: "tempHp"; amount: string; perAlly?: { each: number; max: number } }
  | { type: "applyCondition"; condition: Condition; durationRounds?: number; saveEnds?: z.infer<typeof saveEndsSchema> }
  | { type: "applyEffect"; name: string; durationRounds?: number; mods?: EffectMods; tick?: AutomationNode[]; saveEnds?: z.infer<typeof saveEndsSchema>; oneShot?: boolean; oncePerTurn?: string }
  | { type: "removeEffect"; name: string }
  | { type: "move"; kind: "pull" | "push" | "teleportSelf" | "teleportSelfToMarked" | "withdraw"; distance?: number; provokes?: boolean }
  | { type: "mark"; note?: string }
  | { type: "branch"; if: string; then: AutomationNode[]; else?: AutomationNode[] }
  /** `amount` is how much to spend (default 1); NEGATIVE gains that much instead. `from: "party"`
   *  draws from / adds to the first living party member that owns the resource (an Alchemist's
   *  elixir stock, drunk by whichever ally uses their own action to drink it). */
  | { type: "spendResource"; resource: string; amount?: number; from?: "party" }
  | { type: "rechargeRoll"; resource: string }
  | { type: "useAction"; action: string; times?: number }
  | { type: "summon"; statBlock: string; count: string; max?: number; note?: string; tempHp?: string }
  /** put a damage-absorbing ward on the target: `dice` d8s it can expend, one at a time, to reduce damage
   *  it takes (Clockwork Soul's Bastion of Law); replaces any ward this caster gave someone else */
  | { type: "ward"; dice: number }
  /** the summoner spends a bonus action to make each of its living summons that has an action
   *  with this id take it now (Steel Defender's Rend/Repair, an Eldritch Cannon's activation) */
  | { type: "commandSummon"; action: string; limit?: number; rangeFt?: number }
  /** regain the lowest-level expended spell slot (Wild Magic Surge) */
  | { type: "restoreSlot" }
  /** Inquisitive's Insightful Fighting: `bonus` is the rogue's Wisdom (Insight) modifier, rolled against the
   *  target's Charisma (Deception). On a success the rogue may Sneak Attack that target without advantage. */
  | { type: "insightfulFighting"; bonus: number }
  /** heal up to `total` hit points, divided among the source's allies within `withinFt` (most wounded first) — Clockwork Cavalcade */
  | { type: "healPool"; total: number; withinFt?: number }
  /** the source spends its bonus action (a rider that IS a bonus action: the wolf totem's topple) */
  | { type: "spendBonusAction" }
  /** the source spends its reaction (a rider that IS a reaction: Raging Storm's wave) */
  | { type: "spendReaction" }
  /** a contested ability check: the source rolls d20 + `bonus`, the target d20 + its `theirs` modifier; only a strictly
   *  higher roll wins (a tie leaves things as they were), and `onSuccess` then runs against the target (Panache) */
  | { type: "contest"; bonus: number; theirs: Ability; onSuccess: AutomationNode[] }
  /** weighted random pick, one branch fires (Wild Magic Surge and similar
   *  chaotic-magic tables) — weights don't need to sum to anything in
   *  particular, they're relative. A no-op option (empty `then`, a big
   *  weight) is how "usually nothing happens" is expressed. */
  | { type: "randomEffect"; options: { weight: number; then: AutomationNode[]; note?: string }[] };

export const automationNodeSchema: z.ZodType<AutomationNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("note"), text: z.string() }),
    z.object({ type: z.literal("target"), who: targetSpecSchema, effects: z.array(automationNodeSchema) }),
    z.object({
      type: z.literal("attack"),
      bonus: z.union([z.number().int(), exprSchema]),
      adv: advModeSchema.optional(),
      critRange: z.number().int().min(2).max(20).optional(),
      onHit: z.array(automationNodeSchema),
      onMiss: z.array(automationNodeSchema).optional(),
    }),
    z.object({
      type: z.literal("save"),
      ability: abilitySchema,
      dc: z.union([z.number().int(), exprSchema]),
      adv: advModeSchema.optional(),
      onFail: z.array(automationNodeSchema),
      onSuccess: z.array(automationNodeSchema).optional(),
    }),
    z.object({
      type: z.literal("damage"),
      amount: diceSchema,
      damageType: damageTypeSchema,
      half: z.boolean().optional(),
      ignoreResistances: z.boolean().optional(),
      diceMultiplier: z.number().int().optional(),
      /** Sneak Attack: only applies with advantage on the attack, or an ally
       *  of the attacker within 5ft of the target — checked dynamically
       *  against the attack that's currently resolving, not baked in at
       *  build time (the attack itself doesn't need forced advantage). */
      requiresSneakAttack: z.boolean().optional(),
      /** these are the weapon's own damage dice (Great Weapon Fighting may reroll a 1 or 2 on them) */
      weaponDice: z.boolean().optional(),
      /** lands at most once per turn under this key (Divine Fury: the first creature you hit each turn) */
      oncePerTurn: z.string().optional(),
    }),
    z.object({ type: z.literal("heal"), amount: diceSchema, oncePerTurn: z.string().optional() }),
    z.object({ type: z.literal("tempHp"), amount: diceSchema, perAlly: z.object({ each: z.number().int().positive(), max: z.number().int().positive() }).optional() }),
    z.object({
      type: z.literal("applyCondition"),
      condition: conditionSchema,
      durationRounds: z.number().int().optional(),
      saveEnds: saveEndsSchema.optional(),
    }),
    z.object({
      type: z.literal("applyEffect"),
      name: z.string(),
      durationRounds: z.number().int().optional(),
      mods: effectModsSchema.optional(),
      tick: z.array(automationNodeSchema).optional(),
      saveEnds: saveEndsSchema.optional(),
      // consumed the moment its extraDamageOnHit lands on an attack (smites, Ensnaring Strike, ...)
      oneShot: z.boolean().optional(),
      oncePerTurn: z.string().optional(),
    }),
    z.object({ type: z.literal("removeEffect"), name: z.string() }),
    z.object({
      type: z.literal("move"),
      kind: z.enum(["pull", "push", "teleportSelf", "teleportSelfToMarked", "withdraw"]),
      distance: z.number().int().optional(),
      provokes: z.boolean().optional(), // withdraw/step-away provokes unless set false
    }),
    z.object({ type: z.literal("mark"), note: z.string().optional() }),
    z.object({
      type: z.literal("branch"),
      if: exprSchema,
      then: z.array(automationNodeSchema),
      else: z.array(automationNodeSchema).optional(),
    }),
    z.object({ type: z.literal("spendResource"), resource: z.string(), amount: z.number().int().optional(), from: z.literal("party").optional() }),
    z.object({ type: z.literal("restoreSlot") }),
    z.object({ type: z.literal("insightfulFighting"), bonus: z.number().int() }),
    z.object({ type: z.literal("spendReaction") }),
    z.object({ type: z.literal("spendBonusAction") }),
    z.object({ type: z.literal("healPool"), total: z.number().int().positive(), withinFt: z.number().positive().optional() }),
    z.object({ type: z.literal("contest"), bonus: z.number().int(), theirs: abilitySchema, onSuccess: z.array(automationNodeSchema) }),
    z.object({ type: z.literal("commandSummon"), action: z.string(), limit: z.number().int().positive().optional(), rangeFt: z.number().positive().optional() }),
    z.object({ type: z.literal("rechargeRoll"), resource: z.string() }),
    z.object({ type: z.literal("useAction"), action: z.string(), times: z.number().int().positive().optional() }),
    z.object({
      type: z.literal("summon"),
      statBlock: z.string(),
      count: diceSchema,
      max: z.number().int().positive().optional(), // total of this stat block the summoner may control at once
      note: z.string().optional(),
      tempHp: diceSchema.optional(),               // temporary hit points each summon appears with
    }),
    z.object({ type: z.literal("ward"), dice: z.number().int().positive() }),
    z.object({
      type: z.literal("randomEffect"),
      options: z.array(z.object({
        weight: z.number().positive(),
        then: z.array(automationNodeSchema),
        note: z.string().optional(),
      })).min(1),
    }),
  ]),
);

// ------------------------- special defensive rules -----------------------
// Rules that change the damage/save math rather than being a plain resistance.

export const specialRuleSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("magicResistance") }),
  z.object({ rule: z.literal("legendaryResistance"), perDay: z.number().int().positive() }),
  z.object({ rule: z.literal("flatDamageReduction"), amount: z.number().int().positive() }),        // Zaros "Deathless Scales"
  z.object({ rule: z.literal("resistNonAdvantageAttacks") }),                                        // resist any attack made without advantage
  z.object({ rule: z.literal("advantageOnSaves"), abilities: z.array(abilitySchema) }),              // "Unbroken Will"
  z.object({ rule: z.literal("uncontainable"), note: z.string().optional() }),                       // Unbound / Formless / Step Between Moments
  z.object({ rule: z.literal("denyAdvantageToAttackers") }),                                         // attackers never get advantage vs this creature
  z.object({ rule: z.literal("cannotBeSurprised") }),                                                // sphinxes, All That Has Happened
  z.object({
    rule: z.literal("d20Replacement"),                                                              // once/round, rewrite a nearby d20 to a pre-seen face
    range: z.number().int().positive(),                                                             // feet within which it can nudge a d20
    perRound: z.number().int().positive().default(1),
    // rolled value (1..20) -> the three faces it may swap to (the neighbours on the die)
    table: z.record(z.string(), z.array(z.number().int().min(1).max(20)).length(3)),
  }),
  z.object({
    rule: z.literal("undyingReturn"),                                                               // Undying Grudge / Unrelenting Storm
    returnHp: z.number().int().positive(),
    oncePer: z.enum(["encounter", "rejuvenation"]),
    onReturn: z.array(automationNodeSchema).optional(),
  }),
  z.object({ rule: z.literal("critRange"), value: z.number().int().min(2).max(20) }),                // Invincible Conqueror 19-20
  z.object({ rule: z.literal("minionGuard"), chance: z.number().min(0).max(1) }),                    // summoned minions interpose; a hit on the summoner lands on a minion instead
  z.object({ rule: z.literal("acMeltOnHit"), amount: z.number().int().positive(), min: z.number().int() }), // each physical hit shaves the target's AC, stacking
  z.object({ rule: z.literal("noReactionsAfter"), damageType: damageTypeSchema }),                   // a damage type that strips the target's reactions for a round
  z.object({ rule: z.literal("ambush") }),                                                          // acts first on round 1; its round-1 hits have advantage and auto-crit (Assassinate)
  z.object({ rule: z.literal("flashOfGenius"), resource: z.string(), bonus: z.number().int(), rangeFt: z.number().positive() }), // Artificer, 7th level: reaction, add INT to a save of yourself or a creature within range
  z.object({ rule: z.literal("boostMissedAttack"), bonusDice: z.string(), resource: z.string() }),
  // add a die to a save you just failed (Favored by the Gods, Dark One's Own Luck) — self only, no reaction; `consumeOnlyOnSuccess` = the use is spent only if it turns the save around
  z.object({ rule: z.literal("boostFailedSave"), bonusDice: z.string(), resource: z.string() }),
  // Shadow Magic's Strength of the Grave: when damage would reduce you to 0, a save (DC = baseDc + damage taken) to stay at 1 HP instead; not vs the excluded damage types or on a crit; the use is spent only on success
  z.object({ rule: z.literal("surviveDrop"), ability: abilitySchema, baseDc: z.number().int(), resource: z.string(), excludeTypes: z.array(damageTypeSchema).default([]), excludeCrit: z.boolean().default(true) }),
  // Clockwork Soul's Restore Balance: reaction, cancel advantage/disadvantage on a d20 rolled by a creature within range
  z.object({ rule: z.literal("restoreBalance"), resource: z.string(), rangeFt: z.number().positive() }),
  // Pack Tactics: advantage on an attack roll against a creature with an ally of the attacker within 5 ft of it that isn't incapacitated
  z.object({ rule: z.literal("packTactics") }),
  // Multiattack Defense (Hunter, 7th): when a creature hits you, +4 AC against that creature's later attacks until its next turn
  z.object({ rule: z.literal("multiattackDefense") }),
  // Infused Strikes (Drakewarden's drake): reaction — when another creature within 30 ft that it can see hits with a weapon attack, the target takes extra damage
  z.object({ rule: z.literal("infusedStrikes"), dice: z.string(), damageType: damageTypeSchema }),
  // Persistent Rage (15th): a rage ends early only if you fall unconscious or choose to end it
  z.object({ rule: z.literal("persistentRage") }),
  // Relentless Rage (11th): dropping to 0 while raging, a Constitution save (DC 10, +5 for each use since the last rest) to stay at 1 HP
  z.object({ rule: z.literal("relentlessRage") }),
  // Brutal Critical: this many extra weapon damage dice on a melee critical hit
  z.object({ rule: z.literal("brutalCritical"), dice: z.number().int().positive() }),
  // reroll a failed save (Fanatical Focus: once per rage) — only while the named effect is up; each reroll spends one `resource`
  z.object({ rule: z.literal("rerollFailedSave"), resource: z.string(), whileEffect: z.string().optional() }),
  // Supernatural Defense (Monster Slayer, 7th): +1d6 on saves against effects from the creature you designated with Slayer's Prey
  z.object({ rule: z.literal("supernaturalDefense") }),
  // Parry (Battle Master): a reaction and a superiority die reduce melee-attack damage by the die + `bonus`
  z.object({ rule: z.literal("parry"), resource: z.string(), dice: z.string(), bonus: z.number().int() }),
  // Rage Beyond Death (Zealot, 14th): while raging, 0 hit points doesn't knock you unconscious; failing death saves doesn't kill you until the rage ends
  z.object({ rule: z.literal("rageBeyondDeath") }),
  // Dread Ambusher (Gloom Stalker): +this many feet of walking speed on the first turn of a combat
  z.object({ rule: z.literal("firstTurnSpeed"), ft: z.number().int().positive() }),
  // Tides of Chaos: the first d20 roll of the fight (an attack roll or a save) is made with advantage, spending the use
  z.object({ rule: z.literal("advantageOnce"), resource: z.string() }),
  // Wolf totem: while raging, allies have advantage on melee attacks against hostile creatures within 5 ft of you
  z.object({ rule: z.literal("wolfTotem") }),
  // Totemic Attunement (Bear): while raging, hostile creatures within 5 ft of you have disadvantage on attacks against anyone but you (or another with this feature)
  z.object({ rule: z.literal("bearAttunement") }),
  // Spirit Shield (Ancestral Guardian): while raging, reaction — reduce damage another creature within 30 ft takes by `dice`; `vengeful` (14th) sends the prevented amount back as force damage
  z.object({ rule: z.literal("spiritShield"), dice: z.string(), vengeful: z.boolean().default(false) }),
  // Assassin's Assassinate: advantage on attack rolls against any creature that hasn't taken a turn in the combat yet
  z.object({ rule: z.literal("assassinate") }),
  // Fighting Style: Great Weapon Fighting — a 1 or 2 on the weapon's damage dice is rerolled once
  z.object({ rule: z.literal("greatWeaponFighting") }),
  // Swashbuckler's Fancy Footwork: a creature this one made a melee attack against can't make opportunity attacks against it for the rest of that turn
  z.object({ rule: z.literal("fancyFootwork") }),
  // Thief's Reflexes: a second turn in round 1, at initiative − 10 (not if the party is surprised)
  z.object({ rule: z.literal("extraFirstRoundTurn") }),
  // Scout's Ambush Master: advantage on initiative rolls
  z.object({ rule: z.literal("initiativeAdvantage") }),
  // Scout's Ambush Master: the first creature this one hits in round 1 is easier for the whole party to hit until the start of its next turn
  z.object({ rule: z.literal("ambushMaster") }),
  // Swashbuckler's Rakish Audacity: Sneak Attack without advantage when within 5 ft of the target, no OTHER creature is within 5 ft of the attacker, and no disadvantage
  z.object({ rule: z.literal("soloSneak") }),
  // Scout's Sudden Strike: a second Sneak Attack in the same turn, but never against the same target twice
  z.object({ rule: z.literal("suddenStrike") }),
  // Stroke of Luck: once per rest, turn a missed attack into a hit
  z.object({ rule: z.literal("turnMissIntoHit"), resource: z.string() }),
  // Master Duelist: once per rest, reroll a missed attack with advantage
  z.object({ rule: z.literal("rerollMissWithAdvantage"), resource: z.string() }),
  // advantage on saving throws against effects that would impose these conditions (Aberrant Mind's Psychic Defenses)
  z.object({ rule: z.literal("advantageOnSavesAgainst"), conditions: z.array(conditionSchema) }),   // Favored by the Gods — once/rest, add a bonus die to a roll that would miss and recheck
]);
export type SpecialRule = z.infer<typeof specialRuleSchema>;

// ------------------------------- resources ------------------------------
// Named, limited pools: recharge powers, X/day abilities, spell slots,
// class dice (superiority dice, ki), Channel Divinity, Endurance points, etc.

export const resourceSchema = z.object({
  max: z.union([z.number().int().nonnegative(), z.literal("unbounded")]),
  recharge: z.enum(["shortRest", "longRest", "roll:5-6", "roll:4-6", "roll:6", "perTurn", "none"]).default("longRest"),
  start: z.number().int().nonnegative().optional(),  // defaults to max
});

// spell slots are just resources named slot1..slot9
export const resourcesSchema = z.record(z.string(), resourceSchema);

// ------------------------------ traits / actions -----------------------

export const traitSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: z.enum([
    "always",            // passive; the engine reads mods directly
    "encounterStart",    // e.g. self-cast foresight "usually already active"
    "turnStart",
    "turnEnd",
    "whenHitByAttack",
    "whenReducedToHalf",
    "whenReducedToZero",
    "whenAllyDropsToZero",
    "whenCreatureDiesNearby",
    "onKill",
    "roundStart",
  ]),
  once: z.boolean().optional(),        // fires at most once per encounter
  mods: effectModsSchema.optional(),   // for "always" auras that just modify the owner
  aura: z.object({ radius: z.number().int().positive(), automation: z.array(automationNodeSchema) }).optional(),
  automation: z.array(automationNodeSchema).default([]),
  text: z.string().optional(),         // human-readable copy from the stat block
});
export type Trait = z.infer<typeof traitSchema>;

export const actionCostSchema = z.object({
  action: z.number().int().nonnegative().optional(),
  bonus: z.number().int().nonnegative().optional(),
  reaction: z.number().int().nonnegative().optional(),
  legendary: z.number().int().nonnegative().optional(),
});

export const actionSchema = z.object({
  id: z.string(),
  name: z.string(),
  cost: actionCostSchema.default({ action: 1 }),
  recharge: z.enum(["roll:5-6", "roll:4-6", "roll:6", "none"]).default("none"),
  limitedUse: z.object({ resource: z.string(), amount: z.number().int().positive().default(1) }).optional(),
  trigger: z.string().optional(),      // for reactions: an expr, e.g. "self.wasHitByAttack"
  /** its attack rolls are RANGED attacks (a bow, a ranged spell attack): disadvantage while a hostile creature is within 5 ft of the attacker */
  ranged: z.boolean().optional(),
  isSpell: z.boolean().optional(),     // this action is a spell -> Counterspell can negate it
  concentration: z.boolean().optional(), // the ongoing effect ends if the caster loses concentration
  // gate: the AI may only choose this action while a living enemy has one of these
  // conditions (e.g. an "execute" usable only vs a grappled / incapacitated target).
  usableWhen: z.object({ enemyHasCondition: z.array(conditionSchema).nonempty() }).optional(),
  automation: z.array(automationNodeSchema),
  text: z.string().optional(),
});
export type Action = z.infer<typeof actionSchema>;

export const legendaryActionsSchema = z.object({
  budget: z.number().int().positive(),
  options: z.array(z.object({ action: z.string(), cost: z.number().int().positive().default(1) })),
});

export const lairActionsSchema = z.object({
  initiative: z.number().int().default(20),
  options: z.array(z.object({ action: z.string() })),
  noRepeat: z.boolean().default(true),
});

// --------------------------------- AI knobs ----------------------------
// Per-combatant "personality". Kept as data so the engine has no per-creature branches.

export const aiSchema = z.object({
  targetPriority: z.enum(["lowestHp", "squishiest", "marked", "nearest", "highestThreat"]).default("highestThreat"),
  aoeMinTargets: z.number().int().positive().default(2),          // only breathe/AoE if it catches at least this many
  opener: z.array(z.string()).default([]),                        // action ids to prefer on round 1 (Frightful Presence, a mark-a-foe opener)
  bonusAfterAttack: z.array(z.string()).optional(),               // bonus-action ids an AI-run PC takes right AFTER its `attack` action (Soulknife's second Psychic Blade), first match wins
  bonusRoutine: z.array(z.string()).optional(),                  // bonus-action ids an AI-run PC takes EVERY turn when available, first match wins (command a companion, an extra attack)
  saveLegendaryResistanceFor: z.array(z.string()).default(["stunned", "paralyzed", "banished", "save-or-die", "controlled"]),
  keepDistance: z.boolean().default(false),
  neverRetreat: z.boolean().default(false),
  focusFire: z.boolean().default(true),
});
export type AI = z.infer<typeof aiSchema>;

// ------------------------------- flavor (presentation only) ------------
// Pure stat-block dressing: the engine never reads this. It exists so a
// monster's type/alignment/senses/languages are recorded once, on the data,
// instead of being reconstructed (or guessed) by hand every time someone
// writes the block up.

export const flavorSchema = z.object({
  type: z.string().optional(),       // "dragon", "fey", "fiend (devil)", ...
  alignment: z.string().optional(),  // "chaotic evil", "unaligned", ...
  senses: z.string().optional(),     // "darkvision 120 ft., passive Perception 11"
  languages: z.string().optional(),  // "Common, Draconic", "—", ...
});
export type Flavor = z.infer<typeof flavorSchema>;

// ------------------------------- the combatant ------------------------

export const combatantSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["monster", "pc"]),

  size: sizeSchema.default("medium"),
  cr: z.string().optional(),                      // monsters, e.g. "23"
  level: z.number().int().min(1).max(20).optional(), // pcs
  templateId: z.string().optional(),             // pcs built from a template

  ac: z.number().int().positive(),
  maxHp: z.union([z.number().int().positive(), diceSchema]),
  speeds: z.record(z.string(), z.number().int().nonnegative()).default({ walk: 30 }),

  abilities: z.object({
    str: z.number().int(), dex: z.number().int(), con: z.number().int(),
    int: z.number().int(), wis: z.number().int(), cha: z.number().int(),
  }),
  pb: z.number().int().positive(),
  proficientSaves: z.array(abilitySchema).default([]),
  saveBonusAll: z.number().int().default(0),      // flat bonus to every save (own aura, etc.)
  initiativeBonus: z.number().int().optional(),   // defaults to dex mod

  // caster metadata (set by makeCaster) so the per-PC spell picker can rebuild
  // the spell list from an already-built PC — the engine itself ignores these
  spellClass: z.string().optional(),
  casterKind: z.string().optional(),
  spellAbility: abilitySchema.optional(),

  resistances: z.array(damageTypeSchema).default([]),
  resistancesNonmagical: z.array(damageTypeSchema).default([]), // "b/p/s from nonmagical attacks"
  immunities: z.array(damageTypeSchema).default([]),
  vulnerabilities: z.array(damageTypeSchema).default([]),
  conditionImmunities: z.array(conditionSchema).default([]),
  specialRules: z.array(specialRuleSchema).default([]),

  resources: resourcesSchema.default({}),

  traits: z.array(traitSchema).default([]),
  actions: z.array(actionSchema).default([]),          // includes "multiattack" as an action of useAction nodes
  reactions: z.array(actionSchema).default([]),
  legendaryActions: legendaryActionsSchema.optional(),
  lairActions: lairActionsSchema.optional(),
  regionalNote: z.string().optional(),
  flavor: flavorSchema.optional(),
  /** a summoned companion that takes no actions of its own on its turn (beyond a plain Dodge, if it
   *  has a "dodge" action) unless its summoner spends a bonus action to command it — Steel
   *  Defender, Eldritch Cannon */
  commandOnly: z.boolean().optional(),

  // prefault (not default) so the inner field defaults inside aiSchema are applied
  ai: aiSchema.prefault({}),
});
export type Combatant = z.infer<typeof combatantSchema>;

// ------------------------------- scenarios -------------------------
// This is the layer that makes "test A,B,C,D at level 15 vs a boss, now bump
// B and C a level" a one-number edit.

export const pcSpecSchema = z.object({
  template: z.string(),                           // "blaster-wizard", "shield-paladin", ...
  name: z.string(),
  level: z.number().int().min(1).max(20),
  overrides: z.record(z.string(), z.unknown()).optional(), // tweak a template without forking it
});
export type PcSpec = z.infer<typeof pcSpecSchema>;

// A party/enemy slot is either a PC spec, or the id of a fully hand-authored combatant.
export const partySlotSchema = z.union([pcSpecSchema, z.string()]);

export const scenarioSchema = z.object({
  name: z.string(),
  party: z.array(partySlotSchema),
  enemies: z.array(z.string()),                   // combatant ids
  trials: z.number().int().positive().default(10000),
  seed: z.number().int().optional(),
  notes: z.string().optional(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

// ------------------------------- helpers -------------------------

export function parseCombatant(data: unknown): Combatant {
  return combatantSchema.parse(data);
}

export function parseScenario(data: unknown): Scenario {
  return scenarioSchema.parse(data);
}

/** Convenience: build a resource map of spell slots from an array like [4,3,3,3,2]. */
export function spellSlots(perLevel: number[]): Record<string, z.infer<typeof resourceSchema>> {
  const out: Record<string, z.infer<typeof resourceSchema>> = {};
  perLevel.forEach((n, i) => {
    if (n > 0) out[`slot${i + 1}`] = { max: n, recharge: "longRest" };
  });
  return out;
}
