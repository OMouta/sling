import type { SandboxListView, SandboxSettingsView } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { keyFromInput } from "../routing/router.ts";
import { SettingsInputError } from "../settings.ts";
import { sandboxViews } from "../views.ts";
import {
  allowSandboxRepo,
  removeSandboxRepo,
  SandboxRepoInput,
  SandboxSettingsPatch,
  toSandboxRepoView,
  updateSandboxSettings,
} from "./manage.ts";
import { monthUsage, secretStatus, workspaceSettings, writeSecrets } from "./settings.ts";

const RECENT_DESTROYED = 50;
const KeyParam = z.object({ remoteKey: z.string().min(1).max(300) });

async function settingsView(ctx: AppContext, workspaceId: string): Promise<SandboxSettingsView> {
  const [{ settings, defaultHarness }, secrets] = await Promise.all([
    workspaceSettings(ctx, workspaceId),
    secretStatus(ctx, workspaceId),
  ]);
  return {
    defaultHarness,
    concurrentLimit: settings.concurrentLimit,
    lifetimeMinutes: settings.lifetimeMinutes,
    monthlyMinutesBudget: settings.monthlyMinutesBudget,
    costPerHour: settings.costPerHour,
    secrets,
  };
}

export async function sandboxRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  // ------------------------------------------------------------- sandboxes

  r.get("/api/sandboxes", async (request): Promise<SandboxListView> => {
    const actor = actorOf(request);
    const ws = eq(schema.sandboxes.workspaceId, actor.workspaceId);
    const [live, recent, { settings }] = await Promise.all([
      ctx.db
        .select()
        .from(schema.sandboxes)
        .where(and(ws, ne(schema.sandboxes.state, "destroyed")))
        .orderBy(desc(schema.sandboxes.requestedAt)),
      ctx.db
        .select()
        .from(schema.sandboxes)
        .where(and(ws, eq(schema.sandboxes.state, "destroyed")))
        .orderBy(desc(schema.sandboxes.requestedAt))
        .limit(RECENT_DESTROYED),
      workspaceSettings(ctx, actor.workspaceId),
    ]);
    const rows = [...live, ...recent].sort(
      (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime(),
    );
    const usage = await monthUsage(ctx.db, actor.workspaceId, settings);
    return {
      sandboxes: await sandboxViews(ctx, rows),
      usage: {
        monthMinutes: usage.minutes,
        monthlyMinutesBudget: settings.monthlyMinutesBudget,
        running: live.filter((s) => s.state !== "requested").length,
        concurrentLimit: settings.concurrentLimit,
        estimatedMonthCost: usage.cost,
      },
    };
  });

  r.post(
    "/api/sandboxes/:id/destroy",
    { schema: { params: z.object({ id: z.string() }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const [row] = await ctx.db
        .select({ state: schema.sandboxes.state })
        .from(schema.sandboxes)
        .where(
          and(
            eq(schema.sandboxes.id, request.params.id),
            eq(schema.sandboxes.workspaceId, actor.workspaceId),
          ),
        );
      if (!row) return reply.code(404).send({ error: "not found" });
      if (row.state === "destroyed") {
        return reply.code(409).send({ error: "That sandbox is already destroyed." });
      }
      await ctx.sandboxes.destroy(actor.workspaceId, request.params.id, actor.userId);
      return { ok: true };
    },
  );

  // ------------------------------------------------------------- sandbox repos

  r.get("/api/sandbox-repos", async (request) => {
    const actor = actorOf(request);
    const rows = await ctx.db
      .select()
      .from(schema.sandboxRepos)
      .where(eq(schema.sandboxRepos.workspaceId, actor.workspaceId))
      .orderBy(asc(schema.sandboxRepos.remoteKey));
    return rows.map(toSandboxRepoView);
  });

  r.put(
    "/api/sandbox-repos/:remoteKey",
    { schema: { params: KeyParam, body: SandboxRepoInput } },
    async (request, reply) => {
      const key = keyFromInput(request.params.remoteKey);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Use a remote key such as github.com/owner/name, URL-encoded." });
      }
      try {
        return await allowSandboxRepo(ctx, actorOf(request), key, request.body);
      } catch (err) {
        if (err instanceof SettingsInputError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  r.delete(
    "/api/sandbox-repos/:remoteKey",
    { schema: { params: KeyParam } },
    async (request, reply) => {
      const key = keyFromInput(request.params.remoteKey);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Use a remote key such as github.com/owner/name, URL-encoded." });
      }
      const removed = await removeSandboxRepo(ctx, actorOf(request), key);
      return { ok: true, removed };
    },
  );

  // ------------------------------------------------------------- settings

  r.get("/api/settings/sandboxes", async (request) =>
    settingsView(ctx, actorOf(request).workspaceId),
  );

  r.put("/api/settings/sandboxes", { schema: { body: SandboxSettingsPatch } }, async (request) => {
    const actor = actorOf(request);
    await updateSandboxSettings(ctx, actor, request.body);
    return settingsView(ctx, actor.workspaceId);
  });

  r.put(
    "/api/settings/sandboxes/secrets",
    {
      schema: {
        body: z.object({
          openaiApiKey: z.string().max(4096).optional(),
          anthropicApiKey: z.string().max(4096).optional(),
          gitToken: z.string().max(4096).optional(),
        }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const trimmed = Object.fromEntries(
        Object.entries(request.body).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
      );
      const { set, cleared } = await writeSecrets(
        ctx,
        { workspaceId: actor.workspaceId, ownerId: actor.userId },
        trimmed,
      );
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "settings.sandbox_secrets_changed",
        subjectType: "workspace",
        subjectId: actor.workspaceId,
        // Which ones, never the values.
        details: { set, cleared },
      });
      return { secrets: await secretStatus(ctx, actor.workspaceId) };
    },
  );
}

/** Installations with sandboxes that still exist can't be deleted. */
export async function liveSandboxCount(
  ctx: Pick<AppContext, "db">,
  installationId: string,
): Promise<number> {
  const rows = await ctx.db
    .select({ id: schema.sandboxes.id })
    .from(schema.sandboxes)
    .where(
      and(
        eq(schema.sandboxes.providerInstallationId, installationId),
        inArray(schema.sandboxes.state, [
          "requested",
          "provisioning",
          "ready",
          "busy",
          "releasing",
          "failed",
        ]),
      ),
    );
  return rows.length;
}
