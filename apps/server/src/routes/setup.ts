import { schema } from "@sling/db";
import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { actorFromHeaders } from "../http/session.ts";
import { serverRunnerVersion } from "../runners/builds.ts";

export async function setupRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Tells the web app whether to show first-run setup, login, or the app. */
  app.get("/api/status", async (request) => {
    const [row] = await ctx.db.select({ n: count() }).from(schema.users);
    const actor = await actorFromHeaders(ctx, request.headers);
    const [user] = actor
      ? await ctx.db
          .select({ name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.id, actor.userId))
      : [];
    return {
      needsSetup: (row?.n ?? 0) === 0,
      signedIn: actor !== null,
      email: actor?.email ?? null,
      // What the owner asked to be called at setup.
      name: user?.name.trim() || null,
      version: serverRunnerVersion() ?? "0.0.0",
      // The one address sign-in works at, so a page opened elsewhere can say so.
      publicUrl: ctx.config.publicUrl.origin,
    };
  });
}
