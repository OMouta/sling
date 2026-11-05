import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { agentTools } from "./tools.ts";

interface ToolLike {
  description?: string;
  inputSchema: z.ZodType;
  execute?: (input: unknown, options: { toolCallId: string; messages: [] }) => unknown;
}

function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}

/**
 * Sling's assistant tools, for a turn that runs on a coding agent's CLI.
 * `sling-runner mcp` serves them to the CLI and calls here with the turn's
 * token, which only works while that turn runs, for its conversation.
 */
export async function agentToolRoutes(app: FastifyInstance, ctx: AppContext) {
  const scopeOf = (header: string | undefined) => {
    const token = bearer(header);
    const grant = token ? ctx.cliChat.grant(token) : null;
    return grant
      ? {
          workspaceId: grant.workspaceId,
          ownerId: grant.ownerId,
          conversationId: grant.conversationId,
        }
      : null;
  };

  app.get("/api/agent/tools", async (request, reply) => {
    const scope = scopeOf(request.headers.authorization);
    if (!scope) return reply.code(401).send({ error: "unknown or expired token" });
    const tools = agentTools(ctx, scope) as unknown as Record<string, ToolLike>;
    return {
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        description: t.description ?? "",
        inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }),
      })),
    };
  });

  app.post<{ Params: { name: string }; Body: { arguments?: unknown } }>(
    "/api/agent/tools/:name",
    async (request, reply) => {
      const scope = scopeOf(request.headers.authorization);
      if (!scope) return reply.code(401).send({ error: "unknown or expired token" });
      const tools = agentTools(ctx, scope) as unknown as Record<string, ToolLike>;
      const t = Object.hasOwn(tools, request.params.name) ? tools[request.params.name] : undefined;
      if (!t?.execute)
        return reply.code(404).send({ error: `no tool named ${request.params.name}` });
      const parsed = t.inputSchema.safeParse(request.body?.arguments ?? {});
      if (!parsed.success) {
        return { content: `Invalid arguments: ${z.prettifyError(parsed.error)}`, isError: true };
      }
      try {
        const result = await t.execute(parsed.data, { toolCallId: request.id, messages: [] });
        return { content: JSON.stringify(result ?? null), isError: false };
      } catch (err) {
        ctx.log.warn({ err, tool: request.params.name }, "assistant tool failed");
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  );
}
