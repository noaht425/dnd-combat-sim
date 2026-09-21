// A minimal battle-mode state for unit tests: a grid, positions, and the engine's movement seam, with every d20 at 15 and every damage die at its maximum.
import { makeTemplate } from "../../lib/sim/engine/templates";
import { initCombatant, type CombatantState } from "../../lib/sim/engine/state";
import { makeRng } from "../../lib/sim/engine/rng";
import { makeGrid } from "../../lib/sim/battle/grid";
import { BattleState, boxOfUnit, deriveZones } from "../../lib/sim/battle/state";
import { feetBetweenBoxes } from "../../lib/sim/battle/geometry";
import { moveCreatureInBattle } from "../../lib/sim/battle/forced";
import type { Combatant } from "../../lib/sim/schema";

export function battle(width = 20, height = 20, faces = 15): BattleState {
  const rng = makeRng(1);
  rng.d20 = () => faces;
  rng.d20mode = () => ({ used: faces, nat: faces });
  rng.dice = (n, sides) => n * sides;
  const s: BattleState = {
    round: 1, order: [], activeIdx: 0, units: new Map(), rng, log: [], maxRounds: 10, ended: false, verbose: true, summonCounter: 0,
    grid: makeGrid(width, height), pos: new Map(), glyphs: new Map(), frames: [], recordFrames: true, frameSeq: 0, spawnedWaves: new Set(), reactionSeq: 0,
  };
  s.moveCreature = (req) => moveCreatureInBattle(s, req);
  s.distanceFt = (a, b) => feetBetweenBoxes(boxOfUnit(s, a), boxOfUnit(s, b));
  return s;
}

/** put a creature on the grid: a template (`gwm-fighter` unless another is named), overridden as needed */
export function unitAt(s: BattleState, id: string, side: "party" | "monster", x: number, y: number, over: Partial<Combatant> = {}, template = "gwm-fighter", level = 5): CombatantState {
  const base = makeTemplate(template, level);
  const u = initCombatant({ ...base, ...over }, side, `-${id}`);
  s.units.set(u.id, u);
  s.pos.set(u.id, { x, y });
  s.glyphs.set(u.id, id[0].toUpperCase());
  deriveZones(s);
  return u;
}
