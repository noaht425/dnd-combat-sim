"use client";

import { useEffect, useRef, useState } from "react";
import type { AwaitingInput, AwaitingReaction } from "@/lib/sim/battle";
import type { UnitSnap } from "@/lib/sim/battle/state";
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
  roster?: UnitSnap[];
  done: boolean;
  onCommand: (text: string) => void;
  onReaction: (take: boolean) => void;
  onNewFight: () => void;
  speech: SpeechInput;
  speakEnabled: boolean;
  onToggleSpeak: () => void;
}

function Chip({ label, onClick, tone = "default" }: { label: string; onClick: () => void; tone?: "default" | "gold" | "blood" }) {
  const style =
    tone === "gold"
      ? { borderColor: "var(--gold-dim)", background: "linear-gradient(180deg, var(--ink-4), var(--ink-3))", color: "var(--gold-bright)" }
      : tone === "blood"
        ? { borderColor: "#5c2323", background: "linear-gradient(180deg, var(--ink-4), var(--ink-3))", color: "var(--blood-bright)" }
        : undefined;
  return (
    <button onClick={onClick} className="btn-game shrink-0 rounded-full px-3 py-1.5 text-xs font-medium" style={style}>
      {label}
    </button>
  );
}

function UnitBadge({ u, tone }: { u: UnitSnap; tone: "azure" | "blood" }) {
  const pct = u.maxHp > 0 ? Math.max(0, u.hp) / u.maxHp : 0;
  const tier = pct <= 0.25 ? "critical" : pct <= 0.5 ? "hurt" : undefined;
  const dead = !u.alive || u.hp <= 0;
  const color = tone === "azure" ? "var(--azure-bright)" : "var(--blood-bright)";
  return (
    <div className="shrink-0 flex flex-col gap-1 min-w-[76px] max-w-[100px]" style={{ opacity: dead ? 0.45 : 1 }}>
      <span className="text-[11px] truncate font-medium" style={{ color }} title={u.name}>
        {u.name}
        {dead ? " †" : ""}
      </span>
      <div className="hp-bar">
        <div className="hp-bar-fill" data-tier={tier} style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      <span className="text-[10px] tabular-nums" style={{ color: "var(--parchment-faint)" }}>
        {Math.max(0, u.hp)}/{u.maxHp}
      </span>
      {u.conditions.length > 0 && (
        <span className="text-[9px] truncate" style={{ color: "var(--gold-bright)" }} title={u.conditions.join(", ")}>
          {u.conditions.join(", ")}
        </span>
      )}
    </div>
  );
}

function RosterBar({ roster }: { roster?: UnitSnap[] }) {
  if (!roster?.length) return null;
  const party = roster.filter((u) => u.side === "party");
  const monsters = roster.filter((u) => u.side === "monster");
  return (
    <div
      className="flex gap-3 overflow-x-auto px-4 py-2.5 shrink-0"
      style={{ background: "var(--ink-2)", borderBottom: "1px solid var(--line)" }}
    >
      {party.map((u) => (
        <UnitBadge key={u.id} u={u} tone="azure" />
      ))}
      {party.length > 0 && monsters.length > 0 && <div className="w-px shrink-0 self-stretch" style={{ background: "var(--line-bright)" }} />}
      {monsters.map((u) => (
        <UnitBadge key={u.id} u={u} tone="blood" />
      ))}
    </div>
  );
}

