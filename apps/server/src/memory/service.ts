import {
  MEMORY_PROMPT_BYTES,
  MEMORY_TEXT_MAX,
  type MemoryInput,
  type MemoryPatch,
  type MemoryView,
  newId,
  RECALL_MAX,
  type ReplyTrace,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import type { Actor } from "../http/session.ts";
import { memoryBlock } from "./block.ts";
import { secretReason } from "./secrets.ts";
import { undoLiveStep } from "./steps.ts";
import { searchWords } from "./words.ts";

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

/** Who changed a memory, for the audit log. The user unless the assistant did. */
export interface MemoryChange {
  by?: "user" | "agent";
  /** The chat the assistant changed it from. */
  conversationId?: string;
}

export interface MemoryService {
  /** The owner's memories, most recently used first, or the ones matching `q`. */
  list(owner: MemoryOwner, opts?: { q?: string }): Promise<MemoryView[]>;
  /**
   * Saves one and publishes `memory.updated`. Throws MemoryInputError for text
   * that looks like a secret, saying why, whoever asked.
   */
  create(owner: MemoryOwner, input: MemoryInput, source: MemorySource): Promise<MemoryView>;
  /** Null when there's no such memory. */
  update(
    owner: MemoryOwner,
    id: string,
    patch: MemoryPatch,
    change?: MemoryChange,
  ): Promise<MemoryView | null>;
  /** Deletes it for good and publishes `memory.removed`. False when there was none. */
  remove(owner: MemoryOwner, id: string, change?: MemoryChange): Promise<boolean>;
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

/** The Memory page lists at most this many. A search reaches the rest. */
const LIST_MAX = 2_000;
/** A prompt marks what it includes as used at most this often, to spare writes on every turn. */
const PROMPT_TOUCH_MS = 60 * 60_000;
/** Every line in the block is at least this long, so this many rows always fill it. */
const BLOCK_ROWS = Math.ceil(MEMORY_PROMPT_BYTES / 4);

/** One fact on one line: line breaks and runs of spaces become one space. */
export function normalizeMemory(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const m = schema.memories;

/** The columns a view needs, with the source chat's title. */
const viewColumns = {
  id: m.id,
  text: m.text,
  personalityId: m.personalityId,
  source: m.source,
  conversationId: m.conversationId,
  messageId: m.messageId,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  lastUsedAt: m.lastUsedAt,
  conversationTitle: schema.conversations.title,
};

type ViewRow = {
  id: string;
  text: string;
  personalityId: string | null;
  source: "chat" | "manual";
  conversationId: string | null;
  messageId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date;
  conversationTitle: string | null;
};

function toView(r: ViewRow): MemoryView {
  return {
    id: r.id,
    text: r.text,
    personalityId: r.personalityId,
    source: {
      kind: r.source,
      conversationId: r.conversationId,
      conversationTitle: r.conversationId ? r.conversationTitle : null,
      messageId: r.messageId,
    },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastUsedAt: r.lastUsedAt.toISOString(),
  };
}

function ownedBy(owner: MemoryOwner): SQL {
  return and(eq(m.workspaceId, owner.workspaceId), eq(m.ownerId, owner.userId)) as SQL;
}

/** Memories for every personality, and the ones pinned to this one. */
function visibleTo(personalityId: string | null): SQL {
  return personalityId
    ? (or(isNull(m.personalityId), eq(m.personalityId, personalityId)) as SQL)
    : isNull(m.personalityId);
}

/** A search ranks at most this many matches, the most recently used, so a broad one stays fast. */
const RECALL_CANDIDATES = 1_000;

/**
 * Any of the words, in their English stems or as written. A model asking
 * "vegetarian diet" should still find "Vegetarian".
 */
function anyWords(words: string[]): SQL {
  const q = words.join(" | ");
  return sql`(to_tsquery('english', ${q}) || to_tsquery('simple', ${q}))`;
}

/** Every word, each as text anywhere in the memory or as an English stem: what a filter field expects. */
function pageMatch(query: string): SQL {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const like = and(...words.map((w) => sql`${m.text} ilike ${w}`)) as SQL;
  return or(like, sql`${m.search} @@ plainto_tsquery('english', ${query.slice(0, 500)})`) as SQL;
}

/** Lasting facts about the user, in the workspace's Postgres. */
export class Memories implements MemoryService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  #select() {
    return this.#ctx.db
      .select(viewColumns)
      .from(m)
      .leftJoin(schema.conversations, eq(schema.conversations.id, m.conversationId));
  }

  async #view(id: string): Promise<MemoryView | null> {
    const [row] = await this.#select().where(eq(m.id, id));
    return row ? toView(row) : null;
  }

  async list(owner: MemoryOwner, opts: { q?: string } = {}): Promise<MemoryView[]> {
    const q = opts.q?.trim();
    const rows = await this.#select()
      .where(q ? and(ownedBy(owner), pageMatch(q)) : ownedBy(owner))
      .orderBy(desc(m.lastUsedAt), desc(m.createdAt), desc(m.id))
      .limit(LIST_MAX);
    return rows.map(toView);
  }

  /** Checks text a memory would hold, and returns it as it would be saved. */
  #checked(text: string): string {
    const clean = normalizeMemory(text);
    if (!clean) throw new MemoryInputError("A memory needs some text.");
    if (clean.length > MEMORY_TEXT_MAX) {
      throw new MemoryInputError(`A memory is at most ${MEMORY_TEXT_MAX} characters.`);
    }
    const secret = secretReason(clean);
    if (secret) throw new MemoryInputError(secret, 422);
    return clean;
  }

  async #checkPersonality(owner: MemoryOwner, personalityId: string | null | undefined) {
    if (!personalityId) return;
    const [p] = await this.#ctx.db
      .select({ id: schema.personalities.id })
      .from(schema.personalities)
      .where(
        and(
          eq(schema.personalities.id, personalityId),
          eq(schema.personalities.workspaceId, owner.workspaceId),
        ),
      );
    if (!p) throw new MemoryInputError("No such personality.");
  }

  #publish(owner: MemoryOwner, view: MemoryView) {
    this.#ctx.hub.publish(owner.workspaceId, { type: "memory.updated", memory: view });
  }

  async create(owner: MemoryOwner, input: MemoryInput, source: MemorySource): Promise<MemoryView> {
    const text = this.#checked(input.text);
    await this.#checkPersonality(owner, input.personalityId);
    const id = newId("mem");
    await this.#ctx.db.insert(m).values({
      id,
      workspaceId: owner.workspaceId,
      ownerId: owner.userId,
      text,
      personalityId: input.personalityId ?? null,
      source: source.kind,
      conversationId: source.kind === "chat" ? source.conversationId : null,
      messageId: source.kind === "chat" ? source.messageId : null,
    });
    const view = await this.#view(id);
    if (!view) throw new Error("memory vanished after insert");
    this.#publish(owner, view);
    await audit(this.#ctx, {
      workspaceId: owner.workspaceId,
      actorType: source.kind === "chat" ? "agent" : "user",
      actorId: source.kind === "chat" ? null : owner.userId,
      verb: "memory.created",
      subjectType: "memory",
      subjectId: id,
      details: source.kind === "chat" ? { conversationId: source.conversationId } : {},
    });
    return view;
  }

  async update(
    owner: MemoryOwner,
    id: string,
    patch: MemoryPatch,
    change: MemoryChange = {},
  ): Promise<MemoryView | null> {
    const set: Partial<typeof m.$inferInsert> = {};
    if (patch.text !== undefined) set.text = this.#checked(patch.text);
    if (patch.personalityId !== undefined) {
      await this.#checkPersonality(owner, patch.personalityId);
      set.personalityId = patch.personalityId;
    }
    const [row] = await this.#ctx.db
      .update(m)
      .set({ ...set, updatedAt: new Date() })
      .where(and(ownedBy(owner), eq(m.id, id)))
      .returning({ id: m.id });
    if (!row) return null;
    const view = await this.#view(id);
    if (!view) return null;
    this.#publish(owner, view);
    await audit(this.#ctx, {
      workspaceId: owner.workspaceId,
      ...this.#actor(owner, change),
      verb: "memory.updated",
      subjectType: "memory",
      subjectId: id,
      details: { fields: Object.keys(set) },
    });
    return view;
  }

  #actor(owner: MemoryOwner, change: MemoryChange) {
    return change.by === "agent"
      ? { actorType: "agent" as const, actorId: null }
      : { actorType: "user" as const, actorId: owner.userId };
  }

  async remove(owner: MemoryOwner, id: string, change: MemoryChange = {}): Promise<boolean> {
    const [row] = await this.#ctx.db
      .delete(m)
      .where(and(ownedBy(owner), eq(m.id, id)))
      .returning({ id: m.id, text: m.text, conversationId: m.conversationId });
    if (!row) return false;
    this.#ctx.hub.publish(owner.workspaceId, { type: "memory.removed", id });
    if (row.conversationId) await this.#markUndone(row.conversationId, id, row.text);
    await audit(this.#ctx, {
      workspaceId: owner.workspaceId,
      ...this.#actor(owner, change),
      verb: "memory.deleted",
      subjectType: "memory",
      subjectId: id,
      details: change.conversationId ? { conversationId: change.conversationId } : {},
    });
    return true;
  }

  /**
   * The chat's "Remembered" line for a deleted memory says so from now on:
   * in the reply being written, or in the saved reply it's on.
   */
  async #markUndone(conversationId: string, id: string, text: string) {
    if (undoLiveStep(id, text)) return;
    const rows = await this.#ctx.db
      .select({ id: schema.messages.id, trace: schema.messages.trace })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          sql`jsonb_path_exists(${schema.messages.trace}, '$.steps[*] ? (@.memory.id == $id)', jsonb_build_object('id', ${id}::text))`,
        ),
      );
    for (const r of rows) {
      if (!r.trace) continue;
      const trace: ReplyTrace = {
        ...r.trace,
        steps: r.trace.steps.map((s) =>
          s.kind === "tool" && s.memory?.id === id
            ? { ...s, memory: { ...s.memory, undone: true } }
            : s,
        ),
      };
      await this.#ctx.db.update(schema.messages).set({ trace }).where(eq(schema.messages.id, r.id));
    }
  }

  async recall(
    owner: MemoryOwner,
    personalityId: string | null,
    query: string,
  ): Promise<MemoryView[]> {
    const words = searchWords(query);
    if (words.length === 0) return [];
    const tsq = anyWords(words);
    const candidates = this.#ctx.db
      .select({ id: m.id, search: m.search, lastUsedAt: m.lastUsedAt })
      .from(m)
      .where(and(ownedBy(owner), visibleTo(personalityId), sql`${m.search} @@ ${tsq}`))
      .orderBy(desc(m.lastUsedAt))
      .limit(RECALL_CANDIDATES)
      .as("c");
    const best = await this.#ctx.db
      .select({ id: candidates.id })
      .from(candidates)
      .orderBy(sql`ts_rank(${candidates.search}, ${tsq}) desc`, desc(candidates.lastUsedAt))
      .limit(RECALL_MAX);
    if (best.length === 0) return [];
    const ids = best.map((r) => r.id);
    const rows = await this.#select().where(inArray(m.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Marking them used needn't hold up the answer.
    this.#touch(ids).catch((err) => this.#ctx.log.warn({ err }, "marking memories used failed"));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [toView(r)] : [];
    });
  }

  async promptBlock(owner: MemoryOwner, personalityId: string | null): Promise<string> {
    const rows = await this.#ctx.db
      .select({ id: m.id, text: m.text, lastUsedAt: m.lastUsedAt })
      .from(m)
      .where(and(ownedBy(owner), visibleTo(personalityId)))
      .orderBy(desc(m.lastUsedAt), desc(m.createdAt), desc(m.id))
      .limit(BLOCK_ROWS);
    const { text, used } = memoryBlock(rows.map((r) => r.text));
    const stale = Date.now() - PROMPT_TOUCH_MS;
    await this.#touch(
      rows
        .slice(0, used)
        .filter((r) => r.lastUsedAt.getTime() < stale)
        .map((r) => r.id),
    );
    return text;
  }

  async #touch(ids: string[]) {
    if (ids.length === 0) return;
    await this.#ctx.db.update(m).set({ lastUsedAt: sql`now()` }).where(inArray(m.id, ids));
  }
}
