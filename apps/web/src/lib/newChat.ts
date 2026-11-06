import type { PersonalityView } from "@sling/core";

/** Sent after "New chat" opens the composer, so it can take the focus. */
export const NEW_CHAT_EVENT = "sling:new-chat";

/**
 * What a link to the new chat screen asks for, as in
 * `/?draft=…&personality=incident`: a draft for the composer, and who to
 * talk to. Notifications and workflows link here; nothing is sent until the
 * person sends it.
 */
export interface NewChatLink {
  draft: string;
  /** An ID, a template key, or a name. Null keeps the current pick. */
  personality: string | null;
}

/** The router parses search values as JSON where it can, so `?draft=42` arrives as a number. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

export function readNewChatLink(search: Record<string, unknown>): NewChatLink | null {
  const draft = text(search.draft);
  const personality = text(search.personality)?.trim() || null;
  if (draft === null && personality === null) return null;
  return { draft: (draft ?? "").slice(0, 20_000), personality };
}

/** The personality a link names, by ID, template key, or name, else the default. */
export function linkedPersonality(
  list: PersonalityView[],
  wanted: string,
): PersonalityView | undefined {
  const w = wanted.toLowerCase();
  return (
    list.find((p) => p.id === wanted) ??
    list.find((p) => p.templateKey?.toLowerCase() === w) ??
    list.find((p) => p.name.toLowerCase() === w) ??
    list.find((p) => p.isDefault) ??
    list[0]
  );
}
