// Small dependency-free fuzzy text matching used across the setup / command
// parsers: normalize, token-overlap score, "did you mean" suggestions.

export function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

/** Levenshtein edit distance, capped so a wildly-off candidate short-circuits. */
function editDistance(a: string, b: string, cap = 6): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prevDiag = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[i], dp[i - 1]);
      prevDiag = tmp;
    }
  }
  return dp[a.length];
}

/** 0..1 similarity between a candidate label and a free-text query — token
 *  overlap (each query word matched to its closest label word) blended with a
 *  whole-string edit-distance term, so both "gold drag" and "ogl dragn" hit. */
export function similarity(query: string, label: string): number {
  const q = tokens(query);
  const l = tokens(label);
  if (!q.length || !l.length) return 0;

  let overlap = 0;
  for (const qt of q) {
    let best = 0;
    for (const lt of l) {
      if (qt === lt) { best = 1; break; }
      if (lt.includes(qt) || qt.includes(lt)) best = Math.max(best, 0.8);
      const d = editDistance(qt, lt);
      const maxLen = Math.max(qt.length, lt.length);
      best = Math.max(best, maxLen ? 1 - d / maxLen : 0);
    }
    overlap += Math.max(0, best);
  }
  const tokenScore = overlap / q.length;

  const qs = normalize(query);
  const ls = normalize(label);
  const wholeD = editDistance(qs, ls, 20);
  const wholeScore = 1 - wholeD / Math.max(qs.length, ls.length, 1);

  return tokenScore * 0.7 + Math.max(0, wholeScore) * 0.3;
}

export interface Candidate<T> {
  key: string;
  label: string;
  value: T;
}

export interface MatchResult<T> {
  best?: Candidate<T>;
  bestScore: number;
  /** other close candidates, for a "did you mean" prompt when the top match isn't confident */
  runnersUp: Candidate<T>[];
}

/** Best fuzzy match for `query` among `candidates`, matched against both
 *  `.key` and `.label` (e.g. an id like "gwm-fighter" and its display name). */
export function bestMatch<T>(query: string, candidates: Candidate<T>[]): MatchResult<T> {
  const scored = candidates
    .map((c) => ({ c, score: Math.max(similarity(query, c.key.replace(/-/g, " ")), similarity(query, c.label)) }))
    .sort((a, b) => b.score - a.score);
  return {
    best: scored[0]?.c,
    bestScore: scored[0]?.score ?? 0,
    runnersUp: scored.slice(1, 4).filter((x) => x.score > 0.35).map((x) => x.c),
  };
}
