import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { NotificationAnswerSchema } from "./answers.ts";
import { PushInputError } from "./service.ts";

const base64url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, "must be base64url");

const Subscription = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: base64url.max(200), auth: base64url.max(100) }),
  label: z.string().trim().min(1).max(100),
});

/** The answers notifications send, and this user's devices for push notifications. */
export async function pushRoutes(app: FastifyInstance, ctx: AppContext) {
  answerRoutes(app, ctx);
  // The session hook stays in its own scope: the service worker answers with
  // the token its push carried, and no cookie.
  await app.register(async (scope) => deviceRoutes(scope, ctx));
}

/** This user's devices for push notifications. */
async function deviceRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get("/api/push/key", async () => ({ publicKey: ctx.push.publicKey }));

  r.get("/api/push/subscriptions", async (request) => {
    const actor = actorOf(request);
    return ctx.push.list(actor.workspaceId, actor.userId);
  });

  r.post("/api/push/subscriptions", { schema: { body: Subscription } }, async (request, reply) => {
    const actor = actorOf(request);
    try {
      return await ctx.push.subscribe(actor.workspaceId, actor.userId, request.body);
    } catch (err) {
      if (err instanceof PushInputError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  r.delete(
    "/api/push/subscriptions/:id",
    { schema: { params: z.object({ id: z.string().min(1).max(64) }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const removed = await ctx.push.remove(actor.workspaceId, actor.userId, request.params.id);
      if (!removed) return reply.code(404).send({ error: "No such device." });
      return { ok: true };
    },
  );

  r.post(
    "/api/push/test",
    { schema: { body: z.object({ id: z.string().min(1).max(64) }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const result = await ctx.push.test(actor.workspaceId, actor.userId, request.body.id);
      if (!result) return reply.code(404).send({ error: "No such device." });
      return result;
    },
  );
}

/** Allow or Deny from a notification. The token is the only credential, and it works once. */
function answerRoutes(app: FastifyInstance, ctx: AppContext) {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/approvals/:id/notification-answer",
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: NotificationAnswerSchema,
      },
    },
    async (request, reply) => {
      const result = await ctx.push.answers.answer(request.params.id, request.body);
      if ("error" in result) return reply.code(result.status).send({ error: result.error });
      return result;
    },
  );
}
