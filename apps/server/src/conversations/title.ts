/** How long a chat's title from its first message may be. */
const TITLE_MAX = 60;

/**
 * A chat's title from its first message: the message on one line, cut at a
 * word when it's too long.
 */
export function chatTitle(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length <= TITLE_MAX) return chars.join("");
  const cut = chars.slice(0, TITLE_MAX - 1).join("");
  const space = cut.lastIndexOf(" ");
  // A first word longer than half the title is cut where it has to be.
  const words = space > TITLE_MAX / 2 ? cut.slice(0, space) : cut;
  return `${words.replace(/[\s,.;:!?-]+$/, "")}…`;
}
