import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { SLING_EVENTS } from "@sling/workflow";
import type { ModelMessage } from "ai";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { textOf } from "../agent/history.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { conversationKey, conversationObject } from "../workflows/sling-events.ts";
import { lastMessageAt, messageViews } from "./messages.ts";
import { latestExchange, replaceable } from "./replace.ts";
import { NO_CHAT_WORKFLOW } from "./routes.ts";

type Conversation = typeof schema.conversations.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

const BUSY = "Wait for the reply to finish first.";
const STALE = "That's no longer the latest message. Reload the chat.";
const BLOCKED =
  "This can't run again: the reply did something outside the chat, such as starting a task or sending something.";

/** A user message's content with its text replaced, keeping any other parts. */
function withText(content: unknown, text: string): ModelMessage {
  const parts = (content as { content?: unknown })?.content;
  if (!Array.isArray(parts)) return { role: "user", content: text };
  const rest = parts.filter((p) => (p as { type?: string })?.type !== "text");
  return { role: "user", content: [{ type: "text", text }, ...rest] } as ModelMessage;
}

/**
 * Retry runs the latest reply again, and Edit changes the latest user
 * message and runs it from there. Both replace what came after that
 * message, and only when none of it did anything outside the chat.
 */
export async function replaceRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));
  /** Chats being replaced right now, so a double click can't start two turns. */
  const busy = new Set<string>();

  async function load(workspaceId: string, id: string) {
    const [conv] = await ctx.db
      .select()
      .from(schema.conversations)
      .where(
        and(eq(schema.conversations.id, id), eq(schema.conversations.workspaceId, workspaceId)),
      );
    if (!conv) return null;
    const rows = await ctx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conv.id))
      .orderBy(asc(schema.messages.id));
    return { conv, rows };
  }

  /**
   * Deletes what follows the message, with its feedback, and starts a fresh
   * turn from it. The CLI's session had the old reply, so it starts over.
   */
  async function rerun(conv: Conversation, user: MessageRow, after: MessageRow[], text: string) {
    const ids = after.map((m) => m.id);
    await ctx.db.transaction(async (tx) => {
      if (ids.length) await tx.delete(schema.messages).where(inArray(schema.messages.id, ids));
      await tx
        .update(schema.conversations)
        .set({ agentSession: null, lastMessageAt: lastMessageAt(conv.id) })
        .where(eq(schema.conversations.id, conv.id));
    });
    if (ids.length) {
      ctx.hub.publish(conv.workspaceId, {
        type: "message.removed",
        conversationId: conv.id,
        messageIds: ids,
      });
    }
    const runs = await ctx.events.emit({
      type: SLING_EVENTS.chatMessage,
      workspaceId: conv.workspaceId,
      payload: {
        conversation: conversationObject(conv),
        key: conversationKey(conv),
        message: text,
        messageId: user.id,
      },
      // The message's own ID already started a run once.
      dedupeKey: newId("rpl"),
    });
    if (runs.length === 0) {
      await ctx.agent.addMessage(conv, "assistant", {
        role: "assistant",
        content: NO_CHAT_WORKFLOW,
      });
    }
  }

  r.post(
    "/api/conversations/:id/retry",
    {
      schema: {
        params: z.object({ id: z.string() }),
        // The reply the user saw as the latest, so a stale page can't replace a newer one.
        body: z.object({ messageId: z.string().max(64).optional() }).nullish(),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const loaded = await load(actor.workspaceId, request.params.id);
      if (!loaded) return reply.code(404).send({ error: "not found" });
      const { conv, rows } = loaded;
      if (ctx.agent.status(conv.id) === "thinking" || busy.has(conv.id)) {
        return reply.code(409).send({ error: BUSY });
      }
      const exchange = latestExchange(rows);
      const latestReply = exchange?.after.findLast((m) => m.role === "assistant");
      const asked = request.body?.messageId;
      if (!exchange || !latestReply || (asked && asked !== latestReply.id)) {
        return reply.code(409).send({ error: STALE });
      }
      if (!(await replaceable(ctx, rows)).has(latestReply.id)) {
        return reply.code(409).send({ error: BLOCKED });
      }
      const text = textOf((exchange.user.content as ModelMessage).content);
      busy.add(conv.id);
      try {
        await rerun(conv, exchange.user, exchange.after, text);
      } finally {
        busy.delete(conv.id);
      }
      return { id: exchange.user.id };
    },
  );

  r.post(
    "/api/conversations/:id/messages/:mid/edit",
    {
      schema: {
        params: z.object({ id: z.string(), mid: z.string() }),
        body: z.object({ text: z.string().trim().min(1).max(20_000) }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const loaded = await load(actor.workspaceId, request.params.id);
      if (!loaded) return reply.code(404).send({ error: "not found" });
      const { conv, rows } = loaded;
      if (ctx.agent.status(conv.id) === "thinking" || busy.has(conv.id)) {
        return reply.code(409).send({ error: BUSY });
      }
      const exchange = latestExchange(rows);
      if (!exchange || exchange.user.id !== request.params.mid) {
        return reply.code(409).send({ error: STALE });
      }
      if (!(await replaceable(ctx, rows)).has(exchange.user.id)) {
        return reply.code(409).send({ error: BLOCKED });
      }
      const text = request.body.text;
      busy.add(conv.id);
      try {
        // The same message with new text: its files and what it was sent with stay.
        const [updated] = await ctx.db
          .update(schema.messages)
          .set({ content: withText(exchange.user.content, text) })
          .where(eq(schema.messages.id, exchange.user.id))
          .returning();
        if (!updated) return reply.code(404).send({ error: "not found" });
        const [view] = await messageViews(ctx, actor.workspaceId, actor.userId, [updated]);
        if (view) ctx.hub.publish(conv.workspaceId, { type: "message.updated", message: view });
        await rerun(conv, updated, exchange.after, text);
        return { id: updated.id };
      } finally {
        busy.delete(conv.id);
      }
    },
  );
}
