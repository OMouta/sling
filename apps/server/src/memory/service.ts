import { MEMORY_TEXT_MAX, type MemoryInput, type MemoryPatch, type MemoryView } from "@sling/core";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import type { Actor } from "../http/session.ts";

/** A memory the request can't save or change, with the status to answer. */
export class MemoryInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const MemoryFields = {
  text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
  personalityId: z.string().min(1).max(100).nullable().optional(),
};
export const MemoryInputSchema = z.object(MemoryFields) satisfies z.ZodType<MemoryInput>;
export const MemoryPatchSchema = z.object(MemoryFields).partial() satisfies z.ZodType<MemoryPatch>;
export const MemoryQuery = z.object({ q: z.string().trim().max(200).optional() });

/** Whose memories: one user in one workspace. */
export type MemoryOwner = Pick<Actor, "workspaceId" | "userId">;

/** Where a memory came from. */
export type MemorySource =
  | { kind: "chat"; conversationId: string; messageId: string | null }
  | { kind: "manual" };

export interface MemoryService {
  /** The owner's memories, most recently used first, or the ones matching `q`. */
  list(owner: MemoryOwner, opts?: { q?: string }): Promise<MemoryView[]>;
  /**
   * Saves one and publishes `memory.updated`. Throws MemoryInputError for text
   * that looks like a secret, saying why, whoever asked.
   */
  create(owner: MemoryOwner, input: MemoryInput, source: MemorySource): Promise<MemoryView>;
  /** Null when there's no such memory. */
  update(owner: MemoryOwner, id: string, patch: MemoryPatch): Promise<MemoryView | null>;
  /** Deletes it for good and publishes `memory.removed`. False when there was none. */
  remove(owner: MemoryOwner, id: string): Promise<boolean>;
  /**
   * Searches what the personality can see, at most RECALL_MAX, best first,
   * and marks what it returns as used.
   */
  recall(owner: MemoryOwner, personalityId: string | null, query: string): Promise<MemoryView[]>;
  /**
   * The prompt's "What you know about the user" block: what the personality
   * can see, most recently used first, within MEMORY_PROMPT_BYTES, marked
   * as used. Empty when there's nothing to say.
   */
  promptBlock(owner: MemoryOwner, personalityId: string | null): Promise<string>;
}

/** Lasting facts about the user. Until it's built it holds nothing and saves nothing. */
export class Memories implements MemoryService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async list(): Promise<MemoryView[]> {
    return [];
  }

  async create(): Promise<MemoryView> {
    void this.#ctx;
    throw new MemoryInputError("Memory isn't available on this server yet.", 501);
  }

  async update(): Promise<MemoryView | null> {
    return null;
  }

  async remove(): Promise<boolean> {
    return false;
  }

  async recall(): Promise<MemoryView[]> {
    return [];
  }

  async promptBlock(): Promise<string> {
    return "";
  }
}
