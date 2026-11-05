import type {
  InstallationView,
  NodeRunView,
  RunStatus,
  RunView,
  WorkflowSummaryView,
} from "@sling/core";
import { schema } from "@sling/db";
import type { WorkflowDefinition } from "@sling/workflow";
import { desc, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";

export type WorkflowRow = typeof schema.workflows.$inferSelect;
export type VersionRow = typeof schema.workflowVersions.$inferSelect;
export type RunRow = typeof schema.workflowRuns.$inferSelect;
export type NodeRunRow = typeof schema.nodeRuns.$inferSelect;
export type InstallationRow = typeof schema.connectorInstallations.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toRunView(r: RunRow, workflowName: string, versionNumber: number): RunView {
  return {
    id: r.id,
    workflowId: r.workflowId,
    workflowName,
    versionNumber,
    status: r.status,
    triggerNodeId: r.triggerNodeId,
    triggerType: r.triggerType,
    concurrencyKey: r.concurrencyKey,
    output: r.output ?? null,
    error: r.error ?? null,
    parentRunId: r.parentRunId,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
  };
}

export function toNodeRunView(n: NodeRunRow): NodeRunView {
  return {
    id: n.id,
    runId: n.runId,
    nodeId: n.nodeId,
    nodeType: n.nodeType,
    iteration: n.iteration,
    attempt: n.attempt,
    status: n.status,
    execPort: n.execPort,
    inputs: n.inputs ?? null,
    outputs: n.outputs ?? null,
    error: n.error ?? null,
    startedAt: n.startedAt.toISOString(),
    finishedAt: iso(n.finishedAt),
    durationMs: n.finishedAt ? n.finishedAt.getTime() - n.startedAt.getTime() : null,
  };
}

/** Trigger nodes of a definition, for the list page. */
export function triggerSummary(
  ctx: AppContext,
  def: WorkflowDefinition | null,
): WorkflowSummaryView["triggers"] {
  if (!def) return [];
  return def.nodes
    .filter((n) => {
      const spec = ctx.registry.get(n.type, n.version);
      return spec ? !spec.execInput : false;
    })
    .map((n) => ({
      nodeId: n.id,
      type: n.type,
      label: n.label ?? ctx.registry.get(n.type, n.version)?.title ?? n.type,
    }));
}

export async function workflowSummary(
  ctx: AppContext,
  wf: WorkflowRow,
): Promise<WorkflowSummaryView> {
  const active = wf.activeVersionId ? await ctx.engine.version(wf.activeVersionId) : null;
  const [last] = await ctx.db
    .select({
      id: schema.workflowRuns.id,
      status: schema.workflowRuns.status,
      createdAt: schema.workflowRuns.createdAt,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowId, wf.id))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(1);
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    enabled: wf.enabled,
    templateKey: wf.templateKey,
    activeVersion: active?.number ?? null,
    hasUnpublishedChanges: wf.draftDirty,
    triggers: triggerSummary(ctx, active?.definition ?? null),
    lastRun: last
      ? { id: last.id, status: last.status as RunStatus, createdAt: last.createdAt.toISOString() }
      : null,
    updatedAt: wf.updatedAt.toISOString(),
  };
}

export function toInstallationView(i: InstallationRow): InstallationView {
  return {
    id: i.id,
    connectorId: i.connectorId,
    name: i.name,
    enabled: i.enabled,
    status: i.enabled ? i.status : "disabled",
    statusDetail: i.statusDetail,
    config: i.config,
    hasCredentials: i.credentialId !== null,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}
