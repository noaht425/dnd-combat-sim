# Combat simulator — the data format

This folder is the **shape of the data** the simulator uses, plus the engine
that runs on it. Read this before `schema.ts`; the schema is the exact, picky
version of what's below.

> The bundled monster fixtures are a small **SRD 5.2.1** set (`fixtures/srd.ts`,
> CC-BY-4.0). Homebrew campaign stat blocks are **not** in the repo — they load
> at runtime from a git-ignored local JSON file via the simulator's "Load
> custom monsters" picker (`fixtures/local/`). Anyone running the tool imports
> their own monsters.

## The one idea

Everything in a fight — a dragon, a player character, a summoned zombie — is a
**combatant**: hit points, defenses, and **a list of things it can do**.

Each "thing it can do" is a short list of **steps**. A dragon's breath weapon
and a wizard's Fireball are written the *same way*:

```
target: everyone in a 60-foot cone
  -> they roll a Dexterity save (DC 22)
       on a fail:  take 22d6 fire
       on a success: take 22d6 fire, halved
```

In the format that's:

```jsonc
{
  "type": "target",
  "who": { "who": "area", "shape": "cone", "size": 60 },
  "effects": [
    { "type": "save", "ability": "dex", "dc": 22,
      "onFail":    [ { "type": "damage", "amount": "22d6", "damageType": "fire" } ],
      "onSuccess": [ { "type": "damage", "amount": "22d6", "damageType": "fire", "half": true } ] }
  ]
}
```

Because monsters and PCs are the same kind of thing, **adding a PC is the same
job as adding a monster** — and most of that job is copy‑paste once a few
similar abilities exist.

## What a combatant looks like

| Part | What it holds | Example |
|---|---|---|
| identity | name, `kind` (`monster`/`pc`), size, CR or level | an ancient dragon `cr: "24"`; a fighter `level: 15` |
| defense | AC, HP (a number *or* dice like `"30d20+270"`), speeds | |
| abilities | STR–CHA, proficiency bonus, which saves are proficient, a flat "bonus to every save" | a paladin-style Aura of Protection is `saveBonusAll: 5` |
| damage handling | resistances, immunities, vulnerabilities, condition immunities | a lich: immune necrotic / poison |
| **special rules** | the odd defensive tricks that change the math, not just "resist fire" | `resistNonAdvantageAttacks`, `flatDamageReduction` (−3), `legendaryResistance` (perDay 3), `uncontainable`, `undyingReturn` |
| resources | limited pools: recharge powers, X/day, spell slots, superiority dice, etc. | `breath: { max: 1, recharge: "roll:5-6" }` |
| traits | passive/triggered stuff — auras, "on being hit", "when I hit half HP" | a damaging aura; an at‑half‑HP phase trigger |
| actions | the things it does on its turn, including "Multiattack" (which just says "do claw x2, bite x1") | |
| reactions | same, but with a trigger | a wing‑buffet retaliation; a parry |
| legendary / lair actions | a budget + a menu of which actions can be spent | an adult dragon: budget 3 |
| ai | its "personality": who it targets, when it breathes, what it opens with, what it saves Legendary Resistance for | data, not code — every creature tunes these |

## The steps (the "automation" list)

A step is one of these. Steps that make a decision carry sub‑lists for each
outcome, so the tree can nest as deep as an ability needs.

