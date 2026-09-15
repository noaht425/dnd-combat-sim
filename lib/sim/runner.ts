// Client-side driver for the simulator. Prefers a Web Worker (keeps the UI
// responsive during a long sweep); falls back to a synchronous run on the main
// thread if workers aren't available.

import { runSim, runSweep, runBattleFromSetup, runDayFromSetup, type BattleDecision, type BattleRun, type DayRun, type ReactionChoice, type SimResult, type SimSetup, type SweepDim, type SweepOut } from "./ui";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null | undefined; // undefined = not tried yet, null = unavailable
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error ?? "worker error"));
    };
    worker.onerror = () => {
      // a fatal worker error: fail everything in flight, then fall back to sync
      for (const [, p] of pending) p.reject(new Error("simulator worker crashed"));
      pending.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

type BattleExtra = {
  dim?: SweepDim;
  seed?: number;
  decisions?: BattleDecision[];
  reactionChoices?: ReactionChoice[];
  reactionAuto?: string[];
};

function send<T>(
  kind: "sim" | "sweep" | "battle" | "day",
  setup: SimSetup,
  extra?: BattleExtra,
): Promise<T> {
  const w = getWorker();
  if (!w) {
    // no worker — run synchronously (may block briefly)
    const sync =
      kind === "sim"
        ? runSim(setup)
        : kind === "sweep"
          ? runSweep(setup, extra!.dim!)
          : kind === "day"
            ? runDayFromSetup(setup)
            : runBattleFromSetup(setup, {
                seed: extra?.seed,
                decisions: extra?.decisions,
                reactionChoices: extra?.reactionChoices,
                reactionAuto: extra?.reactionAuto,
              });
    return Promise.resolve(sync as unknown as T);
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    const msg =
      kind === "sim"
        ? { id, kind, setup }
        : kind === "sweep"
          ? { id, kind, setup, dim: extra!.dim }
          : kind === "day"
            ? { id, kind, setup }
            : {
                id,
                kind,
                setup,
                seed: extra?.seed,
                decisions: extra?.decisions,
                reactionChoices: extra?.reactionChoices,
                reactionAuto: extra?.reactionAuto,
              };
    w.postMessage(msg);
  });
}

export function runSimAsync(setup: SimSetup): Promise<SimResult> {
  return send<SimResult>("sim", setup);
}

export function runSweepAsync(setup: SimSetup, dim: SweepDim): Promise<SweepOut> {
  return send<SweepOut>("sweep", setup, { dim });
}

export function runBattleAsync(
  setup: SimSetup,
  seed?: number,
  decisions?: BattleDecision[],
  reactionChoices?: ReactionChoice[],
  reactionAuto?: string[],
): Promise<BattleRun> {
  return send<BattleRun>("battle", setup, { seed, decisions, reactionChoices, reactionAuto });
}

export function runDayAsync(setup: SimSetup): Promise<DayRun> {
  return send<DayRun>("day", setup);
}
