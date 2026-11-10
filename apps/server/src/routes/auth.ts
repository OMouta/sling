import type { FastifyInstance } from "fastify";
import { CLIENT_IP_HEADER } from "../auth/auth.ts";
import type { AppContext } from "../context.ts";

/** Hands /api/auth/* to Better Auth with the raw body. */
export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      const url = new URL(request.url, ctx.config.publicUrl.origin);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
      }
      // Replaces whatever the client sent: Fastify resolves the address through
      // the trusted proxies only.
      headers.set(CLIENT_IP_HEADER, request.ip);
      const body =
        request.method === "GET" || request.body == null ? undefined : String(request.body);
      const response = await ctx.auth.handler(
        new Request(url, { method: request.method, headers, body }),
      );
      reply.status(response.status);
      for (const [key, value] of response.headers) {
        if (key === "set-cookie") continue;
        reply.header(key, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
    },
  });
}
