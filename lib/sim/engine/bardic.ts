// Bardic Inspiration in play (Player's Handbook, Bard): "a creature that has a Bardic Inspiration die from you can roll that die and add the number rolled to one ability check, attack roll, or
// saving throw it makes. It can wait until after it rolls the d20 before deciding to use the Bardic Inspiration die, but must decide before the DM says whether the roll succeeds or fails."
//
// The die is carried as an effect (`inspirationDie` on the holder, sourced by the bard). Here it is spent the way a player would: on an attack roll or saving throw that the die could turn from
// a failure into a success, after the d20 is seen. (Ability checks are not modeled.) The college riders ride on the same effect: Valor's Combat Inspiration (weapon damage, or AC as a
// reaction), Eloquence's Unfailing Inspiration (a die spent on a roll that still fails is kept), Creation's Mote of Potential (thunder damage on an attack roll, temporary hit points on a
// save), and Eloquence's Infectious Inspiration (a die that works hands another to a friend).

import type { DamageType } from "../schema";
import { applyDamage, rollSave } from "./resolve";
import { infectiousInspiration } from "./reactions";
import { livingEnemies, say, type ActiveEffect, type CombatantState, type CombatState } from "./state";

const parse = (d: string) => { const m = d.replace(/\s+/g, "").match(/^(\d+)d(\d+)$/); return { n: m ? Number(m[1]) : 1, sides: m ? Number(m[2]) : 6 }; };
const roll = (state: CombatState, d: string) => { const { n, sides } = parse(d); return state.rng.dice(n, sides); };
const maxOf = (d: string) => { const { n, sides } = parse(d); return n * sides; };

/** the Bardic Inspiration die a creature is carrying, if any */
export const heldDie = (u: CombatantState): ActiveEffect | undefined => u.effects.find((e) => e.mods?.inspirationDie);

/** the die has been rolled and used: the mote does its work, and the die is gone (unless Unfailing Inspiration keeps a die that didn't help) */
function finish(state: CombatState, holder: CombatantState, e: ActiveEffect, kind: "attack" | "save" | "ac" | "damage", worked: boolean, d: number, target?: CombatantState): void {
  const m = e.mods!;
  if (m.moteOfPotential) {
    if (kind === "attack" && target) {
      // "The target and each creature of your choice that you can see within 5 feet of it must succeed on a Constitution saving throw against your spell save DC or take thunder damage equal to the number rolled"
      const near = state.distanceFt
        ? livingEnemies(state, holder).filter((x) => x.id === target.id || state.distanceFt!(target, x) <= 5.001)
        : [target];
      for (const x of near) {
        if (!x.alive) continue;
        const save = rollSave(state, x, "con", m.inspirationDc ?? 13, { stakes: "damage", sourceId: e.sourceId, damageTypes: ["thunder"] });
        if (!save.passed) applyDamage(state, x, d, "thunder", { sourceId: e.sourceId, attackerMagical: true });
      }
      say(state, `${holder.name}'s mote bursts (${d} thunder)`, holder.id);
    } else if (kind === "save") {
      // "the mote vanishes ... causing the creature to gain temporary hit points equal to the number rolled on the Bardic Inspiration die plus your Charisma modifier (minimum of 1)"
      holder.tempHp = Math.max(holder.tempHp, Math.max(1, d + (m.inspirationCha ?? 0)));
    }
  }
  if (!(m.unfailingInspiration && !worked)) holder.effects = holder.effects.filter((x) => x !== e);
  if (worked) infectiousInspiration(state, holder, e);
}

/** an attack roll that fell `deficit` short: the number to add to it (the die, if it turns the miss into a hit), or 0. The die is spent either way. */
export function inspireAttack(state: CombatState, attacker: CombatantState, deficit: number, target: CombatantState): number {
  const e = heldDie(attacker);
  if (!e || deficit <= 0 || deficit > maxOf(e.mods!.inspirationDie!)) return 0; // the die couldn't turn it
  const d = roll(state, e.mods!.inspirationDie!);
  const worked = d >= deficit;
  say(state, `${attacker.name} adds their Bardic Inspiration (+${d}${worked ? "" : ", not enough"})`, attacker.id);
  finish(state, attacker, e, "attack", worked, d, target);
  return worked ? d : 0;
}

/** a saving throw that fell `deficit` short: whether the die saves it */
export function inspireSave(state: CombatState, target: CombatantState, deficit: number): boolean {
  const e = heldDie(target);
  if (!e || deficit <= 0 || deficit > maxOf(e.mods!.inspirationDie!)) return false;
  const d = roll(state, e.mods!.inspirationDie!);
  const worked = d >= deficit;
  say(state, `${target.name} adds their Bardic Inspiration to the save (+${d}${worked ? "" : ", not enough"})`, target.id);
  finish(state, target, e, "save", worked, d);
  return worked;
}

/**
 * Combat Inspiration, the defensive use (Valor, 3rd): "When a creature is hit by an attack, it can use its reaction to roll the Bardic Inspiration die and add the number rolled to its AC against that
 * attack, after seeing the roll but before knowing whether it hits or misses." `margin` is how far the roll beat its armor class. Returns whether the attack now misses.
 */
export function inspireAc(state: CombatState, target: CombatantState, margin: number): boolean {
  const e = heldDie(target);
  if (!e || !e.mods!.combatInspiration || target.reactionUsed || margin < 0) return false;
  if (margin >= Math.ceil(maxOf(e.mods!.inspirationDie!) * 0.6)) return false; // not a gamble worth a reaction
  target.reactionUsed = true;
  const d = roll(state, e.mods!.inspirationDie!);
  const missed = d > margin;
  say(state, `${target.name} adds their Bardic Inspiration to their armor class (+${d}${missed ? ", the blow misses" : ", still hits"})`, target.id);
  finish(state, target, e, "ac", missed, d);
  return missed;
}

/** Combat Inspiration, the offensive use: the die added to a weapon damage roll just made — kept for armor class while its holder is hurt */
export function inspireDamage(state: CombatState, attacker: CombatantState, target: CombatantState, type: DamageType): void {
  const e = heldDie(attacker);
  if (!e || !e.mods!.combatInspiration || !target.alive || attacker.hp < attacker.maxHp * 0.5) return;
  const d = roll(state, e.mods!.inspirationDie!);
  say(state, `${attacker.name} adds their Bardic Inspiration to the damage (+${d})`, attacker.id);
  finish(state, attacker, e, "damage", true, d);
  applyDamage(state, target, d, type, { sourceId: attacker.id, viaAttack: true, attackerMagical: true });
}
