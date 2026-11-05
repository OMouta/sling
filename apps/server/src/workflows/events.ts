import { schema } from "@sling/db";
import { and, eq, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { RunRow } from "./views.ts";

/** Something that happened, offered to every subscribed trigger. */
export interface BusEvent {
  type: string;
  workspaceId: string;
  /** Connector events: only triggers on this installation see it. */
  installationId?: string;
  /** Only triggers of this workflow see it, for follow-ups bound to one workflow. */
  workflowId?: string;
  payload: unknown;
  at?: Date;
  /** Repeat emits with the same key start no second run in the same workflow. */
  dedupeKey?: string;
}

/**
 * Matches events against `workflow_triggers` and starts a run for every
 * trigger whose spec accepts it.
 */
export class EventBus {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** Returns the runs the event started. */
  async emit(event: BusEvent): Promise<RunRow[]> {
    const ctx = this.#ctx;
    const at = event.at ?? new Date();
    const where: SQL[] = [
      eq(schema.workflowTriggers.workspaceId, event.workspaceId),
      eq(schema.workflowTriggers.event, event.type),
      eq(schema.workflows.enabled, true),
    ];
    if (event.installationId) {
      where.push(eq(schema.workflowTriggers.installationId, event.installationId));
    }
    if (event.workflowId) where.push(eq(schema.workflowTriggers.workflowId, event.workflowId));
    const rows = await ctx.db
      .select({ trigger: schema.workflowTriggers, ownerId: schema.workflows.ownerId })
      .from(schema.workflowTriggers)
      .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowTriggers.workflowId))
      .where(and(...where));

    const runs: RunRow[] = [];
    for (const { trigger, ownerId } of rows) {
      try {
        const version = await ctx.engine.version(trigger.versionId);
        const node = version?.graph.nodes.get(trigger.nodeId);
        const spec = node ? ctx.registry.get(node.type, node.version) : undefined;
        if (!node || !spec?.trigger) continue;
        const parsed = (
          spec.configSchema as { safeParse(v: unknown): { success: boolean; data?: unknown } }
        ).safeParse(node.config);
        if (!parsed.success) {
          ctx.log.warn({ triggerId: trigger.id }, "trigger config no longer parses; skipping");
          continue;
        }
        const match = spec.trigger.match(
          {
            type: event.type,
            workspaceId: event.workspaceId,
            ...(event.installationId ? { installationId: event.installationId } : {}),
            payload: event.payload,
            at,
          },
          parsed.data,
        );
        if (!match) continue;
        const run = await ctx.engine.startRun({
          workflowId: trigger.workflowId,
          workspaceId: trigger.workspaceId,
          ownerId,
          versionId: trigger.versionId,
          triggerNodeId: trigger.nodeId,
          outputs: match.outputs,
          concurrencyKey: match.concurrencyKey ?? null,
          dedupeKey: event.dedupeKey ?? null,
          installationId: event.installationId ?? null,
        });
        if (run) runs.push(run);
      } catch (err) {
        ctx.log.error(
          { err, triggerId: trigger.id, event: event.type },
          "trigger failed to start a run",
        );
      }
    }
    return runs;
  }
}
