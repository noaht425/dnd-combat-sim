"use client";

// The Web Speech API isn't in TypeScript's DOM lib (non-standard), so these
// are minimal ambient types for just the surface this app touches.
interface SpeechRecognitionResultLike {
  transcript: string;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<SpeechRecognitionResultLike>>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

import { useCallback, useEffect, useRef, useState } from "react";

// iOS Safari's SpeechRecognition is present but silently does nothing when
// the page is running as an installed home-screen PWA (a documented WebKit
// limitation, not something fixable from here) — but works fine in a plain
// Safari tab. This timeout is the fallback for that "detected but dead" case:
// if nothing happens within it, give up and tell the caller, rather than
// leaving the mic UI stuck on "listening" forever.
const LISTEN_TIMEOUT_MS = 8000;

export interface SpeechInput {
  /** true if the constructor exists — doesn't guarantee it will actually work (see above) */
  supported: boolean;
  listening: boolean;
  /** starts listening once; calls onResult with the transcript, or onFail if
   *  nothing came back (denied, unsupported, or the standalone-PWA dead-API case) */
  listen: (onResult: (text: string) => void, onFail?: () => void) => void;
  stop: () => void;
}

export function useSpeechInput(): SpeechInput {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    // feature-detects window.SpeechRecognition — can't run during SSR (no
    // `window`) or as a lazy useState initializer (server/client would then
    // disagree on whether the mic button renders, and React would flag a
    // hydration mismatch), so this is a legitimate bare setState-in-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(!!(window.SpeechRecognition || window.webkitSpeechRecognition));
  }, []);

  const stop = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      // ignore — already stopped
    }
    setListening(false);
  }, []);

  const listen = useCallback((onResult: (text: string) => void, onFail?: () => void) => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      onFail?.();
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let settled = false;
    const settle = (fn?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setListening(false);
      fn?.();
    };
    const timer = setTimeout(() => {
      try {
        rec.stop();
      } catch {
        // ignore
      }
      settle(onFail);
    }, LISTEN_TIMEOUT_MS);

    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript;
      settle(() => (transcript ? onResult(transcript) : onFail?.()));
    };
    rec.onerror = () => settle(onFail);
    rec.onend = () => settle(onFail);

    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      settle(onFail);
    }
  }, []);

  return { supported, listening, listen, stop };
}

/** Reads text aloud. Must be called synchronously within a user-gesture
 *  handler (a tap) — iOS blocks speech otherwise. This app's turn-resolution
 *  is fully synchronous (no network), so calling this at the end of the same
 *  click handler that submitted the turn satisfies that. */
export function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text.trim()) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
  } catch {
    // best-effort — speech is a bonus, not a requirement
  }
}

export function stopSpeaking(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}
