"use client";

import { useEffect, useRef, useState } from "react";
import { advance, peekFight, sendReaction, type AdvanceResult } from "@/lib/combat/orchestrator";
import { newSession, type FightSession, type FightingSession } from "@/lib/combat/session";
import SetupScreen from "./components/SetupScreen";
import BattleScreen, { type ChatLine } from "./components/BattleScreen";
import { useSpeechInput, speak } from "./components/useSpeech";

const STORAGE_KEY = "dnd-combat-sim.session.v2";
const SPEAK_KEY = "dnd-combat-sim.speak-enabled";

let idCounter = 0;
const nextId = () => idCounter++;

type LiveState = Pick<AdvanceResult, "awaiting" | "awaitingReaction" | "liveUnits" | "roster" | "grid" | "initiative" | "lastAoeCells">;

function pickLive(r: AdvanceResult): LiveState {
  return { awaiting: r.awaiting, awaitingReaction: r.awaitingReaction, liveUnits: r.liveUnits, roster: r.roster, grid: r.grid, initiative: r.initiative, lastAoeCells: r.lastAoeCells };
}

export default function Home() {
  const [session, setSession] = useState<FightSession | undefined>(undefined);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [feedback, setFeedback] = useState<string>("");
  const [live, setLive] = useState<LiveState>({});
  const [speakEnabled, setSpeakEnabled] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const speech = useSpeechInput();

  useEffect(() => {
    // one-time hydration from localStorage — can't be a lazy useState
    // initializer (SSR has no window/localStorage, and the resulting
    // server/client mismatch would trip React's hydration check).
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const restored: FightSession = JSON.parse(raw);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSession(restored);
        if (restored.phase !== "setup") setLive(pickLive(peekFight(restored)));
      }
      setSpeakEnabled(localStorage.getItem(SPEAK_KEY) === "1");
    } catch {
      // ignore — fresh state is a fine fallback
    }
  }, []);

  function persist(next: FightSession | undefined) {
    setSession(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // best-effort — Save/Load file export is the real save/resume path
    }
  }

  function applyResult(result: AdvanceResult, userText?: string) {
    persist(result.session);
    setLive(pickLive(result));
    if (result.session.phase === "setup") {
      setFeedback(result.lines.join("\n"));
      return;
    }
    setLines((prev) => [
      ...prev,
      ...(userText ? [{ id: nextId(), role: "user" as const, text: userText }] : []),
      ...result.lines.map((t) => ({ id: nextId(), role: "system" as const, text: t })),
    ]);
    if (speakEnabled && result.lines.length) speak(result.lines.join(". "));
  }

  /** The one place every typed, spoken, tapped-chip, or picker-built command goes through. */
  function runCommand(text: string) {
    if (!text.trim()) return;
    applyResult(advance(session, text), text);
  }

  function reactTo(take: boolean) {
    if (!session || session.phase === "setup" || !live.awaitingReaction) return;
    applyResult(sendReaction(session as FightingSession, live.awaitingReaction, take), take ? "(use it)" : "(skip it)");
  }

  function newFight() {
    persist(undefined);
    setLines([]);
    setFeedback("");
    setLive({});
  }

  function toggleSpeak() {
    const next = !speakEnabled;
    setSpeakEnabled(next);
    try {
      localStorage.setItem(SPEAK_KEY, next ? "1" : "0");
    } catch {
      // ignore
    }
  }

  function saveFight() {
    if (!session) return;
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fight-save-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function loadFight(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed: FightSession = JSON.parse(String(reader.result));
        persist(parsed);
        setLines([{ id: nextId(), role: "system", text: "Loaded saved fight. Say anything to continue." }]);
        setLive(parsed.phase !== "setup" ? pickLive(peekFight(parsed)) : {});
      } catch {
        setFeedback("That file didn't look like a saved fight.");
      }
    };
    reader.readAsText(file);
  }

  const draft = !session || session.phase === "setup" ? (session ?? newSession()) : undefined;
  const fighting: FightingSession | undefined = session && session.phase !== "setup" ? session : undefined;

  return (
    <div className="flex flex-col h-dvh">
      <header className="flex items-center justify-between gap-2 px-4 py-2.5 shrink-0 relative z-10" style={{ background: "linear-gradient(180deg, var(--ink-3), var(--ink-2))", borderBottom: "1px solid var(--line)", boxShadow: "0 2px 8px var(--shadow)" }}>
        <h1 className="font-display text-sm font-semibold tracking-wide flex items-center gap-1.5" style={{ color: "var(--gold-bright)" }}>
          <span aria-hidden>⚔</span> Combat Sim
        </h1>
        <div className="flex gap-1.5">
          <button onClick={saveFight} disabled={!session} className="btn-game text-[11px] px-2.5 py-1.5 rounded-md">
            Save
          </button>
          <button onClick={() => fileRef.current?.click()} className="btn-game text-[11px] px-2.5 py-1.5 rounded-md">
            Load
          </button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFight(f); e.target.value = ""; }} />
          <button onClick={newFight} className="btn-game text-[11px] px-2.5 py-1.5 rounded-md">
            New
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        {fighting ? (
          <BattleScreen
            lines={lines}
            awaiting={live.awaiting}
            awaitingReaction={live.awaitingReaction}
            liveUnitsList={live.liveUnits}
            roster={live.roster}
            grid={live.grid}
            initiative={live.initiative}
            lastAoeCells={live.lastAoeCells}
            done={fighting.phase === "done"}
            onCommand={runCommand}
            onReaction={reactTo}
            onNewFight={newFight}
            speech={speech}
            speakEnabled={speakEnabled}
            onToggleSpeak={toggleSpeak}
          />
        ) : (
          <SetupScreen draft={draft!} onChangeDraft={(d) => persist(d)} onCommand={runCommand} onStart={() => runCommand("start")} speech={speech} feedback={feedback} />
        )}
      </div>
    </div>
  );
}
