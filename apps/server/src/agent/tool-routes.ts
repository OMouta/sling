import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { agentTools } from "./tools.ts";

interface ToolLike {
  description?: string;
  inputSchema: z.ZodType;
  execute?: (
    input: unknown,
    options: { toolCallId: string; messages: []; abortSignal?: AbortSignal },
  ) => unknown;
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
  const grantOf = (header: string | undefined) => {
    const token = bearer(header);
    return token ? ctx.cliChat.grant(token) : null;
  };
  const scopeOf = (header: string | undefined) => {
    const grant = grantOf(header);
    return grant
      ? {
          workspaceId: grant.workspaceId,
          ownerId: grant.ownerId,
          conversationId: grant.conversationId,
          trace: ctx.cliChat.traceFor(grant.turnId),
          allowed: grant.tools,
          appTools: grant.appTools,
        }
      : null;
  };
  /** Sling's own tools the turn may call, and the tools for the user's apps built with it. */
  const toolsOf = (scope: NonNullable<ReturnType<typeof scopeOf>>) => {
    const own = agentTools(ctx, scope, scope.allowed) as unknown as Record<string, ToolLike>;
    const apps = Object.entries(scope.appTools as Record<string, ToolLike>).filter(([name]) =>
      scope.allowed.has(name),
    );
    return { ...own, ...Object.fromEntries(apps) };
  };

  app.get("/api/agent/tools", async (request, reply) => {
    const scope = scopeOf(request.headers.authorization);
    if (!scope) return reply.code(401).send({ error: "unknown or expired token" });
    const tools = toolsOf(scope);
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
      const tools = toolsOf(scope);
      const t = Object.hasOwn(tools, request.params.name) ? tools[request.params.name] : undefined;
      if (!t?.execute)
        return reply.code(404).send({ error: `no tool named ${request.params.name}` });
      const trace = scope.trace;
      const name = request.params.name;
      const args = request.body?.arguments ?? {};
      // Unique for good: a send's idempotency key comes from it, and request IDs start over on restart.
      const callId = `mcp_${randomBytes(12).toString("base64url")}`;
      trace?.toolStarted(callId, name, args);
      const parsed = t.inputSchema.safeParse(args);
      if (!parsed.success) {
        const content = `Invalid arguments: ${z.prettifyError(parsed.error)}`;
        trace?.toolFinished(callId, false, content);
        return { content, isError: true };
      }
      // The agent gave up on the call, as when its turn was stopped.
      const gone = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      try {
        const result = await t.execute(parsed.data, {
          toolCallId: callId,
          messages: [],
          abortSignal: gone.signal,
        });
        const content = JSON.stringify(result ?? null);
        trace?.toolFinished(callId, true, content);
        return { content, isError: false };
      } catch (err) {
        ctx.log.warn({ err, tool: name }, "assistant tool failed");
        const content = err instanceof Error ? err.message : String(err);
        trace?.toolFinished(callId, false, content);
        return { content, isError: true };
      }
    },
  );
}
