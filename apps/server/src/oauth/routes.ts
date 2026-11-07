import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { OAUTH_PROVIDERS, OAuthCallbackQuery, OAuthError, OAuthStartQuery } from "./service.ts";

const Provider = z.object({ provider: z.enum(OAUTH_PROVIDERS) });

/** Where the browser lands after a consent, on the Connectors page. */
function back(
  outcome: "connected" | "failed",
  detail?: { installationId?: string; error?: string },
) {
  const q = new URLSearchParams({ oauth: outcome });
  if (detail?.installationId) q.set("installation", detail.installationId);
  if (detail?.error) q.set("error", detail.error);
  return `/connectors?${q}`;
}

export async function oauthRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  /** The session the consent is bound to. */
  const sessionId = async (request: FastifyRequest) =>
    (await ctx.auth.api.getSession({ headers: fromNodeHeaders(request.headers) }))?.session.id ??
    "";

  r.get(
    "/api/oauth/:provider/start",
    { schema: { params: Provider, querystring: OAuthStartQuery } },
    async (request, reply) => {
      try {
        const url = await ctx.oauth.startUrl(
          actorOf(request),
          await sessionId(request),
          request.params.provider,
          request.query.installationId,
        );
        return reply.redirect(url);
      } catch (err) {
        if (err instanceof OAuthError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );

  r.get(
    "/api/oauth/:provider/callback",
    { schema: { params: Provider, querystring: OAuthCallbackQuery } },
    async (request, reply) => {
      try {
        const done = await ctx.oauth.callback(
          await sessionId(request),
          request.params.provider,
          request.query,
        );
        return reply.redirect(back("connected", { installationId: done.installationId }));
      } catch (err) {
        if (err instanceof OAuthError)
          return reply.redirect(back("failed", { error: err.message }));
        throw err;
      }
    },
  );
}
