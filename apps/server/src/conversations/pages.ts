import { schema } from "@sling/db";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.ts";

type MessageRow = typeof schema.messages.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;

/** Messages a page of a chat holds at most. */
export const MESSAGE_PAGE = 60;
/**
 * Roughly how many bytes of message content and traces a page holds. A
 * page stops early at this, but always has at least one message.
 */
export const MESSAGE_PAGE_BYTES = 512 * 1024;
/** Most messages a refresh from a loaded message returns before it falls back to the latest page. */
const FROM_MAX = 2_000;

export interface MessagePage {
  /** Oldest first. */
  rows: MessageRow[];
  /** The chat's tasks this page shows: started in its stretch of time, or named by its notes. */
  tasks: TaskRow[];
  /** The oldest message's ID, to ask for the page before it. Null when there's nothing older. */
  olderCursor: string | null;
}

function size(row: MessageRow): number {
  return JSON.stringify(row.content).length + (row.trace ? JSON.stringify(row.trace).length : 0);
}

/**
 * A page of a chat's messages, newest first from `before` (or from the
 * end), cut by count and by size. With `from`, every message from that one
 * on instead, so a refresh keeps what a reader already scrolled back to.
 *
 * Tasks split between pages by when they started: a page has the tasks
 * after the message before it, up to its own newest message, so every task
 * is on exactly one page. A note about an older task brings that task too.
 */
export async function messagePage(
  ctx: AppContext,
  conversationId: string,
  opts: { before?: string; from?: string } = {},
): Promise<MessagePage> {
  const m = schema.messages;
  let rows: MessageRow[] | null = null;
  let previous: MessageRow | null = null;

  if (opts.from) {
    const since = await ctx.db
      .select()
      .from(m)
      .where(and(eq(m.conversationId, conversationId), gte(m.id, opts.from)))
      .orderBy(asc(m.id))
      .limit(FROM_MAX + 1);
    if (since.length <= FROM_MAX) {
      rows = since;
      const [before] = await ctx.db
        .select()
        .from(m)
        .where(and(eq(m.conversationId, conversationId), lt(m.id, opts.from)))
        .orderBy(desc(m.id))
        .limit(1);
      previous = before ?? null;
    }
  }

  if (!rows) {
    const newest = await ctx.db
      .select()
      .from(m)
      .where(
        and(eq(m.conversationId, conversationId), opts.before ? lt(m.id, opts.before) : undefined),
      )
      .orderBy(desc(m.id))
      .limit(MESSAGE_PAGE + 1);
    const kept: MessageRow[] = [];
    let bytes = 0;
    for (const row of newest.slice(0, MESSAGE_PAGE)) {
      bytes += size(row);
      if (kept.length > 0 && bytes > MESSAGE_PAGE_BYTES) break;
      kept.push(row);
    }
    previous = newest[kept.length] ?? null;
    rows = kept.reverse();
  }

  const oldest = rows[0];
  const newestRow = rows.at(-1);
  const t = schema.tasks;
  const named = [...new Set(rows.flatMap((r) => (r.taskId ? [r.taskId] : [])))];
  const window: SQL[] = [];
  if (previous) window.push(gt(t.createdAt, previous.createdAt));
  // Only an older page has an end: the page after it starts its tasks there.
  if (opts.before && newestRow) window.push(lte(t.createdAt, newestRow.createdAt));
  const inWindow = window.length ? and(...window) : undefined;
  const tasks = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.conversationId, conversationId),
        inWindow && named.length ? or(inWindow, inArray(t.id, named)) : inWindow,
      ),
    )
    .orderBy(asc(t.createdAt));
  return {
    rows,
    tasks,
    olderCursor: previous && oldest ? oldest.id : null,
  };
}
