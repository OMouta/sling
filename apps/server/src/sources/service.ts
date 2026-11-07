import { schema } from "@sling/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { AppContext } from "../context.ts";
import type { SourceRow } from "./views.ts";

export interface SourceActor {
  workspaceId: string;
  userId: string;
}

/** Whose sources a turn searches: its personality's, and its chat's files. */
export interface SourceScope {
  workspaceId: string;
  personalityId: string | null;
  conversationId: string | null;
}

export interface SourceHit {
  sourceId: string;
  name: string;
  /** The PDF page, from 1. Null for text without pages. */
  page: number | null;
  text: string;
  /** What a citation links to: the file at this page. */
  link: string;
}

export interface SourceRead {
  sourceId: string;
  name: string;
  text: string;
  /** The pages it covered, for a PDF. */
  fromPage: number | null;
  toPage: number | null;
  truncated: boolean;
}

export interface NewFile {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

/** Where a new source goes: a personality, or a chat file waiting for its message. */
export type SourceTarget = { personalityId: string } | { attachment: true };

/**
 * Sources: files and links a personality answers from, and files attached in
 * a chat. Adding one answers at once with it processing; a job extracts its
 * text and chunks it for search.
 */
export interface SourceService {
  start(boss: PgBoss): Promise<void>;
  addFile(actor: SourceActor, target: SourceTarget, file: NewFile): Promise<SourceRow>;
  addLink(
    actor: SourceActor,
    personalityId: string,
    url: string,
    name?: string,
  ): Promise<SourceRow>;
  remove(workspaceId: string, id: string): Promise<SourceRow | null>;
  /** A personality's sources, oldest first. */
  forPersonality(workspaceId: string, personalityId: string): Promise<SourceRow[]>;
  /** The files sent with these messages. */
  forMessages(workspaceId: string, messageIds: readonly string[]): Promise<SourceRow[]>;
  /**
   * Gives uploaded files to a sent message. Only the uploader's files that
   * no message has yet are taken; the rest are left out.
   */
  attach(
    actor: SourceActor,
    conversationId: string,
    messageId: string,
    ids: readonly string[],
  ): Promise<SourceRow[]>;
  search(scope: SourceScope, query: string, limit?: number): Promise<SourceHit[]>;
  read(
    scope: SourceScope,
    sourceId: string,
    opts: { page?: number; fromPage?: number; toPage?: number },
  ): Promise<SourceRead | null>;
  /** The original bytes. */
  file(workspaceId: string, id: string): Promise<{ row: SourceRow; data: Uint8Array } | null>;
  /** What a citation of this source links to. */
  link(id: string, page?: number | null): string;
}

/**
 * The parts every workstream needs before extraction and search exist:
 * listing, attaching, and links. The rest refuses until it's built.
 */
export class Sources implements SourceService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async start(_boss: PgBoss): Promise<void> {}

  async addFile(): Promise<SourceRow> {
    throw new Error("Sources aren't available yet.");
  }

  async addLink(): Promise<SourceRow> {
    throw new Error("Sources aren't available yet.");
  }

  async remove(workspaceId: string, id: string): Promise<SourceRow | null> {
    const [row] = await this.#ctx.db
      .delete(schema.sources)
      .where(and(eq(schema.sources.id, id), eq(schema.sources.workspaceId, workspaceId)))
      .returning();
    return row ?? null;
  }

  async forPersonality(workspaceId: string, personalityId: string): Promise<SourceRow[]> {
    return this.#ctx.db
      .select()
      .from(schema.sources)
      .where(
        and(
          eq(schema.sources.workspaceId, workspaceId),
          eq(schema.sources.personalityId, personalityId),
        ),
      )
      .orderBy(schema.sources.createdAt);
  }

  async forMessages(workspaceId: string, messageIds: readonly string[]): Promise<SourceRow[]> {
    if (messageIds.length === 0) return [];
    return this.#ctx.db
      .select()
      .from(schema.sources)
      .where(
        and(
          eq(schema.sources.workspaceId, workspaceId),
          inArray(schema.sources.messageId, [...messageIds]),
        ),
      )
      .orderBy(schema.sources.createdAt);
  }

  async attach(
    actor: SourceActor,
    conversationId: string,
    messageId: string,
    ids: readonly string[],
  ): Promise<SourceRow[]> {
    if (ids.length === 0) return [];
    return this.#ctx.db
      .update(schema.sources)
      .set({ conversationId, messageId })
      .where(
        and(
          eq(schema.sources.workspaceId, actor.workspaceId),
          eq(schema.sources.ownerId, actor.userId),
          inArray(schema.sources.id, [...ids]),
          isNull(schema.sources.personalityId),
          isNull(schema.sources.messageId),
        ),
      )
      .returning();
  }

  async search(): Promise<SourceHit[]> {
    return [];
  }

  async read(): Promise<SourceRead | null> {
    return null;
  }

  async file(workspaceId: string, id: string) {
    const [row] = await this.#ctx.db
      .select()
      .from(schema.sources)
      .where(and(eq(schema.sources.id, id), eq(schema.sources.workspaceId, workspaceId)));
    if (!row) return null;
    const [f] = await this.#ctx.db
      .select()
      .from(schema.sourceFiles)
      .where(eq(schema.sourceFiles.sourceId, id));
    return f ? { row, data: f.data } : null;
  }

  link(id: string, page?: number | null): string {
    const url = new URL(`/api/sources/${id}/view`, this.#ctx.config.publicUrl);
    if (page) url.searchParams.set("page", String(page));
    return url.toString();
  }
}
