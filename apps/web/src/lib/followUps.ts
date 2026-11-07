/** What hides the rest of a reply while it streams: its follow-ups, which show as buttons once it's done. */
const MARK = "<follow-ups";

/**
 * A reply as it streams, without its follow-ups block. A tag cut off at the
 * end is held back too, since the next piece might finish it.
 */
export function liveText(text: string): string {
  const at = text.indexOf(MARK);
  if (at !== -1) return text.slice(0, at);
  for (let i = Math.max(0, text.length - MARK.length + 1); i < text.length; i++) {
    if (text[i] === "<" && MARK.startsWith(text.slice(i))) return text.slice(0, i);
  }
  return text;
}
