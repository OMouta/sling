import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { RuleInputError, RuleInputSchema } from "./service.ts";

const Id = z.object({ id: z.string().min(1).max(100) });

export async function ruleRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get("/api/rules", async (request) => ctx.rules.list(actorOf(request).workspaceId));

  // From an approval card's Always allow, and from the Rules tab.
  r.post("/api/rules", { schema: { body: RuleInputSchema } }, async (request, reply) => {
    try {
      return await ctx.rules.create(actorOf(request), request.body);
    } catch (err) {
      if (err instanceof RuleInputError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // Revokes: the rule stays, for the audit, and never matches again.
  r.delete("/api/rules/:id", { schema: { params: Id } }, async (request, reply) => {
    const view = await ctx.rules.revoke(actorOf(request), request.params.id);
    if (!view) return reply.code(404).send({ error: "No such rule." });
    return view;
  });
}
