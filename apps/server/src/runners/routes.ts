import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { Error_Code } from "@sling/runner-protocol";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { normalizePairingCode, pairingCode, sha256Hex } from "../crypto.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { runnerView, runnerViews } from "../views.ts";

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/** Small fixed-window limiter for the unauthenticated pairing endpoint. */
const attempts = new Map<string, { count: number; resetAt: number }>();
function allowAttempt(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

export async function runnerRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Called by `sling-runner pair`. Authenticated by the one-time code only.
  r.post(
    "/api/runner/pair",
    {
      schema: {
        body: z.object({
          code: z.string().min(8).max(32),
          publicKey: z.base64().refine((k) => Buffer.from(k, "base64").length === 32, {
            message: "publicKey must be a raw 32-byte Ed25519 key",
          }),
          name: z.string().min(1).max(100),
          os: z.string().max(50),
          arch: z.string().max(50),
          hostname: z.string().max(200),
          version: z.string().max(50),
        }),
      },
    },
    async (request, reply) => {
      if (!allowAttempt(request.ip)) {
        return reply.code(429).send({ error: "Too many attempts. Wait a minute." });
      }
      const body = request.body;
      const codeHash = sha256Hex(normalizePairingCode(body.code));
      const runnerId = newId("rnr");
      const result = await ctx.db.transaction(async (tx) => {
        const [enrollment] = await tx
          .update(schema.runnerEnrollments)
          .set({ usedAt: new Date(), runnerId: null })
          .where(
            and(
              eq(schema.runnerEnrollments.codeHash, codeHash),
              isNull(schema.runnerEnrollments.usedAt),
              gt(schema.runnerEnrollments.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!enrollment) return null;
        await tx.insert(schema.runners).values({
          id: runnerId,
          workspaceId: enrollment.workspaceId,
          ownerId: enrollment.ownerId,
          name: body.name,
          publicKey: body.publicKey,
          os: body.os,
          arch: body.arch,
          hostname: body.hostname,
          version: body.version,
        });
        await tx
          .update(schema.runnerEnrollments)
          .set({ runnerId })
          .where(eq(schema.runnerEnrollments.id, enrollment.id));
        return enrollment;
      });
      if (!result) {
        return reply.code(400).send({ error: "That code is invalid, used, or expired." });
      }
      await audit(ctx, {
        workspaceId: result.workspaceId,
        actorType: "runner",
        actorId: runnerId,
        verb: "runner.paired",
        subjectType: "runner",
        subjectId: runnerId,
        details: { name: body.name, hostname: body.hostname, os: body.os },
      });
      const view = await runnerView(ctx, runnerId);
      if (view) ctx.hub.publish(result.workspaceId, { type: "runner.updated", runner: view });
      return { runnerId };
    },
  );

  await app.register(async (scope) => {
    const s = scope.withTypeProvider<ZodTypeProvider>();
    s.addHook("preHandler", requireActor(ctx));

    s.get("/api/runners", async (request) => runnerViews(ctx, actorOf(request).workspaceId));

    s.post("/api/runners/enrollments", async (request) => {
      const actor = actorOf(request);
      const code = pairingCode();
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
      await ctx.db.insert(schema.runnerEnrollments).values({
        id: newId("enr"),
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        codeHash: sha256Hex(normalizePairingCode(code)),
        expiresAt,
      });
      const url = ctx.config.publicUrl.origin;
      return {
        code,
        expiresAt: expiresAt.toISOString(),
        command: `sling-runner pair ${url} ${code}`,
      };
    });

    s.delete(
      "/api/runners/:id",
      { schema: { params: z.object({ id: z.string() }) } },
      async (request, reply) => {
        const actor = actorOf(request);
        const [row] = await ctx.db
          .update(schema.runners)
          .set({ revokedAt: new Date(), online: false })
          .where(
            and(
              eq(schema.runners.id, request.params.id),
              eq(schema.runners.workspaceId, actor.workspaceId),
              isNull(schema.runners.revokedAt),
            ),
          )
          .returning();
        if (!row) return reply.code(404).send({ error: "not found" });
        ctx.runners.disconnect(row.id, Error_Code.REVOKED, "this runner was revoked");
        await ctx.tasks?.runnerRevoked(row.id);
        await audit(ctx, {
          workspaceId: actor.workspaceId,
          actorType: "user",
          actorId: actor.userId,
          verb: "runner.revoked",
          subjectType: "runner",
          subjectId: row.id,
          details: { name: row.name },
        });
        const view = await runnerView(ctx, row.id);
        if (view) ctx.hub.publish(actor.workspaceId, { type: "runner.updated", runner: view });
        return { ok: true };
      },
    );
  });
}
