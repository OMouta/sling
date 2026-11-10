import { useSyncExternalStore } from "react";

/**
 * A reply as it sounds read aloud: no code blocks, a link's text but not
 * its address, no citation numbers, and none of Markdown's marks.
 */
export function speakableText(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open;
      continue;
    }
    // A table's divider row says nothing; its cells read as a list.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    lines.push(
      line
        .replace(/^\s*\|(.*)\|\s*$/, "$1")
        .replace(/\s*\|\s*/g, ", ")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""),
    );
  }
  return lines
    .join("\n")
    .replace(/\s*\[\d+\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>\s]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1")
    .replace(/(?<!\w)_(?!\s)(.+?)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Longest piece spoken at once: some browsers stop a long utterance partway. */
const PIECE_CHARS = 220;

/** Splits text into pieces at sentence ends, each short enough to speak whole. */
export function speechPieces(text: string): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [];
  const pieces: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (current && current.length + s.length + 1 > PIECE_CHARS) {
      pieces.push(current);
      current = "";
    }
    if (s.length > PIECE_CHARS) {
      for (const word of s.split(" ")) {
        if (current && current.length + word.length + 1 > PIECE_CHARS) {
          pieces.push(current);
          current = "";
        }
        current = current ? `${current} ${word}` : word;
      }
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** The message being read aloud, if any. Only one at a time. */
let speaking: string | null = null;
const listeners = new Set<() => void>();

function set(id: string | null) {
  speaking = id;
  for (const l of listeners) l();
}

/** Stops whatever is being read. */
export function stopSpeaking() {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
  set(null);
}

/** Reads a reply aloud, stopping any other first. */
export function speak(id: string, markdown: string) {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
  const pieces = speechPieces(speakableText(markdown));
  if (pieces.length === 0) {
    set(null);
    return;
  }
  set(id);
  // The language the user speaks, as dictation uses; the page's own is always English.
  const lang = navigator.language || undefined;
  for (const [i, piece] of pieces.entries()) {
    const u = new SpeechSynthesisUtterance(piece);
    if (lang) u.lang = lang;
    const last = i === pieces.length - 1;
    // Cancelling for the next reply ends these too; only this reply's own end counts.
    u.onend = () => {
      if (last && speaking === id) set(null);
    };
    u.onerror = () => {
      if (speaking === id) stopSpeaking();
    };
    window.speechSynthesis.speak(u);
  }
}

/** Whether this message is being read aloud now. */
export function useSpeaking(id: string): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => speaking === id,
  );
}

/** For a reply that goes away, such as when leaving the chat: stops it if it's the one being read. */
export function stopIfSpeaking(id: string) {
  if (speaking === id) stopSpeaking();
}
