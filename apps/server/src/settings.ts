/**
 * Workspace and notification settings, for the settings routes and the
 * assistant's setup tools alike. Each change is audited and tells open
 * pages to load the settings again.
 */
import type { NotificationSettings, PermissionMode } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type ChatSettingsPatch, chatDefaults, mergeSettings } from "./agent/chat-settings.ts";
import { audit } from "./audit.ts";
import type { AppContext } from "./context.ts";
import { notificationSettings } from "./push/payloads.ts";
import { isTimeZone } from "./timezone.ts";
import { followWorkspaceZone } from "./workflows/triggers.ts";

interface Owner {
  workspaceId: string;
  userId: string;
}

export class SettingsInputError extends Error {}

export const NotificationsPatch = z.object({
  approvals: z.boolean().optional(),
  tasks: z.boolean().optional(),
  replies: z.boolean().optional(),
});
export type NotificationsPatch = z.infer<typeof NotificationsPatch>;

export function settingsChanged(ctx: Pick<AppContext, "hub">, workspaceId: string) {
  ctx.hub.publish(workspaceId, { type: "settings.updated" });
}

export async function setDefaultMode(ctx: AppContext, actor: Owner, mode: PermissionMode) {
  await ctx.db
    .update(schema.workspaces)
    .set({ defaultMode: mode })
    .where(eq(schema.workspaces.id, actor.workspaceId));
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: "settings.default_mode_changed",
    subjectType: "workspace",
    subjectId: actor.workspaceId,
    details: { mode },
  });
  settingsChanged(ctx, actor.workspaceId);
}

export async function setTimeZone(ctx: AppContext, actor: Owner, timeZone: string) {
  if (!isTimeZone(timeZone)) {
    throw new SettingsInputError(`${timeZone} isn't a time zone this server knows.`);
  }
  await ctx.db
    .update(schema.workspaces)
    .set({ timeZone })
    .where(eq(schema.workspaces.id, actor.workspaceId));
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: "settings.time_zone_changed",
    subjectType: "workspace",
    subjectId: actor.workspaceId,
    details: { timeZone },
  });
  await followWorkspaceZone(ctx, actor.workspaceId);
  settingsChanged(ctx, actor.workspaceId);
}

/** The user's push categories. */
export async function notificationsOf(
  ctx: Pick<AppContext, "db">,
  actor: Owner,
): Promise<NotificationSettings> {
  const m = schema.workspaceMembers;
  const [member] = await ctx.db
    .select({ notifications: m.notifications })
    .from(m)
    .where(and(eq(m.workspaceId, actor.workspaceId), eq(m.userId, actor.userId)));
  return notificationSettings(member?.notifications);
}

/** Which pushes the user gets. Categories left out keep their setting. */
export async function setNotifications(
  ctx: AppContext,
  actor: Owner,
  patch: NotificationsPatch,
): Promise<NotificationSettings> {
  const m = schema.workspaceMembers;
  const where = and(eq(m.workspaceId, actor.workspaceId), eq(m.userId, actor.userId));
  const next = notificationSettings({ ...(await notificationsOf(ctx, actor)), ...patch });
  await ctx.db.update(m).set({ notifications: next }).where(where);
  settingsChanged(ctx, actor.workspaceId);
  return next;
}

/** What new conversations start with. */
export async function setChatDefaults(
  ctx: AppContext,
  actor: Owner,
  patch: z.infer<typeof ChatSettingsPatch>,
) {
  const [ws] = await ctx.db
    .select({ chatDefaults: schema.workspaces.chatDefaults })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, actor.workspaceId));
  const next = mergeSettings(ws?.chatDefaults, patch);
  await ctx.db
    .update(schema.workspaces)
    .set({
      chatDefaults: next,
      // The sandbox settings show the same default agent.
      ...(next.agent ? { defaultHarness: next.agent.harness } : {}),
    })
    .where(eq(schema.workspaces.id, actor.workspaceId));
  settingsChanged(ctx, actor.workspaceId);
  return chatDefaults(ctx, actor.workspaceId);
}
