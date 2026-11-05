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

/**
 * Small fixed-window limiter for the unauthenticated pairing endpoint. Only
 * failed attempts count: guessing codes fails, while several sandboxes behind
 * one address pairing at once succeed.
 */
const failures = new Map<string, { count: number; resetAt: number }>();
function blocked(ip: string): boolean {
  const entry = failures.get(ip);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= 10;
}
function recordFailure(ip: string) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || entry.resetAt < now) failures.set(ip, { count: 1, resetAt: now + 60_000 });
  else entry.count += 1;
}

export async function runnerRoutes(app: FastifyInstance, ctx: AppContext) {
  async function ownedRunner(workspaceId: string, id: string) {
    const [row] = await ctx.db
      .select()
      .from(schema.runners)
      .where(
        and(
          eq(schema.runners.id, id),
          eq(schema.runners.workspaceId, workspaceId),
          eq(schema.runners.ephemeral, false),
          isNull(schema.runners.revokedAt),
        ),
      );
    return row ?? null;
  }

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
      if (blocked(request.ip)) {
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
        if (enrollment.sandboxId) {
          // A sandbox's code is only good while that sandbox is starting.
          const [sbx] = await tx
            .select({ state: schema.sandboxes.state })
            .from(schema.sandboxes)
            .where(eq(schema.sandboxes.id, enrollment.sandboxId));
          if (sbx?.state !== "provisioning") return null;
        }
        await tx.insert(schema.runners).values({
          id: runnerId,
          workspaceId: enrollment.workspaceId,
          ownerId: enrollment.ownerId,
          name: enrollment.sandboxId ? `sandbox-${enrollment.sandboxId.slice(-6)}` : body.name,
          publicKey: body.publicKey,
          os: body.os,
          arch: body.arch,
          hostname: body.hostname,
          version: body.version,
          ephemeral: enrollment.sandboxId !== null,
          sandboxId: enrollment.sandboxId,
        });
        await tx
          .update(schema.runnerEnrollments)
          .set({ runnerId })
          .where(eq(schema.runnerEnrollments.id, enrollment.id));
        return enrollment;
      });
      if (!result) {
        recordFailure(request.ip);
        return reply.code(400).send({ error: "That code is invalid, used, or expired." });
      }
      await audit(ctx, {
        workspaceId: result.workspaceId,
        actorType: "runner",
        actorId: runnerId,
        verb: "runner.paired",
        subjectType: "runner",
        subjectId: runnerId,
        details: {
          name: body.name,
          hostname: body.hostname,
          os: body.os,
          ...(result.sandboxId ? { sandboxId: result.sandboxId } : {}),
        },
      });
      if (result.sandboxId) await ctx.sandboxes.paired(result.sandboxId, runnerId);
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
        /** For a machine that already has sling-runner. */
        command: `sling-runner pair ${url} ${code}`,
        /** Installs, pairs, and starts the Runner in one go. */
        installCommand: `curl -fsSL ${url}/install.sh | SLING_CODE=${code} sh`,
        windowsInstallCommand: `$env:SLING_CODE='${code}'; irm ${url}/install.ps1 | iex`,
      };
    });

    /**
     * Allows repos the machine found: one by `path` (optionally renamed), or
     * several by `paths` in one change. The machine checks each path itself.
     */
    s.post(
      "/api/runners/:id/repos",
      {
        schema: {
          params: z.object({ id: z.string() }),
          body: z.union([
            z.object({
              path: z.string().min(1).max(1024),
              name: z
                .string()
                .regex(/^[A-Za-z0-9._-]{1,64}$/)
                .optional(),
            }),
            z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(200) }),
          ]),
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const runner = await ownedRunner(actor.workspaceId, request.params.id);
        if (!runner) return reply.code(404).send({ error: "not found" });
        if (!runner.remoteRepos) {
          return reply.code(409).send({
            error: "This machine doesn't accept repo changes from Sling.",
          });
        }
        const body = request.body;
        if ("paths" in body) {
          // Only paths the machine reported go over, so a stale list can't widen it.
          const wanted = new Set(body.paths);
          const found = runner.foundRepos.filter((f) => wanted.has(f.path));
          if (found.length === 0)
            return reply
              .code(404)
              .send({ error: "None of those repos are on the machine's list." });
          const result = await ctx.runners.changeRepo(
            runner.id,
            { op: "add-many", paths: found.map((f) => f.path) },
            60_000,
          );
          await audit(ctx, {
            workspaceId: actor.workspaceId,
            actorType: "user",
            actorId: actor.userId,
            verb: result.ok ? "runner.repo_allowed" : "runner.repo_change_refused",
            subjectType: "runner",
            subjectId: runner.id,
            details: { paths: found.map((f) => f.path), message: result.message },
          });
          if (!result.ok) return reply.code(409).send({ error: result.message });
          return { ok: true, message: result.message };
        }
        const found = runner.foundRepos.find((f) => f.path === body.path);
        if (!found)
          return reply.code(404).send({ error: "That repo isn't on the machine's list." });
        const result = await ctx.runners.changeRepo(runner.id, {
          op: "add",
          path: found.path,
          ...(body.name ? { name: body.name } : {}),
        });
        await audit(ctx, {
          workspaceId: actor.workspaceId,
          actorType: "user",
          actorId: actor.userId,
          verb: result.ok ? "runner.repo_allowed" : "runner.repo_change_refused",
          subjectType: "runner",
          subjectId: runner.id,
          details: {
            path: found.path,
            name: body.name ?? found.name,
            message: result.message,
          },
        });
        if (!result.ok) return reply.code(409).send({ error: result.message });
        return { ok: true, message: result.message };
      },
    );

    /** Stops allowing a repo on a machine. */
    s.delete(
      "/api/runners/:id/repos/:name",
      { schema: { params: z.object({ id: z.string(), name: z.string().min(1).max(64) }) } },
      async (request, reply) => {
        const actor = actorOf(request);
        const runner = await ownedRunner(actor.workspaceId, request.params.id);
        if (!runner) return reply.code(404).send({ error: "not found" });
        const result = await ctx.runners.changeRepo(runner.id, {
          op: "remove",
          name: request.params.name,
        });
        await audit(ctx, {
          workspaceId: actor.workspaceId,
          actorType: "user",
          actorId: actor.userId,
          verb: result.ok ? "runner.repo_removed" : "runner.repo_change_refused",
          subjectType: "runner",
          subjectId: runner.id,
          details: { name: request.params.name, message: result.message },
        });
        if (!result.ok) return reply.code(409).send({ error: result.message });
        return { ok: true, message: result.message };
      },
    );

    /** Asks a machine to look for repos again. */
    s.post(
      "/api/runners/:id/scan",
      { schema: { params: z.object({ id: z.string() }) } },
      async (request, reply) => {
        const actor = actorOf(request);
        const runner = await ownedRunner(actor.workspaceId, request.params.id);
        if (!runner) return reply.code(404).send({ error: "not found" });
        if (!ctx.runners.scanRepos(runner.id)) {
          return reply.code(409).send({ error: "The machine is offline." });
        }
        return { ok: true };
      },
    );

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
        await ctx.tasks.runnerRevoked(row.id);
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
