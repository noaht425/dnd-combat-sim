// Maintenance script, not part of the app's test suite (the root
// vitest.config.mts scopes `include` to tests/**, so this needs its own
// config) — run by hand whenever the spell/monster/PC catalog changes enough
// to be worth retraining the local NLU model on:
//
//   npx vitest run --config tools/nlu/vitest.config.mts
//
// Dumps real action/unit names from the live game data into vocab.json,
// which tools/nlu/generate_data.py reads to build synthetic training
// sentences. The trained model itself (lib/combat/nluModel.ts) does NOT use
// this file — it computes entity words from the same live data directly at
// runtime, so it can never go stale; this file only feeds offline training.

import { describe, it } from "vitest";
import { writeFileSync } from "fs";
import { MONSTER_FIXTURES } from "../../lib/sim/fixtures";
import { SPELLS } from "../../lib/sim/spells/catalog";
import { TEMPLATE_IDS, makeTemplate } from "../../lib/sim/engine/templates";

describe("dump vocab for offline NLU training", () => {
  it("writes tools/nlu/vocab.json", () => {
    const monsterNames = new Set<string>();
    const monsterActionNames = new Set<string>();
    for (const m of MONSTER_FIXTURES) {
      monsterNames.add(m.name);
      for (const a of m.actions) monsterActionNames.add(a.name);
      for (const r of m.reactions ?? []) monsterActionNames.add(r.name);
    }

    const spellNames = new Set<string>();
    for (const sp of SPELLS) spellNames.add(sp.name);

    const pcActionNames = new Set<string>();
    for (const id of TEMPLATE_IDS) {
      for (const lvl of [3, 9, 15]) {
        const c = makeTemplate(id, lvl);
        for (const a of c.actions) pcActionNames.add(a.name);
        for (const r of c.reactions ?? []) pcActionNames.add(r.name);
      }
    }

    const vocab = {
      monsterNames: [...monsterNames].sort(),
      monsterActionNames: [...monsterActionNames].sort(),
      spellNames: [...spellNames].sort(),
      pcActionNames: [...pcActionNames].sort(),
    };
    writeFileSync("tools/nlu/vocab.json", JSON.stringify(vocab, null, 2));
    console.log(
      `monsters=${vocab.monsterNames.length} monsterActions=${vocab.monsterActionNames.length} spells=${vocab.spellNames.length} pcActions=${vocab.pcActionNames.length}`,
    );
  });
});
