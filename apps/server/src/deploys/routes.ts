import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CheckInputError } from "../checks/service.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { DeployLaterError } from "../tasks/service.ts";
import { taskView } from "../views.ts";
import { DeployInputError, TargetInput, TargetPatch } from "./service.ts";

const Id = z.object({ id: z.string().min(1).max(100) });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DeployInputError || err instanceof CheckInputError) {
    return reply.code(err.status).send({ error: err.message });
  }
  throw err;
}

export async function deployRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get("/api/deploy-targets", async (request) => ctx.deploys.list(actorOf(request).workspaceId));

  r.post("/api/deploy-targets", { schema: { body: TargetInput } }, async (request, reply) => {
    try {
      return await ctx.deploys.create(actorOf(request), request.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  r.patch(
    "/api/deploy-targets/:id",
    { schema: { params: Id, body: TargetPatch } },
    async (request, reply) => {
      try {
        return await ctx.deploys.update(actorOf(request), request.params.id, request.body);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  r.delete("/api/deploy-targets/:id", { schema: { params: Id } }, async (request, reply) => {
    const ok = await ctx.deploys.remove(actorOf(request), request.params.id);
    if (!ok) return reply.code(404).send({ error: "No such deploy target." });
    return { ok: true };
  });

  r.post("/api/deploy-targets/:id/check", { schema: { params: Id } }, async (request, reply) => {
    const view = await ctx.deploys.check(actorOf(request).workspaceId, request.params.id);
    if (!view) return reply.code(404).send({ error: "No such deploy target." });
    return view;
  });

  r.post("/api/tasks/:id/deploy", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    try {
      await ctx.tasks.deployLater(actor.workspaceId, request.params.id, actor.userId);
    } catch (err) {
      if (err instanceof DeployLaterError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
    const view = await taskView(ctx, request.params.id);
    if (!view) return reply.code(404).send({ error: "No such task." });
    return view;
  });
}
