import { it } from "vitest";
import { FIXTURES_BY_ID } from "../src/lib/sim/fixtures";
import { runCombat, summarise } from "../src/lib/sim/engine/loop";
import { buildParty, standardParty } from "../src/lib/sim/engine/scenario";
import { TEMPLATE_IDS } from "../src/lib/sim/engine/templates";

// ─────────────────────────────────────────────────────────────────────────────
// EDIT THESE, then run:  npm run narrate
// ─────────────────────────────────────────────────────────────────────────────
const MONSTER = "adult-red-dragon"; // ogre bandit-captain gladiator young-gold-dragon
                                    // adult-red-dragon tarrasque  — plus any id from a
                                    // loaded custom-monster pack (fixtures/local/)
const PARTY_LEVEL = 16;   // 1–20
const SEED = 5;           // change for a different roll of the dice

const USE_TEMPLATES = true; // false -> the abstract Phase-1 generic party

// leave null for the standard 4 (paladin / fighter / wizard / cleric), or list your own.
// templates: gwm-fighter assassin-rogue blaster-wizard life-cleric vengeance-paladin hunter-ranger
type Spec = { template: string; name?: string };
const CUSTOM_PARTY = null as Spec[] | null;
// e.g. [{ template: "gwm-fighter", name: "Bront" }, { template: "gwm-fighter", name: "Korr" },
//       { template: "blaster-wizard", name: "Cyra" }, { template: "life-cleric", name: "Dax" }]
// ─────────────────────────────────────────────────────────────────────────────

it(`narrates ${MONSTER} (L${PARTY_LEVEL}, seed ${SEED})`, () => {
  const monster = FIXTURES_BY_ID[MONSTER];
  if (!monster) throw new Error(`no fixture "${MONSTER}"`);

  const specs = CUSTOM_PARTY
    ? CUSTOM_PARTY.map((p) => ({ template: p.template, name: p.name, level: PARTY_LEVEL }))
    : standardParty(PARTY_LEVEL);
  for (const sp of specs) {
    if (!TEMPLATE_IDS.includes(sp.template)) throw new Error(`unknown template "${sp.template}" — one of ${TEMPLATE_IDS.join(", ")}`);
  }
  const party = USE_TEMPLATES ? buildParty(specs) : undefined;

  const state = runCombat([monster], { seed: SEED, level: PARTY_LEVEL, party, keepLog: true });
  const r = summarise(state, true);

  const who = party ? party.map((p) => p.name).join(", ") : `generic party L${PARTY_LEVEL}`;
  const lines: string[] = ["", `  ${monster.name}  (CR ${monster.cr})   vs   ${who}   [seed ${SEED}]`, "  " + "─".repeat(62)];
  let round = 0;
  for (const entry of r.log) {
    const m = entry.match(/^R(\d+): (.*)$/);
    if (m && Number(m[1]) !== round) { round = Number(m[1]); lines.push(`  Round ${round}`); }
    lines.push(`    ${m ? m[2] : entry}`);
  }
  lines.push("  " + "─".repeat(62));
  const mon = [...state.units.values()].find((u) => u.side === "monster")!;
  lines.push(`  RESULT: ${r.winner === "party" ? "party wins" : r.winner === "monster" ? "party wiped" : "draw"} after ${r.rounds} rounds`);
  lines.push(`  ${monster.name}: ${Math.max(0, mon.hp)}/${mon.maxHp} HP left   |   party: ${Math.round(r.partyHpPct * 100)}% HP, ${r.partySurvivors}/${specs.length} standing`);
  lines.push("");

  console.log(lines.join("\n"));
});
