"use client";

import { useEffect, useRef, useState } from "react";
import type { AwaitingInput, AwaitingReaction, BattleGrid, RosterInit } from "@/lib/sim/battle";
import type { UnitSnap } from "@/lib/sim/battle/state";
import { TERRAIN_GLYPH, type Terrain } from "@/lib/sim/battle/grid";
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
  grid?: BattleGrid;
  initiative?: RosterInit[];
  lastAoeCells?: string[];
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

// terrain type -> color; floor gets a dim center-dot rather than its raw "."
// glyph, same convention as the Vault battle map this was adapted from
const TERRAIN_COLOR: Partial<Record<Terrain, string>> = {
  wall: "var(--parchment-faint)",
  difficult: "var(--moss-bright)",
  hazard: "var(--blood-bright)",
  cover: "var(--gold-bright)",
};

// applyEffect ids that mark ground a creature is standing in, not just a buff
// on them — a unit carrying one gets a ring instead of a plain glyph, since
// the engine tracks this per-creature (who was caught), not as a standing
// zone anyone can walk into.
const GROUND_EFFECTS = new Set(["spike-growth", "spirit-guardians"]);

function BoardView({
  grid,
  roster,
  initiative,
  actorId,
  lastAoeCells,
  expanded,
  onToggle,
}: {
  grid?: BattleGrid;
  roster?: UnitSnap[];
  initiative?: RosterInit[];
  actorId?: string;
  lastAoeCells?: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!grid || !roster?.length) return null;

  const unitAt = new Map<string, UnitSnap>();
  for (const u of roster) {
    if (!u.alive) continue;
    for (let dy = 0; dy < u.fp; dy++) for (let dx = 0; dx < u.fp; dx++) unitAt.set(`${u.x + dx},${u.y + dy}`, u);
  }
  const aoeCells = new Set(lastAoeCells ?? []);

  return (
    <div className="shrink-0 px-4 py-2" style={{ borderBottom: "1px solid var(--line)", background: "var(--ink-2)" }}>
      <button onClick={onToggle} className="text-[10px] uppercase tracking-wider font-display mb-1.5" style={{ color: "var(--gold-bright)" }}>
        {expanded ? "▾" : "▸"} Board
      </button>
      {expanded && (
        <div className="overflow-x-auto">
          {initiative && initiative.length > 0 && (
            <p className="text-[10px] mb-1 truncate font-mono" style={{ color: "var(--parchment-faint)" }}>
              {initiative.map((i) => i.name).join(" › ")}
            </p>
          )}
          <div className="inline-flex font-mono leading-none select-none" style={{ fontSize: "11px" }}>
            <div className="flex flex-col text-right pr-1 tabular-nums shrink-0" style={{ color: "var(--parchment-faint)", opacity: 0.5 }}>
              {Array.from({ length: grid.height }, (_, y) => (
                <span key={y} style={{ height: "1.15em", width: "1.6ch" }}>
                  {y + 1}
                </span>
              ))}
            </div>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${grid.width}, 1.15em)` }}>
              {Array.from({ length: grid.height }, (_, y) => (
                <div key={y} className="contents">
                  {Array.from({ length: grid.width }, (_, x) => {
                    const key = `${x},${y}`;
                    const u = unitAt.get(key);
                    const t = grid.tiles[y * grid.width + x];
                    let ch = t === "floor" ? "·" : TERRAIN_GLYPH[t];
                    let color = TERRAIN_COLOR[t] ?? "var(--parchment-faint)";
                    // the AoE tint goes down first — a unit's own actor
                    // highlight still wins if the two ever overlap
                    let bg: string | undefined = aoeCells.has(key) ? "rgba(196, 60, 40, 0.32)" : undefined;
                    let strike = false;
                    let groundEffect = false;
                    if (u) {
                      ch = u.glyph;
                      color = u.side === "party" ? "var(--azure-bright)" : "var(--blood-bright)";
                      if (u.downed) {
                        color = "var(--parchment-faint)";
                        strike = true;
                      }
                      groundEffect = u.effects.some((e) => GROUND_EFFECTS.has(e));
                      if (u.id === actorId) bg = "rgba(201, 162, 39, 0.3)";
                    }
                    return (
                      <span
                        key={x}
                        className="text-center"
                        title={groundEffect ? "standing in a persistent area effect" : undefined}
                        style={{
                          height: "1.15em",
                          color,
                          background: bg,
                          textDecoration: strike ? "line-through" : groundEffect ? "underline" : undefined,
                          textDecorationColor: groundEffect ? "var(--moss-bright)" : undefined,
                          textDecorationThickness: groundEffect ? "2px" : undefined,
                        }}
                      >
                        {ch}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
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
  grid,
  initiative,
  lastAoeCells,
  done,
  onCommand,
  onReaction,
  onNewFight,
  speech,
  speakEnabled,
  onToggleSpeak,
}: Props) {
  const [input, setInput] = useState("");
  const [showBoard, setShowBoard] = useState(true);
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
      <BoardView grid={grid} roster={roster} initiative={initiative} actorId={awaiting?.unitId} lastAoeCells={lastAoeCells} expanded={showBoard} onToggle={() => setShowBoard((s) => !s)} />

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
