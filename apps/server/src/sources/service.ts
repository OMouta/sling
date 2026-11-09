import {
  MESSAGE_MAX_FILES,
  MESSAGE_MAX_IMAGE_BYTES,
  MESSAGE_MAX_IMAGES,
  newId,
  PERSONALITY_MAX_SOURCES,
  SOURCE_MAX_BYTES,
} from "@sling/core";
import { type Db, schema } from "@sling/db";
import { and, asc, count, eq, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { searchWords } from "../memory/words.ts";
import { chunkPages } from "./chunks.ts";
import { ExtractError, extract } from "./extract.ts";
import { type FetchOptions, fetchLink, LinkError } from "./fetch-link.ts";
import { detect, detectFetched } from "./kinds.ts";
import { type SourceRow, toSourceView } from "./views.ts";

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

/** A source the request can't add, with the status to answer and why. */
export class SourceInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Sources: files and links a personality answers from, and files attached in
 * a chat. Adding one answers at once with it processing; a job extracts its
 * text and chunks it for search.
 */
export interface SourceService {
  start(boss: PgBoss): Promise<void>;
  idle?(): Promise<void>;
  addFile(actor: SourceActor, target: SourceTarget, file: NewFile): Promise<SourceRow>;
  addLink(
    actor: SourceActor,
    personalityId: string,
    url: string,
    name?: string,
  ): Promise<SourceRow>;
  /** Deletes it with its file and text. `actorId` is who asked, for the audit log. */
  remove(workspaceId: string, id: string, actorId?: string): Promise<SourceRow | null>;
  /** A personality's sources, oldest first. */
  forPersonality(workspaceId: string, personalityId: string): Promise<SourceRow[]>;
  /** The files sent with these messages. */
  forMessages(workspaceId: string, messageIds: readonly string[]): Promise<SourceRow[]>;
  /**
   * Why these uploads can't go with one message, or null when they can:
   * too many files or images, or images too large together.
   */
  checkAttachments(actor: SourceActor, ids: readonly string[]): Promise<string | null>;
  /**
   * Gives uploaded files to a sent message. Only the uploader's files that
   * no message has yet are taken; the rest are left out.
   */
  attach(
    actor: SourceActor,
    conversationId: string,
    messageId: string,
    ids: readonly string[],
    db?: Pick<Db, "update">,
  ): Promise<SourceRow[]>;
  /** Waits up to `ms` for these to finish processing, and returns them as they are then. */
  settled(workspaceId: string, ids: readonly string[], ms: number): Promise<SourceRow[]>;
  search(scope: SourceScope, query: string, limit?: number): Promise<SourceHit[]>;
  read(
    scope: SourceScope,
    sourceId: string,
    opts: { page?: number; fromPage?: number; toPage?: number },
  ): Promise<SourceRead | null>;
  /** The text of these sources, by source, in order, each page marked for a PDF. */
  texts(ids: readonly string[]): Promise<Map<string, string>>;
  /** The original bytes. */
  file(workspaceId: string, id: string): Promise<{ row: SourceRow; data: Uint8Array } | null>;
  /** The original bytes of several sources, by id. */
  bytes(ids: readonly string[]): Promise<Map<string, Uint8Array>>;
  /** What a citation of this source links to. */
  link(id: string, page?: number | null): string;
}

export const SOURCE_QUEUE = "source-process";
/** Most search hits a call returns. */
export const SEARCH_MAX = 8;
/** Most text one read returns. */
export const READ_MAX_CHARS = 30_000;
/** Uploads never sent with a message are deleted after this long. */
const ORPHAN_MS = 24 * 60 * 60_000;
/** Chunks inserted per statement. */
const INSERT_BATCH = 500;

const s = schema.sources;
const c = schema.sourceChunks;

/** The words joined by `op`, in their English stems or as written, as memory search does. */
function words(list: string[], op: "&" | "|"): SQL {
  const q = list.join(` ${op} `);
  return sql`(to_tsquery('english', ${q}) || to_tsquery('simple', ${q}))`;
}

/**
 * A search ranks at most this many matches, so a word in every chunk stays
 * fast: ranking is what's slow, and finding matches stops at the cap.
 */
const SEARCH_CANDIDATES = 1_000;

/** The sources a scope may search and read. */
function inScope(scope: SourceScope): SQL | null {
  const parts = [
    scope.personalityId ? eq(s.personalityId, scope.personalityId) : null,
    scope.conversationId ? eq(s.conversationId, scope.conversationId) : null,
  ].filter((p): p is SQL => p !== null);
  if (parts.length === 0) return null;
  return and(eq(s.workspaceId, scope.workspaceId), eq(s.state, "ready"), or(...parts)) as SQL;
}

/** "Page n" markers between a PDF's pages, so the model can say where it read something. */
function joinPages(rows: { page: number | null; text: string }[]): string {
  const out: string[] = [];
  let page: number | null | undefined;
  for (const r of rows) {
    if (r.page !== null && r.page !== page) out.push(`[Page ${r.page}]`);
    page = r.page;
    out.push(r.text);
  }
  return out.join("\n\n");
}

/** The name a link gets until its page's title is known: the address without its scheme. */
function linkName(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.host}${path}`.slice(0, 200);
}

export class Sources implements SourceService {
  readonly #ctx: AppContext;
  #boss: PgBoss | null = null;
  readonly #inflight = new Set<Promise<unknown>>();
  /** How links are fetched. Tests point it at a local server. */
  linkOptions: FetchOptions = {};

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  get #db() {
    return this.#ctx.db;
  }

  // ------------------------------------------------------------- jobs

  async start(boss: PgBoss): Promise<void> {
    this.#boss = boss;
    await boss.createQueue(SOURCE_QUEUE, {
      retryLimit: 2,
      retryDelay: 5,
      expireInSeconds: 300,
      deleteAfterSeconds: 24 * 60 * 60,
    });
    await boss.work<{ id: string }>(
      SOURCE_QUEUE,
      { pollingIntervalSeconds: 1, localConcurrency: 2 },
      async (jobs) => {
        for (const job of jobs) await this.process(job.data.id);
      },
    );
    // A restart mid-job leaves sources processing; they run again.
    const waiting = await this.#db.select({ id: s.id }).from(s).where(eq(s.state, "processing"));
    for (const w of waiting) await this.#enqueue(w.id);
    await this.#pruneOrphans();
  }

  /** Resolves once sources processing in this process without a job queue are done. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  async #enqueue(id: string) {
    if (this.#boss) {
      await this.#boss.send(SOURCE_QUEUE, { id });
      return;
    }
    const p = this.process(id)
      .catch((err) => this.#ctx.log.error({ err, id }, "processing a source failed"))
      .finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
  }

  async #pruneOrphans(ownerId?: string) {
    const old = new Date(Date.now() - ORPHAN_MS);
    await this.#db
      .delete(s)
      .where(
        and(
          isNull(s.personalityId),
          isNull(s.conversationId),
          lt(s.createdAt, old),
          ownerId ? eq(s.ownerId, ownerId) : undefined,
        ),
      );
  }

  #publish(row: SourceRow) {
    this.#ctx.hub.publish(row.workspaceId, { type: "source.updated", source: toSourceView(row) });
  }

  /**
   * Extracts a source's text, chunks it, and marks it ready, or failed with
   * the reason. Running it again redoes it, so a retried job is harmless.
   */
  async process(id: string): Promise<void> {
    const [row] = await this.#db.select().from(s).where(eq(s.id, id));
    if (row?.state !== "processing") return;
    let set: Partial<typeof s.$inferInsert>;
    let chunks: ReturnType<typeof chunkPages> = [];
    try {
      let bytes: Uint8Array;
      let mediaType = row.mediaType;
      let charset: string | undefined;
      if (row.kind === "link" && row.url) {
        const fetched = await fetchLink(row.url, this.linkOptions);
        bytes = fetched.bytes;
        const type = detectFetched(bytes, fetched.contentType);
        if (!type) throw new ExtractError("Sling can't read this kind of page.");
        mediaType = type;
        charset = /charset=([^;]+)/i.exec(fetched.contentType)?.[1]?.trim().replace(/"/g, "");
        if (type !== "application/pdf") charset ??= "utf-8";
      } else {
        const [f] = await this.#db
          .select({ data: schema.sourceFiles.data })
          .from(schema.sourceFiles)
          .where(eq(schema.sourceFiles.sourceId, id));
        if (!f) throw new ExtractError("Its file is missing. Upload it again.");
        bytes = f.data;
      }
      const text = await extract(bytes, mediaType, charset ? { charset } : {});
      chunks = chunkPages(text.pages, text.paged);
      if (chunks.length === 0) throw new ExtractError("No text found.");
      set = {
        state: "ready",
        error: null,
        mediaType,
        pages: text.paged ? text.pages.length : null,
        chars: text.pages.reduce((n, p) => n + p.length, 0),
        ...(row.kind === "link" ? { size: bytes.byteLength } : {}),
        // A link nobody named takes its page's title.
        ...(row.kind === "link" && text.title && row.name === linkNameOf(row.url)
          ? { name: text.title.slice(0, 200) }
          : {}),
      };
    } catch (err) {
      const known = err instanceof ExtractError || err instanceof LinkError;
      if (!known) this.#ctx.log.warn({ err, sourceId: id }, "couldn't read a source");
      set = {
        state: "failed",
        error: known ? err.message : "Sling couldn't read it.",
        pages: null,
        chars: 0,
      };
      chunks = [];
    }
    const updated = await this.#db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: s.id })
        .from(s)
        .where(and(eq(s.id, id), eq(s.state, "processing")))
        .for("update");
      // Removed, or finished by another run, in the meantime.
      if (!current) return null;
      await tx.delete(c).where(eq(c.sourceId, id));
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        await tx.insert(c).values(
          chunks.slice(i, i + INSERT_BATCH).map((ch, j) => ({
            sourceId: id,
            workspaceId: row.workspaceId,
            ordinal: i + j,
            page: ch.page,
            text: ch.text,
          })),
        );
      }
      const [u] = await tx
        .update(s)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(s.id, id))
        .returning();
      return u ?? null;
    });
    if (updated) this.#publish(updated);
  }

  // ------------------------------------------------------------- adding

  async #checkPersonality(actor: SourceActor, personalityId: string) {
    const [p] = await this.#db
      .select({ id: schema.personalities.id })
      .from(schema.personalities)
      .where(
        and(
          eq(schema.personalities.id, personalityId),
          eq(schema.personalities.workspaceId, actor.workspaceId),
          isNull(schema.personalities.archivedAt),
        ),
      );
    if (!p) throw new SourceInputError("No such personality.", 404);
    const [n] = await this.#db
      .select({ n: count() })
      .from(s)
      .where(eq(s.personalityId, personalityId));
    if ((n?.n ?? 0) >= PERSONALITY_MAX_SOURCES) {
      throw new SourceInputError(
        `A personality has at most ${PERSONALITY_MAX_SOURCES} sources. Remove one first.`,
        409,
      );
    }
  }

  async #added(row: SourceRow, actor: SourceActor) {
    this.#publish(row);
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "source.added",
      subjectType: "source",
      subjectId: row.id,
      details: {
        kind: row.kind,
        name: row.name,
        ...(row.personalityId ? { personalityId: row.personalityId } : {}),
        ...(row.url ? { url: row.url } : {}),
      },
    });
  }

  async addFile(actor: SourceActor, target: SourceTarget, file: NewFile): Promise<SourceRow> {
    const name = file.name.trim().replace(/[\\/]/g, "_").slice(0, 200) || "file";
    if (file.data.byteLength === 0) throw new SourceInputError("That file is empty.");
    if (file.data.byteLength > SOURCE_MAX_BYTES) {
      throw new SourceInputError(`Files are at most ${SOURCE_MAX_BYTES / (1024 * 1024)} MB.`, 413);
    }
    const kind = detect(file.data, name);
    if ("refused" in kind) throw new SourceInputError(kind.refused, 415);
    if ("personalityId" in target) {
      if (kind.kind === "image") {
        throw new SourceInputError(
          "A personality's sources are documents and links. Send an image in a chat instead.",
          415,
        );
      }
      await this.#checkPersonality(actor, target.personalityId);
    } else {
      if (kind.kind === "image" && file.data.byteLength > MESSAGE_MAX_IMAGE_BYTES) {
        throw new SourceInputError(
          `An image is at most ${MESSAGE_MAX_IMAGE_BYTES / (1024 * 1024)} MB.`,
          413,
        );
      }
      await this.#pruneOrphans(actor.userId);
    }
    const id = newId("src");
    // An image has no text to read, so it's ready as soon as it's stored.
    const ready = kind.kind === "image";
    const row = await this.#db.transaction(async (tx) => {
      const [r] = await tx
        .insert(s)
        .values({
          id,
          workspaceId: actor.workspaceId,
          ownerId: actor.userId,
          personalityId: "personalityId" in target ? target.personalityId : null,
          kind: kind.kind,
          name,
          mediaType: kind.mediaType,
          size: file.data.byteLength,
          state: ready ? "ready" : "processing",
        })
        .returning();
      await tx.insert(schema.sourceFiles).values({ sourceId: id, data: file.data });
      return r;
    });
    if (!row) throw new Error("source insert failed");
    await this.#added(row, actor);
    if (!ready) await this.#enqueue(id);
    return row;
  }

  async addLink(
    actor: SourceActor,
    personalityId: string,
    raw: string,
    name?: string,
  ): Promise<SourceRow> {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new SourceInputError("That isn't a web address.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new SourceInputError("Only http and https links can be added.");
    }
    url.hash = "";
    await this.#checkPersonality(actor, personalityId);
    const [row] = await this.#db
      .insert(s)
      .values({
        id: newId("src"),
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        personalityId,
        kind: "link",
        name: name?.trim().slice(0, 200) || linkName(url),
        mediaType: "text/html",
        url: url.toString(),
      })
      .returning();
    if (!row) throw new Error("source insert failed");
    await this.#added(row, actor);
    await this.#enqueue(row.id);
    return row;
  }

  async remove(workspaceId: string, id: string, actorId?: string): Promise<SourceRow | null> {
    const [row] = await this.#db
      .delete(s)
      .where(and(eq(s.id, id), eq(s.workspaceId, workspaceId)))
      .returning();
    if (!row) return null;
    this.#ctx.hub.publish(workspaceId, { type: "source.removed", id });
    await audit(this.#ctx, {
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      verb: "source.removed",
      subjectType: "source",
      subjectId: id,
      details: {
        kind: row.kind,
        name: row.name,
        ...(row.personalityId ? { personalityId: row.personalityId } : {}),
      },
    });
    return row;
  }

  // ------------------------------------------------------------- listing

  async forPersonality(workspaceId: string, personalityId: string): Promise<SourceRow[]> {
    return this.#db
      .select()
      .from(s)
      .where(and(eq(s.workspaceId, workspaceId), eq(s.personalityId, personalityId)))
      .orderBy(s.createdAt);
  }

  async forMessages(workspaceId: string, messageIds: readonly string[]): Promise<SourceRow[]> {
    if (messageIds.length === 0) return [];
    return this.#db
      .select()
      .from(s)
      .where(and(eq(s.workspaceId, workspaceId), inArray(s.messageId, [...messageIds])))
      .orderBy(s.createdAt);
  }

  async checkAttachments(actor: SourceActor, ids: readonly string[]): Promise<string | null> {
    if (ids.length === 0) return null;
    if (ids.length > MESSAGE_MAX_FILES)
      return `A message takes at most ${MESSAGE_MAX_FILES} files.`;
    const rows = await this.#db
      .select({ kind: s.kind, size: s.size })
      .from(s)
      .where(
        and(
          eq(s.workspaceId, actor.workspaceId),
          eq(s.ownerId, actor.userId),
          inArray(s.id, [...ids]),
          isNull(s.personalityId),
          isNull(s.messageId),
        ),
      );
    if (rows.length < new Set(ids).size) return "A file isn't there anymore. Attach it again.";
    const images = rows.filter((r) => r.kind === "image");
    if (images.length > MESSAGE_MAX_IMAGES) {
      return `A message takes at most ${MESSAGE_MAX_IMAGES} images.`;
    }
    if (images.reduce((n, r) => n + r.size, 0) > MESSAGE_MAX_IMAGE_BYTES) {
      return `A message's images are at most ${MESSAGE_MAX_IMAGE_BYTES / (1024 * 1024)} MB together.`;
    }
    return null;
  }

  async attach(
    actor: SourceActor,
    conversationId: string,
    messageId: string,
    ids: readonly string[],
    db: Pick<Db, "update"> = this.#db,
  ): Promise<SourceRow[]> {
    if (ids.length === 0) return [];
    return db
      .update(s)
      .set({ conversationId, messageId })
      .where(
        and(
          eq(s.workspaceId, actor.workspaceId),
          eq(s.ownerId, actor.userId),
          inArray(s.id, [...ids]),
          isNull(s.personalityId),
          isNull(s.messageId),
        ),
      )
      .returning();
  }

  async settled(workspaceId: string, ids: readonly string[], ms: number): Promise<SourceRow[]> {
    if (ids.length === 0) return [];
    const end = Date.now() + ms;
    for (;;) {
      const rows = await this.#db
        .select()
        .from(s)
        .where(and(eq(s.workspaceId, workspaceId), inArray(s.id, [...ids])));
      if (!rows.some((r) => r.state === "processing") || Date.now() >= end) return rows;
      await new Promise((ok) => setTimeout(ok, Math.min(500, Math.max(0, end - Date.now()))));
    }
  }

  // ------------------------------------------------------------- reading

  async search(scope: SourceScope, query: string, limit = SEARCH_MAX): Promise<SourceHit[]> {
    const list = searchWords(query);
    const where = inScope(scope);
    if (list.length === 0 || !where) return [];
    const max = Math.min(limit, SEARCH_MAX);
    const ranked = async (tsq: SQL) => {
      const candidates = this.#db
        .select({
          sourceId: c.sourceId,
          page: c.page,
          text: c.text,
          ordinal: c.ordinal,
          search: c.search,
          name: s.name,
        })
        .from(c)
        .innerJoin(s, eq(s.id, c.sourceId))
        .where(and(eq(c.workspaceId, scope.workspaceId), where, sql`${c.search} @@ ${tsq}`))
        .limit(SEARCH_CANDIDATES)
        .as("c");
      return this.#db
        .select({
          sourceId: candidates.sourceId,
          ordinal: candidates.ordinal,
          page: candidates.page,
          text: candidates.text,
          name: candidates.name,
        })
        .from(candidates)
        .orderBy(
          sql`ts_rank(${candidates.search}, ${tsq}) desc`,
          asc(candidates.sourceId),
          asc(candidates.ordinal),
        )
        .limit(max);
    };
    // Passages with every word come first; any of them fills in when those are few.
    let rows = await ranked(words(list, "&"));
    if (rows.length < max && list.length > 1) {
      const seen = new Set(rows.map((r) => `${r.sourceId}:${r.ordinal}`));
      const more = (await ranked(words(list, "|"))).filter(
        (r) => !seen.has(`${r.sourceId}:${r.ordinal}`),
      );
      rows = [...rows, ...more].slice(0, max);
    }
    return rows.map(({ ordinal: _, ...r }) => ({ ...r, link: this.link(r.sourceId, r.page) }));
  }

  async read(
    scope: SourceScope,
    sourceId: string,
    opts: { page?: number; fromPage?: number; toPage?: number },
  ): Promise<SourceRead | null> {
    const where = inScope(scope);
    if (!where) return null;
    const [src] = await this.#db
      .select({ id: s.id, name: s.name, pages: s.pages })
      .from(s)
      .where(and(eq(s.id, sourceId), where));
    if (!src) return null;
    let from: number | null = null;
    let to: number | null = null;
    if (src.pages) {
      from = Math.max(1, Math.min(opts.page ?? opts.fromPage ?? 1, src.pages));
      to = Math.max(from, Math.min(opts.page ?? opts.toPage ?? src.pages, src.pages));
    }
    const range = from !== null && to !== null ? sql`and page between ${from} and ${to}` : sql``;
    // Only the chunks that fit, and whether more were left out.
    const { rows } = await this.#db.execute<{
      page: number | null;
      text: string;
      before: string;
      total: string;
    }>(sql`
      select page, text, before, total from (
        select page, text, ordinal,
          coalesce(sum(char_length(text)) over (order by ordinal rows between unbounded preceding and 1 preceding), 0) as before,
          sum(char_length(text)) over () as total
        from source_chunks where source_id = ${sourceId} ${range}
      ) c where before < ${READ_MAX_CHARS} order by ordinal`);
    let text = joinPages(rows);
    const truncated = Number(rows[0]?.total ?? 0) > READ_MAX_CHARS || text.length > READ_MAX_CHARS;
    if (text.length > READ_MAX_CHARS) text = text.slice(0, READ_MAX_CHARS);
    const lastPage = rows.at(-1)?.page ?? to;
    return {
      sourceId: src.id,
      name: src.name,
      text,
      fromPage: from,
      toPage: truncated ? lastPage : to,
      truncated,
    };
  }

  async texts(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.#db
      .select({ sourceId: c.sourceId, page: c.page, text: c.text })
      .from(c)
      .where(inArray(c.sourceId, [...ids]))
      .orderBy(asc(c.sourceId), asc(c.ordinal));
    const by = new Map<string, { page: number | null; text: string }[]>();
    for (const r of rows) {
      const list = by.get(r.sourceId) ?? [];
      list.push(r);
      by.set(r.sourceId, list);
    }
    for (const [id, list] of by) out.set(id, joinPages(list));
    return out;
  }

  async file(workspaceId: string, id: string) {
    const [row] = await this.#db
      .select()
      .from(s)
      .where(and(eq(s.id, id), eq(s.workspaceId, workspaceId)));
    if (!row) return null;
    const [f] = await this.#db
      .select()
      .from(schema.sourceFiles)
      .where(eq(schema.sourceFiles.sourceId, id));
    return f ? { row, data: f.data } : null;
  }

  async bytes(ids: readonly string[]): Promise<Map<string, Uint8Array>> {
    if (ids.length === 0) return new Map();
    const rows = await this.#db
      .select()
      .from(schema.sourceFiles)
      .where(inArray(schema.sourceFiles.sourceId, [...ids]));
    return new Map(rows.map((r) => [r.sourceId, r.data]));
  }

  link(id: string, page?: number | null): string {
    const url = new URL(`/api/sources/${id}/view`, this.#ctx.config.publicUrl);
    if (page) url.searchParams.set("page", String(page));
    return url.toString();
  }
}

/** The name addLink gives a link nobody named. */
function linkNameOf(raw: string | null): string {
  try {
    return raw ? linkName(new URL(raw)) : "";
  } catch {
    return "";
  }
}

/**
 * The source and page a citation link points at, when it's one of this
 * server's source links.
 */
export function parseSourceLink(
  href: string,
  publicUrl: URL,
): { sourceId: string; page: number | null } | null {
  let url: URL;
  try {
    url = new URL(href, publicUrl);
  } catch {
    return null;
  }
  if (url.origin !== publicUrl.origin) return null;
  const m = /^\/api\/sources\/([\w-]+)\/view$/.exec(url.pathname);
  if (!m?.[1]) return null;
  const page = Number(url.searchParams.get("page"));
  return { sourceId: m[1], page: Number.isInteger(page) && page > 0 ? page : null };
}
