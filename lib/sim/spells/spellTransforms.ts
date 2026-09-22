// Helpers that rewrite a built spell's automation tree — a class or subclass feature that touches "one damage roll of a spell" (Empowered
// Evocation, Elemental Affinity, Overchannel, Power Surge, Potent Cantrip...) is a small transform over the same nodes the spell was built from.
// Shared by the caster templates so none of them has to reach into another's module.

import type { AutomationNode } from "../schema";

/** "cast-fireball-3" -> "fireball"; "cast-fire-bolt" -> "fire-bolt" (cantrips have no trailing slot number) — the slot suffix is always a bare
 *  integer, which no catalog spell id ends in, so stripping it is unambiguous. */
export function baseSpellId(actionId: string): string {
  return actionId.replace(/^cast-/, "").replace(/-\d+$/, "");
}

/** merges `bonus` into a dice-notation amount's existing flat modifier rather than appending a second one — the schema's amount regex allows only
 *  ONE flat modifier right after the first dice term (e.g. "1d4+1"), so naively producing "1d4+1+4" fails validation. A bare integer amount just adds. */
export function addFlatBonus(amount: string, bonus: number): string {
  const pureNum = amount.match(/^\s*(\d+)\s*$/);
  if (pureNum) return String(parseInt(pureNum[1], 10) + bonus);
  const m = amount.match(/^(\s*-?\d*d\d+)([+-]\d+)?(.*)$/);
  if (!m) return `${amount}+${bonus}`;
  const [, dice, flatStr, rest] = m;
  const newFlat = (flatStr ? parseInt(flatStr, 10) : 0) + bonus;
  const flatPart = newFlat === 0 ? "" : newFlat > 0 ? `+${newFlat}` : `${newFlat}`;
  return `${dice}${flatPart}${rest}`;
}

/** the largest total a dice string can roll: "8d6+3" -> 51 ("2d8+1d6" style multi-term strings sum every term) */
export function maxOfDice(amount: string): number {
  let total = 0;
  for (const term of amount.replace(/\s+/g, "").match(/[+-]?\d*d\d+|[+-]?\d+/g) ?? []) {
    const m = term.match(/^([+-]?)(\d*)d(\d+)$/);
    if (m) total += (m[1] === "-" ? -1 : 1) * (m[2] ? Number(m[2]) : 1) * Number(m[3]);
    else total += Number(term);
  }
  return total;
}

type Rolled = Extract<AutomationNode, { type: "damage" | "heal" }>;

/** finds the FIRST rolled node reachable from `nodes` — a damage node (optionally restricted to one or several `damageType`s) or, with
 *  `includeHeal`, a heal node — and adds `bonus` to its dice string. A number merges into the flat modifier; a string ("1d8") is appended as a
 *  dice term. Used for effects that boost "one roll" of a spell (Empowered Evocation, Elemental Affinity, Arcane Firearm, Alchemical Savant),
 *  which unlike Disciple of Life's flat-HP-node-per-heal only ever touch a single roll per cast, not every matching node. */
export function injectFirstDamageBonus(
  nodes: AutomationNode[],
  bonus: number | string,
  damageType?: string | string[],
  includeHeal = false,
): { nodes: AutomationNode[]; applied: boolean } {
  const types = damageType === undefined ? undefined : Array.isArray(damageType) ? damageType : [damageType];
  const matches = (n: AutomationNode): n is Rolled =>
    (n.type === "damage" && (!types || types.includes(n.damageType))) || (includeHeal && n.type === "heal");
  // a dice bonus goes after the amount's own dice — or first, when the amount is a plain number ("70" -> "1d8+70": a flat number can't lead)
  const withBonus = (amount: string): string => (typeof bonus === "number" ? addFlatBonus(amount, bonus) : /^\s*\d+\s*$/.test(amount) ? `${bonus}+${amount.trim()}` : `${amount}+${bonus}`);
  const sameRoll = (a: Rolled, b: Rolled): boolean =>
    a.type === b.type && a.amount === b.amount && (a.type !== "damage" || a.damageType === (b as typeof a).damageType);
  let applied = false;
  const walk = (list: AutomationNode[]): AutomationNode[] => list.map((n) => {
    if (applied) return n;
    if (matches(n)) {
      applied = true;
      return { ...n, amount: withBonus(n.amount) };
    }
    if (n.type === "target") return { ...n, effects: walk(n.effects) };
    if (n.type === "attack") return { ...n, onHit: walk(n.onHit), onMiss: n.onMiss && walk(n.onMiss) };
    if (n.type === "save") {
      // onFail/onSuccess damage nodes for a save-for-half effect share one rolled value across every target hit by the same cast (a Fireball's
      // sharedRolls cache keys on the exact amount string) — bumping only onFail's string would split that into two independent rolls (one pool
      // for failed saves, a different one for halved successes). Keeping both strings identical preserves the shared roll.
      const failIdx = n.onFail.findIndex(matches);
      if (!applied && failIdx !== -1) {
        applied = true;
        const original = n.onFail[failIdx] as Rolled;
        const amount = withBonus(original.amount);
        const onFail = n.onFail.map((x, i) => (i === failIdx ? { ...original, amount } : x));
        const onSuccess = n.onSuccess?.map((x) => (matches(x) && sameRoll(x, original) ? { ...x, amount } : x));
        return { ...n, onFail, onSuccess };
      }
      return { ...n, onFail: walk(n.onFail), onSuccess: n.onSuccess && walk(n.onSuccess) };
    }
    if (n.type === "branch") return { ...n, then: walk(n.then), else: n.else && walk(n.else) };
    return n;
  });
  return { nodes: walk(nodes), applied };
}

