import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { DeployInputError } from "../deploys/service.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { CheckInputError, CheckInputSchema, CheckPatchSchema } from "./service.ts";

const Id = z.object({ id: z.string().min(1).max(100) });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof CheckInputError || err instanceof DeployInputError) {
    return reply.code(err.status).send({ error: err.message });
  }
  throw err;
}

export async function checkRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get("/api/checks", async (request) => ctx.checks.list(actorOf(request).workspaceId));

  r.post("/api/checks", { schema: { body: CheckInputSchema } }, async (request, reply) => {
    try {
      return await ctx.checks.create(actorOf(request), request.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  r.patch(
    "/api/checks/:id",
    { schema: { params: Id, body: CheckPatchSchema } },
    async (request, reply) => {
      try {
        const view = await ctx.checks.update(actorOf(request), request.params.id, request.body);
        if (!view) return reply.code(404).send({ error: "No such check." });
        return view;
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  r.delete("/api/checks/:id", { schema: { params: Id } }, async (request, reply) => {
    const ok = await ctx.checks.remove(actorOf(request), request.params.id);
    if (!ok) return reply.code(404).send({ error: "No such check." });
    return { ok: true };
  });

  r.post("/api/checks/:id/run", { schema: { params: Id } }, async (request, reply) => {
    const view = await ctx.checks.run(actorOf(request).workspaceId, request.params.id);
    if (!view) return reply.code(404).send({ error: "No such check." });
    return view;
  });

  r.get("/api/checks/:id/results", { schema: { params: Id } }, async (request, reply) => {
    const results = await ctx.checks.results(actorOf(request).workspaceId, request.params.id);
    if (!results) return reply.code(404).send({ error: "No such check." });
    return results;
  });
}
