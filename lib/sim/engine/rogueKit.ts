// The pieces every rogue build shares, straight from the printed Rogue table:
//   Sneak Attack (ceil(level/2) d6, once per turn), Uncanny Dodge 5th, Evasion 7th, Slippery Mind 15th
//   (Wisdom saves), Elusive 18th (no advantage against you), Stroke of Luck 20th.
// Weapon attacks follow the action economy: the Attack action is ONE swing with the main-hand weapon; the
// off-hand weapon is a separate bonus-action attack (two-weapon fighting: no ability modifier on its damage,
// since a rogue has no fighting style). Subclass features that cost a bonus action therefore really do compete
// with the off-hand swing.
//
// Lives in its own module because both templates.ts and spells/casterTemplates.ts (Arcane Trickster) need it,
// and casterTemplates.ts is imported BY templates.ts.

import type { Action, AutomationNode, Combatant, DamageType, Trait } from "../schema";

export const rogueProf = (lvl: number) => 2 + Math.floor((lvl - 1) / 4);

export interface StrikeOpts {
  /** a shortbow build: 1d6 + Dex at range and no off-hand attack (a bow is two-handed). Default is the melee
   *  rapier (1d8) + shortsword (1d6 off-hand) loadout. */
  ranged?: boolean;
  /** main-hand damage die (default the rapier's 1d8, or the shortbow's 1d6) */
  die?: string;
  /** damage type of the weapon AND of the Sneak Attack dice riding on it (Psychic Blades: psychic) */
  type?: DamageType;
  /** nodes that run on a hit right after the Sneak Attack damage node (Eye for Weakness, Rend Mind) */
  riders?: AutomationNode[];
  /** off-hand damage die (default the shortsword's 1d6) */
  offhandDie?: string;
  /** does the off-hand damage add the ability modifier? Not without a fighting style — but Psychic Blades do */
  offhandMod?: boolean;
  offhandName?: string;
}

export interface RogueKit {
  pb: number;
  dex: number;
  sneak: string;
  /** the Attack action: one swing, carrying Sneak Attack if the hit qualifies */
  attack: Action;
  /** the off-hand bonus attack, taken after the Attack action (none for a bow build) */
  offhand?: Action;
  /** Cunning Action (2nd): Disengage as a bonus action, so retreating from melee provokes no opportunity attacks */
  disengage?: Action;
  ranged: boolean;
  traits: Trait[];
  reactions: Combatant["reactions"];
  specialRules: Combatant["specialRules"];
  resources: Combatant["resources"];
  proficientSaves: Combatant["proficientSaves"];
}

export function rogueKit(level: number, o: StrikeOpts = {}): RogueKit {
  const pb = rogueProf(level);
  const dex = pb === 6 ? 5 : 4;
  const sneak = `${Math.ceil(level / 2)}d6`;
  const type = o.type ?? "piercing";
  const riders = o.riders ?? [];

  const swing = (die: string, mod: boolean): AutomationNode => ({
    type: "attack", bonus: pb + dex,
    onHit: [
      { type: "damage", amount: mod ? `${die}+${dex}` : die, damageType: type },
      { type: "damage", amount: sneak, damageType: type, requiresSneakAttack: true },
      ...riders,
    ],
  });
  const at: AutomationNode = { type: "target", who: { who: "squishiestEnemy" }, effects: [] };

  const attack: Action = {
    id: "attack", name: "Attack + Sneak Attack", cost: { action: 1 }, recharge: "none", ...(o.ranged ? { ranged: true } : {}),
    automation: [{ ...at, effects: [swing(o.die ?? (o.ranged ? "1d6" : "1d8"), true)] } as AutomationNode],
  };
  const offhand: Action | undefined = o.ranged ? undefined : {
    id: "offhand", name: o.offhandName ?? "Off-hand attack", cost: { bonus: 1 }, recharge: "none",
    automation: [{ ...at, effects: [swing(o.offhandDie ?? "1d6", o.offhandMod ?? false)] } as AutomationNode],
  };

  const traits: Trait[] = level >= 7
    ? [{ id: "evasion", name: "Evasion", trigger: "always", automation: [], text: "half on a failed Dex save, none on a success (engine hook)" }]
    : [];
  const reactions: Combatant["reactions"] = level >= 5
    ? [{
        id: "uncanny-dodge", name: "Uncanny Dodge", cost: { reaction: 1 }, recharge: "none",
        trigger: "self.wasHitByAttack", automation: [{ type: "note", text: "halves the triggering attack's damage (engine hook)" }],
      }]
    : [];
  const specialRules: Combatant["specialRules"] = [];
  if (level >= 18) specialRules.push({ rule: "denyAdvantageToAttackers" }); // Elusive
  const resources: Combatant["resources"] = {};
  if (level >= 20) { // Stroke of Luck
    specialRules.push({ rule: "turnMissIntoHit", resource: "stroke_of_luck" });
    resources.stroke_of_luck = { max: 1, recharge: "shortRest" };
  }
  const proficientSaves: Combatant["proficientSaves"] = level >= 15 ? ["dex", "int", "wis"] : ["dex", "int"]; // Slippery Mind

  const disengage: Action | undefined = level >= 2 ? {
    id: "cunning-disengage", name: "Cunning Action: Disengage", cost: { bonus: 1 }, recharge: "none",
    automation: [{ type: "target", who: { who: "self" }, effects: [{ type: "applyEffect", name: "disengaged", mods: { noOpportunityAttacks: true, untilSourceNextTurn: true } }] }],
  } : undefined;
  return { pb, dex, sneak, attack, offhand, disengage, ranged: !!o.ranged, traits, reactions, specialRules, resources, proficientSaves };
}
