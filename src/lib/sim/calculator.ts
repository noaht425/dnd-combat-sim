// Phase 1 — the "is this CR right?" attrition calculator.
//
// It does NOT play the fight out. It computes, from the fixture + a modelled
// party: how many rounds each side needs to drop the other, how much of the
// party's HP is left when the monster dies, the rough TPK risk, and where that
// lands relative to the monster's labelled CR.
//
// Treat the output as a smoke detector, not a verdict. Phase 2/3 (a real turn
// loop + Monte-Carlo variance) refine it.

import type { Combatant } from "./schema";
import { estimateDefense, partyHitRate } from "./defense";
import { estimateOffense } from "./offense";
import { genericParty, type PartyProfile } from "./party";

export interface Assessment {
  monster: string;
  labelledCr: string | undefined;
  vsParty: string;

  monsterEffectiveHp: number;
  monsterDprVsParty: number;
  partyDprVsMonster: number;
  partyTotalHp: number;
  partyHitRate: number; // fraction

  roundsForPartyToWin: number;
  roundsForMonsterToTpk: number;
  partyHpPctWhenMonsterDies: number;

  tpkRisk: "negligible" | "low" | "real" | "high" | "party loses";
  readsAs: "well below tier" | "below tier" | "on tier" | "above tier" | "well above tier";
  effectiveCr: string; // e.g. "~23-24" or "~27"

  contributors: Array<{ source: string; perRound: number; pct: number }>;
  notes: string[];
}

function crToNumber(cr: string | undefined): number | null {
  if (cr == null) return null;
  if (cr.includes("/")) {
    const [a, b] = cr.split("/").map(Number);
    return a / b;
  }
  const n = Number(cr);
  return Number.isNaN(n) ? null : n;
}

