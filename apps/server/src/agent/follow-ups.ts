import type { ModelMessage } from "ai";

const OPEN = "<follow-ups>";
const CLOSE = "</follow-ups>";
/** What hides the rest of a reply while it streams, before the tag is even closed. */
const MARK = "<follow-ups";

export const FOLLOW_UPS_MAX = 3;
export const FOLLOW_UP_MAX_CHARS = 120;

/** The fixed prompt's last rule. The chat turns the block into buttons and never shows it. */
export const FOLLOW_UPS_RULE = `Follow-ups: when there's a natural next step, end your reply with up to ${FOLLOW_UPS_MAX} short messages the user might send you next, in their voice, one per line between ${OPEN} and ${CLOSE}, as the very last thing you write. Write none for small talk, or when you just started a task.`;

/** A line as a button would send it: no list marker or quotes around it. */
function clean(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^"(.*)"$/, "$1")
    .trim();
}

/**
 * Takes the last follow-ups block out of a reply. Returns the reply without
 * it, and its lines: at most three, none empty, and none too long to be a
 * message someone would tap. A block that never closed runs to the end.
 */
export function splitFollowUps(text: string): { text: string; followUps: string[] } {
  const start = text.lastIndexOf(OPEN);
  if (start === -1) return { text, followUps: [] };
  const close = text.indexOf(CLOSE, start);
  const body = text.slice(start + OPEN.length, close === -1 ? undefined : close);
  const after = close === -1 ? "" : text.slice(close + CLOSE.length);
  const followUps = body
    .split("\n")
    .map(clean)
    .filter((l) => l && l.length <= FOLLOW_UP_MAX_CHARS)
    .slice(0, FOLLOW_UPS_MAX);
  return { text: `${text.slice(0, start).trimEnd()}${after}`.trim(), followUps };
}

/**
 * A reply as it streams, without its follow-ups. Everything from the tag
 * on is hidden, and so is a tag cut off at the end, since the next piece
 * might finish it. What's shown only ever grows as text comes in.
 */
export function liveText(text: string): string {
  const at = text.indexOf(MARK);
  if (at !== -1) return text.slice(0, at);
  for (let i = Math.max(0, text.length - MARK.length + 1); i < text.length; i++) {
    if (text[i] === "<" && MARK.startsWith(text.slice(i))) return text.slice(0, i);
  }
  return text;
}

/** A model step as stored, without the follow-ups block, so neither the chat nor a model sees it again. */
export function withoutFollowUps(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant") return message;
  if (typeof message.content === "string") {
    return { ...message, content: splitFollowUps(message.content).text };
  }
  const i = message.content.findLastIndex((p) => p.type === "text");
  const part = message.content[i];
  if (part?.type !== "text") return message;
  const content = message.content.slice();
  content[i] = { ...part, text: splitFollowUps(part.text).text };
  return { ...message, content };
}
