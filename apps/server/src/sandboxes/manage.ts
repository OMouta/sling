/**
 * Sandbox limits and the list of repos allowed in sandboxes, for the routes
 * and the assistant's setup tools alike.
 */
import { cloneUrlFor, HARNESSES, remoteKey, type SandboxRepoView } from "@sling/core";
import { type SandboxSettings, schema } from "@sling/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { SettingsInputError, settingsChanged } from "../settings.ts";
import { resolveSettings } from "./settings.ts";

interface Owner {
  workspaceId: string;
  userId: string;
}

type SandboxRepoRow = typeof schema.sandboxRepos.$inferSelect;

export function toSandboxRepoView(r: SandboxRepoRow): SandboxRepoView {
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

/** Whether clone URLs may be local paths, which only tests use. */
export function allowLocalCloneUrls(ctx: Pick<AppContext, "config">): boolean {
  return process.env.NODE_ENV === "test" || ctx.config.testing?.allowLocalCloneUrls === true;
}

export const SandboxRepoInput = z.object({
  /** Defaults to the HTTPS URL for the remote key. */
  cloneUrl: z.string().min(1).max(500).optional(),
  defaultBranch: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w][\w./-]*$/, "not a branch name")
    .default("main"),
  network: z.boolean().default(false),
});
export type SandboxRepoInput = z.infer<typeof SandboxRepoInput>;

/** Adds a repo to the sandbox list, or changes its entry. `key` is a normalized remote. */
export async function allowSandboxRepo(
  ctx: AppContext,
  actor: Owner,
  key: string,
  body: SandboxRepoInput,
): Promise<SandboxRepoView> {
  const cloneUrl = body.cloneUrl?.trim() || cloneUrlFor(key);
  const checked = checkCloneUrl(cloneUrl, key, allowLocalCloneUrls(ctx));
  if (!checked.ok) throw new SettingsInputError(checked.error);
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
  settingsChanged(ctx, actor.workspaceId);
  return toSandboxRepoView(row);
}

/** Takes a repo off the sandbox list. False when it wasn't on it. */
export async function removeSandboxRepo(
  ctx: AppContext,
  actor: Owner,
  key: string,
): Promise<boolean> {
  const removed = await ctx.db
    .delete(schema.sandboxRepos)
    .where(
      and(
        eq(schema.sandboxRepos.workspaceId, actor.workspaceId),
        eq(schema.sandboxRepos.remoteKey, key),
      ),
    )
    .returning({ key: schema.sandboxRepos.remoteKey });
  if (removed.length === 0) return false;
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: "sandbox_repo.disallowed",
    subjectType: "sandbox_repo",
    subjectId: key,
  });
  settingsChanged(ctx, actor.workspaceId);
  return true;
}

export const SandboxSettingsPatch = z.object({
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
});
export type SandboxSettingsPatch = z.infer<typeof SandboxSettingsPatch>;

/** Changes the sandbox limits. Parts left out stay as they are. */
export async function updateSandboxSettings(
  ctx: AppContext,
  actor: Owner,
  body: SandboxSettingsPatch,
): Promise<void> {
  const [ws] = await ctx.db
    .select({
      sandboxSettings: schema.workspaces.sandboxSettings,
      chatDefaults: schema.workspaces.chatDefaults,
    })
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
      // New chats use the same default agent. Its model belonged to the old one.
      ...(body.defaultHarness &&
      ws?.chatDefaults?.agent &&
      ws.chatDefaults.agent.harness !== body.defaultHarness
        ? {
            chatDefaults: {
              ...ws.chatDefaults,
              agent: { harness: body.defaultHarness, model: null, effort: null, fast: false },
            },
          }
        : {}),
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
  settingsChanged(ctx, actor.workspaceId);
}
