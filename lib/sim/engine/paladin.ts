// A paladin's auras and the oath features that tick at the start or end of a turn (Player's Handbook, Paladin, and the oaths).
//
// An aura reaches the paladin and every friendly creature within its range — 10 feet, 30 feet from the 18th level — "while the paladin is conscious": Aura of Protection ("+ your Charisma modifier
// (minimum +1) to saving throws"), Aura of Courage (immune to being frightened), Aura of Devotion (immune to being charmed), Aura of Warding (resistance to damage from spells), Aura of Conquest (a
// frightened creature that starts its turn in it takes psychic damage). In Monte-Carlo, which has no distances, every friendly creature is taken to be in range. Where auras of one kind overlap
// only the best applies ("the effects of the same name from different sources don't stack").

import type { Condition } from "../schema";
import { applyDamage, rollSave } from "./resolve";
import { applyHealing, isIncapacitated, say, type CombatantState, type CombatState } from "./state";

type Aura = { kind: "protection" | "immunity" | "spellResistance" | "conquest"; rangeFt: number; bonus?: number; conditions?: Condition[] };

/** every aura of `kind` from a conscious paladin on `u`'s side (u included) that reaches `u` */
function aurasFor(state: CombatState, u: CombatantState, kind: Aura["kind"]): Aura[] {
  const out: Aura[] = [];
  for (const p of state.units.values()) {
    if (p.side !== u.side || !p.alive || p.downed || isIncapacitated(p)) continue;
    for (const r of p.ref.specialRules) {
      if (r.rule !== "paladinAura" || r.kind !== kind) continue;
      if (p.id !== u.id && state.distanceFt && state.distanceFt(p, u) > r.rangeFt + 0.001) continue;
      out.push(r);
    }
  }
  return out;
}

/** Aura of Protection: the best bonus to saving throws that reaches `u` */
export const auraSaveBonus = (state: CombatState, u: CombatantState): number => aurasFor(state, u, "protection").reduce((n, a) => Math.max(n, a.bonus ?? 0), 0);

/** Aura of Courage / Aura of Devotion: `u` can't be given this condition while inside the aura */
export const auraBlocks = (state: CombatState, u: CombatantState, condition: Condition): boolean => aurasFor(state, u, "immunity").some((a) => a.conditions?.includes(condition));

/** Aura of Warding: resistance to damage from spells */
export const auraResistsSpells = (state: CombatState, u: CombatantState): boolean => aurasFor(state, u, "spellResistance").length > 0;

/** paladins on the other side whose effect (Holy Nimbus, Dread Lord, Avenging Angel) or aura reaches `u` */
function opposingPaladins(state: CombatState, u: CombatantState, rangeFt: number): CombatantState[] {
  return [...state.units.values()].filter((p) => p.side !== u.side && p.alive && !p.downed && !isIncapacitated(p) && (!state.distanceFt || state.distanceFt(p, u) <= rangeFt + 0.001));
}

/**
 * What an enemy paladin's aura does to a creature as its turn starts: Aura of Conquest ("frightened creatures ... take psychic damage equal to half your paladin level"), Holy Nimbus ("Any enemy creature that
 * ends its turn in the bright light takes 10 radiant damage" — here as its turn starts), Dread Lord ("Any frightened enemy that starts its turn in the aura takes 4d10 psychic damage") and Avenging Angel
 * ("Enemies within 30 feet ... must succeed on a Wisdom saving throw or become frightened ... attack rolls against the frightened creature have advantage").
 */
export function paladinStartOfTurn(state: CombatState, u: CombatantState): void {
  if (!u.alive || u.downed) return;
  for (const p of opposingPaladins(state, u, 30)) {
    const dist = state.distanceFt ? state.distanceFt(p, u) : 0;
    for (const r of p.ref.specialRules) {
      if (r.rule === "paladinAura" && r.kind === "conquest" && u.conditions.has("frightened") && dist <= r.rangeFt + 0.001) {
        say(state, `${u.name} shudders in ${p.name}'s Aura of Conquest`, p.id);
        applyDamage(state, u, r.bonus ?? 1, "psychic", { sourceId: p.id, attackerMagical: true });
      }
    }
    if (!u.alive) return;
    const nimbus = p.effects.find((e) => e.name === "holy-nimbus");
    if (nimbus) { say(state, `${u.name} is scorched by ${p.name}'s Holy Nimbus`, p.id); applyDamage(state, u, 10, "radiant", { sourceId: p.id, attackerMagical: true }); }
    const dread = p.effects.find((e) => e.name === "dread-lord");
    if (dread && u.alive && u.conditions.has("frightened")) { say(state, `${u.name} withers in ${p.name}'s aura of dread`, p.id); applyDamage(state, u, state.rng.dice(4, 10), "psychic", { sourceId: p.id, attackerMagical: true }); }
    const angel = p.effects.find((e) => e.name === "avenging-angel");
    if (angel && u.alive && !u.conditions.has("frightened") && !u.effects.some((e) => e.name === "avenging-fear" && e.sourceId === p.id)) {
      const save = rollSave(state, u, "wis", angel.mods?.inspirationDc ?? 14, { magical: true, stakes: "control", sourceId: p.id, conditions: ["frightened"] });
      if (!save.passed) {
        u.conditions.set("frightened", { expiresRound: state.round + 10, sourceId: p.id, endsOnDamage: true });
        u.effects.push({ name: "avenging-fear", expiresRound: state.round + 10, sourceId: p.id, mods: { attacksAgainstItAdvantage: "adv" } });
        say(state, `${u.name} is terrified by ${p.name}'s Avenging Angel`, p.id);
      }
    }
  }
}

/** Protective Spirit (Redemption, 15th): "If you end your turn with fewer than half of your hit points remaining and you aren't incapacitated, you regain 1d6 + half your paladin level hit points." */
export function paladinEndOfTurn(state: CombatState, u: CombatantState): void {
  if (!u.alive || u.downed || isIncapacitated(u) || !u.ref.specialRules.some((r) => r.rule === "protectiveSpirit") || u.hp >= u.maxHp / 2) return;
  const healed = applyHealing(state, u, state.rng.dice(1, 6) + Math.floor((u.ref.level ?? 1) / 2));
  if (healed > 0) say(state, `${u.name} is mended by a protective spirit (+${healed})`, u.id);
}
