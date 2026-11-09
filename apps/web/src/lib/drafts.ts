import { newId } from "@sling/core";
import { useCallback, useRef, useState } from "react";

/**
 * Unsent text, one per chat, kept in this tab's session storage: it stays
 * when you switch chats or reload, and goes when the tab closes or you sign
 * out. Files added but not sent aren't kept.
 */
const PREFIX = "sling.draft.";

function read(key: string): string {
  try {
    return sessionStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, text: string) {
  try {
    if (text) sessionStorage.setItem(PREFIX + key, text);
    else sessionStorage.removeItem(PREFIX + key);
  } catch {
    // Storage can be off or full; the draft then lives only on the page.
  }
}

/** Forgets every draft, as on sign-out, so the next person on this tab doesn't see them. */
export function clearDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing stored.
  }
}

/** A composer's text, saved as a draft under `key` as it changes. */
export function useDraft(key: string): [string, (text: string) => void] {
  const [state, setState] = useState(() => ({ key, text: read(key) }));
  // Another chat in the same page: show its own draft.
  let current = state;
  if (state.key !== key) {
    current = { key, text: read(key) };
    setState(current);
  }
  const set = useCallback(
    (text: string) => {
      write(key, text);
      setState({ key, text });
    },
    [key],
  );
  return [current.text, set];
}

/**
 * The ID a message goes out with. Sending the same thing again after a
 * failure keeps the ID, so a message the server saved before its response
 * was lost isn't saved twice; anything else gets a new one.
 */
export function useSendId() {
  const last = useRef<{ id: string; what: string } | null>(null);
  return {
    take(what: string): string {
      if (last.current?.what !== what) last.current = { id: newId("snd"), what };
      return last.current.id;
    },
    /** The message went out: the next one is new. */
    done() {
      last.current = null;
    },
  };
}