export function assess(monster: Combatant, party?: PartyProfile): Assessment {
  // default party: 4 PCs at a level that "should" face this CR
  const crN = crToNumber(monster.cr) ?? 10;
  const defaultLevel = Math.max(1, Math.min(20, Math.round(crN))); // CR N ~ level N for solo bosses
  const p = party ?? genericParty(defaultLevel, 4);

  const def = estimateDefense(monster, p);
  const off = estimateOffense(monster, p);

  // party's sustained DPR that actually lands on the monster (dprVsAC already
  // folds hit chance; estimateDefense folded resistances into effectiveHp)
  const partyDpr = p.dprVsAC(monster.ac);

  // monster's effective DPR: raw output, minus party healing/round
  const monsterDpr = Math.max(1, off.perRoundParty - p.healingPerRound);

  const roundsForPartyToWin = def.effectiveHp / Math.max(1, partyDpr);
  const roundsForMonsterToTpk = p.totalHp / monsterDpr;

  // party HP left at the moment the monster dies
  const hpLeft = 1 - roundsForPartyToWin / roundsForMonsterToTpk;
  const partyHpPctWhenMonsterDies = Math.max(0, Math.round(hpLeft * 100));

  // TPK risk from how close the two clocks are (variance swings ~1-1.5 rounds)
  let tpkRisk: Assessment["tpkRisk"];
  if (roundsForPartyToWin >= roundsForMonsterToTpk) tpkRisk = "party loses";
  else if (hpLeft > 0.55) tpkRisk = "negligible";
  else if (hpLeft > 0.35) tpkRisk = "low";
  else if (hpLeft > 0.15) tpkRisk = "real";
  else tpkRisk = "high";

  // where it reads relative to an "on-tier solo boss" (party wins in ~4-6 rounds
  // ending near ~45% HP)
  let readsAs: Assessment["readsAs"];
  const r = roundsForPartyToWin;
  if (tpkRisk === "party loses" || r > 9) readsAs = "well above tier";
  else if (r > 6 || hpLeft < 0.2) readsAs = "above tier";
  else if (r >= 3.5 && hpLeft >= 0.2 && hpLeft <= 0.68) readsAs = "on tier";
  else if (r >= 2.5) readsAs = "below tier";
  else readsAs = "well below tier";

  // translate to a CR band around the label
  const offset =
    readsAs === "well above tier" ? 2.5 :
    readsAs === "above tier" ? 1 :
    readsAs === "on tier" ? 0 :
    readsAs === "below tier" ? -1 : -2.5;
  const base = crN;
  const lo = Math.max(0, Math.round(base + offset - 0.5));
  const hi = Math.max(0, Math.round(base + offset + 0.5));
  const effectiveCr = lo === hi ? `~${lo}` : `~${lo}-${hi}`;

  const totalOut = Object.values(off.breakdown).reduce((s, x) => s + x, 0) || 1;
  const contributors = Object.entries(off.breakdown)
    .map(([source, perRound]) => ({ source, perRound: Math.round(perRound), pct: Math.round((perRound / totalOut) * 100) }))
    .sort((a, b) => b.perRound - a.perRound);

  const notes = [...def.notes, ...off.notes];
  if (def.controlResilience < 1.5 && crN >= 17) notes.push("thin against save-or-lose (low Legendary Resistance / no Magic Resistance) — one control spell may end it early");
  if (def.baseHp < def.effectiveHp * 0.6) notes.push("raw HP is low; its durability is mostly resistances / traits — swingy vs different party builds");
  const perPcHp = p.totalHp / p.size;
  const glassCannon = roundsForPartyToWin < 2.4 && off.bestSingleHit >= perPcHp * 0.55;
  if (glassCannon) notes.push(`glass cannon: dies fast but one hit (~${Math.round(off.bestSingleHit)}) can drop a PC (~${Math.round(perPcHp)} HP) before it falls`);

  // things the calculator can't score — so the effective CR is a floor/ceiling
  const allNodes = [...monster.actions, ...monster.reactions, ...monster.traits.map((t) => ({ automation: [...t.automation, ...(t.aura?.automation ?? [])] }))];
  const jsonBlob = JSON.stringify(allNodes);
  if (jsonBlob.includes('"summon"')) notes.push("summons reinforcements the calculator doesn't fight — the real encounter is harder than this");
  const controlHits = (jsonBlob.match(/"applyCondition"|"applyEffect"|"d20Replacement"/g) ?? []).length;
  if (controlHits >= 6) notes.push("control-heavy: much of its threat is lockdown the calculator under-scores — treat the effective CR as a floor");

  return {
    monster: monster.name,
    labelledCr: monster.cr,
    vsParty: p.label,
    monsterEffectiveHp: def.effectiveHp,
    monsterDprVsParty: Math.round(off.perRoundParty),
    partyDprVsMonster: Math.round(partyDpr),
    partyTotalHp: p.totalHp,
    partyHitRate: Math.round(partyHitRate(monster, p) * 100) / 100,
    roundsForPartyToWin: Math.round(r * 10) / 10,
    roundsForMonsterToTpk: Math.round(roundsForMonsterToTpk * 10) / 10,
    partyHpPctWhenMonsterDies,
    tpkRisk,
    readsAs,
    effectiveCr,
    contributors,
    notes,
  };
}

/** Pretty one-block summary for the console / a report. */
export function formatAssessment(a: Assessment): string {
  const L: string[] = [];
  L.push(`${a.monster}  (labelled CR ${a.labelledCr ?? "?"})  vs ${a.vsParty}`);
  L.push(`  monster: ~${a.monsterEffectiveHp} effective HP, ~${a.monsterDprVsParty}/round out`);
  L.push(`  party:   ${a.partyTotalHp} HP, ~${a.partyDprVsMonster}/round in (hits ${Math.round(a.partyHitRate * 100)}% of the time)`);
  L.push(`  clocks:  party wins in ~${a.roundsForPartyToWin} rounds  |  monster TPKs in ~${a.roundsForMonsterToTpk} rounds`);
  L.push(`  result:  ${a.readsAs.toUpperCase()}  (effective CR ${a.effectiveCr}) — party ends at ~${a.partyHpPctWhenMonsterDies}% HP, TPK risk: ${a.tpkRisk}`);
  if (a.contributors.length) L.push(`  damage:  ${a.contributors.slice(0, 4).map((c) => `${c.source} ${c.pct}%`).join(", ")}`);
  for (const n of a.notes) L.push(`  note:    ${n}`);
  return L.join("\n");
}
