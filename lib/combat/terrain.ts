// Spec §2.7 — 10 terrain presets, each with real mechanical properties
// (movement cost, cover, hazards), not just a flavor label. Built on the
// engine's existing grid/hazard system (lib/sim/battle/grid.ts) — no engine
// changes needed, this is purely preset data + a small patch-painting helper.
//
// A preset's `openingLines` feed spec §2.8's atmospheric opening scene
// (narrate.ts) — a couple of sentences that mention the terrain naturally
// rather than a bulleted readout, picked pseudo-randomly per fight (seeded,
// so a save/resume replay reads the same way twice).

import { makeGrid, type BattleGrid, type HazardSpec, type Terrain } from "../sim/battle/grid";

export interface TerrainPreset {
  id: string;
  name: string;
  /** one line for a setup-screen picker */
  blurb: string;
  hazard?: HazardSpec;
  /** paints features onto a floor-filled base grid of the given size */
  paint: (g: BattleGrid) => void;
  /** 2-3 variants; narrate.ts picks one deterministically per fight */
  openingLines: string[];
}

function rect(g: BattleGrid, x0: number, y0: number, x1: number, y1: number, t: Terrain): void {
  for (let y = Math.max(0, y0); y <= Math.min(g.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(g.width - 1, x1); x++) {
      g.tiles[y * g.width + x] = t;
    }
  }
}
function scatter(g: BattleGrid, cells: [number, number][], t: Terrain): void {
  for (const [x, y] of cells) {
    if (x >= 0 && x < g.width && y >= 0 && y < g.height) g.tiles[y * g.width + x] = t;
  }
}