/** puts `extra` right after the first damage node reachable from `nodes` (in the same list, so it runs for the same target) — optionally
 *  restricted to one or several `damageType`s (Thunderous Strike: only after lightning damage, not every damage node a spell might deal) */
export function injectAfterFirstDamage(nodes: AutomationNode[], extra: AutomationNode[], damageType?: string | string[]): { nodes: AutomationNode[]; applied: boolean } {
  const types = damageType === undefined ? undefined : Array.isArray(damageType) ? damageType : [damageType];
  let applied = false;
  const walk = (list: AutomationNode[]): AutomationNode[] => {
    const out: AutomationNode[] = [];
    for (const n of list) {
      if (applied) { out.push(n); continue; }
      if (n.type === "damage" && (!types || types.includes(n.damageType))) { applied = true; out.push(n, ...extra); continue; }
      if (n.type === "target") out.push({ ...n, effects: walk(n.effects) });
      else if (n.type === "attack") out.push({ ...n, onHit: walk(n.onHit), onMiss: n.onMiss && walk(n.onMiss) });
      else if (n.type === "save") out.push({ ...n, onFail: walk(n.onFail), onSuccess: n.onSuccess && walk(n.onSuccess) });
      else if (n.type === "branch") out.push({ ...n, then: walk(n.then), else: n.else && walk(n.else) });
      else out.push(n);
    }
    return out;
  };
  return { nodes: walk(nodes), applied };
}

/** every damage node deals its maximum: each amount becomes the constant it could at most roll (a save-for-half pair keeps matching strings, so
 *  the shared roll still holds). Overchannel. */
export function maximizeDamage(nodes: AutomationNode[]): AutomationNode[] {
  return nodes.map((n): AutomationNode => {
    if (n.type === "damage") return { ...n, amount: String(maxOfDice(n.amount)) };
    if (n.type === "target") return { ...n, effects: maximizeDamage(n.effects) };
    if (n.type === "attack") return { ...n, onHit: maximizeDamage(n.onHit), onMiss: n.onMiss && maximizeDamage(n.onMiss) };
    if (n.type === "save") return { ...n, onFail: maximizeDamage(n.onFail), onSuccess: n.onSuccess && maximizeDamage(n.onSuccess) };
    if (n.type === "branch") return { ...n, then: maximizeDamage(n.then), else: n.else && maximizeDamage(n.else) };
    return n;
  });
}

/** applies `fn` to every node in the tree (children first), keeping the tree's shape */
export function mapNodes(nodes: AutomationNode[], fn: (n: AutomationNode) => AutomationNode): AutomationNode[] {
  return nodes.map((n): AutomationNode => {
    let m: AutomationNode = n;
    if (n.type === "target") m = { ...n, effects: mapNodes(n.effects, fn) };
    else if (n.type === "attack") m = { ...n, onHit: mapNodes(n.onHit, fn), onMiss: n.onMiss && mapNodes(n.onMiss, fn) };
    else if (n.type === "save") m = { ...n, onFail: mapNodes(n.onFail, fn), onSuccess: n.onSuccess && mapNodes(n.onSuccess, fn) };
    else if (n.type === "branch") m = { ...n, then: mapNodes(n.then, fn), else: n.else && mapNodes(n.else, fn) };
    return fn(m);
  });
}

/** Potent Cantrip (Evocation): a creature that succeeds on its saving throw against a cantrip still takes half the cantrip's damage */
export function potentCantrip(nodes: AutomationNode[]): AutomationNode[] {
  return mapNodes(nodes, (n) => {
    if (n.type !== "save" || n.onSuccess?.length) return n;
    const dmg = n.onFail.filter((x): x is Extract<AutomationNode, { type: "damage" }> => x.type === "damage");
    if (!dmg.length) return n;
    return { ...n, onSuccess: dmg.map((d) => ({ ...d, half: true })) };
  });
}

/** puts `extra` right after the first heal node reachable from `nodes` (in the same list, so it runs for the same healer) */
export function injectAfterFirstHeal(nodes: AutomationNode[], extra: AutomationNode[]): { nodes: AutomationNode[]; applied: boolean } {
  let applied = false;
  const walk = (list: AutomationNode[]): AutomationNode[] => {
    const out: AutomationNode[] = [];
    for (const n of list) {
      if (applied) { out.push(n); continue; }
      if (n.type === "heal") { applied = true; out.push(n, ...extra); continue; }
      if (n.type === "target") out.push({ ...n, effects: walk(n.effects) });
      else if (n.type === "branch") out.push({ ...n, then: walk(n.then), else: n.else && walk(n.else) });
      else out.push(n);
    }
    return out;
  };
  return { nodes: walk(nodes), applied };
}

/** like `maximizeDamage`, but only the damage nodes of the given types (Destructive Wrath: "when you roll lightning or thunder damage") */
export function maximizeDamageOfTypes(nodes: AutomationNode[], types: string[]): AutomationNode[] {
  return nodes.map((n): AutomationNode => {
    if (n.type === "damage") return types.includes(n.damageType) ? { ...n, amount: String(maxOfDice(n.amount)) } : n;
    if (n.type === "target") return { ...n, effects: maximizeDamageOfTypes(n.effects, types) };
    if (n.type === "attack") return { ...n, onHit: maximizeDamageOfTypes(n.onHit, types), onMiss: n.onMiss && maximizeDamageOfTypes(n.onMiss, types) };
    if (n.type === "save") return { ...n, onFail: maximizeDamageOfTypes(n.onFail, types), onSuccess: n.onSuccess && maximizeDamageOfTypes(n.onSuccess, types) };
    if (n.type === "branch") return { ...n, then: maximizeDamageOfTypes(n.then, types), else: n.else && maximizeDamageOfTypes(n.else, types) };
    return n;
  });
}
