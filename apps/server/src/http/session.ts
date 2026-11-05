import { schema } from "@sling/db";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";

export interface Actor {
  userId: string;
  workspaceId: string;
  email: string;
}

const workspaceByUser = new Map<string, string>();

export async function actorFromHeaders(
  ctx: AppContext,
  headers: FastifyRequest["headers"],
): Promise<Actor | null> {
  const session = await ctx.auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session) return null;
  let workspaceId = workspaceByUser.get(session.user.id);
  if (!workspaceId) {
    const [m] = await ctx.db
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, session.user.id))
      .limit(1);
    if (!m) return null;
    workspaceId = m.workspaceId;
    workspaceByUser.set(session.user.id, workspaceId);
  }
  return { userId: session.user.id, workspaceId, email: session.user.email };
}

/** Use as a preHandler. Sets `request.actor` or replies 401. */
export function requireActor(ctx: AppContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await actorFromHeaders(ctx, request.headers);
    if (!actor) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    request.actor = actor;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}

export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw new Error("route is missing requireActor");
  return request.actor;
}