| Step | Meaning |
|---|---|
| `target` | pick who the following steps apply to (`self`, `aiChoice`, `nearestEnemy`, `lowestHpEnemy`, `marked`, `chosenEnemies` up to N, or an `area` shape) |
| `attack` | roll to hit vs AC; `onHit` / `onMiss` sub‑lists; optional expanded crit range |
| `save` | force a saving throw vs a DC; `onFail` / `onSuccess` sub‑lists |
| `damage` | roll `NdX` of a type; `half` for save‑for‑half; `ignoreResistances`; `diceMultiplier` (doubled dice) |
| `heal`, `tempHp` | |
| `applyCondition` | put a standard condition on the target, with an optional "repeat the save at end of turn to shake it" |
| `applyEffect` | a named rider — an aura, a curse, ongoing damage, a stat change (AC, save bonus, can't‑heal, max‑HP loss, no reactions). Optional `tick` runs every turn. |
| `branch` | `if <formula> then [...] else [...]` — phase triggers, "if the target is frightened", HP thresholds |
| `spendResource` / `rechargeRoll` | use up / try to recharge a pool |
| `move` | pull, push, teleport to self / to the marked foe |
| `mark` | swear vengeance on / choose a foe |
| `useAction` | run another action (this is how Multiattack works) |
| `summon` | bring in N of a stat block (from the minion registry) |
| `note` | a line for the fight log |

Formulas (`branch.if`, and any DC/bonus that isn't a plain number) are short
text like `self.hp <= self.maxHp / 2`, `round >= 3`, `target.has('frightened')`,
`lastSave.passed`. The schema stores them; the engine evaluates them.

## How PCs fit

Three tiers, all landing in the **same** combatant shape:

1. **Templates** (`engine/templates.ts`). A shelf of level‑scaled class builds —
   `blaster-wizard`, `gwm-fighter`, `life-cleric`, `assassin-rogue`, … — each
   with a **level dial**. Pick four, set levels, done.
2. **Custom PC** — copy the nearest template, change a few choices.
3. **Import** — pull from the vault's own PC notes (`classToTemplate` maps a
   note's class string to the nearest template).

The engine never knows or cares which tier a combatant came from.

## Scenarios — the "bump b and c a level" part

A scenario is a tiny file:

```jsonc
{
  "name": "party vs the Adult Red Dragon",
  "party": [
    { "template": "blaster-wizard",       "name": "Ari",   "level": 15 },
    { "template": "battlemaster-fighter",  "name": "Bront", "level": 15 },
    { "template": "life-cleric",           "name": "Cora",  "level": 15 },
    { "template": "assassin-rogue",        "name": "Dax",   "level": 15 }
  ],
  "enemies": ["adult-red-dragon"],
  "trials": 10000
}
```

"Now bump B and C up a level" = change two `15`s to `16` and run again. Swap
`"adult-red-dragon"` for `"tarrasque"`, add a fifth party member, change Ari's
template — all one‑line edits.

## What's already in the repo that this builds on

- `src/lib/dice.ts` — rolls `"3d10+8"` strings; RNG is injectable (needed for
  repeatable batches); supports "reroll 1s and 2s" (Great Weapon Fighting).
- `src/lib/conditions.ts` — the canonical condition list; our ids match it.
- `src/lib/initiative.ts` — the existing lightweight combatant/encounter model;
  this schema is the richer superset.
- All three are shared with the Electron desktop app, and so is this whole
  folder (vendored byte‑for‑byte as `src/common/sim/`).

## Status

- [x] `schema.ts` — the format.
- [x] `tests/sim-schema.test.ts` — proves it parses, applies defaults, rejects junk, and that a PC uses the identical shape.
- [x] `validate.ts` — structural validator (unknown action/resource refs, HP resolves, PB vs CR, d20-table completeness, dice notation, recharge gating, …).
- [x] `fixtures/` — `srd.ts` (a small SRD 5.2.1 monster set) + `pc-fighter-15.ts`. Custom monsters load at runtime from git‑ignored local JSON. **0 errors, 0 warnings.**
- [x] **Phase 1** — the attrition calculator. `math.ts` + `party.ts` + `offense.ts` + `defense.ts` + `calculator.ts` + `report.ts`. Given a fixture and a modelled party it returns effective HP, damage/round each way, rounds-to-win each way, TPK risk, and an "effective CR" band with plain-language notes.
  - **Run it:** `npx vitest run tests/sim-report.test.ts` prints the read on every bundled fixture.
  - **Use it:** `assessVsParty(monster, level, size)` from `report.ts` — "test PCs at level 15 vs the Adult Red Dragon, now bump to 16".
- [x] **Phase 2** — the turn engine, in `engine/`. Seeded RNG, initiative, action economy, legendary + lair action timing, the ~14 conditions + custom riders, concentration, recharge rolls, DoT / aura ticks, save-ends, undying-return, and the automation-tree **interpreter** that executes nodes against live state. Plus a Monte-Carlo wrapper.
  - **`npm run narrate`** — plays one fight and prints a full turn-by-turn log (edit the constants at the top of `tests/sim-narrate.test.ts`).
  - **`npm run sim:report`** — the Phase 1 CR read for every bundled fixture.
  - **In code:** `runCombat([monster], { seed, level, keepLog: true })` for one fight; `monteCarlo([monster], { trials: 500, level })` for a distribution.
- [x] **Phase 3 (part 1)** — **PC templates + scenarios.** `engine/templates.ts` (level-scaled class builds) + `engine/scenario.ts` (`buildParty`, `runScenario`, `standardParty`). `runCombat` / `monteCarlo` take a real `party`, and damage types matter — a fire-heavy party visibly underperforms vs a fire-immune monster.
- [x] **Phase 3 (part 2a)** — **the heuristic AI.** `engine/score.ts` (expected-value scoring: `scoreAction` weighs damage + control-condition value + healing, folds in hit/save odds, immunities, finisher bonus, a 1/day-power penalty; `estimatedThreat` / `chooseFocusTarget`). Both sides **score every candidate action and take the best**; the party **gangs up on a shared focus** (`state.focusId`); the boss controls the biggest threat. **Legendary-Resistance judgement** is stakes-based — burn it on a hard lock (stun/paralyze/banish) always, on lesser control only with ≥2 left, never on a damage save. `usableWhen.enemyHasCondition` gates "execute" actions to a locked-down target. Healer no longer burns every turn re-reviving into an execute.
  - Two engine bugs fixed alongside: (1) a save-for-half effect with a rider was applying the **rider on a successful save** — now a clean save takes half damage and *none* of the condition; (2) a monster's `eachEnemy` burst hit the **whole party regardless of position** — now abstracted like `area` (front line only).
- [x] **Phase 3 (part 2b)** — **the un-modelled mechanics.**
  - **Real summons.** `engine/minions.ts` is a registry of light stat blocks (SRD Fire Elemental, Chain Devil; custom packs can register more). A `summon` node spawns `initCombatant`s onto the summoner's side and into the initiative order, respecting the node's `max`. `evalExpr` learned `self.isSinging` / `self.sangSinceLastTurn` for "sing to raise the dead"–style lair actions. `REVERTS_ON_SUMMONER_DEATH` — flagged minions wink out when their summoner dies.
  - **`minionGuard`** (special rule) — summoned minions interpose: a configurable chance that a hit on the summoner lands on a minion instead. Turns an alphastrike into the attrition fight a body-wall boss is built as.
  - **Compounding effect-mods honoured:** `acMeltOnHit` (each physical hit shaves AC, to a floor), `cannotHeal` (the healer skips those targets), `damageTakenMultiplier` (a vulnerability/"sponge" rider).
  - **`d20Replacement`** — once per round a creature may rewrite a nearby attack-roll or save with one of a few pre-seen faces, spent defensively (turn a hit into a miss).
  - **`noReactionsAfter`** — a damage type that strips the target's reactions until its next turn.
- [x] **Phase 3 (part 2c)** — **the reaction system.** `engine/reactions.ts`. Combatants spend their reaction. The engine calls in at four moments:
  - **an attack roll is about to be finalised** — the target may cast **Shield** (+5 AC) or a "the blow simply misses" defensive reaction (saved for crits / when low).
  - **damage is about to land** — **Uncanny Dodge** halves one attack. The generic party carries a single "Defensive Reaction" (halve a hit, 1/round) from level 9 up.
  - **damage has landed** — recharge and re-fire a breath the first time the creature is bloodied, a thunder-punish retaliation, a "react to 30+ from one source" buffet.
  - **a spell is cast** — a PC may **Counterspell** an enemy spell (control / big save-or-suck only).
  - `canTakeReactions` gates every one, so a "no reactions" rider actually shuts reactions off. Reactions never trigger reactions (`state.inReaction`).
- [x] **Phase 3 (part 2d)** — **opportunity attacks + monster Counterspell.**
  - **Opportunity attacks.** A `move` node gets `kind: "withdraw"` (+ optional `provokes: false`); a ranged-primary monster (`ai.keepDistance`) that's been hit in melee since its last turn **peels back to range once**, and up to two melee-zone enemies that still hold their reaction get one basic attack. Teleporters blink out and never provoke. One-time per monster — in a zoneless model, chasing a repositioned flyer is a wash.
  - **Monster Counterspell.** A monster that carries the `counterspell` resource spends it to negate a party control spell (spells are flagged `isSpell`). `mayCounterspell` fires in either direction.
- [x] **Phase 3 (part 3) — the analysis + depth pass.**
  - **What-if sweeps** (`engine/sweep.ts`, `scenarioSweep` / `levelLadder` / `rosterCheck` in `scenario.ts`). `RunOptions.tuning` carries six knobs — `monsterHpMult`, `monsterToHitDelta`, `monsterDcDelta`, `monsterDamageMult`, `partyToHitDelta`, `partyDamageMult`. `sweep(monsters, base, "monsterHpMult", [0.7…1.5])` runs a Monte-Carlo per value. The tuning instrument: *"this block at 1.0× HP wins 0.05 for the party, at 1.3× it's 0.79."*
  - **Damage attribution.** `CombatResult.contributions` (per-combatant dealt / taken / `downedRound`) and `state.firstPartyDown{Round,Id}`. `MonteCarloResult` carries `partyDamage` / `monsterDamage`, `firstDownRoundP50`, `anyDownRate`, `firstToFall`. `damageReport(result)` is the plain-text read.
  - **Endurance rider** — `maybeForcedEndurance` in `rollSave`: a creature with an `endurance` resource can, on a failed control save, add its CON and eat escalating force damage instead. Tried before Legendary Resistance, capped so the self-harm doesn't exceed the effect.
  - **Concentration** matters. `action.concentration: true`; the caster tracks `concentratingOn`; a failed CON save on damage, a stun-lock, or casting a new concentration spell calls `breakConcentration`, which strips those effects across every combatant.
- [x] **Phase 3 (part 4) — multi-monster + party depth.**
  - **Multi-monster.** `enemies` entries take a count — `"chain-devil x3"` — resolving against both `FIXTURES_BY_ID` and the minion registry, with unique ids / names. `state.monsterFocusId` mirrors the party's `focusId` so a pack concentrates fire. `encounterBudget(crs, level, size)` gives the DMG XP-budget rating (`easy`…`overwhelming`, `deadlyRatio`) for a pile of monsters.
  - **More templates** — `totem-barbarian`, `open-hand-monk` (Flurry + Stunning Strike), `draconic-sorcerer`. All parse + validate clean at levels 1 / 10 / 20.
  - **Feats & magic items** — `applyLoadout(combatant, loadout)` and a `loadout?` field on `PartyMemberSpec`: `weaponBonus`, `saveItem`, `acItem`, `resilientCon`, `toughHp`.
- [x] **Phase 3 (part 5) — the spell system.** `src/lib/sim/spells/`.
  - **Catalog** (`catalog.ts`) — the SRD 5.2.1 spell list, levels 0–9. Combat spells carry a `build(ctx)` that emits automation **as a function of the slot level** (upcasting: Fireball is `8d6 + (slot−3)d6`, Hold Monster targets `1 + (slot−5)`). Pure-utility spells are list-only.
  - **Slots** (`slots.ts`) — the four progressions: **full**, **half**, **third**, **warlock** pact magic + Mystic Arcanum. `slotResources(kind, level)` → the `resources` map.
  - **Preparation** (`prepare.ts`) — `preparedCount`, `cantripsKnown`, and `autoPrepare(class, kind, level, mod, focus)` — an opinionated pick with a per-spell-level quota so a level-20 wizard gets a *spread*, not 25 ninth-level nukes.
  - **Casting** (`cast.ts` / `caster.ts`) — `spellActions(spell, ctx)` expands a prepared spell into **one Action per reachable slot level**, each spending its `slotN`. Reaction spells go to `reactions[]`. `makeCaster(spec)` assembles the whole PC. A slot-level penalty (`lvl² · discipline`) stops the AI burning a 9th on a mook.
  - **Templates rebuilt on it** — `blaster-wizard`, `life-cleric`, `vengeance-paladin`, `hunter-ranger`, `draconic-sorcerer`, `moon-druid`, `lore-bard`, `warlock`.
- [x] **Phase 3 (part 6) — action economy + honest healing.**
  - **Action economy.** Every combatant tracks **one action, one bonus action, one reaction per turn**, reset at the start of *its own* turn.
  - **The bonus-action-spell rule (RAW).** Cast a **leveled** spell with your action *or* bonus action and the only other spell you may cast that turn is a cantrip.
  - **Heal-spell corrections.** Mass Heal is *700 HP divided* (a full party-heal); Power Word Heal is *one PC to full + shrug off stun/paralyze/charm/frighten*; **Prayer of Healing is a 10-minute cast** — removed as a combat option; Aid raises max HP (modelled as temp HP).
  - **The boss goes for the medic.** `estimatedThreat` adds a bonus for a healer, so `chooseFocusTarget` and control-scoring point the boss at the cleric.
  - **DPR-race-aware healing.** `score.ts` heal value is discounted when the enemies out-damage what a heal restores — the cleric heals to *prevent a death*, not to top off.
  - **`PARTY_FRICTION`** (`ai.ts`, 0.10) — a per-turn chance a templated PC repositions / hesitates instead of acting; the templated-party analogue of the generic party's `SOLO_BOSS_DISRUPTION` haircut.

### What the engine is and isn't

It **plays the fight out**, round by round, deterministically per seed, with both
sides running the heuristic AI (score every action, take the best; party
focus-fires; boss controls the biggest threat; stakes-based Legendary
Resistance; reactions on both sides, including a one-time opportunity attack when
a ranged boss peels out of melee). Positioning is abstract (melee / ranged
zones, no grid — so OAs only fire on that one "boss withdraws" case), and
`narrate` / `runScenario` can use either the abstract Phase-1 generic party or a
real templated one.

Because it plays disruption out for real (a chain-stun actually locks PCs out,
and a stunned PC can't react) it is **stricter than the Phase 1 average** for
control-heavy monsters.

### Phase 3 (part 7) — the 5e-accuracy pass

A full read-through of the resolution layer against the PHB. Fixed:
  - **Stabilised PC bug** — a PC that stabilised on 3 death saves was `downed = false` at 0 HP and the engine let it act. Now `stable` is its own flag: it stays unconscious until healed.
  - **Restrained** now imposes **disadvantage on the restrained creature's own attack rolls and Dexterity saves** (before it was purely "you're easier to hit"). Prone and blinded also give the affected creature disadvantage on attacks — so a restrain-heavy monster reads materially harder.
  - **Auto-crit** — a melee hit against a **paralyzed or unconscious** creature is a critical hit. Attacks against a **blinded** creature get advantage.
  - **Damage order of operations** — flat reduction is applied *before* resistance, resistance is applied at most once (no double-halving), and division rounds down.
  - **Charmed** — a charmed creature can't attack the charmer; in a solo fight that's the whole enemy side, so it loses its turn.
  - **Grapple escape** — a grappled creature rolls Athletics/Acrobatics vs the grappler's escape DC at the start of its turn.
  - **Ambush / Assassinate** (`{ rule: "ambush" }`) — an ambusher acts first on round 1 and its round-1 hits have advantage and auto-crit.
  - **No natural-20 auto-success on saving throws** (2014 RAW; attacks keep nat-20 auto-hit).
  - **Casters take Resilient (Con) / War Caster** — full-caster templates are Con-save proficient, so they hold concentration on Bless / Haste / Hold Monster.

**Known abstractions (inherent to a zoneless model — document, don't fix):** no
grid, so no cover (+2/+5 AC), no measured ranges or line of sight, opportunity
attacks only fire on the one "ranged boss peels out of melee" case, and an aura
is modelled as hitting ~half the enemies. Also not modelled: surprise-round
*party* denial (only the monster ambush side), Metamagic (one spell per turn for
everyone), multiclass casters, short rests across an adventuring day (warlock
pact slots / Action Surge are one-fight resources), Evasion / Pack Tactics / the
exact Sneak-Attack trigger, and the pure-utility spell tail (list-only).

### Phase 3 (part 8) — the Sim view

The engine has a face. In **project-vault-cloud** it's
`src/app/(app)/simulator/page.tsx` (a Next client component; nav link "Sim" in
`Shell.tsx`). In the **Electron app** it's
`src/renderer/src/components/simulator/SimulatorView.tsx` (nav button "Sim" in
`App.tsx`, `mainView === 'simulator'`), with `worker.ts` / `runner.ts` beside
it. Both are fed by one browser-safe facade — `ui.ts` in this folder — and the
engine itself is the same vendored copy, so a scenario reads identically in
either app.

  - **Enemy list.** Bosses (legendary-action blocks), then standalone monsters, then the minion pool — each CR-sorted, each with a count stepper, so `chain-devil ×3` is a click. Custom monsters loaded from local JSON join the list.
  - **Party editor.** Rows of {name, template, level}; "reset to standard 4", an all-levels stepper, add/remove (1–6). Each row has a **gear drawer** — the `applyLoadout` knobs (weapon +1/2/3, AC, saves, Resilient (Con), Tough) with a `+2 wpn · +1 AC` summary chip when collapsed.
  - **Import from PC notes.** Lists every `type: pc` note (cloud: `/api/notes?type=pc`; desktop: `window.vaultApi.searchTitles('', 'pc')`), reads each one's frontmatter, maps its class string to the nearest template (`classToTemplate`) and its level, and loads the party. A starting point to tweak, not a precise sheet import.
  - **Single fight** → the full `runSim`: Monte-Carlo verdict banner (party favoured / bloodied / in trouble / wipe), win + TPK + rounds P10–P90 + party HP on win, the `encounterBudget` rating, first-to-fall, per-combatant damage bars, and a collapsible turn-by-turn narrated log for the seed.
  - **What-if sweep** → `runSweep` across one of seven preset axes (party level, monster HP ×, monster damage ×, monster to-hit Δ, monster save-DC Δ, party to-hit Δ, party damage ×). One Monte-Carlo per point, tabulated, with the current setup's row marked "· now". Level uses `levelLadder`; the rest ride `RunOptions.tuning` via `scenarioSweep`.
  - **Off the main thread.** `worker.ts` + `runner.ts` — a module Web Worker runs `runSim` / `runSweep` so a 1000-trial × 7-point sweep doesn't freeze the page; `runner.ts` falls back to a synchronous run if the worker can't be constructed. `SimSetup` persists to `localStorage` (`fightSimSetup`) — scratch, not campaign canon, and per-device.

### What Phase 1 is and isn't

It's a **smoke detector**, not a verdict. It's the DMG-style "3-round attrition"
math, computed per stat block from a modelled *middling* party of 4 (one healer,
competent but not optimised, ~2/3 of its output eaten by a solo boss's control).
It does **not** play the fight out, position anyone, or make tactical choices.

Known blind spots (each surfaces a note in the output):
- **Control it under-scores** — hard stun-locks, charm-drag, "rewrite the die" defenses. Control-heavy blocks read ~1-2 CR *under* their label; treat those effective CRs as a floor.
- **Adds it doesn't fight** — a `summon` node's minions. Encounters with summons are harder than the number.
- **Compounding effects** — AC-melt, stacking wound riders. Modelled as their first-hit value only.
- **Party ceiling** — a strong, prepared party out-damages the model and can remove a boss with one spell; the calculator's "party of 4" is deliberately average.

The tunable constants live at the top of `party.ts` (`SOLO_BOSS_DISRUPTION`,
`EXECUTION_EFFICIENCY`) and `offense.ts` (`TACTICAL_REALISM`).
