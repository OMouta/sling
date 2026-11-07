import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { MemoryInputError, MemoryInputSchema, MemoryPatchSchema, MemoryQuery } from "./service.ts";

const Id = z.object({ id: z.string().min(1).max(100) });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof MemoryInputError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export async function memoryRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get("/api/memories", { schema: { querystring: MemoryQuery } }, async (request) =>
    ctx.memory.list(actorOf(request), request.query.q ? { q: request.query.q } : {}),
  );

  r.post("/api/memories", { schema: { body: MemoryInputSchema } }, async (request, reply) => {
    try {
      return await ctx.memory.create(actorOf(request), request.body, { kind: "manual" });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  r.patch(
    "/api/memories/:id",
    { schema: { params: Id, body: MemoryPatchSchema } },
    async (request, reply) => {
      try {
        const view = await ctx.memory.update(actorOf(request), request.params.id, request.body);
        if (!view) return reply.code(404).send({ error: "No such memory." });
        return view;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  r.delete("/api/memories/:id", { schema: { params: Id } }, async (request, reply) => {
    const ok = await ctx.memory.remove(actorOf(request), request.params.id);
    if (!ok) return reply.code(404).send({ error: "No such memory." });
    return { ok: true };
  });
}
