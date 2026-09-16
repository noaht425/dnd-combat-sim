"use client";

import { useMemo, useState } from "react";
import { CLASS_TEMPLATES } from "@/lib/combat/classTemplates";
import { listMonsters } from "@/lib/combat/monsters";
import { TERRAIN_PRESETS } from "@/lib/combat/terrain";
import { removeEnemy, removePartyMember, type SetupDraft } from "@/lib/combat/session";
import type { SpeechInput } from "./useSpeech";

interface Props {
  draft: SetupDraft;
  onChangeDraft: (d: SetupDraft) => void;
  /** routes free text (typed or spoken) through the same parser the picker uses under the hood */
  onCommand: (text: string) => void;
  onStart: () => void;
  speech: SpeechInput;
  feedback?: string;
}

const MONSTERS = listMonsters();

const inputCls =
  "rounded-md px-2.5 py-2 text-sm placeholder:text-[color:var(--parchment-faint)] focus:outline-none focus:ring-1";
const inputStyle: React.CSSProperties = { background: "var(--ink)", border: "1px solid var(--line)", color: "var(--parchment)" };

function MicButton({ speech, onText, className }: { speech: SpeechInput; onText: (t: string) => void; className?: string }) {
  if (!speech.supported) return null;
  return (
    <button
      type="button"
      onClick={() => speech.listen(onText)}
      aria-label="Speak"
      className={`btn-game shrink-0 rounded-full w-10 h-10 flex items-center justify-center text-sm ${speech.listening ? "animate-pulse" : ""} ${className ?? ""}`}
      style={speech.listening ? { background: "linear-gradient(180deg, var(--blood-bright), var(--blood))", borderColor: "#5c2323" } : undefined}
    >
      🎤
    </button>
  );
}

function SectionHeader({ children, tone }: { children: React.ReactNode; tone: "gold" | "azure" | "blood" }) {
  const color = tone === "azure" ? "var(--azure-bright)" : tone === "blood" ? "var(--blood-bright)" : "var(--gold-bright)";
  return (
    <h2 className="font-display text-xs font-semibold uppercase tracking-[0.15em] mb-2.5" style={{ color }}>
      {children}
    </h2>
  );
}

