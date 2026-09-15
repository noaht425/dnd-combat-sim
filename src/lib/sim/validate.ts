// A lightweight validator for stat-block data. It runs the zod schema first,
// then a set of cross-field / referential checks that the schema can't express.
// This is the "does this stat block hang together?" gate — run it over every
// fixture and every stat block imported from the vault.

import {
  combatantSchema,
  type Action,
  type AutomationNode,
  type Combatant,
} from "./schema";

export interface ValidationResult {
  id: string;
  name: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// --- helpers ---------------------------------------------------------------

function walk(nodes: AutomationNode[] | undefined, visit: (n: AutomationNode) => void): void {
  if (!nodes) return;
  for (const n of nodes) {
    visit(n);
    switch (n.type) {
      case "target":
        walk(n.effects, visit);
        break;
      case "attack":
        walk(n.onHit, visit);
        walk(n.onMiss, visit);
        break;
      case "save":
        walk(n.onFail, visit);
        walk(n.onSuccess, visit);
        break;
      case "branch":
        walk(n.then, visit);
        walk(n.else, visit);
        break;
      case "applyEffect":
        walk(n.tick, visit);
        break;
    }
  }
}

const DICE_RE = /^\s*-?\d*d\d+([+-]\d+)?(\s*[+-]\s*\d+d\d+)*\s*$|^\s*\d+\s*$/i;

/** Average value of a dice string like "3d10+8" or "22d6" or "10". */
export function averageOfDice(s: string): number | null {
  if (!DICE_RE.test(s)) return null;
  const cleaned = s.replace(/\s+/g, "");
  if (/^-?\d+$/.test(cleaned)) return Number(cleaned);
  let total = 0;
  const terms = cleaned.match(/[+-]?(\d*d\d+|\d+)/gi) ?? [];
  for (const t of terms) {
    const sign = t.startsWith("-") ? -1 : 1;
    const body = t.replace(/^[+-]/, "");
    const dm = body.match(/^(\d*)d(\d+)$/i);
    if (dm) {
      const count = dm[1] ? Number(dm[1]) : 1;
      const sides = Number(dm[2]);
      total += sign * count * ((sides + 1) / 2);
    } else {
      total += sign * Number(body);
    }
  }
  return total;
}

function expectedPb(cr: string | undefined): number | null {
  if (cr == null) return null;
  const n = Number(cr);
  if (Number.isNaN(n)) return null;
  if (n <= 4) return 2;
  if (n <= 8) return 3;
  if (n <= 12) return 4;
  if (n <= 16) return 5;
  if (n <= 20) return 6;
  if (n <= 24) return 7;
  if (n <= 28) return 8;
  return 9;
}

// --- the checks ----------------------------------------------------------

export function validateCombatant(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1 — schema
  const parsed = combatantSchema.safeParse(input);
  if (!parsed.success) {
    const anyInput = input as { id?: string; name?: string };
    return {
      id: anyInput.id ?? "<unknown>",
      name: anyInput.name ?? "<unknown>",
      ok: false,
      errors: parsed.error.issues.map((i) => `schema: ${i.path.join(".")} — ${i.message}`),
      warnings: [],
    };
  }
  const c: Combatant = parsed.data;

  const allActions: Action[] = [...c.actions, ...c.reactions];
  const actionIds = new Set(allActions.map((a) => a.id));

  // 2 — HP
  const hpAvg = typeof c.maxHp === "number" ? c.maxHp : averageOfDice(c.maxHp);
  if (hpAvg == null || hpAvg <= 0) errors.push(`maxHp "${String(c.maxHp)}" does not resolve to a positive number`);

  // 3 — PB vs CR
  const wantPb = c.kind === "monster" ? expectedPb(c.cr) : null;
  if (wantPb != null && wantPb !== c.pb) {
    warnings.push(`pb ${c.pb} but CR ${c.cr} expects PB ${wantPb}`);
  }
  if (c.kind === "monster" && c.cr == null) warnings.push("monster has no cr");
  if (c.kind === "pc" && c.level == null) warnings.push("pc has no level");

  // 4 — duplicate action ids
  const seen = new Set<string>();
  for (const a of allActions) {
    if (seen.has(a.id)) errors.push(`duplicate action id "${a.id}"`);
    seen.add(a.id);
  }

  // 5 — useAction targets exist
  for (const a of allActions) {
    walk(a.automation, (n) => {
      if (n.type === "useAction" && !actionIds.has(n.action)) {
        errors.push(`action "${a.id}": useAction -> unknown action "${n.action}"`);
      }
    });
  }
  for (const t of c.traits) {
    walk(t.automation, (n) => {
      if (n.type === "useAction" && !actionIds.has(n.action)) {
        errors.push(`trait "${t.id}": useAction -> unknown action "${n.action}"`);
      }
    });
    if (t.aura) {
      walk(t.aura.automation, (n) => {
        if (n.type === "useAction" && !actionIds.has(n.action)) {
          errors.push(`trait "${t.id}" aura: useAction -> unknown action "${n.action}"`);
        }
      });
    }
  }

  // 6 — resource references resolve
  const resourceNames = new Set(Object.keys(c.resources));
  const checkResource = (where: string, name: string) => {
    if (!resourceNames.has(name)) errors.push(`${where}: unknown resource "${name}"`);
  };
  for (const a of allActions) {
    if (a.limitedUse) checkResource(`action "${a.id}".limitedUse`, a.limitedUse.resource);
    walk(a.automation, (n) => {
      if (n.type === "spendResource") checkResource(`action "${a.id}"`, n.resource);
      if (n.type === "rechargeRoll") checkResource(`action "${a.id}"`, n.resource);
    });
  }
  for (const t of c.traits) {
    walk(t.automation, (n) => {
      if (n.type === "spendResource") checkResource(`trait "${t.id}"`, n.resource);
      if (n.type === "rechargeRoll") checkResource(`trait "${t.id}"`, n.resource);
    });
  }

  // 7 — legendary actions
  if (c.legendaryActions) {
    for (const opt of c.legendaryActions.options) {
      if (!actionIds.has(opt.action)) errors.push(`legendary option -> unknown action "${opt.action}"`);
      if (opt.cost > c.legendaryActions.budget) {
        warnings.push(`legendary "${opt.action}" costs ${opt.cost} > budget ${c.legendaryActions.budget}`);
      }
      const act = allActions.find((a) => a.id === opt.action);
      if (act && act.cost.legendary == null && act.cost.action == null && Object.keys(act.cost).length > 0) {
        // fine — reaction-style / lair cost
      }
    }
  }

  // 8 — lair actions
  if (c.lairActions) {
    for (const opt of c.lairActions.options) {
      if (!actionIds.has(opt.action)) errors.push(`lair option -> unknown action "${opt.action}"`);
    }
  }

  // 9 — reactions have a trigger
  for (const r of c.reactions) {
    if (!r.trigger) errors.push(`reaction "${r.id}" has no trigger`);
  }

  // 10 — recharge actions should be gated by a resource
  for (const a of c.actions) {
    if (a.recharge !== "none" && !a.limitedUse) {
      warnings.push(`action "${a.id}" has recharge ${a.recharge} but no limitedUse resource — the engine can't track its availability`);
    }
  }

  // 11 — attack / save / damage node sanity
  for (const a of allActions) {
    walk(a.automation, (n) => {
      if (n.type === "damage") {
        if (averageOfDice(n.amount) == null) errors.push(`action "${a.id}": damage amount "${n.amount}" is not dice notation`);
      }
      if (n.type === "heal" && averageOfDice(n.amount) == null) {
        errors.push(`action "${a.id}": heal amount "${n.amount}" is not dice notation`);
      }
      if (n.type === "target" && n.who.who === "area" && !(n.who.size > 0)) {
        errors.push(`action "${a.id}": area target has no positive size`);
      }
    });
  }

  // 12 — d20Replacement table completeness
  for (const rule of c.specialRules) {
    if (rule.rule === "d20Replacement") {
      for (let face = 1; face <= 20; face++) {
        const row = rule.table[String(face)];
        if (!row) errors.push(`d20Replacement: missing row for ${face}`);
        else if (row.length !== 3) errors.push(`d20Replacement: row ${face} has ${row.length} entries, expected 3`);
        else if (row.some((v) => v < 1 || v > 20)) errors.push(`d20Replacement: row ${face} has an out-of-range face`);
      }
    }
  }

  // 13 — ai.opener references
  for (const openerId of c.ai.opener) {
    if (!actionIds.has(openerId)) warnings.push(`ai.opener references unknown action "${openerId}"`);
  }

  // 14 — summon max sanity
  for (const a of allActions) {
    walk(a.automation, (n) => {
      if (n.type === "summon" && n.max != null && n.max <= 0) errors.push(`action "${a.id}": summon max must be positive`);
    });
  }
  for (const t of c.traits) {
    walk(t.automation, (n) => {
      if (n.type === "summon" && n.max != null && n.max <= 0) errors.push(`trait "${t.id}": summon max must be positive`);
    });
  }

  // 15 — legendary-menu action ids should not also be plain turn actions with an action cost
  if (c.legendaryActions) {
    for (const opt of c.legendaryActions.options) {
      const act = allActions.find((a) => a.id === opt.action);
      if (act && act.cost.action != null && act.cost.action > 0) {
        warnings.push(`legendary "${opt.action}" is also a full action (cost.action ${act.cost.action}); usually legendary options cost only legendary actions`);
      }
    }
  }

  return {
    id: c.id,
    name: c.name,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateAll(inputs: unknown[]): ValidationResult[] {
  return inputs.map(validateCombatant);
}
