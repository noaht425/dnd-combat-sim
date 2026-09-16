"use client";

import { useMemo, useState } from "react";
import { CLASS_TEMPLATES } from "@/lib/combat/classTemplates";
import { listMonsters } from "@/lib/combat/monsters";
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

function MicButton({ speech, onText, className }: { speech: SpeechInput; onText: (t: string) => void; className?: string }) {
  if (!speech.supported) return null;
  return (
    <button
      type="button"
      onClick={() => speech.listen(onText)}
      aria-label="Speak"
      className={`shrink-0 rounded-full w-9 h-9 flex items-center justify-center text-sm ${speech.listening ? "bg-red-500 text-white animate-pulse" : "bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200"} ${className ?? ""}`}
    >
      🎤
    </button>
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
    <div className="flex flex-col h-full overflow-y-auto px-4 py-4 gap-6 bg-zinc-50 dark:bg-zinc-950">
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">Party</h2>
        {draft.party.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1.5">
            {draft.party.map((p, i) => (
              <li key={i} className="flex items-center justify-between bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100">
                <span>{memberLabel(p)}</span>
                <button onClick={() => onChangeDraft(removePartyMember(draft, i))} aria-label="Remove" className="text-zinc-400 hover:text-red-500 px-2">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <select value={klass} onChange={(e) => setKlass(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm text-zinc-900 dark:text-zinc-50">
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
            className="w-16 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm text-zinc-900 dark:text-zinc-50"
          />
          <input
            placeholder="name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 min-w-[7rem] rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm text-zinc-900 dark:text-zinc-50"
          />
          <button onClick={addMember} className="rounded-md bg-indigo-600 text-white text-sm font-medium px-3 py-2">
            Add
          </button>
        </div>
        <button
          onClick={() => onCommand(`standard party level ${level}`)}
          className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 underline underline-offset-2"
        >
          or load a standard 4-person party at level {level}
        </button>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">Enemies</h2>
        {draft.enemyNames.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1.5">
            {draft.enemyNames.map((n, i) => (
              <li key={i} className="flex items-center justify-between bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100">
                <span>{n}</span>
                <button onClick={() => onChangeDraft(removeEnemy(draft, i))} aria-label="Remove" className="text-zinc-400 hover:text-red-500 px-2">
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
          className="w-full mb-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm text-zinc-900 dark:text-zinc-50"
        />
        <div className="flex flex-wrap gap-2 items-center">
          <select value={selectedMonster?.id ?? ""} onChange={(e) => setMonsterId(e.target.value)} className="flex-1 min-w-[9rem] rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm text-zinc-900 dark:text-zinc-50">
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
            className="w-16 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm text-zinc-900 dark:text-zinc-50"
          />
          <button onClick={addEnemy} disabled={!selectedMonster} className="rounded-md bg-indigo-600 text-white text-sm font-medium px-3 py-2 disabled:opacity-40">
            Add
          </button>
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">Or say/type it</h2>
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
            className="flex-1 rounded-full border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-50"
          />
          <MicButton speech={speech} onText={(t) => setFreeText(t)} />
          <button type="submit" className="rounded-full bg-zinc-800 dark:bg-zinc-700 text-white text-sm font-medium px-4 py-2.5">
            Send
          </button>
        </form>
        {feedback && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap">{feedback}</p>}
      </section>

      <button
        onClick={onStart}
        disabled={!canStart}
        className="mt-auto sticky bottom-0 rounded-full bg-indigo-600 text-white font-semibold py-3.5 disabled:opacity-40"
      >
        Start Fight
      </button>
    </div>
  );
}
