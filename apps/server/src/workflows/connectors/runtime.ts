import type {
  AnyConnector,
  ApprovalDecision,
  EventSource,
  SourceContext,
  SourceStatus,
} from "@sling/connector-sdk";
import type { InstallationStatus } from "@sling/core";
import { schema } from "@sling/db";
import type { NodeLogger } from "@sling/workflow";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { audit } from "../../audit.ts";
import type { AppContext } from "../../context.ts";
import { toInstallationView } from "../views.ts";
import { readCredentials, workspaceOwner } from "./installations.ts";

interface Running {
  installationId: string;
  workspaceId: string;
  connector: AnyConnector;
  abort: AbortController;
  source: EventSource | null;
  attempts: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  /** Set once the source reports a status of its own. */
  reported: boolean;
}

/** Longest wait between restarts of a failing source. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Runs connector event sources: one per enabled installation that an
 * enabled workflow's trigger uses. Failed sources restart with backoff.
 */
export class ConnectorRuntime {
  readonly #ctx: AppContext;
  readonly #running = new Map<string, Running>();
  #queue: Promise<void> = Promise.resolve();
  /** First restart delay. Doubles per failure up to five minutes. */
  backoffBaseMs = 1000;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** Whether a source is running for an installation. */
  isRunning(installationId: string): boolean {
    return this.#running.has(installationId);
  }

  /**
   * Starts and stops sources to match what's needed. Calls are serialized so
   * two reconciles never race on the same installation.
   */
  reconcile(workspaceId?: string): Promise<void> {
    const run = this.#queue.then(() => this.#reconcile(workspaceId));
    this.#queue = run.catch((err) => this.#ctx.log.error({ err }, "connector reconcile failed"));
    return run;
  }

  /** Stops and restarts one installation's source, after its credentials or config changed. */
  async restart(installationId: string): Promise<void> {
    const r = this.#running.get(installationId);
    if (r) await this.#stop(r);
    await this.reconcile(r?.workspaceId);
  }

  /**
   * Stops the sources of these connectors and starts whatever is still
   * needed, so they run on the connectors' current definitions. Used when an
   * extension is updated, disabled, or removed.
   */
  restartConnectors(connectorIds: ReadonlySet<string>): Promise<void> {
    const run = this.#queue.then(async () => {
      const stale = [...this.#running.values()].filter((r) => connectorIds.has(r.connector.id));
      await Promise.all(stale.map((r) => this.#stop(r)));
      await this.#reconcile();
    });
    this.#queue = run.catch((err) => this.#ctx.log.error({ err }, "connector restart failed"));
    return run;
  }

  async stopAll(): Promise<void> {
    await this.#queue;
    await Promise.all([...this.#running.values()].map((r) => this.#stop(r)));
  }

  async #reconcile(workspaceId?: string) {
    const db = this.#ctx.db;
    const installs = await db
      .select()
      .from(schema.connectorInstallations)
      .where(workspaceId ? eq(schema.connectorInstallations.workspaceId, workspaceId) : undefined);
    const used = new Set(
      (
        await db
          .selectDistinct({ id: schema.workflowTriggers.installationId })
          .from(schema.workflowTriggers)
          .where(
            and(
              isNotNull(schema.workflowTriggers.installationId),
              installs.length > 0
                ? inArray(
                    schema.workflowTriggers.installationId,
                    installs.map((i) => i.id),
                  )
                : undefined,
            ),
          )
      ).map((r) => r.id),
    );
    const wanted = new Set<string>();
    for (const inst of installs) {
      const connector = this.#ctx.registry.connector(inst.connectorId);
      const needed =
        !this.#ctx.config.automationPaused &&
        inst.enabled &&
        used.has(inst.id) &&
        connector?.source !== undefined;
      if (needed && connector) {
        wanted.add(inst.id);
        if (!this.#running.has(inst.id)) await this.#start(inst, connector);
      } else {
        const r = this.#running.get(inst.id);
        if (r) await this.#stop(r);
        const status: InstallationStatus = inst.enabled ? "idle" : "disabled";
        if (inst.status !== status) await this.#setStatus(inst.id, status, null);
      }
    }
    for (const r of this.#running.values()) {
      if ((!workspaceId || r.workspaceId === workspaceId) && !wanted.has(r.installationId)) {
        await this.#stop(r);
      }
    }
  }

  async #start(inst: typeof schema.connectorInstallations.$inferSelect, connector: AnyConnector) {
    const r: Running = {
      installationId: inst.id,
      workspaceId: inst.workspaceId,
      connector,
      abort: new AbortController(),
      source: null,
      attempts: 0,
      timer: null,
      stopped: false,
      reported: false,
    };
    this.#running.set(inst.id, r);
    await this.#launch(r);
  }

  async #launch(r: Running) {
    if (r.stopped) return;
    const [inst] = await this.#ctx.db
      .select()
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.id, r.installationId));
    if (!inst?.enabled) {
      this.#running.delete(r.installationId);
      return;
    }
    r.abort = new AbortController();
    r.reported = false;
    await this.#setStatus(inst.id, "connecting", null);
    try {
      const credentials = await readCredentials(this.#ctx, inst);
      const config = r.connector.configSchema.parse(inst.config);
      const ctx = this.#sourceContext(r, credentials, config);
      const source = await r.connector.source?.start(ctx);
      if (r.stopped) {
        await source?.stop();
        return;
      }
      r.source = source ?? null;
      // A source that started without saying otherwise is connected.
      if (!r.reported) await this.#setStatus(inst.id, "connected", null);
    } catch (err) {
      await this.#failed(r, err instanceof Error ? err.message : String(err));
    }
  }

