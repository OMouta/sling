import {
  CONVERSATION_FILTERS,
  type ConversationPage,
  type ConversationSummaryView,
  MESSAGE_MAX_FILES,
  newId,
  PERMISSION_MODES,
  type TaskState,
} from "@sling/core";
import { type MessageMeta, schema } from "@sling/db";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatSettingsPatch, mergeSettings } from "../agent/chat-settings.ts";
import type { ApprovalOutcome } from "../agent/commands.ts";
import { textOf } from "../agent/history.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { decodeCursor, encodeCursor } from "../http/cursor.ts";
import { actorOf, requireActor } from "../http/session.ts";
import {
  conversationPersonality,
  defaultPersonality,
  toPersonalityView,
  usablePersonality,
} from "../personalities/service.ts";
import { taskViews, toConversationView } from "../views.ts";
import { messageViews } from "./messages.ts";
import { messagePage } from "./pages.ts";
import { chatTitle } from "./title.ts";

const Id = z.object({ id: z.string() });

export const NO_CHAT_WORKFLOW =
  "No workflow handles chat messages, so nothing will answer. Enable Sling Assistant, or another workflow with a Chat message trigger, under Workflows.";

export async function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  async function owned(workspaceId: string, id: string) {
    const [conv] = await ctx.db
      .select()
      .from(schema.conversations)
      .where(
        and(eq(schema.conversations.id, id), eq(schema.conversations.workspaceId, workspaceId)),
      );
    return conv ?? null;
  }

  /** A chat that starts with files and no text is named after its first file. */
  async function firstFileName(ids: readonly string[] | undefined): Promise<string> {
    if (!ids?.length) return "Files";
    const [f] = await ctx.db
      .select({ name: schema.sources.name })
      .from(schema.sources)
      .where(inArray(schema.sources.id, [...ids]))
      .limit(1);
    return f?.name ?? "Files";
  }

  // Chats with at least one message, newest activity first, a page at a
  // time, each with what a list needs to show it. `q` searches titles and
  // message text; `filter` picks what's going on in them.
  r.get(
    "/api/conversations",
    {
      schema: {
        querystring: z.object({
          q: z.string().trim().max(200).optional(),
          filter: z.enum(CONVERSATION_FILTERS).default("all"),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(PAGE),
        }),
      },
    },
    async (request, reply): Promise<ConversationPage> => {
      const actor = actorOf(request);
      const { q, filter, limit } = request.query;
      const after = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      if (request.query.cursor && !after) return reply.code(400).send({ error: "bad cursor" });
      const c = schema.conversations;
      const pattern = q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
      const matches = pattern
        ? or(
            ilike(c.title, pattern),
            sql`exists (select 1 from ${schema.messages} m where m.conversation_id = ${c.id} and m.role in ('user', 'assistant') and m.content->>'content' ilike ${pattern})`,
          )
        : undefined;
      const status = statusFilters(ctx, actor.workspaceId);
      const shown = and(eq(c.workspaceId, actor.workspaceId), isNotNull(c.lastMessageAt), matches);
      const rows = await ctx.db
        .select()
        .from(c)
        .where(
          and(
            shown,
            filter === "archived" ? isNotNull(c.archivedAt) : isNull(c.archivedAt),
            filter === "waiting" || filter === "working" || filter === "tasks"
              ? status[filter]
              : undefined,
            after
              ? sql`(${c.lastMessageAt}, ${c.id}) < (${after.at}::timestamptz, ${after.id})`
              : undefined,
          ),
        )
        // Newest activity first: a rename doesn't move a conversation up.
        .orderBy(desc(c.lastMessageAt), desc(c.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const [counts] = after
        ? [null]
        : await ctx.db
            .select({
              waiting: sql<number>`(count(*) filter (where ${status.waiting}))::int`,
              working: sql<number>`(count(*) filter (where ${status.working}))::int`,
            })
            .from(c)
            .where(and(shown, isNull(c.archivedAt)));
      return {
        items: await conversationSummaries(ctx, actor.workspaceId, page),
        nextCursor:
          rows.length > limit && last?.lastMessageAt
            ? encodeCursor(last.lastMessageAt, last.id)
            : null,
        counts: counts ?? null,
      };
    },
  );

  // The personality is picked here and never changes for this chat.
  r.post(
    "/api/conversations",
    { schema: { body: z.object({ personalityId: z.string().optional() }).nullish() } },
    async (request, reply) => {
      const actor = actorOf(request);
      const asked = request.body?.personalityId;
      const personality = asked
        ? await usablePersonality(ctx.db, actor.workspaceId, asked)
        : await defaultPersonality(ctx.db, actor.workspaceId);
      if (asked && !personality) {
        return reply.code(400).send({ error: "That personality doesn't exist anymore." });
      }
      const [ws] = await ctx.db
        .select({ mode: schema.workspaces.defaultMode })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, actor.workspaceId));
      const [conv] = await ctx.db
        .insert(schema.conversations)
        .values({
          id: newId("cnv"),
          workspaceId: actor.workspaceId,
          ownerId: actor.userId,
          mode: ws?.mode ?? "auto",
          personalityId: personality?.id ?? null,
        })
        .returning();
      if (!conv) throw new Error("insert failed");
      const view = toConversationView(conv);
      ctx.hub.publish(actor.workspaceId, { type: "conversation.updated", conversation: view });
      return view;
    },
  );

  // A chat with its latest page of messages and the tasks that go with
  // them. With `from`, every message from that one on, so a refresh keeps
  // what the reader already scrolled back to.
  r.get(
    "/api/conversations/:id",
    { schema: { params: Id, querystring: z.object({ from: z.string().max(64).optional() }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const conv = await owned(actor.workspaceId, request.params.id);
      if (!conv) return reply.code(404).send({ error: "not found" });
      const page = await messagePage(ctx, conv.id, { from: request.query.from });
      const [usage] = await ctx.db
        .select({
          input: sum(sql`(${schema.messages.usage}->>'inputTokens')::bigint`),
          output: sum(sql`(${schema.messages.usage}->>'outputTokens')::bigint`),
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conv.id));
      // Even when archived: the chat keeps the personality it started with.
      const personality = await conversationPersonality(ctx.db, conv);
      return {
        conversation: toConversationView(conv),
        personality: personality ? toPersonalityView(personality) : null,
        messages: await messageViews(ctx, actor.workspaceId, actor.userId, page.rows),
        tasks: await taskViews(ctx, page.tasks),
        olderCursor: page.olderCursor,
        agentStatus: ctx.agent.status(conv.id),
        live: ctx.agent.live(conv.id),
        usage: {
          inputTokens: Number(usage?.input ?? 0),
          outputTokens: Number(usage?.output ?? 0),
        },
      };
    },
  );

  // The page of a chat before `before`, for scrolling back.
  r.get(
    "/api/conversations/:id/messages",
    {
      schema: {
        params: Id,
        querystring: z.object({ before: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const conv = await owned(actor.workspaceId, request.params.id);
      if (!conv) return reply.code(404).send({ error: "not found" });
      const page = await messagePage(ctx, conv.id, { before: request.query.before });
      return {
        messages: await messageViews(ctx, actor.workspaceId, actor.userId, page.rows, {
          latest: false,
        }),
        tasks: await taskViews(ctx, page.tasks),
        olderCursor: page.olderCursor,
      };
    },
  );

  r.patch(
    "/api/conversations/:id",
    {
      schema: {
        params: Id,
        body: z.object({
          title: z.string().min(1).max(120).optional(),
          mode: z.enum(PERMISSION_MODES).optional(),
          /** The assistant's model and the coding agent for this conversation. */
          settings: ChatSettingsPatch.optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const conv = await owned(actor.workspaceId, request.params.id);
      if (!conv) return reply.code(404).send({ error: "not found" });
      const [updated] = await ctx.db
        .update(schema.conversations)
        .set({
          ...(request.body.title ? { title: request.body.title } : {}),
          ...(request.body.mode ? { mode: request.body.mode } : {}),
          ...(request.body.settings
            ? { settings: mergeSettings(conv.settings, request.body.settings) }
            : {}),
        })
        .where(eq(schema.conversations.id, conv.id))
        .returning();
      if (request.body.mode && request.body.mode !== conv.mode) {
        await audit(ctx, {
          workspaceId: actor.workspaceId,
          actorType: "user",
          actorId: actor.userId,
          verb: "conversation.mode_changed",
          subjectType: "conversation",
          subjectId: conv.id,
          details: { from: conv.mode, to: request.body.mode },
        });
      }
      if (!updated) return reply.code(404).send({ error: "not found" });
      const view = toConversationView(updated);
      ctx.hub.publish(actor.workspaceId, { type: "conversation.updated", conversation: view });
      return view;
    },
  );

  // The user's answer to something the assistant waits on in the chat: a
  // command that wants to leave the sandbox, a send, or a change to Sling's
  // setup. A change's secrets come with the answer, straight from its card.
  r.post(
    "/api/conversations/:id/commands/:approvalId",
    {
      schema: {
        params: z.object({ id: z.string(), approvalId: z.string() }),
        body: z.object({
          decision: z.enum(["approve", "deny"]),
          secrets: z.record(z.string().max(100), z.string()).optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const conv = await owned(actor.workspaceId, request.params.id);
      if (!conv) return reply.code(404).send({ error: "not found" });
      const result = ctx.commands.decide(
        actor.workspaceId,
        conv.id,
        request.params.approvalId,
        request.body.decision,
        request.body.secrets,
      );
      if (result === "gone") {
        const ended = await ctx.commands.outcome(request.params.approvalId);
        const mine = ended?.workspaceId === actor.workspaceId && ended.conversationId === conv.id;
        return reply.code(409).send({
          error: mine ? lateAnswer(ended) : "That isn't waiting for an answer anymore.",
          ...(mine ? { state: ended.state, reason: ended.reason } : {}),
        });
      }
      if (result === "bad_secrets") {
        return reply.code(400).send({ error: "That approval doesn't take those fields." });
      }
      if (result === "missing_secrets") {
        return reply.code(400).send({ error: "Fill in every field first." });
      }
      return { ok: true };
    },
  );

  // Archiving hides a chat from the lists and keeps everything in it, so
  // Restore brings it back as it was. Tasks it started keep running.
  async function setArchived(workspaceId: string, id: string, archived: boolean) {
    const [updated] = await ctx.db
      .update(schema.conversations)
      .set({ archivedAt: archived ? new Date() : null })
      .where(
        and(eq(schema.conversations.id, id), eq(schema.conversations.workspaceId, workspaceId)),
      )
      .returning();
    if (!updated) return null;
    const view = toConversationView(updated);
    ctx.hub.publish(workspaceId, { type: "conversation.updated", conversation: view });
    return view;
  }

  r.post("/api/conversations/:id/archive", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const view = await setArchived(actor.workspaceId, request.params.id, true);
    return view ?? reply.code(404).send({ error: "not found" });
  });

  r.post("/api/conversations/:id/restore", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const view = await setArchived(actor.workspaceId, request.params.id, false);
    return view ?? reply.code(404).send({ error: "not found" });
  });

  r.post(
    "/api/conversations/:id/messages",
    {
      schema: {
        params: Id,
        body: z.object({
          // Files can go on their own, such as a photo with nothing to add.
          text: z.string().trim().max(20_000),
          attachmentIds: z.array(z.string().max(64)).max(MESSAGE_MAX_FILES).optional(),
          research: z.boolean().optional(),
          personalityId: z.string().max(64).optional(),
          clientId: z.string().min(8).max(64).optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      let conv = await owned(actor.workspaceId, request.params.id);
      if (!conv) return reply.code(404).send({ error: "not found" });
      const { personalityId, research, attachmentIds, clientId } = request.body;
      // The same message sent again, after its response was lost: it's saved
      // already, with its files, and its turn was queued with it.
      if (clientId) {
        const [sent] = await ctx.db
          .select({ id: schema.messages.id })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, conv.id),
              eq(schema.messages.clientId, clientId),
            ),
          );
        if (sent) return { id: sent.id };
      }
      if (!request.body.text && !attachmentIds?.length) {
        return reply.code(400).send({ error: "Write a message first." });
      }
      const files = await ctx.sources.checkAttachments(actor, attachmentIds ?? []);
      if (files) return reply.code(400).send({ error: files });
      // A mention of the chat's own personality is just a message.
      const mentioned =
        personalityId && personalityId !== conv.personalityId
          ? await usablePersonality(ctx.db, actor.workspaceId, personalityId)
          : null;
      if (personalityId && personalityId !== conv.personalityId && !mentioned) {
        return reply.code(400).send({ error: "That personality doesn't exist anymore." });
      }
      const meta: MessageMeta = {
        ...(research ? { research: true } : {}),
        ...(mentioned ? { personalityId: mentioned.id } : {}),
      };
      // Writing in an archived chat brings it back.
      if (conv.archivedAt) {
        await setArchived(actor.workspaceId, conv.id, false);
        conv = { ...conv, archivedAt: null };
      }
      if (conv.title === "New conversation") {
        const title = chatTitle(request.body.text || (await firstFileName(attachmentIds)));
        const [u] = await ctx.db
          .update(schema.conversations)
          .set({ title })
          .where(eq(schema.conversations.id, conv.id))
          .returning();
        if (u) conv = u;
      }
      const row = await ctx.agent.addUserMessage(conv, request.body.text, {
        meta: Object.keys(meta).length ? meta : null,
        dispatch: true,
        ...(attachmentIds?.length ? { attachmentIds } : {}),
        ...(clientId ? { clientId } : {}),
      });
      if (!row) throw new Error("insert failed");
      return { id: row.id };
    },
  );
}

const ACTIVE_TASK_STATES: TaskState[] = ["queued", "dispatched", "running"];

/** Chats a list page holds, unless it asks for fewer. */
const PAGE = 50;
const MAX_PAGE = 100;

/**
 * What the status filters match, as conditions on a conversations row. A
 * reply being written, and a command or send waiting in a turn, live in
 * this process; the rest is in the database. Each is an `in` over the
 * workspace's tasks, which Postgres hashes once instead of probing per chat.
 */
function statusFilters(
  ctx: AppContext,
  workspaceId: string,
): Record<"waiting" | "working" | "tasks", SQL> {
  const c = schema.conversations;
  const t = schema.tasks;
  const a = schema.approvals;
  const asking = [...ctx.commands.waitingConversations(workspaceId)];
  const thinking = ctx.agent.thinking();
  return {
    waiting: or(
      sql`${c.id} in (select ${t.conversationId} from ${a} inner join ${t} on ${t.id} = ${a.taskId} where ${a.workspaceId} = ${workspaceId} and ${a.state} = 'pending')`,
      asking.length ? inArray(c.id, asking) : undefined,
    ) as SQL,
    working: or(
      sql`${c.id} in (select ${t.conversationId} from ${t} where ${t.workspaceId} = ${workspaceId} and ${inArray(t.state, ACTIVE_TASK_STATES)})`,
      thinking.length ? inArray(c.id, thinking) : undefined,
    ) as SQL,
    tasks: sql`${c.id} in (select ${t.conversationId} from ${t} where ${t.workspaceId} = ${workspaceId})`,
  };
}

/** Why an answer came too late, from how the approval ended. */
function lateAnswer(ended: ApprovalOutcome): string {
  if (ended.state === "approved" || ended.state === "denied") return "That was already answered.";
  if (ended.reason === "restart") return "Sling restarted while this waited, so it was cancelled.";
  if (ended.reason === "stopped") return "The reply that asked was stopped, so it was cancelled.";
  return "Nobody answered in time, so it was cancelled.";
}

/** One line of a message, for a list. */
function previewOf(content: unknown, role: string): string {
  const text = textOf((content as { content?: unknown })?.content).trim();
  const line = role === "system" ? (text.split("\n")[0] ?? "") : text;
  const flat = line.replace(/\s+/g, " ");
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

/** Lists conversations with their latest message, tasks, and whether they wait on the user. */
export async function conversationSummaries(
  ctx: AppContext,
  workspaceId: string,
  rows: (typeof schema.conversations.$inferSelect)[],
): Promise<ConversationSummaryView[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const [latest, tasks, approvals] = await Promise.all([
    ctx.db
      .selectDistinctOn([schema.messages.conversationId], {
        conversationId: schema.messages.conversationId,
        role: schema.messages.role,
        content: schema.messages.content,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.conversationId, ids),
          inArray(schema.messages.role, ["user", "assistant", "system"]),
        ),
      )
      .orderBy(schema.messages.conversationId, desc(schema.messages.id)),
    ctx.db
      .select({
        conversationId: schema.tasks.conversationId,
        total: sql<number>`count(*)::int`,
        active: sql<number>`(count(*) filter (where ${inArray(schema.tasks.state, ACTIVE_TASK_STATES)}))::int`,
      })
      .from(schema.tasks)
      .where(inArray(schema.tasks.conversationId, ids))
      .groupBy(schema.tasks.conversationId),
    ctx.db
      .selectDistinct({ conversationId: schema.tasks.conversationId })
      .from(schema.approvals)
      .innerJoin(schema.tasks, eq(schema.approvals.taskId, schema.tasks.id))
      .where(
        and(
          eq(schema.approvals.workspaceId, workspaceId),
          eq(schema.approvals.state, "pending"),
          inArray(schema.tasks.conversationId, ids),
        ),
      ),
  ]);
  const last = new Map(latest.map((m) => [m.conversationId, m]));
  const taskCounts = new Map(tasks.map((t) => [t.conversationId, t]));
  const waiting = new Set([
    ...approvals.map((a) => a.conversationId),
    ...ctx.commands.waitingConversations(workspaceId),
  ]);
  return rows.map((r) => {
    const m = last.get(r.id);
    const t = taskCounts.get(r.id);
    return {
      ...toConversationView(r),
      preview: m ? previewOf(m.content, m.role) || null : null,
      previewRole: m && m.role !== "tool" ? m.role : null,
      lastMessageAt: m?.createdAt.toISOString() ?? null,
      taskCount: t?.total ?? 0,
      activeTasks: t?.active ?? 0,
      waiting: waiting.has(r.id),
      agentStatus: ctx.agent.status(r.id),
      source: r.externalKey?.split(":")[0] ?? "app",
    };
  });
}
