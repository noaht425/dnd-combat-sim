import { expect, it } from "vitest";
import { assessAll, fullReport, summaryTable, assessVsParty } from "../src/lib/sim/report";
import { FIXTURES_BY_ID } from "../src/lib/sim/fixtures";

// Run `npx vitest run tests/sim-report.test.ts` to see the Phase 1 read on
// every bundled stat block. Not an assertion-heavy test — it exists to print
// the table.

it("prints the Phase 1 CR read for every bundled stat block", () => {
  const all = assessAll();
  console.log("\n" + summaryTable(all) + "\n\n" + "-".repeat(80) + "\n\n" + fullReport() + "\n");
  expect(all.length).toBeGreaterThanOrEqual(5);
});

it("supports the 'test PCs at level L vs monster' scenario", () => {
  // bump the party a level and see the read move
  const l13 = assessVsParty(FIXTURES_BY_ID["adult-red-dragon"], 13, 4);
  const l20 = assessVsParty(FIXTURES_BY_ID["adult-red-dragon"], 20, 4);
  // a higher-level party grinds it down faster
  expect(l20.roundsForPartyToWin).toBeLessThan(l13.roundsForPartyToWin);
  console.log(`\nAdult Red Dragon vs L13x4: ${l13.readsAs} (${l13.effectiveCr})   vs L20x4: ${l20.readsAs} (${l20.effectiveCr})\n`);
});
