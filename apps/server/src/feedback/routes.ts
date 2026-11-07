import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { NoChatMachine } from "../agent/cli-chat.ts";
import { NoModelConfigured } from "../agent/models.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { usablePersonality } from "../personalities/service.ts";
import { clearRating, FeedbackInput, feedbackSummary, rateReply } from "./service.ts";
import { SuggestionError, suggestInstructions } from "./suggest.ts";

const Id = z.object({ id: z.string() });
const NOT_YOURS = "Only the chat's owner can rate its replies.";

/** Thumbs on replies, what they add up to for a personality, and the instructions they suggest. */
export async function feedbackRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.put(
    "/api/messages/:id/feedback",
    { schema: { params: Id, body: FeedbackInput } },
    async (request, reply) => {
      const result = await rateReply(ctx, actorOf(request), request.params.id, request.body);
      if (result === "forbidden") return reply.code(403).send({ error: NOT_YOURS });
      if (!result) return reply.code(404).send({ error: "not found" });
      return result;
    },
  );

  r.delete("/api/messages/:id/feedback", { schema: { params: Id } }, async (request, reply) => {
    const result = await clearRating(ctx, actorOf(request), request.params.id);
    if (result === "forbidden") return reply.code(403).send({ error: NOT_YOURS });
    if (!result) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  r.get("/api/personalities/:id/feedback", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const personality = await usablePersonality(ctx.db, actor.workspaceId, request.params.id);
    if (!personality) return reply.code(404).send({ error: "not found" });
    return feedbackSummary(ctx, personality);
  });

  r.post("/api/personalities/:id/suggest", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const personality = await usablePersonality(ctx.db, actor.workspaceId, request.params.id);
    if (!personality) return reply.code(404).send({ error: "not found" });
    try {
      return await suggestInstructions(ctx, actor, personality);
    } catch (err) {
      if (err instanceof SuggestionError) return reply.code(409).send({ error: err.message });
      if (err instanceof NoModelConfigured || err instanceof NoChatMachine) {
        return reply.code(409).send({ error: err.message });
      }
      ctx.log.warn({ err, personalityId: personality.id }, "suggesting instructions failed");
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `The model hit an error: ${message}` });
    }
  });
}
