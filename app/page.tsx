"use client";

import { useEffect, useRef, useState } from "react";
import type { FightSession } from "@/lib/combat/session";

interface ChatLine {
  role: "user" | "system";
  text: string;
  id: number;
}

const STORAGE_KEY = "dnd-combat-sim.session.v1";

let idCounter = 0;
const nextId = () => idCounter++;

export default function Home() {
  const [session, setSession] = useState<FightSession | undefined>(undefined);
  const [lines, setLines] = useState<ChatLine[]>([
    { id: nextId(), role: "system", text: "Build a party — try \"draconic sorcerer level 12\" — then set enemies with \"enemies: an adult red dragon\"." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // one-time hydration from localStorage — can't run during SSR (no
    // `window`) or as a lazy useState initializer (server/client would
    // then disagree and React would flag a hydration mismatch), so this is
    // the one legitimate case for a bare setState-in-effect here.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setSession(JSON.parse(raw));
    } catch {
      // ignore — a fresh session is a fine fallback
    }
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setLines((prev) => [...prev, { id: nextId(), role: "user", text: message }]);
    setInput("");
    try {
      const res = await fetch("/api/battle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, message }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLines((prev) => [...prev, { id: nextId(), role: "system", text: `Error: ${data.error ?? "unknown"}` }]);
        return;
      }
      setSession(data.session);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data.session));
      } catch {
        // best-effort — the explicit Save button is the real save/resume path
      }
      const text: string = (data.lines as string[]).join("\n");
      if (text) setLines((prev) => [...prev, { id: nextId(), role: "system", text }]);
    } catch {
      setLines((prev) => [...prev, { id: nextId(), role: "system", text: "Couldn't reach the server — try again." }]);
    } finally {
      setBusy(false);
    }
  }

  function newFight() {
    setSession(undefined);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setLines([{ id: nextId(), role: "system", text: "New fight. Build a party to begin." }]);
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
        const parsed = JSON.parse(String(reader.result));
        setSession(parsed);
        setLines((prev) => [...prev, { id: nextId(), role: "system", text: "Loaded saved fight. Say anything to continue." }]);
      } catch {
        setLines((prev) => [...prev, { id: nextId(), role: "system", text: "That file didn't look like a saved fight." }]);
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="flex flex-col h-dvh bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">D&D Combat Sim</h1>
        <div className="flex gap-2">
          <button onClick={saveFight} disabled={!session} className="text-xs px-2.5 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 disabled:opacity-40">
            Save
          </button>
          <button onClick={() => fileRef.current?.click()} className="text-xs px-2.5 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
            Load
          </button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFight(f); e.target.value = ""; }} />
          <button onClick={newFight} className="text-xs px-2.5 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
            New
          </button>
        </div>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {lines.map((l) => (
          <div key={l.id} className={`max-w-[88%] whitespace-pre-wrap text-sm leading-relaxed rounded-2xl px-3.5 py-2.5 ${l.role === "user" ? "self-end bg-indigo-600 text-white" : "self-start bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 border border-zinc-200 dark:border-zinc-800"}`}>
            {l.text}
          </div>
        ))}
        {busy && <div className="self-start text-xs text-zinc-400 px-3.5">…</div>}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="flex gap-2 p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say what happens next…"
          autoComplete="off"
          autoCapitalize="off"
          onKeyDown={(e) => {
            // explicit Enter handling — some mobile/embedded keyboards don't
            // trigger a form's native implicit submission on Enter
            if (e.key === "Enter") { e.preventDefault(); send(input); }
          }}
          className="flex-1 rounded-full border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button type="submit" disabled={busy || !input.trim()} className="rounded-full bg-indigo-600 text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40">
          Send
        </button>
      </form>
    </div>
  );
}
