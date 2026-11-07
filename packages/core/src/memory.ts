/**
 * Memory: lasting facts about the user that the assistant saves on its own or
 * the user adds, shared by every personality unless pinned to one.
 */

/** Longest memory, in characters. */
export const MEMORY_TEXT_MAX = 500;

/** Most bytes the prompt's block of memories may take. */
export const MEMORY_PROMPT_BYTES = 6 * 1024;

/** Most memories one `recall` returns. */
export const RECALL_MAX = 20;

export type MemorySourceKind = "chat" | "manual";

export interface MemoryView {
  id: string;
  text: string;
  /** The one personality that sees it. Null when every personality does. */
  personalityId: string | null;
  source: {
    /** `chat`: saved by the assistant in a chat. `manual`: added on the Memory page. */
    kind: MemorySourceKind;
    /** The chat it was saved in. Null for manual ones, and once that chat is deleted. */
    conversationId: string | null;
    conversationTitle: string | null;
    messageId: string | null;
  };
  createdAt: string;
  updatedAt: string;
  /** When a prompt last included it or `recall` last returned it. */
  lastUsedAt: string;
}

/** POST /api/memories */
export interface MemoryInput {
  text: string;
  personalityId?: string | null;
}

/** PATCH /api/memories/:id */
export type MemoryPatch = Partial<MemoryInput>;

/** What a `remember` step in a reply saved, for its "Remembered" line and Undo. */
export interface ToolStepMemory {
  id: string;
  text: string;
  /** Undone from the chat, which deletes it. */
  undone: boolean;
}
