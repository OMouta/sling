import { MEMORY_TEXT_MAX, type MemoryView } from "@sling/core";
import { schema } from "@sling/db";
import { tool } from "ai";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { ToolScope } from "../agent/tools.ts";
import type { AppContext } from "../context.ts";
import { conversationPersonality } from "../personalities/service.ts";
import { MemoryInputError, type MemoryOwner, normalizeMemory } from "./service.ts";
import { trackStep } from "./steps.ts";

interface CallOptions {
  toolCallId: string;
}

/** Who the chat is with, read when the tool runs: its personality and latest message. */
async function chatOf(ctx: AppContext, scope: ToolScope) {
  const [conv] = await ctx.db
    .select({
      workspaceId: schema.conversations.workspaceId,
      personalityId: schema.conversations.personalityId,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, scope.conversationId));
  if (!conv) return null;
  const [personality, [message]] = await Promise.all([
    conversationPersonality(ctx.db, conv),
    ctx.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, scope.conversationId),
          eq(schema.messages.role, "user"),
        ),
      )
      .orderBy(desc(schema.messages.id))
      .limit(1),
  ]);
  return { personalityId: personality?.id ?? null, messageId: message?.id ?? null };
}

function shown(v: MemoryView) {
  return {
    id: v.id,
    text: v.text,
    saved: v.createdAt.slice(0, 10),
    ...(v.personalityId ? { onlyThisPersonality: true } : {}),
  };
}

/** remember, forget, and recall. They read and write only Sling's own data, so every mode allows them. */
export function memoryTools(ctx: AppContext, scope: ToolScope) {
  const owner: MemoryOwner = { workspaceId: scope.workspaceId, userId: scope.ownerId };
  const m = schema.memories;

  return {
    remember: tool({
      description:
        "Save one lasting fact about the user, as a short line: a preference, a person and how to reach them, a place, a routine, or something they asked you to remember. Every chat's prompt includes it from then on, with every personality unless onlyThisPersonality is set. Never save a secret such as a password, key, or card number, a one-off detail, or anything they asked you to forget. The chat shows what you saved, with Undo.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(MEMORY_TEXT_MAX)
          .describe(
            'The fact in a few words, such as "Vegetarian" or "Jo Silva is their accountant, jo@silva.pt".',
          ),
        onlyThisPersonality: z
          .boolean()
          .default(false)
          .describe(
            "True only when it matters to this personality alone, such as the level of a language they practice with you.",
          ),
      }),
      execute: async (input, options: CallOptions) => {
        const chat = await chatOf(ctx, scope);
        if (!chat) return { error: "conversation not found" };
        const text = normalizeMemory(input.text);
        const personalityId = input.onlyThisPersonality ? chat.personalityId : null;
        // Saying it again changes nothing: the one it has stays, and counts as used.
        const [same] = await ctx.db
          .select({ id: m.id, text: m.text })
          .from(m)
          .where(
            and(
              eq(m.workspaceId, owner.workspaceId),
              eq(m.ownerId, owner.userId),
              chat.personalityId
                ? or(isNull(m.personalityId), eq(m.personalityId, chat.personalityId))
                : isNull(m.personalityId),
              sql`lower(${m.text}) = lower(${text})`,
            ),
          )
          .limit(1);
        if (same) {
          await ctx.db.update(m).set({ lastUsedAt: sql`now()` }).where(eq(m.id, same.id));
          return { id: same.id, text: same.text, alreadyRemembered: true };
        }
        let view: MemoryView;
        try {
          view = await ctx.memory.create(
            owner,
            { text, personalityId },
            { kind: "chat", conversationId: scope.conversationId, messageId: chat.messageId },
          );
        } catch (err) {
          if (err instanceof MemoryInputError) return { error: `Not saved. ${err.message}` };
          throw err;
        }
        if (scope.trace) {
          scope.trace.toolUpdate(options.toolCallId, {
            memory: { id: view.id, text: view.text, undone: false },
          });
          trackStep(view.id, scope.trace, options.toolCallId);
        }
        return {
          id: view.id,
          text: view.text,
          for: personalityId ? "this personality" : "every personality",
        };
      },
    }),

    forget: tool({
      description:
        "Delete a memory for good, when the user asks you to forget something. Find its id with recall first, unless you saved it in this chat.",
      inputSchema: z.object({
        id: z.string().min(1).max(100).describe("The memory's id, from recall or remember."),
      }),
      execute: async ({ id }) => {
        const chat = await chatOf(ctx, scope);
        if (!chat) return { error: "conversation not found" };
        const [row] = await ctx.db
          .select({ id: m.id, personalityId: m.personalityId })
          .from(m)
          .where(
            and(eq(m.id, id), eq(m.workspaceId, owner.workspaceId), eq(m.ownerId, owner.userId)),
          );
        const visible = row && (!row.personalityId || row.personalityId === chat.personalityId);
        if (!visible) return { error: "No memory has that id. Find it with recall." };
        await ctx.memory.remove(owner, id, { by: "agent", conversationId: scope.conversationId });
        return { forgotten: true };
      },
    }),

    recall: tool({
      description:
        "Search everything you remember about the user by its words, for something that isn't among what you already know about them, such as an older detail. Returns at most 20, best match first.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .describe('A few words to look for, such as "Jo accountant" or "boiler".'),
      }),
      execute: async ({ query }) => {
        const chat = await chatOf(ctx, scope);
        if (!chat) return { error: "conversation not found" };
        const found = await ctx.memory.recall(owner, chat.personalityId, query);
        return found.length
          ? { memories: found.map(shown) }
          : { memories: [], note: "Nothing matches." };
      },
    }),
  };
}
