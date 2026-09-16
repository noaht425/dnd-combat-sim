"use client";

import { useEffect, useRef, useState } from "react";
import type { AwaitingInput, AwaitingReaction } from "@/lib/sim/battle";
import type { LiveUnit } from "@/lib/combat/targetResolver";
import type { SpeechInput } from "./useSpeech";

export interface ChatLine {
  id: number;
  role: "user" | "system";
  text: string;
}

interface Props {
  lines: ChatLine[];
  awaiting?: AwaitingInput;
  awaitingReaction?: AwaitingReaction;
  liveUnitsList?: LiveUnit[];
  done: boolean;
  onCommand: (text: string) => void;
  onReaction: (take: boolean) => void;
  onNewFight: () => void;
  speech: SpeechInput;
  speakEnabled: boolean;
  onToggleSpeak: () => void;
}

function Chip({ label, onClick, tone = "default" }: { label: string; onClick: () => void; tone?: "default" | "accent" }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium border ${
        tone === "accent"
          ? "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
          : "border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200"
      }`}
    >
      {label}
    </button>
  );
}

export default function BattleScreen({ lines, awaiting, awaitingReaction, liveUnitsList, done, onCommand, onReaction, onNewFight, speech, speakEnabled, onToggleSpeak }: Props) {
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  function send(text: string) {
    if (!text.trim()) return;
    onCommand(text);
    setInput("");
  }

  function fillMain(name: string) {
    setInput(name);
    inputRef.current?.focus();
  }
  function fillBonus(name: string) {
    setInput((prev) => (prev.trim() ? `${prev.trim()} then ${name}` : name));
    inputRef.current?.focus();
  }
  function fillTarget(name: string) {
    setInput((prev) => (prev.trim() ? `${prev.trim()} at ${name}` : `attack ${name}`));
    inputRef.current?.focus();
  }

  const enemyChips = awaiting ? liveUnitsList?.filter((u) => u.side === "monster") ?? [] : [];

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950">
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2">
        {lines.map((l) => (
          <div
            key={l.id}
            className={
              l.role === "user"
                ? "self-end max-w-[85%] rounded-2xl px-3.5 py-2 text-sm bg-indigo-600 text-white whitespace-pre-wrap"
                : "self-stretch rounded-lg px-3 py-2 text-sm font-mono leading-relaxed bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap"
            }
          >
            {l.text}
          </div>
        ))}
      </div>

      {awaitingReaction && (
        <div className="mx-4 mb-3 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-3">
          <p className="text-sm text-amber-900 dark:text-amber-200 mb-2">
            (Round {awaitingReaction.round}) {awaitingReaction.prompt}
          </p>
          <div className="flex gap-2">
            <button onClick={() => onReaction(true)} className="flex-1 rounded-full bg-amber-600 text-white text-sm font-medium py-2">
              {awaitingReaction.takeLabel}
            </button>
            <button onClick={() => onReaction(false)} className="flex-1 rounded-full border border-amber-400 text-amber-800 dark:text-amber-200 text-sm font-medium py-2">
              {awaitingReaction.declineLabel}
            </button>
          </div>
        </div>
      )}

      {!awaitingReaction && awaiting && (
        <div className="px-4 pb-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">
            {awaiting.unitName}&rsquo;s turn (round {awaiting.round}) — tap to fill in below, then Send or edit first
          </p>
          <div className="flex gap-1.5 overflow-x-auto pb-1.5 -mx-4 px-4">
            {awaiting.actions.map((a) => (
              <Chip key={a.id} label={a.name} onClick={() => fillMain(a.name)} tone="accent" />
            ))}
            {awaiting.bonusActions.map((a) => (
              <Chip key={a.id} label={`+ ${a.name}`} onClick={() => fillBonus(a.name)} />
            ))}
            <Chip label="Hold" onClick={() => onCommand("hold")} />
          </div>
          {enemyChips.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4 mt-1">
              {enemyChips.map((u) => (
                <Chip key={u.id} label={u.name} onClick={() => fillTarget(u.name)} />
              ))}
            </div>
          )}
        </div>
      )}

      {done && (
        <div className="px-4 pb-3">
          <button onClick={onNewFight} className="w-full rounded-full bg-indigo-600 text-white font-semibold py-3">
            New Fight
          </button>
        </div>
      )}

      {!done && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2 p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={onToggleSpeak}
            aria-label="Toggle spoken narration"
            className={`shrink-0 rounded-full w-9 h-9 flex items-center justify-center text-sm ${speakEnabled ? "bg-indigo-600 text-white" : "bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400"}`}
          >
            {speakEnabled ? "🔊" : "🔇"}
          </button>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Say what happens next…"
            autoComplete="off"
            autoCapitalize="off"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                send(input);
              }
            }}
            className="flex-1 min-w-0 rounded-full border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {speech.supported && (
            <button
              type="button"
              onClick={() => speech.listen((text) => send(text))}
              aria-label="Speak your move"
              className={`shrink-0 rounded-full w-9 h-9 flex items-center justify-center text-sm ${speech.listening ? "bg-red-500 text-white animate-pulse" : "bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200"}`}
            >
              🎤
            </button>
          )}
          <button type="submit" disabled={!input.trim()} className="shrink-0 rounded-full bg-indigo-600 text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40">
            Send
          </button>
        </form>
      )}
    </div>
  );
}
