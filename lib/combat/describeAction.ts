// Turns an Action's automation tree into a short plain-English line, for a
// "what does this do" lookup during a turn. Monster fixtures already carry a
// hand-written `.text` summary — used as-is when present. PC/spell actions
// don't, so this walks the schema's automation nodes (the same structured
// data the engine executes) into readable text.

import type { Action, AutomationNode, EffectMods, TargetSpec } from "../sim/schema";

const MAX_DEPTH = 5;

const deslug = (s: string): string => s.replace(/-/g, " ");

/** The handful of EffectMods fields worth surfacing in a lookup — a buff's
 *  actual numbers (Searing Smite's +1d6 fire, Bless-style save bonuses),
 *  not the debuff/aura riders that mostly matter on monster stat blocks
 *  (those already come with a hand-written `.text`). */
function fmtMods(mods: EffectMods | undefined): string | undefined {
  if (!mods) return undefined;
  const parts: string[] = [];
  if (mods.extraDamageOnHit) parts.push(`+${mods.extraDamageOnHit.amount} ${mods.extraDamageOnHit.damageType} on next hit`);
  if (mods.acBonus) parts.push(`${mods.acBonus >= 0 ? "+" : ""}${mods.acBonus} AC`);
  if (mods.saveBonusAll) parts.push(`${mods.saveBonusAll >= 0 ? "+" : ""}${mods.saveBonusAll} to saves`);
  if (mods.damageTakenMultiplier !== undefined) parts.push(`takes ${Math.round(mods.damageTakenMultiplier * 100)}% damage`);
  if (mods.attackAdvantage) parts.push(`${mods.attackAdvantage} on attacks`);
  if (mods.saveAdvantage) parts.push(`${mods.saveAdvantage} on saves`);
  if (mods.speedZero) parts.push("speed 0");
  if (mods.noReactions) parts.push("no reactions");
  return parts.length ? parts.join(", ") : undefined;
}

function fmtBonus(n: number | string): string {
  if (typeof n !== "number") return "variable";
  return n >= 0 ? `+${n}` : `${n}`;
}

function fmtWho(who: TargetSpec): string | undefined {
  switch (who.who) {
    case "area":
      return `${who.size}-ft ${who.shape}`;
    case "eachEnemy":
      return "every enemy";
    case "eachAlly":
      return "every ally";
    case "lowestHpAlly":
      return "the most-hurt ally";
    case "chosenEnemies":
      return `up to ${who.upTo} enemies`;
    default:
      return undefined; // self / aiChoice / marked / nearestEnemy / … — not worth calling out
  }
}

function describeNodes(nodes: AutomationNode[], siblings: Action[], depth: number): string[] {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  for (const n of nodes) {
    const s = describeNode(n, siblings, depth);
    if (s) out.push(s);
  }
  return out;
}

function describeNode(n: AutomationNode, siblings: Action[], depth: number): string {
  switch (n.type) {
    case "target": {
      const who = fmtWho(n.who);
      const inner = describeNodes(n.effects, siblings, depth + 1).join(", ");
      return who ? `${who}: ${inner}` : inner;
    }
    case "attack": {
      const hit = describeNodes(n.onHit, siblings, depth + 1).join(", ");
      return `${fmtBonus(n.bonus)} to hit${hit ? ` — ${hit}` : ""}`;
    }
    case "save": {
      const fail = describeNodes(n.onFail, siblings, depth + 1).join(", ");
      const dc = typeof n.dc === "number" ? n.dc : "variable";
      return `DC ${dc} ${n.ability.toUpperCase()} save${fail ? ` — fail: ${fail}` : ""}`;
    }
    case "damage": {
      const half = n.half ? " (half on a successful save)" : "";
      return `${n.amount} ${n.damageType}${half}`;
    }
    case "heal":
      return `heals ${n.amount}`;
    case "tempHp":
      return `${n.amount} temp HP`;
    case "applyCondition": {
      const dur = n.saveEnds ? " (save ends)" : n.durationRounds ? ` for ${n.durationRounds} round(s)` : "";
      return `${n.condition}${dur}`;
    }
    case "applyEffect": {
      const modText = fmtMods(n.mods);
      const dur = n.saveEnds ? " (save ends)" : n.durationRounds ? ` for ${n.durationRounds} round(s)` : "";
      return modText ? `${modText}${dur}` : `${deslug(n.name)}${dur}`;
    }
    case "useAction": {
      const sub = siblings.find((a) => a.id === n.action);
      const times = n.times && n.times > 1 ? ` x${n.times}` : "";
      return sub ? `${sub.name}${times}` : `${n.action}${times}`;
    }
    case "branch":
      return "(conditional effect)";
    case "move":
      return n.kind;
    case "mark":
      return "marks the target";
    case "summon":
      return `summons ${n.count} ${n.statBlock}`;
    case "note":
    case "removeEffect":
    case "spendResource":
    case "rechargeRoll":
      return "";
  }
}

export function describeAction(action: Action, siblings: Action[]): string {
  if (action.text) return action.text;
  const lines = describeNodes(action.automation, siblings, 0);
  return lines.length ? lines.join("; ") : "(no automated effect — a passive or narrative-only action)";
}
