// Web Worker: runs the (synchronous, CPU-bound) simulator off the main thread
// so a 1000-trial sweep doesn't freeze the page. Driven by `runner.ts`.

/// <reference lib="webworker" />

import { runSim, runSweep, runBattleFromSetup, runDayFromSetup, type BattleDecision, type ReactionChoice, type SimSetup, type SweepDim } from "./ui";

type Req =
  | { id: number; kind: "sim"; setup: SimSetup }
  | { id: number; kind: "sweep"; setup: SimSetup; dim: SweepDim }
  | {
      id: number;
      kind: "battle";
      setup: SimSetup;
      seed?: number;
      decisions?: BattleDecision[];
      reactionChoices?: ReactionChoice[];
      reactionAuto?: string[];
    }
  | { id: number; kind: "day"; setup: SimSetup };

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  try {
    const result =
      msg.kind === "sim"
        ? runSim(msg.setup)
        : msg.kind === "sweep"
          ? runSweep(msg.setup, msg.dim)
          : msg.kind === "day"
            ? runDayFromSetup(msg.setup)
            : runBattleFromSetup(msg.setup, {
                seed: msg.seed,
                decisions: msg.decisions,
                reactionChoices: msg.reactionChoices,
                reactionAuto: msg.reactionAuto,
              });
    (self as unknown as Worker).postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
