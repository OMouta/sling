import type { PermissionMode } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, count, eq, inArray, isNull, max } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { effectiveLabels } from "../runners/labels.ts";
import { monthUsage, workspaceSettings } from "../sandboxes/settings.ts";
import type { MachineCandidate, ProviderEntry, RouteRequest, RouterInput } from "./router.ts";

/** Execution provider installations in a workspace, oldest first. Enabled ones only, unless asked. */
export async function providerInstallations(
  ctx: Pick<AppContext, "db" | "registry">,
  workspaceId: string,
  opts: { includeDisabled?: boolean } = {},
): Promise<(ProviderEntry & { connectorId: string; enabled: boolean })[]> {
  const rows = await ctx.db
    .select({
      id: schema.connectorInstallations.id,
      name: schema.connectorInstallations.name,
      connectorId: schema.connectorInstallations.connectorId,
      enabled: schema.connectorInstallations.enabled,
    })
    .from(schema.connectorInstallations)
    .where(eq(schema.connectorInstallations.workspaceId, workspaceId))
    .orderBy(asc(schema.connectorInstallations.createdAt));
  return rows.flatMap((r) => {
    const connector = ctx.registry.connector(r.connectorId);
    if (!connector?.executionProvider) return [];
    if (!r.enabled && !opts.includeDisabled) return [];
    return [{ ...r, connectorName: connector.name }];
  });
}

/** Everything the router needs about a workspace, read in a handful of queries. */
export async function loadRouterInput(
  ctx: AppContext,
  workspaceId: string,
  request: RouteRequest,
  mode: PermissionMode,
): Promise<RouterInput> {
  const db = ctx.db;
  const runners = await db
    .select()
    .from(schema.runners)
    .where(
      and(
        eq(schema.runners.workspaceId, workspaceId),
        isNull(schema.runners.revokedAt),
        eq(schema.runners.ephemeral, false),
      ),
    )
    .orderBy(asc(schema.runners.pairedAt));
  const runnerIds = runners.map((r) => r.id);
  const [repos, loads, sandboxRepos, providers, { settings }] = await Promise.all([
    runnerIds.length
      ? db
          .select()
          .from(schema.repos)
          .where(and(inArray(schema.repos.runnerId, runnerIds), isNull(schema.repos.removedAt)))
      : [],
    runnerIds.length
      ? db
          .select({ runnerId: schema.tasks.runnerId, n: count() })
          .from(schema.tasks)
          .where(
            and(
              inArray(schema.tasks.runnerId, runnerIds),
              inArray(schema.tasks.state, ["queued", "dispatched", "running"]),
            ),
          )
          .groupBy(schema.tasks.runnerId)
      : [],
    db.select().from(schema.sandboxRepos).where(eq(schema.sandboxRepos.workspaceId, workspaceId)),
    providerInstallations(ctx, workspaceId),
    workspaceSettings(ctx, workspaceId),
  ]);
  const repoIds = repos.map((r) => r.id);
  const [lastRuns, usage] = await Promise.all([
    repoIds.length
      ? db
          .select({ repoId: schema.tasks.repoId, at: max(schema.tasks.createdAt) })
          .from(schema.tasks)
          .where(inArray(schema.tasks.repoId, repoIds))
          .groupBy(schema.tasks.repoId)
      : [],
    monthUsage(db, workspaceId, settings),
  ]);
  const lastRun = new Map(lastRuns.map((r) => [r.repoId, r.at]));
  const load = new Map(loads.map((l) => [l.runnerId, l.n]));

  const machines: MachineCandidate[] = runners.map((r) => ({
    id: r.id,
    name: r.name,
    online: ctx.runners.isOnline(r.id),
    labels: effectiveLabels(r),
    capabilities: r.capabilities,
    maxMode: r.maxMode,
    maxConcurrentTasks: r.maxConcurrentTasks,
    load: load.get(r.id) ?? 0,
    pairedAt: r.pairedAt,
    repos: repos
      .filter((p) => p.runnerId === r.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        remoteKey: p.remoteKey,
        lastTaskAt: lastRun.get(p.id) ?? null,
      })),
  }));

  return {
    request,
    mode,
    machines,
    sandboxRepos: sandboxRepos.map((s) => ({
      remoteKey: s.remoteKey,
      cloneUrl: s.cloneUrl,
      defaultBranch: s.defaultBranch,
      network: s.network,
    })),
    providers: providers.map((p) => ({ id: p.id, name: p.name, connectorName: p.connectorName })),
    sandboxBudget: { usedMinutes: usage.minutes, budgetMinutes: settings.monthlyMinutesBudget },
    now: new Date(),
  };
}
