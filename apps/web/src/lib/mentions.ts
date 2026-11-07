import type { PersonalityView } from "@sling/core";
import { type KeyboardEvent, type RefObject, useEffect, useState } from "react";

/** The `@word` being typed at the caret: where it starts, and what follows the `@`. */
export interface MentionQuery {
  start: number;
  end: number;
  text: string;
}

/**
 * The `@` token the caret is in, when it starts a word. A space is allowed,
 * so names such as "Language coach" can be typed out.
 */
export function mentionAt(value: string, caret: number): MentionQuery | null {
  const m = /(^|\s)@([^@\n]{0,40})$/.exec(value.slice(0, caret));
  if (!m) return null;
  const start = m.index + (m[1]?.length ?? 0);
  return { start, end: caret, text: m[2] ?? "" };
}

/** Personalities whose name, or a word in it, starts with what's typed. */
export function matchPersonalities(list: PersonalityView[], typed: string): PersonalityView[] {
  const q = typed.toLowerCase();
  return list.filter((p) => {
    const name = p.name.toLowerCase();
    return name.startsWith(q) || name.includes(` ${q}`);
  });
}

export interface Mention {
  /** The personality the message mentions, sent as its `personalityId`. */
  mentioned: PersonalityView | null;
  /** The list to show, empty when it's closed. */
  options: PersonalityView[];
  cursor: number;
  setCursor: (i: number) => void;
  pick: (p: PersonalityView) => void;
  /** For the composer's keys. True when the list used the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * @mentions in a composer: typing `@` at the start of a word lists the
 * other personalities, and picking one puts `@Name ` in the text. One per
 * message: picking another replaces it, and deleting its text drops it.
 */
export function useMention({
  text,
  setText,
  inputRef,
  personalities,
}: {
  text: string;
  setText: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Who can be mentioned: everyone but the chat's own personality. */
  personalities: PersonalityView[];
}): Mention {
  const [chosen, setChosen] = useState<PersonalityView | null>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [cursor, setCursor] = useState(0);
  // Escape closes the list until another `@` starts.
  const [dismissed, setDismissed] = useState<number | null>(null);

  // What's typed and where the caret is decide whether the list is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read the caret again when the text changes.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const sync = () => {
      const q =
        document.activeElement === el && el.selectionStart === el.selectionEnd
          ? mentionAt(el.value, el.selectionStart)
          : null;
      setQuery((old) =>
        old?.start === q?.start && old?.end === q?.end && old?.text === q?.text ? old : q,
      );
      if (!q) setDismissed(null);
    };
    sync();
    document.addEventListener("selectionchange", sync);
    el.addEventListener("focus", sync);
    el.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("selectionchange", sync);
      el.removeEventListener("focus", sync);
      el.removeEventListener("blur", sync);
    };
  }, [text, inputRef]);

  // Deleting the `@Name` text drops the mention.
  const mentioned = chosen && text.includes(`@${chosen.name}`) ? chosen : null;
  useEffect(() => {
    if (chosen && !mentioned) setChosen(null);
  }, [chosen, mentioned]);

  const open = query !== null && dismissed !== query.start;
  const options = open ? matchPersonalities(personalities, query.text) : [];
  const typed = query?.text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: start at the top as the filter changes.
  useEffect(() => setCursor(0), [typed]);

  // Keys can come before the effect above has caught up with the last
  // letter typed, so picking reads the token from the box itself.
  const live = (): { value: string; query: MentionQuery | null } => {
    const el = inputRef.current;
    if (!el) return { value: text, query };
    const at =
      el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    return { value: el.value, query: at ?? query };
  };

  const pick = (p: PersonalityView) => {
    const { value, query: q } = live();
    if (!q) return;
    const token = `@${p.name} `;
    let before = value.slice(0, q.start);
    let after = value.slice(q.end);
    // One mention per message: the one picked before goes.
    if (chosen && chosen.id !== p.id) {
      const old = `@${chosen.name}`;
      const drop = (s: string) => {
        const at = s.indexOf(old);
        const end = at + old.length;
        return s.slice(0, at) + s.slice(s[end] === " " ? end + 1 : end);
      };
      if (before.includes(old)) before = drop(before);
      else after = drop(after);
    }
    if (after.startsWith(" ")) after = after.slice(1);
    setText(before + token + after);
    setChosen(p);
    setQuery(null);
    const caret = before.length + token.length;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus({ preventScroll: true });
      el?.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return false;
    const q = live().query;
    if (!q || dismissed === q.start) return false;
    const found = matchPersonalities(personalities, q.text);
    if (found.length === 0) return false;
    // The cursor belongs to the list on screen; a list that's behind starts at the top.
    const at = q.text === query?.text ? Math.min(cursor, found.length - 1) : 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const by = e.key === "ArrowDown" ? 1 : -1;
      setCursor((at + by + found.length) % found.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const p = found[at];
      if (p) pick(p);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(q.start);
      return true;
    }
    return false;
  };

  return { mentioned, options, cursor, setCursor, pick, onKeyDown };
}

/**
 * Who wrote a reply, from its trace. Replies that don't say, and ones by a
 * personality that's since been deleted, show as the chat's own.
 */
export function replyAuthor<P extends { id: string }>(
  message: { trace: { personality?: { id: string } } | null },
  list: readonly PersonalityView[] | undefined,
  own: P | null | undefined,
): PersonalityView | P | null | undefined {
  const id = message.trace?.personality?.id;
  if (!id || id === own?.id) return own;
  return list?.find((p) => p.id === id) ?? own;
}
