import {
  cloneUrlFor,
  HARNESSES,
  remoteKey,
  type SandboxListView,
  type SandboxRepoView,
  type SandboxSettingsView,
} from "@sling/core";
import type { SandboxSettings } from "@sling/db";
import { schema } from "@sling/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { keyFromInput } from "../routing/router.ts";
import { sandboxViews } from "../views.ts";
import {
  monthUsage,
  resolveSettings,
  secretStatus,
  workspaceSettings,
  writeSecrets,
} from "./settings.ts";

const RECENT_DESTROYED = 50;
const KeyParam = z.object({ remoteKey: z.string().min(1).max(300) });

type SandboxRepoRow = typeof schema.sandboxRepos.$inferSelect;

function toSandboxRepoView(r: SandboxRepoRow): SandboxRepoView {
  return {
    remoteKey: r.remoteKey,
    cloneUrl: r.cloneUrl,
    defaultBranch: r.defaultBranch,
    network: r.network,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Checks a sandbox clone URL. Sandboxes clone only over HTTPS, with the git
 * token from Settings rather than one in the URL. Tests may use local paths.
 */
export function checkCloneUrl(
  cloneUrl: string,
  key: string,
  allowLocal: boolean,
): { ok: true } | { ok: false; error: string } {
  if (allowLocal && (cloneUrl.startsWith("file://") || cloneUrl.startsWith("/"))) {
    return { ok: true };
  }
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    return { ok: false, error: "The clone URL isn't a URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The clone URL must use HTTPS." };
  if (url.username || url.password) {
    return {
      ok: false,
      error:
        "Leave credentials out of the clone URL. Store a GitHub token under Settings → Sandboxes instead.",
    };
  }
  const urlKey = remoteKey(cloneUrl);
  if (urlKey !== key) {
    return { ok: false, error: `The clone URL is for ${urlKey ?? "another repo"}, not ${key}.` };
  }
  return { ok: true };
}

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
  const allowLocal = () =>
    process.env.NODE_ENV === "test" || ctx.config.testing?.allowLocalCloneUrls === true;

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
    {
      schema: {
        params: KeyParam,
        body: z.object({
          /** Defaults to the HTTPS URL for the remote key. */
          cloneUrl: z.string().min(1).max(500).optional(),
          defaultBranch: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[\w][\w./-]*$/, "not a branch name")
            .default("main"),
          network: z.boolean().default(false),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const key = keyFromInput(request.params.remoteKey);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Use a remote key such as github.com/owner/name, URL-encoded." });
      }
      const body = request.body;
      const cloneUrl = body.cloneUrl?.trim() || cloneUrlFor(key);
      const checked = checkCloneUrl(cloneUrl, key, allowLocal());
      if (!checked.ok) return reply.code(400).send({ error: checked.error });
      const [row] = await ctx.db
        .insert(schema.sandboxRepos)
        .values({
          workspaceId: actor.workspaceId,
          ownerId: actor.userId,
          remoteKey: key,
          cloneUrl,
          defaultBranch: body.defaultBranch,
          network: body.network,
        })
        .onConflictDoUpdate({
          target: [schema.sandboxRepos.workspaceId, schema.sandboxRepos.remoteKey],
          set: { cloneUrl, defaultBranch: body.defaultBranch, network: body.network },
        })
        .returning();
      if (!row) throw new Error("upsert failed");
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "sandbox_repo.allowed",
        subjectType: "sandbox_repo",
        subjectId: key,
        details: { cloneUrl, defaultBranch: body.defaultBranch, network: body.network },
      });
      return toSandboxRepoView(row);
    },
  );

  r.delete(
    "/api/sandbox-repos/:remoteKey",
    { schema: { params: KeyParam } },
    async (request, reply) => {
      const actor = actorOf(request);
      const key = keyFromInput(request.params.remoteKey);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Use a remote key such as github.com/owner/name, URL-encoded." });
      }
      const removed = await ctx.db
        .delete(schema.sandboxRepos)
        .where(
          and(
            eq(schema.sandboxRepos.workspaceId, actor.workspaceId),
            eq(schema.sandboxRepos.remoteKey, key),
          ),
        )
        .returning({ key: schema.sandboxRepos.remoteKey });
      if (removed.length) {
        await audit(ctx, {
          workspaceId: actor.workspaceId,
          actorType: "user",
          actorId: actor.userId,
          verb: "sandbox_repo.disallowed",
          subjectType: "sandbox_repo",
          subjectId: key,
        });
      }
      return { ok: true, removed: removed.length > 0 };
    },
  );

  // ------------------------------------------------------------- settings

  r.get("/api/settings/sandboxes", async (request) =>
    settingsView(ctx, actorOf(request).workspaceId),
  );

  r.put(
    "/api/settings/sandboxes",
    {
      schema: {
        body: z.object({
          defaultHarness: z.enum(HARNESSES).optional(),
          concurrentLimit: z.number().int().min(1).max(50).optional(),
          lifetimeMinutes: z
            .number()
            .int()
            .min(5)
            .max(24 * 60)
            .optional(),
          monthlyMinutesBudget: z.number().int().min(0).max(1_000_000).optional(),
          /** Replaces the whole map. Provider installation ID to cost per hour. */
          costPerHour: z.record(z.string(), z.number().finite().min(0).max(10_000)).optional(),
        }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body;
      const [ws] = await ctx.db
        .select({ sandboxSettings: schema.workspaces.sandboxSettings })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, actor.workspaceId));
      const current = resolveSettings(ws?.sandboxSettings);
      const next: SandboxSettings = {
        concurrentLimit: body.concurrentLimit ?? current.concurrentLimit,
        lifetimeMinutes: body.lifetimeMinutes ?? current.lifetimeMinutes,
        monthlyMinutesBudget: body.monthlyMinutesBudget ?? current.monthlyMinutesBudget,
        costPerHour: body.costPerHour ?? current.costPerHour,
      };
      await ctx.db
        .update(schema.workspaces)
        .set({
          sandboxSettings: next,
          ...(body.defaultHarness ? { defaultHarness: body.defaultHarness } : {}),
        })
        .where(eq(schema.workspaces.id, actor.workspaceId));
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "settings.sandboxes_changed",
        subjectType: "workspace",
        subjectId: actor.workspaceId,
        details: { ...body },
      });
      // A higher limit may let waiting requests start.
      if (body.concurrentLimit !== undefined) await ctx.sandboxes.pump(actor.workspaceId);
      return settingsView(ctx, actor.workspaceId);
    },
  );

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