export default function BattleScreen({
  lines,
  awaiting,
  awaitingReaction,
  liveUnitsList,
  roster,
  done,
  onCommand,
  onReaction,
  onNewFight,
  speech,
  speakEnabled,
  onToggleSpeak,
}: Props) {
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
    <div className="flex flex-col h-full">
      <RosterBar roster={roster} />

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-2">
        {lines.map((l) => (
          <div
            key={l.id}
            className={l.role === "user" ? "self-end max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap" : "panel self-stretch px-3 py-2 text-sm font-mono leading-relaxed whitespace-pre-wrap"}
            style={
              l.role === "user"
                ? { background: "linear-gradient(180deg, var(--gold-bright), var(--gold))", color: "#241a06", fontWeight: 500 }
                : { color: "var(--parchment)" }
            }
          >
            {l.text}
          </div>
        ))}
      </div>

      {awaitingReaction && (
        <div className="mx-4 mb-3 rounded-xl p-3" style={{ background: "linear-gradient(180deg, var(--ink-3), var(--ink-2))", border: "1px solid var(--gold-dim)", boxShadow: "0 0 0 1px rgba(0,0,0,0.3), 0 4px 14px var(--shadow)" }}>
          <p className="font-display text-[11px] uppercase tracking-[0.15em] mb-1" style={{ color: "var(--gold-bright)" }}>
            ⚡ Reaction — Round {awaitingReaction.round}
          </p>
          <p className="text-sm mb-2.5" style={{ color: "var(--parchment)" }}>
            {awaitingReaction.prompt}
          </p>
          <div className="flex gap-2">
            <button onClick={() => onReaction(true)} className="btn-game btn-gold flex-1 rounded-full text-sm font-medium py-2">
              {awaitingReaction.takeLabel}
            </button>
            <button onClick={() => onReaction(false)} className="btn-game flex-1 rounded-full text-sm font-medium py-2">
              {awaitingReaction.declineLabel}
            </button>
          </div>
        </div>
      )}

      {!awaitingReaction && awaiting && (
        <div className="px-4 pb-2">
          <p className="font-display text-[11px] uppercase tracking-[0.12em] mb-1.5" style={{ color: "var(--gold-bright)" }}>
            {awaiting.unitName}&rsquo;s Turn · Round {awaiting.round}
          </p>
          <div className="flex gap-1.5 overflow-x-auto pb-1.5 -mx-4 px-4">
            {awaiting.actions.map((a) => (
              <Chip key={a.id} label={a.name} onClick={() => fillMain(a.name)} tone="gold" />
            ))}
            {awaiting.bonusActions.map((a) => (
              <Chip key={a.id} label={`+ ${a.name}`} onClick={() => fillBonus(a.name)} />
            ))}
            <Chip label="Hold" onClick={() => onCommand("hold")} />
            <Chip label="↺ Undo" onClick={() => onCommand("undo")} />
          </div>
          {enemyChips.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4 mt-1">
              {enemyChips.map((u) => (
                <Chip key={u.id} label={u.name} onClick={() => fillTarget(u.name)} tone="blood" />
              ))}
            </div>
          )}
        </div>
      )}

      {done && (
        <div className="px-4 pb-4">
          <button onClick={onNewFight} className="btn-game btn-gold w-full font-display tracking-wide rounded-lg py-3">
            ⚔ New Fight ⚔
          </button>
        </div>
      )}

      {!done && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2 p-3"
          style={{ borderTop: "1px solid var(--line)", background: "var(--ink-2)", paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={onToggleSpeak}
            aria-label="Toggle spoken narration"
            className="btn-game shrink-0 rounded-full w-10 h-10 flex items-center justify-center text-sm"
            style={speakEnabled ? { background: "linear-gradient(180deg, var(--gold-bright), var(--gold))", color: "#241a06", borderColor: "var(--gold-dim)" } : undefined}
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
            className="flex-1 min-w-0 rounded-full px-4 py-2.5 text-sm focus:outline-none focus:ring-1"
            style={{ background: "var(--ink)", border: "1px solid var(--line)", color: "var(--parchment)" }}
          />
          {speech.supported && (
            <button
              type="button"
              onClick={() => speech.listen((text) => { setInput(text); inputRef.current?.focus(); })}
              aria-label="Speak your move"
              className={`btn-game shrink-0 rounded-full w-10 h-10 flex items-center justify-center text-sm ${speech.listening ? "animate-pulse" : ""}`}
              style={speech.listening ? { background: "linear-gradient(180deg, var(--blood-bright), var(--blood))", borderColor: "#5c2323" } : undefined}
            >
              🎤
            </button>
          )}
          <button type="submit" disabled={!input.trim()} className="btn-game btn-gold shrink-0 rounded-full text-sm font-medium px-4 py-2.5">
            Send
          </button>
        </form>
      )}
    </div>
  );
}
