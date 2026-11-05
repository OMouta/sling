import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { NodeError } from "@sling/workflow";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { conversationObject } from "../sling-events.ts";
import { defineNode } from "../types.ts";

/** Largest value `state.kv_set` stores, as JSON. */
const MAX_KV_BYTES = 256 * 1024;

const key = z.string().min(1).max(200).describe("Key. May be an expression.");

export const kvGetNode = defineNode({
  type: "state.kv_get",
  version: 1,
  title: "Get stored value",
  description: "Reads a value this workflow stored earlier, in this run or a previous one.",
  category: "state",
  configSchema: z.object({ key }),
  expressionFields: ["key"],
  inputs: [],
  outputs: [
    { name: "value", type: "json", description: "The stored value, or null." },
    { name: "found", type: "boolean", description: "Whether the key was set." },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (ctx, { config }) => {
    const [row] = await ctx.services.app.db
      .select({ value: schema.workflowKv.value })
      .from(schema.workflowKv)
      .where(
        and(
          eq(schema.workflowKv.workflowId, ctx.workflowId),
          eq(schema.workflowKv.key, config.key),
        ),
      );
    return { exec: "next", outputs: { value: row?.value ?? null, found: row !== undefined } };
  },
});

export const kvSetNode = defineNode({
  type: "state.kv_set",
  version: 1,
  title: "Store value",
  description: "Stores a value for this workflow under a key. Later runs can read it.",
  category: "state",
  configSchema: z.object({
    key,
    value: z
      .string()
      .optional()
      .describe("Value to store when the value input has no edge. May be an expression."),
  }),
  expressionFields: ["key", "value"],
  inputs: [{ name: "value", type: "json", required: true, description: "The value to store." }],
  outputs: [],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (ctx, { inputs, config }) => {
    const value = inputs.value ?? null;
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_KV_BYTES) {
      throw new NodeError(`Stored values are limited to ${MAX_KV_BYTES} bytes`, {
        code: "too_large",
      });
    }
    await ctx.services.app.db
      .insert(schema.workflowKv)
      .values({ workflowId: ctx.workflowId, workspaceId: ctx.workspaceId, key: config.key, value })
      .onConflictDoUpdate({
        target: [schema.workflowKv.workflowId, schema.workflowKv.key],
        set: { value, updatedAt: new Date() },
      });
    return { exec: "next" };
  },
});

export const conversationNode = defineNode({
  type: "state.conversation",
  version: 1,
  title: "Conversation",
  description:
    "Finds the conversation for a key, or creates it. The key is a Sling conversation ID, or an outside channel such as discord:<installation>:<channel>. The conversation then belongs to this workflow, so task updates come back here.",
  category: "state",
  configSchema: z.object({
    key: z
      .string()
      .optional()
      .describe(
        "The key, when the key input has no edge. May be an expression, such as ={{ trigger.key }}.",
      ),
    title: z.string().optional().describe("Title for a new conversation. May be an expression."),
  }),
  expressionFields: ["key", "title"],
  inputs: [{ name: "key", type: "string", required: true, description: "The conversation key." }],
  outputs: [{ name: "conversation", type: "conversation", description: "The conversation." }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (ctx, { inputs, config }) => {
    const db = ctx.services.app.db;
    const k = String(inputs.key ?? "").trim();
    if (!k) throw new NodeError("The conversation key is empty", { code: "invalid_input" });
    const find = async () => {
      const rows = await db
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.workspaceId, ctx.workspaceId),
            or(eq(schema.conversations.externalKey, k), eq(schema.conversations.id, k)),
          ),
        );
      return rows.find((r) => r.externalKey === k) ?? rows[0] ?? null;
    };
    let conv = await find();
    if (!conv) {
      const [ws] = await db
        .select({ mode: schema.workspaces.defaultMode })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ctx.workspaceId));
      const [created] = await db
        .insert(schema.conversations)
        .values({
          id: newId("cnv"),
          workspaceId: ctx.workspaceId,
          ownerId: ctx.ownerId,
          mode: ws?.mode ?? "auto",
          workflowId: ctx.workflowId,
          externalKey: k,
          title: (config.title ?? "").trim().slice(0, 120) || k.slice(0, 120),
        })
        .onConflictDoNothing()
        .returning();
      conv = created ?? (await find());
    }
    if (!conv)
      throw new NodeError("Couldn't create the conversation", { code: "conversation_failed" });
    if (conv.workflowId !== ctx.workflowId || conv.archivedAt) {
      const [u] = await db
        .update(schema.conversations)
        .set({ workflowId: ctx.workflowId, archivedAt: null })
        .where(eq(schema.conversations.id, conv.id))
        .returning();
      if (u) conv = u;
    }
    return { exec: "next", outputs: { conversation: conversationObject(conv) } };
  },
});

export const stateNodes = [kvGetNode, kvSetNode, conversationNode];
