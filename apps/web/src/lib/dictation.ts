import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Dictation into the composer with the browser's own speech recognition.
 * Chrome sends the audio to Google and Safari to Apple; Sling never sees it.
 * Words show in the composer as they're recognized, and nothing sends on
 * its own.
 */

interface Alternative {
  transcript: string;
}
interface ResultList {
  readonly length: number;
  [index: number]: { readonly length: number; [index: number]: Alternative; isFinal: boolean };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onaudiostart: (() => void) | null;
  onresult: ((e: { resultIndex: number; results: ResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionClass = new () => Recognition;

/** The browser's speech recognition, prefixed or not. Null where there's none. */
export function speechRecognition(): RecognitionClass | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionClass;
    webkitSpeechRecognition?: RecognitionClass;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const PROBLEMS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked.",
  "service-not-allowed": "Speech recognition is off on this device.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs a connection.",
  "language-not-supported": "Speech recognition doesn't know this language.",
};

/** What was typed, then what was said, with one space between. */
export function joinSpoken(typed: string, said: string): string {
  const words = said.trim();
  if (!words) return typed;
  if (!typed) return words;
  return /\s$/.test(typed) ? typed + words : `${typed} ${words}`;
}

export interface Dictation {
  /** False where the browser has no speech recognition, so there's no button. */
  supported: boolean;
  /** From the press until recognition ends. */
  listening: boolean;
  /** The microphone is on and words are being recognized. */
  hearing: boolean;
  error: string | null;
  start(): void;
  /** Stops listening. Words still being recognized arrive after. */
  stop(): void;
  /** Stops at once and drops anything still coming, as when the message is sent. */
  cancel(): void;
}

export function useDictation(text: string, setText: (text: string) => void): Dictation {
  const [state, setState] = useState<"idle" | "starting" | "hearing">("idle");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  // What the composer held when this round began, the first result that's
  // ours, and what we last wrote, so typing in between isn't overwritten.
  const round = useRef({ typed: "", from: 0, written: "" });
  const current = useRef(text);
  const write = useRef(setText);
  useLayoutEffect(() => {
    current.current = text;
    write.current = setText;
  });

  useEffect(() => () => rec.current?.abort(), []);

  const start = useCallback(() => {
    const Recognition = speechRecognition();
    if (!Recognition || rec.current) return;
    const r = new Recognition();
    r.lang = navigator.language;
    r.continuous = true;
    r.interimResults = true;
    round.current = { typed: current.current, from: 0, written: current.current };
    r.onaudiostart = () => setState("hearing");
    r.onresult = (e) => {
      if (rec.current !== r) return;
      const s = round.current;
      if (current.current !== s.written) {
        s.typed = current.current;
        s.from = e.resultIndex;
      }
      let said = "";
      for (let i = s.from; i < e.results.length; i++) said += e.results[i]?.[0]?.transcript ?? "";
      const next = joinSpoken(s.typed, said);
      s.written = next;
      current.current = next;
      write.current(next);
    };
    r.onerror = (e) => {
      const problem = PROBLEMS[e.error];
      if (problem) setError(problem);
    };
    r.onend = () => {
      if (rec.current !== r) return;
      rec.current = null;
      setState("idle");
    };
    rec.current = r;
    setError(null);
    setState("starting");
    try {
      r.start();
    } catch {
      rec.current = null;
      setState("idle");
    }
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);

  const cancel = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    r.abort();
    setState("idle");
  }, []);

  return {
    supported: speechRecognition() !== null,
    listening: state !== "idle",
    hearing: state === "hearing",
    error,
    start,
    stop,
    cancel,
  };
}
