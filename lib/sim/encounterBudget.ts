// DMG-style encounter XP budget: does this pile of monsters add up to an Easy /
// Medium / Hard / Deadly fight for a given party? Used for multi-monster
// scenarios where a single "effective CR" doesn't say much.

// XP thresholds per character (DMG p.82), Easy / Medium / Hard / Deadly.
const THRESHOLDS: Record<number, [number, number, number, number]> = {
  1: [25, 50, 75, 100], 2: [50, 100, 150, 200], 3: [75, 150, 225, 400],
  4: [125, 250, 375, 500], 5: [250, 500, 750, 1100], 6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700], 8: [450, 900, 1400, 2100], 9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800], 11: [800, 1600, 2400, 3600], 12: [1000, 2000, 3000, 4500],
  13: [1100, 2200, 3400, 5100], 14: [1250, 2500, 3800, 5700], 15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200], 17: [2000, 3900, 5900, 8800], 18: [2100, 4200, 6300, 9500],
  19: [2400, 4900, 7300, 10900], 20: [2800, 5700, 8500, 12700],
};

// CR -> XP (DMG p.274).
const CR_XP: Record<string, number> = {
  "0": 10, "1/8": 25, "0.125": 25, "1/4": 50, "0.25": 50, "1/2": 100, "0.5": 100,
  "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800, "6": 2300, "7": 2900, "8": 3900,
  "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000, "14": 11500, "15": 13000,
  "16": 15000, "17": 18000, "18": 20000, "19": 22000, "20": 25000, "21": 33000, "22": 41000,
  "23": 50000, "24": 62000, "25": 75000, "26": 90000, "27": 105000, "28": 120000,
  "29": 135000, "30": 155000,
};

/** encounter multiplier for a party of 3-5 (DMG p.82) */
function multiplier(n: number): number {
  if (n <= 1) return 1;
  if (n === 2) return 1.5;
  if (n <= 6) return 2;
  if (n <= 10) return 2.5;
  if (n <= 14) return 3;
  return 4;
}

export type EncounterRating = "trivial" | "easy" | "medium" | "hard" | "deadly" | "overwhelming";

export interface EncounterBudget {
  partyLevel: number;
  partySize: number;
  monsterCount: number;
  rawXp: number;
  adjustedXp: number;
  /** party totals for easy / medium / hard / deadly */
  thresholds: { easy: number; medium: number; hard: number; deadly: number };
  rating: EncounterRating;
  /** adjustedXp as a multiple of the party's Deadly budget */
  deadlyRatio: number;
}

export function encounterBudget(crs: string[], partyLevel: number, partySize = 4): EncounterBudget {
  const lvl = Math.max(1, Math.min(20, Math.round(partyLevel)));
  const per = THRESHOLDS[lvl];
  const thresholds = {
    easy: per[0] * partySize,
    medium: per[1] * partySize,
    hard: per[2] * partySize,
    deadly: per[3] * partySize,
  };
  const rawXp = crs.reduce((s, cr) => s + (CR_XP[String(cr).trim()] ?? 0), 0);
  const adjustedXp = Math.round(rawXp * multiplier(crs.length));

  let rating: EncounterRating = "trivial";
  if (adjustedXp >= thresholds.deadly * 2.5) rating = "overwhelming";
  else if (adjustedXp >= thresholds.deadly) rating = "deadly";
  else if (adjustedXp >= thresholds.hard) rating = "hard";
  else if (adjustedXp >= thresholds.medium) rating = "medium";
  else if (adjustedXp >= thresholds.easy) rating = "easy";

  return {
    partyLevel: lvl,
    partySize,
    monsterCount: crs.length,
    rawXp,
    adjustedXp,
    thresholds,
    rating,
    deadlyRatio: Math.round((adjustedXp / thresholds.deadly) * 100) / 100,
  };
}

export function formatEncounterBudget(b: EncounterBudget): string {
  return (
    `${b.monsterCount} monster(s), ${b.rawXp.toLocaleString()} XP raw / ${b.adjustedXp.toLocaleString()} adjusted ` +
    `vs a party of ${b.partySize} at level ${b.partyLevel} — ` +
    `**${b.rating.toUpperCase()}** (${b.deadlyRatio}× the Deadly budget of ${b.thresholds.deadly.toLocaleString()})`
  );
}