export default function SetupScreen({ draft, onChangeDraft, onCommand, onStart, speech, feedback }: Props) {
  const [klass, setKlass] = useState(CLASS_TEMPLATES[0].templateId);
  const [level, setLevel] = useState(5);
  const [name, setName] = useState("");
  const [monsterFilter, setMonsterFilter] = useState("");
  const [monsterId, setMonsterId] = useState(MONSTERS[0]?.id ?? "");
  const [count, setCount] = useState(1);
  const [freeText, setFreeText] = useState("");

  const filteredMonsters = useMemo(() => {
    const q = monsterFilter.trim().toLowerCase();
    const list = q ? MONSTERS.filter((m) => m.name.toLowerCase().includes(q)) : MONSTERS;
    return list.slice(0, 60);
  }, [monsterFilter]);
  const selectedMonster = filteredMonsters.find((m) => m.id === monsterId) ?? filteredMonsters[0];

  function addMember() {
    const alias = CLASS_TEMPLATES.find((c) => c.templateId === klass)!;
    const nameBit = name.trim() ? ` named ${name.trim()}` : "";
    onCommand(`${alias.subclassName} ${alias.className} level ${level}${nameBit}`);
    setName("");
  }

  function addEnemy() {
    if (!selectedMonster) return;
    onCommand(`enemies: ${count} ${selectedMonster.name}`);
  }

  function memberLabel(p: SetupDraft["party"][number]): string {
    const alias = CLASS_TEMPLATES.find((c) => c.templateId === p.template);
    return `${p.name ? `${p.name} — ` : ""}${alias ? `${alias.subclassName} ${alias.className}` : p.template} ${p.level}`;
  }

  const canStart = draft.party.length > 0 && draft.enemyEntries.length > 0;

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-5 gap-5">
      <section className="panel p-4">
        <SectionHeader tone="azure">⚜ Party</SectionHeader>
        {draft.party.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1.5">
            {draft.party.map((p, i) => (
              <li
                key={i}
                className="flex items-center justify-between rounded-lg px-3 py-2 text-sm"
                style={{ background: "var(--ink)", border: "1px solid var(--line)", color: "var(--parchment)", borderLeft: "3px solid var(--azure)" }}
              >
                <span>{memberLabel(p)}</span>
                <button onClick={() => onChangeDraft(removePartyMember(draft, i))} aria-label="Remove" className="px-2 transition-colors" style={{ color: "var(--parchment-faint)" }}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <select value={klass} onChange={(e) => setKlass(e.target.value)} className={inputCls} style={inputStyle}>
            {CLASS_TEMPLATES.map((c) => (
              <option key={c.templateId} value={c.templateId}>
                {c.subclassName} {c.className}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={20}
            value={level}
            onChange={(e) => setLevel(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className={`${inputCls} w-16`}
            style={inputStyle}
          />
          <input
            placeholder="name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${inputCls} flex-1 min-w-[7rem]`}
            style={inputStyle}
          />
          <button onClick={addMember} className="btn-game btn-gold text-sm font-medium px-3.5 py-2 rounded-md">
            Add
          </button>
        </div>
        <button onClick={() => onCommand(`standard party level ${level}`)} className="mt-2.5 text-xs underline underline-offset-2" style={{ color: "var(--azure-bright)" }}>
          or load a standard 4-person party at level {level}
        </button>
      </section>

      <section className="panel p-4">
        <SectionHeader tone="blood">☠ Enemies</SectionHeader>
        {draft.enemyNames.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1.5">
            {draft.enemyNames.map((n, i) => (
              <li
                key={i}
                className="flex items-center justify-between rounded-lg px-3 py-2 text-sm"
                style={{ background: "var(--ink)", border: "1px solid var(--line)", color: "var(--parchment)", borderLeft: "3px solid var(--blood)" }}
              >
                <span>{n}</span>
                <button onClick={() => onChangeDraft(removeEnemy(draft, i))} aria-label="Remove" className="px-2" style={{ color: "var(--parchment-faint)" }}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          placeholder="filter monsters…"
          value={monsterFilter}
          onChange={(e) => setMonsterFilter(e.target.value)}
          className={`${inputCls} w-full mb-2`}
          style={inputStyle}
        />
        <div className="flex flex-wrap gap-2 items-center">
          <select value={selectedMonster?.id ?? ""} onChange={(e) => setMonsterId(e.target.value)} className={`${inputCls} flex-1 min-w-[9rem]`} style={inputStyle}>
            {filteredMonsters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} (CR {m.cr})
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={20}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            className={`${inputCls} w-16`}
            style={inputStyle}
          />
          <button onClick={addEnemy} disabled={!selectedMonster} className="btn-game btn-blood text-sm font-medium px-3.5 py-2 rounded-md">
            Add
          </button>
        </div>
      </section>

      <section className="panel p-4">
        <SectionHeader tone="gold">⛰ Terrain</SectionHeader>
        <select
          value={draft.terrainId ?? ""}
          onChange={(e) => onCommand(e.target.value ? `terrain: ${TERRAIN_PRESETS.find((t) => t.id === e.target.value)!.name}` : "terrain: none")}
          className={`${inputCls} w-full`}
          style={inputStyle}
        >
          <option value="">Plain open room (default)</option>
          {TERRAIN_PRESETS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {draft.terrainId && (
          <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--parchment-dim)" }}>
            {TERRAIN_PRESETS.find((t) => t.id === draft.terrainId)?.blurb}
          </p>
        )}
      </section>

      <section className="panel p-4">
        <SectionHeader tone="gold">✦ Or Say / Type It</SectionHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!freeText.trim()) return;
            onCommand(freeText);
            setFreeText("");
          }}
          className="flex gap-2 items-center"
        >
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder='"draconic sorcerer level 12 vs an adult red dragon"'
            onKeyDown={(e) => {
              // explicit Enter handling — some mobile/embedded keyboards
              // don't trigger a form's native implicit submission on Enter
              if (e.key === "Enter" && freeText.trim()) {
                e.preventDefault();
                onCommand(freeText);
                setFreeText("");
              }
            }}
            className={`${inputCls} flex-1 rounded-full px-4`}
            style={inputStyle}
          />
          <MicButton speech={speech} onText={(t) => setFreeText(t)} />
          <button type="submit" className="btn-game text-sm font-medium px-4 py-2.5 rounded-full">
            Send
          </button>
        </form>
        {feedback && (
          <p className="mt-2.5 text-xs whitespace-pre-wrap leading-relaxed" style={{ color: "var(--parchment-dim)" }}>
            {feedback}
          </p>
        )}
      </section>

      <button onClick={onStart} disabled={!canStart} className="btn-game btn-gold font-display text-base tracking-wide mt-1 sticky bottom-0 rounded-lg py-3.5">
        ⚔ Start Fight ⚔
      </button>
    </div>
  );
}