  /** A source failed to start or reported an error: tear it down and try again later. */
  async #failed(r: Running, detail: string) {
    if (r.stopped) return;
    const source = r.source;
    r.source = null;
    r.abort.abort();
    try {
      await source?.stop();
    } catch {
      // Already broken.
    }
    await this.#setStatus(r.installationId, "error", detail);
    const delay = Math.min(this.backoffBaseMs * 2 ** r.attempts, MAX_BACKOFF_MS);
    r.attempts++;
    this.#ctx.log.warn(
      { installationId: r.installationId, delay, detail },
      "connector source failed",
    );
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = null;
      void this.#launch(r);
    }, delay);
  }

  async #stop(r: Running) {
    r.stopped = true;
    this.#running.delete(r.installationId);
    if (r.timer) clearTimeout(r.timer);
    r.abort.abort();
    try {
      await r.source?.stop();
    } catch (err) {
      this.#ctx.log.warn(
        { err, installationId: r.installationId },
        "connector source didn't stop cleanly",
      );
    }
    r.source = null;
  }

  async #setStatus(id: string, status: InstallationStatus, detail: string | null) {
    const [row] = await this.#ctx.db
      .update(schema.connectorInstallations)
      .set({ status, statusDetail: detail })
      .where(eq(schema.connectorInstallations.id, id))
      .returning();
    if (row) {
      this.#ctx.hub.publish(row.workspaceId, {
        type: "installation.updated",
        installation: toInstallationView(row),
      });
    }
  }

  #sourceContext(
    r: Running,
    credentials: Record<string, unknown>,
    config: unknown,
  ): SourceContext<unknown, unknown> {
    const ctx = this.#ctx;
    const base = ctx.log.child({ installationId: r.installationId, connector: r.connector.id });
    const log: NodeLogger = {
      info: (m, d) => base.info(d ?? {}, m),
      warn: (m, d) => base.warn(d ?? {}, m),
      error: (m, d) => base.error(d ?? {}, m),
    };
    // A source may only emit the events its own triggers listen for.
    const allowed = new Set(
      r.connector.nodes.filter((n) => n.trigger).map((n) => n.trigger?.event as string),
    );
    const abort = r.abort;
    const live = () => !r.stopped && !abort.signal.aborted;
    const db = ctx.db;
    return {
      installationId: r.installationId,
      workspaceId: r.workspaceId,
      credentials,
      config,
      log,
      signal: abort.signal,
      emit: async (event) => {
        if (!live()) return;
        if (!allowed.has(event.type)) {
          log.warn("dropped an event no trigger of this connector listens for", {
            type: event.type,
          });
          return;
        }
        await ctx.events.emit({
          type: event.type,
          workspaceId: r.workspaceId,
          installationId: r.installationId,
          payload: event.payload,
          ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        });
      },
      state: {
        get: async (key) => {
          const [row] = await db
            .select({ value: schema.connectorState.value })
            .from(schema.connectorState)
            .where(
              and(
                eq(schema.connectorState.installationId, r.installationId),
                eq(schema.connectorState.key, key),
              ),
            );
          return row?.value ?? null;
        },
        set: async (key, value) => {
          await db
            .insert(schema.connectorState)
            .values({ installationId: r.installationId, key, value })
            .onConflictDoUpdate({
              target: [schema.connectorState.installationId, schema.connectorState.key],
              set: { value, updatedAt: new Date() },
            });
        },
      },
      approvals: {
        decide: (decision) => this.#decide(r, decision),
        reportRefused: async (decision) => {
          await audit(ctx, {
            workspaceId: r.workspaceId,
            actorType: "system",
            verb: "approval.refused",
            subjectType: "approval",
            subjectId: decision.approvalId,
            details: {
              via: decision.actor.via,
              externalUserId: decision.actor.externalUserId,
              approve: decision.approve,
              reason: decision.reason,
              installationId: r.installationId,
            },
          });
        },
      },
      setStatus: (status: SourceStatus, detail?: string) => {
        if (!live()) return;
        r.reported = true;
        if (status === "error") {
          void this.#failed(r, detail ?? "The connection failed");
          return;
        }
        if (status === "connected") r.attempts = 0;
        void this.#setStatus(r.installationId, status, detail ?? null);
      },
    };
  }

  async #decide(r: Running, decision: ApprovalDecision): Promise<{ ok: boolean; message: string }> {
    const ctx = this.#ctx;
    const [a] = await ctx.db
      .select({ state: schema.approvals.state })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.id, decision.approvalId),
          eq(schema.approvals.workspaceId, r.workspaceId),
        ),
      );
    if (!a) return { ok: false, message: "That approval doesn't exist." };
    if (a.state !== "pending")
      return { ok: false, message: `That approval is already ${a.state}.` };
    const owner = await workspaceOwner(ctx, r.workspaceId);
    if (!owner) return { ok: false, message: "The workspace has no owner." };
    const ok = await ctx.tasks.decide(
      r.workspaceId,
      decision.approvalId,
      owner,
      decision.approve,
      decision.actor,
    );
    if (!ok) return { ok: false, message: "That approval is no longer pending." };
    return { ok: true, message: decision.approve ? "Approved." : "Rejected." };
  }
}
