import { newId, PERMISSION_MODES } from "@sling/core";
import { schema } from "@sling/db";
import { SLING_EVENTS } from "@sling/workflow";
import { and, asc, desc, eq, isNull, sql, sum } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { toMessageView } from "../agent/history.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
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

  r.get("/api/conversations", async (request) => {
    const actor = actorOf(request);
    const rows = await ctx.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, actor.workspaceId),
          isNull(schema.conversations.archivedAt),
        ),
      )
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(200);
    return rows.map(toConversationView);
  });

  r.post("/api/conversations", async (request) => {
    const actor = actorOf(request);
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
      })
      .returning();
    if (!conv) throw new Error("insert failed");
    const view = toConversationView(conv);
    ctx.hub.publish(actor.workspaceId, { type: "conversation.updated", conversation: view });
    return view;
  });

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
    return {
      conversation: toConversationView(conv),
      messages: rows.map(toMessageView).filter((m) => m !== null),
      tasks: await taskViews(ctx, tasks),
      agentStatus: ctx.agent.status(conv.id),
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
