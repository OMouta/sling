import { type ConversationSummaryView, newId, PERMISSION_MODES, type TaskState } from "@sling/core";
import { schema } from "@sling/db";
import { SLING_EVENTS } from "@sling/workflow";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, sum } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ChatSettingsPatch, mergeSettings } from "../agent/chat-settings.ts";
import { textOf, toMessageView } from "../agent/history.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import {
  conversationPersonality,
  defaultPersonality,
  toPersonalityView,
  usablePersonality,
} from "../personalities/service.ts";
import { taskViews, toConversationView } from "../views.ts";
import { conversationKey, conversationObject } from "../workflows/sling-events.ts";

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

  // Conversations with at least one message, newest first, each with what
  // a list needs to show it. `q` searches titles and message text.
  r.get(
    "/api/conversations",
    { schema: { querystring: z.object({ q: z.string().trim().max(200).optional() }) } },
    async (request) => {
      const actor = actorOf(request);
      const q = request.query.q;
      const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const hasMessage = sql`exists (select 1 from ${schema.messages} m where m.conversation_id = ${schema.conversations.id} and m.role in ('user', 'assistant', 'system'))`;
      const matches = pattern
        ? or(
            ilike(schema.conversations.title, pattern),
            sql`exists (select 1 from ${schema.messages} m where m.conversation_id = ${schema.conversations.id} and m.role in ('user', 'assistant') and m.content->>'content' ilike ${pattern})`,
          )
        : undefined;
      const rows = await ctx.db
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.workspaceId, actor.workspaceId),
            isNull(schema.conversations.archivedAt),
            hasMessage,
            matches,
          ),
        )
        // Newest activity first: a rename doesn't move a conversation up.
        .orderBy(
          desc(
            sql`(select max(m.created_at) from ${schema.messages} m where m.conversation_id = ${schema.conversations.id})`,
          ),
        )
        .limit(200);
      return conversationSummaries(ctx, actor.workspaceId, rows);
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

  r.get("/api/conversations/:id", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const conv = await owned(actor.workspaceId, request.params.id);
    if (!conv) return reply.code(404).send({ error: "not found" });
    const rows = await ctx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conv.id))
      .orderBy(asc(schema.messages.id));
    const tasks = await ctx.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.conversationId, conv.id))
      .orderBy(asc(schema.tasks.createdAt));
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
      messages: rows.map(toMessageView).filter((m) => m !== null),
      tasks: await taskViews(ctx, tasks),
      agentStatus: ctx.agent.status(conv.id),
      live: ctx.agent.live(conv.id),
      usage: { inputTokens: Number(usage?.input ?? 0), outputTokens: Number(usage?.output ?? 0) },
    };
  });

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
        return reply.code(409).send({ error: "That isn't waiting for an answer anymore." });
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

  r.delete("/api/conversations/:id", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const conv = await owned(actor.workspaceId, request.params.id);
    if (!conv) return reply.code(404).send({ error: "not found" });
    await ctx.db
      .update(schema.conversations)
      .set({ archivedAt: new Date() })
      .where(eq(schema.conversations.id, conv.id));
    return { ok: true };
  });

  r.post(
    "/api/conversations/:id/messages",
    { schema: { params: Id, body: z.object({ text: z.string().trim().min(1).max(20_000) }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      let conv = await owned(actor.workspaceId, request.params.id);
      if (!conv) return reply.code(404).send({ error: "not found" });
      if (conv.title === "New conversation") {
        const title = request.body.text.replace(/\s+/g, " ").slice(0, 60);
        const [u] = await ctx.db
          .update(schema.conversations)
          .set({ title })
          .where(eq(schema.conversations.id, conv.id))
          .returning();
        if (u) conv = u;
      }
      const row = await ctx.agent.addUserMessage(conv, request.body.text);
      if (!row) throw new Error("insert failed");
      const runs = await ctx.events.emit({
        type: SLING_EVENTS.chatMessage,
        workspaceId: actor.workspaceId,
        payload: {
          conversation: conversationObject(conv),
          key: conversationKey(conv),
          message: request.body.text,
          messageId: row.id,
        },
        dedupeKey: row.id,
      });
      if (runs.length === 0) {
        await ctx.agent.addMessage(conv, "assistant", {
          role: "assistant",
          content: NO_CHAT_WORKFLOW,
        });
      }
      return { id: row.id };
    },
  );
}

const ACTIVE_TASK_STATES: TaskState[] = ["queued", "dispatched", "running"];

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