export const TERRAIN_PRESETS: TerrainPreset[] = [
  {
    id: "boat-deck",
    name: "Boat Deck",
    blurb: "open planks, lashed cargo for cover, tangled rigging underfoot",
    paint: (g) => {
      rect(g, 4, 3, 6, 4, "cover");
      rect(g, g.width - 7, 3, g.width - 5, 4, "cover");
      rect(g, 4, g.height - 5, 6, g.height - 4, "cover");
      rect(g, g.width - 7, g.height - 5, g.width - 5, g.height - 4, "cover");
      rect(g, Math.floor(g.width / 2) - 3, Math.floor(g.height / 2) - 1, Math.floor(g.width / 2) + 3, Math.floor(g.height / 2) + 1, "difficult");
    },
    openingLines: [
      "The deck rolls underfoot with the swell, crates of cargo lashed down along the rails for cover.",
      "Salt spray slicks the planks; coiled rigging tangles the footing amidships.",
    ],
  },
  {
    id: "mountainside",
    name: "Mountainside",
    blurb: "loose scree slows movement, boulders for cover, a sheer drop at the edge",
    hazard: { amount: "2d6", damageType: "bludgeoning", when: "enter", save: { ability: "dex", dc: 13 } },
    paint: (g) => {
      rect(g, 0, 0, g.width - 1, 1, "hazard"); // cliff edge along the top
      rect(g, 2, 4, 5, 6, "difficult");
      rect(g, g.width - 6, 4, g.width - 3, 6, "difficult");
      scatter(g, [[6, 8], [7, 8], [g.width - 8, 9], [g.width - 7, 9], [Math.floor(g.width / 2), 7]], "cover");
    },
    openingLines: [
      "Loose scree shifts with every step; a sheer drop falls away at the ridge behind you.",
      "Wind-scoured boulders break up the slope, and the ground itself fights for footing.",
    ],
  },
  {
    id: "cavern",
    name: "Cavern",
    blurb: "stalagmites block sight, rock outcroppings for cover, a pocket of choking spores",
    hazard: { amount: "2d4", damageType: "poison", when: "start", save: { ability: "con", dc: 12 } },
    paint: (g) => {
      scatter(g, [[3, 3], [3, 4], [g.width - 4, 3], [g.width - 4, 4], [Math.floor(g.width / 2), 2]], "wall");
      rect(g, Math.floor(g.width / 2) - 1, Math.floor(g.height / 2), Math.floor(g.width / 2) + 1, Math.floor(g.height / 2) + 1, "hazard");
      scatter(g, [[5, g.height - 4], [g.width - 6, g.height - 4]], "cover");
    },
    openingLines: [
      "Stalagmites rise like teeth from the cavern floor, and a faint spore-mist clings low to one hollow.",
      "The dark presses close, broken rock underfoot and jagged pillars breaking every line of sight.",
    ],
  },
  {
    id: "burning-building",
    name: "Burning Building",
    blurb: "collapsed debris blocks the way, smoke chokes movement, open flame licks the floor",
    hazard: { amount: "3d6", damageType: "fire", when: "both", save: { ability: "dex", dc: 13 } },
    paint: (g) => {
      rect(g, 0, 0, g.width - 1, 0, "wall");
      rect(g, 0, g.height - 1, g.width - 1, g.height - 1, "wall");
      scatter(g, [[2, 2], [3, 2], [g.width - 3, g.height - 3], [g.width - 4, g.height - 3]], "wall");
      rect(g, Math.floor(g.width / 2) - 2, 3, Math.floor(g.width / 2) + 2, 5, "hazard");
      rect(g, 3, g.height - 5, g.width - 4, g.height - 4, "difficult");
    },
    openingLines: [
      "Flame has already taken the rafters; smoke pools thick enough to slow every step.",
      "Collapsed beams choke half the room, and open fire crawls across the floorboards.",
    ],
  },
  {
    id: "frozen-lake",
    name: "Frozen Lake",
    blurb: "snowdrift slows the flanks, thin ice cracks underfoot near the center",
    hazard: { amount: "2d6", damageType: "cold", when: "enter", save: { ability: "dex", dc: 13 } },
    paint: (g) => {
      rect(g, 0, 0, 3, g.height - 1, "difficult");
      rect(g, g.width - 4, 0, g.width - 1, g.height - 1, "difficult");
      rect(g, Math.floor(g.width / 2) - 3, Math.floor(g.height / 2) - 2, Math.floor(g.width / 2) + 3, Math.floor(g.height / 2) + 2, "hazard");
    },
    openingLines: [
      "Snowdrift banks the edges of the ice; nearer the center it thins to a dangerous, glassy sheen.",
      "Every footstep near the middle answers with a crack — the lake hasn't fully frozen through.",
    ],
  },
  {
    id: "graveyard",
    name: "Graveyard",
    blurb: "tombstones for cover, overgrown ground, a crumbling open grave underfoot",
    hazard: { amount: "1d6", damageType: "bludgeoning", when: "enter", save: { ability: "dex", dc: 11 } },
    paint: (g) => {
      scatter(g, [[3, 3], [5, 3], [7, 4], [g.width - 4, 3], [g.width - 6, 3], [g.width - 8, 4]], "cover");
      rect(g, 2, g.height - 5, g.width - 3, g.height - 4, "difficult");
      rect(g, Math.floor(g.width / 2), Math.floor(g.height / 2), Math.floor(g.width / 2) + 1, Math.floor(g.height / 2) + 1, "hazard");
    },
    openingLines: [
      "Leaning headstones offer what cover the dead are willing to give; the grass has gone to seed between them.",
      "One grave stands open and crumbling at its edge — an easy place to lose your footing.",
    ],
  },
  {
    id: "marketplace",
    name: "Marketplace",
    blurb: "stalls and carts for cover, a crowd-choked square slows the crossing",
    paint: (g) => {
      scatter(g, [[4, 3], [6, 3], [g.width - 5, 3], [g.width - 7, 3], [4, g.height - 4], [g.width - 5, g.height - 4]], "cover");
      rect(g, Math.floor(g.width / 2) - 3, Math.floor(g.height / 2) - 1, Math.floor(g.width / 2) + 3, Math.floor(g.height / 2) + 1, "difficult");
    },
    openingLines: [
      "Abandoned stalls and overturned carts litter the square, the crowd long since scattered.",
      "Awnings flap over empty tables; the press of a market-day crowd still clogs the middle of the square.",
    ],
  },
  {
    id: "throne-room",
    name: "Throne Room",
    blurb: "a colonnade of pillars for cover, open floor everywhere else",
    paint: (g) => {
      for (let x = 4; x < g.width - 3; x += 5) scatter(g, [[x, 3], [x, g.height - 4]], "cover");
      rect(g, 0, 0, 1, g.height - 1, "wall");
      rect(g, g.width - 2, 0, g.width - 1, g.height - 1, "wall");
    },
    openingLines: [
      "Stone pillars march down either side of the hall, the only cover on an otherwise open floor.",
      "Banners hang still in the cold air of the throne room; there's nowhere here to hide for long.",
    ],
  },
  {
    id: "sewer",
    name: "Sewer",
    blurb: "narrow stone walls, ankle-deep water, a channel of caustic runoff",
    hazard: { amount: "2d6", damageType: "acid", when: "enter", save: { ability: "dex", dc: 12 } },
    paint: (g) => {
      rect(g, 0, 0, g.width - 1, 1, "wall");
      rect(g, 0, g.height - 2, g.width - 1, g.height - 1, "wall");
      rect(g, 2, Math.floor(g.height / 2), g.width - 3, Math.floor(g.height / 2), "hazard");
      rect(g, 2, 2, g.width - 3, g.height - 3, "difficult");
    },
    openingLines: [
      "Water stands ankle-deep between narrow stone walls, and a channel of something caustic cuts down the middle.",
      "The tunnel presses in close and dripping; runoff pools where the footing is already bad.",
    ],
  },
  {
    id: "volcanic-cavern",
    name: "Volcanic Cavern",
    blurb: "rock formations for cover, ash-choked ground, open fissures of lava",
    hazard: { amount: "4d6", damageType: "fire", when: "both", save: { ability: "dex", dc: 15 } },
    paint: (g) => {
      rect(g, Math.floor(g.width / 2) - 4, 4, Math.floor(g.width / 2) - 2, g.height - 5, "hazard");
      rect(g, Math.floor(g.width / 2) + 2, 4, Math.floor(g.width / 2) + 4, g.height - 5, "hazard");
      rect(g, 2, 2, g.width - 3, g.height - 3, "difficult");
      scatter(g, [[3, 3], [g.width - 4, g.height - 4]], "wall");
    },
    openingLines: [
      "Open fissures glow molten-orange through the ash, close enough that the heat presses back.",
      "Ash blankets the uneven floor, and somewhere close the rock itself is still burning.",
    ],
  },
];

export function findTerrain(id: string): TerrainPreset | undefined {
  return TERRAIN_PRESETS.find((t) => t.id === id);
}

/** Builds a real BattleGrid for a preset, sized to the crowd (same sizing
 *  heuristic as the engine's own default room). */
export function buildTerrainGrid(preset: TerrainPreset, unitCount: number): BattleGrid {
  const width = Math.max(16, Math.min(28, 12 + unitCount * 2));
  const height = Math.max(12, Math.min(20, 8 + unitCount));
  const g = makeGrid(width, height, "floor");
  preset.paint(g);
  if (preset.hazard) g.hazard = preset.hazard;
  return g;
}

/** Deterministic pick from a preset's opening-line variants, seeded so a
 *  save/resume replay narrates the same opening twice. */
export function pickOpeningLine(preset: TerrainPreset, seed: number): string {
  const idx = Math.abs(seed) % preset.openingLines.length;
  return preset.openingLines[idx];
}
