import { schema } from "@sling/db";
import { tool } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ToolScope } from "../agent/tools.ts";
import type { AppContext } from "../context.ts";
import { conversationPersonality } from "../personalities/service.ts";
import type { SourceScope } from "./service.ts";

/**
 * The tools a turn gets when its personality has a source or its chat has a
 * document. They aren't a tool group: having sources is the switch.
 */
export const SOURCE_TOOLS = ["search_sources", "read_source"] as const;

/**
 * Whose sources the turn reads: the personality answering it, which the
 * turn's trace records, and the chat's own files.
 */
async function scopeOf(ctx: AppContext, scope: ToolScope): Promise<SourceScope> {
  let personalityId = scope.trace?.personality?.id ?? null;
  if (!personalityId) {
    const [conv] = await ctx.db
      .select({
        workspaceId: schema.conversations.workspaceId,
        personalityId: schema.conversations.personalityId,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, scope.conversationId));
    personalityId = conv ? ((await conversationPersonality(ctx.db, conv))?.id ?? null) : null;
  }
  return { workspaceId: scope.workspaceId, personalityId, conversationId: scope.conversationId };
}

/** search_sources and read_source. They only read, so every mode allows them. */
export function sourceTools(ctx: AppContext, scope: ToolScope) {
  return {
    search_sources: tool({
      description:
        "Search your sources and the documents attached in this chat for passages about something, by their words. Returns at most 8 passages, best first, each with its source, page, and the link to cite it by.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(200)
          .describe('A few telling words, not a question, such as "pets deposit".'),
      }),
      execute: async ({ query }) => {
        const hits = await ctx.sources.search(await scopeOf(ctx, scope), query);
        if (hits.length === 0) {
          return { results: [], note: "Nothing matches. Try other words." };
        }
        return {
          results: hits.map((h) => ({
            sourceId: h.sourceId,
            name: h.name,
            ...(h.page ? { page: h.page } : {}),
            text: h.text,
            link: h.link,
          })),
        };
      },
    }),

    read_source: tool({
      description:
        "Read one of your sources or a document attached in this chat, by its sourceId from search_sources: a page, a range of pages, or from the start. Returns at most 30,000 characters, and says when there's more.",
      inputSchema: z.object({
        sourceId: z.string().min(1).max(64).describe("The source's id, from search_sources."),
        page: z.number().int().min(1).optional().describe("One page of a PDF."),
        fromPage: z.number().int().min(1).optional().describe("The first page to read."),
        toPage: z.number().int().min(1).optional().describe("The last page to read."),
      }),
      execute: async ({ sourceId, page, fromPage, toPage }) => {
        const read = await ctx.sources.read(await scopeOf(ctx, scope), sourceId, {
          ...(page ? { page } : {}),
          ...(fromPage ? { fromPage } : {}),
          ...(toPage ? { toPage } : {}),
        });
        if (!read) return { error: "No source has that id. Find it with search_sources." };
        return {
          sourceId: read.sourceId,
          name: read.name,
          ...(read.fromPage ? { fromPage: read.fromPage, toPage: read.toPage } : {}),
          text: read.text,
          link: ctx.sources.link(read.sourceId, read.fromPage),
          truncated: read.truncated,
        };
      },
    }),
  };
}
