import {
  type AnyConnector,
  type ProviderConfigBase,
  type ProviderContext,
  SANDBOX_LABELS,
  type SandboxSpec,
} from "@sling/connector-sdk";
import {
  APPROVAL_TTL_MS,
  type Harness,
  isTerminalAction,
  isTerminalTask,
  newId,
  SANDBOX_ENV,
  type SandboxFallbackPayload,
  type SandboxState,
} from "@sling/core";
import { schema } from "@sling/db";
import { Error_Code } from "@sling/runner-protocol";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { normalizePairingCode, pairingCode, sha256Hex } from "../crypto.ts";
import type { RouteDecision } from "../routing/router.ts";
import { sandboxMinutes, sandboxView, taskView } from "../views.ts";
import { readCredentials } from "../workflows/connectors/installations.ts";
import { REDACTED, secretStrings } from "../workflows/redact.ts";
import {
  monthUsage,
  type ResolvedSandboxSettings,
  readSecrets,
  workspaceSettings,
} from "./settings.ts";

type SandboxRow = typeof schema.sandboxes.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;
type InstallationRow = typeof schema.connectorInstallations.$inferSelect;
type SandboxDecision = Extract<RouteDecision, { kind: "sandbox" }>;

/** How long a sandbox's Runner has to connect after the provider starts it. */
export const BOOT_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a sandbox's one-time pairing code lasts. */
export const SANDBOX_CODE_TTL_MS = 15 * 60 * 1000;
/** Safety net inside the sandbox: its Runner exits after this long without a task. */
export const IDLE_EXIT_SECONDS = 900;
export const DEFAULT_SANDBOX_IMAGE = "sling-sandbox:latest";
const CREATE_TIMEOUT_MS = 5 * 60 * 1000;
const DESTROY_TIMEOUT_MS = 2 * 60 * 1000;
const LIST_TIMEOUT_MS = 60 * 1000;
/** A teardown that hasn't finished after this long is retried by the sweep. */
const TEARDOWN_RETRY_MS = 60 * 1000;

/** States that hold a provider resource, and count against the concurrent limit. */
const HOLDING: SandboxState[] = ["provisioning", "ready", "busy", "releasing", "failed"];
const NOT_DESTROYED: SandboxState[] = ["requested", ...HOLDING];

function scrub(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join(REDACTED);
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sandboxes: provisioning through an execution provider, binding the task when
 * the sandbox's Runner connects, teardown once the task is delivered, the
 * fallback approval, and the sweep that enforces limits and removes orphans.
 */
export class SandboxService {
  readonly #ctx: AppContext;
  /** Per-workspace chain, so two requests never race for the last slot. */
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #tearingDown = new Set<string>();
  readonly #background = new Set<Promise<unknown>>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  get #db() {
    return this.#ctx.db;
  }

  /** Resolves when provider calls started in the background have finished. Tests use it. */
  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  #inBackground(label: string, work: () => Promise<unknown>) {
    const p = work().catch((err) => this.#ctx.log.error({ err }, label));
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }

  // ------------------------------------------------------------- requesting

  /**
   * Requests a sandbox for a task that waits unbound. It provisions right away
   * when a slot is free, and otherwise waits as `requested`.
   */
  async request(task: TaskRow, providerInstallationId: string, remoteKey: string) {
    const id = newId("sbx");
    const [row] = await this.#db
      .insert(schema.sandboxes)
      .values({
        id,
        workspaceId: task.workspaceId,
        ownerId: task.ownerId,
        providerInstallationId,
        taskId: task.id,
        harness: task.harness,
        remoteKey,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    await this.#db
      .update(schema.tasks)
      .set({ sandboxId: id, environment: "sandbox" })
      .where(eq(schema.tasks.id, task.id));
    await audit(this.#ctx, {
      workspaceId: task.workspaceId,
      actorType: "system",
      verb: "sandbox.requested",
      subjectType: "sandbox",
      subjectId: id,
      details: { taskId: task.id, providerInstallationId, remoteKey, harness: task.harness },
    });
    await this.publish(id);
    await this.pump(task.workspaceId);
    return row;
  }

  /** Starts requested sandboxes while the workspace has free slots. */
  pump(workspaceId: string): Promise<void> {
    const prev = this.#pumps.get(workspaceId) ?? Promise.resolve();
    const next = prev.then(() => this.#pump(workspaceId));
    const settled = next.catch((err) => this.#ctx.log.error({ err, workspaceId }, "sandbox pump"));
    this.#pumps.set(workspaceId, settled);
    void settled.finally(() => {
      if (this.#pumps.get(workspaceId) === settled) this.#pumps.delete(workspaceId);
    });
    return settled;
  }

  async #pump(workspaceId: string) {
    const { settings } = await workspaceSettings(this.#ctx, workspaceId);
    for (;;) {
      const holding = await this.#db
        .select({ id: schema.sandboxes.id })
        .from(schema.sandboxes)
        .where(
          and(
            eq(schema.sandboxes.workspaceId, workspaceId),
            inArray(schema.sandboxes.state, HOLDING),
          ),
        );
      if (holding.length >= settings.concurrentLimit) return;
      const [next] = await this.#db
        .select()
        .from(schema.sandboxes)
        .where(
          and(
            eq(schema.sandboxes.workspaceId, workspaceId),
            eq(schema.sandboxes.state, "requested"),
          ),
        )
        .orderBy(asc(schema.sandboxes.requestedAt))
        .limit(1);
      if (!next) return;
      await this.#provision(next, settings);
    }
  }

  /**
   * Claims a slot, mints the pairing code, and starts the provider's create in
   * the background. Problems found before the provider is called fail the
   * sandbox and its task right here.
   */
  async #provision(sbx: SandboxRow, settings: ResolvedSandboxSettings) {
    const now = new Date();
    const lifetimeMinutes = settings.lifetimeMinutes;
    const [claimed] = await this.#db
      .update(schema.sandboxes)
      .set({
        state: "provisioning",
        provisioningAt: now,
        expiresAt: new Date(now.getTime() + lifetimeMinutes * 60_000),
      })
      .where(and(eq(schema.sandboxes.id, sbx.id), eq(schema.sandboxes.state, "requested")))
      .returning();
    if (!claimed) return;

    const prepared = await this.#prepare(claimed, settings).catch((err: unknown) => ({
      ok: false as const,
      error: `Sling couldn't prepare the sandbox: ${errorText(err)}`,
    }));
    if (!prepared.ok) {
      await this.#fail(claimed, prepared.error);
      return;
    }
    const { spec, connector, pctx, secrets, install } = prepared;
    await this.#db
      .update(schema.sandboxes)
      .set({ image: spec.image })
      .where(eq(schema.sandboxes.id, claimed.id));
    await audit(this.#ctx, {
      workspaceId: claimed.workspaceId,
      actorType: "system",
      verb: "sandbox.provisioning",
      subjectType: "sandbox",
      subjectId: claimed.id,
      details: {
        taskId: claimed.taskId,
        provider: install.name,
        connectorId: install.connectorId,
        image: spec.image,
        remoteKey: claimed.remoteKey,
        harness: claimed.harness,
        // Names only. Values never leave the spec.
        env: Object.keys(spec.env).sort(),
        lifetimeSeconds: spec.lifetimeSeconds,
      },
    });
    await this.publish(claimed.id);
    await this.#publishTask(claimed.taskId);

    this.#inBackground("sandbox create", async () => {
      const provider = connector.executionProvider;
      if (!provider) throw new Error("not an execution provider");
      let externalId: string;
      try {
        const created = await provider.create(
          { ...pctx, signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) },
          spec,
        );
        externalId = created.externalId;
      } catch (err) {
        await this.#fail(
          claimed,
          `The provider couldn't start it: ${scrub(errorText(err), secrets)}`,
        );
        return;
      }
      const [row] = await this.#db
        .update(schema.sandboxes)
        .set({ externalId })
        .where(eq(schema.sandboxes.id, claimed.id))
        .returning();
      await audit(this.#ctx, {
        workspaceId: claimed.workspaceId,
        actorType: "system",
        verb: "sandbox.created",
        subjectType: "sandbox",
        subjectId: claimed.id,
        details: { externalId },
      });
      if (row && (row.state === "destroyed" || row.destroyedAt)) {
        // Torn down while the provider was still creating it.
        await this.#destroyExternal(row, externalId);
        return;
      }
      await this.publish(claimed.id);
    });
  }

  async #prepare(sbx: SandboxRow, settings: ResolvedSandboxSettings) {
    const db = this.#db;
    const { lifetimeMinutes, monthlyMinutesBudget: budget } = settings;
    const [task] = sbx.taskId
      ? await db.select().from(schema.tasks).where(eq(schema.tasks.id, sbx.taskId))
      : [];
    // biome-ignore lint/complexity/useOptionalChain: the explicit check keeps `task` narrowed below.
    if (!task || task.state !== "queued" || task.runnerId) {
      return { ok: false as const, error: "Its task isn't waiting for it any more." };
    }
    const { minutes } = await monthUsage(db, sbx.workspaceId, settings);
    if (minutes >= budget) {
      return {
        ok: false as const,
        error: `This month's ${budget} sandbox minutes are used up. Raise the budget in Settings to run more.`,
      };
    }
    const [install] = await db
      .select()
      .from(schema.connectorInstallations)
      .where(
        and(
          eq(schema.connectorInstallations.id, sbx.providerInstallationId),
          eq(schema.connectorInstallations.workspaceId, sbx.workspaceId),
        ),
      );
    if (!install?.enabled)
      return { ok: false as const, error: "Its sandbox provider is gone or disabled." };
    const connector = this.#ctx.registry.connector(install.connectorId);
    if (!connector?.executionProvider) {
      return {
        ok: false as const,
        error: `The ${install.connectorId} connector isn't an available sandbox provider.`,
      };
    }
    const [repo] = await db
      .select()
      .from(schema.sandboxRepos)
      .where(
        and(
          eq(schema.sandboxRepos.workspaceId, sbx.workspaceId),
          eq(schema.sandboxRepos.remoteKey, sbx.remoteKey),
        ),
      );
    if (!repo)
      return { ok: false as const, error: `${sbx.remoteKey} is no longer allowed in sandboxes.` };

    const pctx = await this.#providerContext(install, connector);
    const config = pctx.config as ProviderConfigBase;
    const controlPlaneUrl = config.controlPlaneUrl || this.#ctx.config.publicUrl.origin;
    const image = config.image || this.#ctx.config.sandboxImage || DEFAULT_SANDBOX_IMAGE;

    const code = pairingCode();
    const codeHash = sha256Hex(normalizePairingCode(code));
    await db.insert(schema.runnerEnrollments).values({
      id: newId("enr"),
      workspaceId: sbx.workspaceId,
      ownerId: sbx.ownerId,
      codeHash,
      expiresAt: new Date(Date.now() + SANDBOX_CODE_TTL_MS),
      sandboxId: sbx.id,
    });
    await db
      .update(schema.sandboxes)
      .set({ bootCodeHash: codeHash })
      .where(eq(schema.sandboxes.id, sbx.id));

    const stored = await readSecrets(this.#ctx, sbx.workspaceId);
    const harness: Harness = sbx.harness;
    const env: Record<string, string> = {
      [SANDBOX_ENV.url]: controlPlaneUrl,
      [SANDBOX_ENV.pairCode]: code,
      [SANDBOX_ENV.sandboxId]: sbx.id,
      [SANDBOX_ENV.repos]: JSON.stringify([
        {
          name: task.repoName,
          cloneUrl: repo.cloneUrl,
          defaultBranch: repo.defaultBranch,
          network: repo.network,
        },
      ]),
      [SANDBOX_ENV.harnesses]: harness,
      [SANDBOX_ENV.maxMode]: "full-access",
      [SANDBOX_ENV.idleExitSeconds]: String(IDLE_EXIT_SECONDS),
    };
    if (harness === "codex" && stored.openaiApiKey) {
      env[SANDBOX_ENV.openaiApiKey] = stored.openaiApiKey;
    }
    if (harness === "claude-code" && stored.anthropicApiKey) {
      env[SANDBOX_ENV.anthropicApiKey] = stored.anthropicApiKey;
    }
    if (stored.gitToken) env[SANDBOX_ENV.gitToken] = stored.gitToken;
    const testing = this.#ctx.config.testing;
    if (testing?.sandboxCodexBin) env.SLING_CODEX_BIN = testing.sandboxCodexBin;
    if (testing?.sandboxClaudeBin) env.SLING_CLAUDE_BIN = testing.sandboxClaudeBin;

    const spec: SandboxSpec = {
      sandboxId: sbx.id,
      workspaceId: sbx.workspaceId,
      image,
      env,
      labels: { [SANDBOX_LABELS.sandbox]: sbx.id, [SANDBOX_LABELS.workspace]: sbx.workspaceId },
      ...(config.cpus ? { cpus: config.cpus } : {}),
      ...(config.memoryMb ? { memoryMb: config.memoryMb } : {}),
      lifetimeSeconds: lifetimeMinutes * 60,
    };
    const secrets = new Set<string>([code, ...Object.values(stored)]);
    secretStrings(pctx.credentials as Record<string, unknown>, connector.secretFields, secrets);
    return { ok: true as const, spec, connector, pctx, secrets, install };
  }

  async #providerContext(
    install: InstallationRow,
    connector: AnyConnector,
  ): Promise<ProviderContext<unknown, unknown>> {
    const log = this.#ctx.log.child({ installationId: install.id, connector: connector.id });
    return {
      installationId: install.id,
      workspaceId: install.workspaceId,
      credentials: connector.credentialsSchema.parse(await readCredentials(this.#ctx, install)),
      config: connector.configSchema.parse(install.config),
      log: {
        info: (m, d) => log.info(d ?? {}, m),
        warn: (m, d) => log.warn(d ?? {}, m),
        error: (m, d) => log.error(d ?? {}, m),
      },
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    };
  }

  // ------------------------------------------------------------- fallback

  /** No machine could take the task: ask whether to run it in a sandbox. Returns the approval ID. */
  async offerFallback(task: TaskRow, decision: SandboxDecision): Promise<string> {
    const id = newId("apv");
    const payload: SandboxFallbackPayload = {
      taskId: task.id,
      taskTitle: task.title,
      remoteKey: decision.repo.remoteKey,
      cloneUrl: decision.repo.cloneUrl,
      providerInstallationId: decision.provider.id,
      providerName: decision.provider.name,
      harness: task.harness,
      reasons: decision.reasons,
    };
    await this.#db.insert(schema.approvals).values({
      id,
      workspaceId: task.workspaceId,
      ownerId: task.ownerId,
      kind: "sandbox_fallback",
      title: `Run "${task.title}" in a ${decision.provider.connectorName} sandbox?`,
      payload: payload as unknown as Record<string, unknown>,
      taskId: task.id,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    });
    await audit(this.#ctx, {
      workspaceId: task.workspaceId,
      actorType: "system",
      verb: "sandbox.fallback_offered",
      subjectType: "task",
      subjectId: task.id,
      details: {
        approvalId: id,
        remoteKey: payload.remoteKey,
        provider: payload.providerName,
        reasons: payload.reasons,
      },
    });
    return id;
  }

  /**
   * The fallback approval was decided or expired. Approving provisions the
   * sandbox. Rejecting or expiring cancels the task.
   */
  async fallbackDecided(
    approval: typeof schema.approvals.$inferSelect,
    outcome: "approved" | "rejected" | "expired",
  ): Promise<void> {
    if (!approval.taskId) return;
    const [task] = await this.#db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, approval.taskId));
    // biome-ignore lint/complexity/useOptionalChain: the explicit check keeps `task` narrowed below.
    if (!task || task.state !== "queued" || task.runnerId || task.sandboxId) return;
    if (outcome !== "approved") {
      await this.#ctx.tasks.end(
        task.id,
        outcome === "rejected"
          ? "You chose not to run it in a sandbox, so it was cancelled."
          : "Nobody approved running it in a sandbox within 24 hours, so it was cancelled.",
        "cancelled",
      );
      return;
    }
    const payload = approval.payload as unknown as SandboxFallbackPayload | null;
    if (!payload?.providerInstallationId || !payload.remoteKey) return;
    await this.request(task, payload.providerInstallationId, payload.remoteKey);
  }

  // ------------------------------------------------------------- the Runner

  /** A sandbox's Runner paired. Links it, and refuses codes for sandboxes that are gone. */
  async paired(sandboxId: string, runnerId: string): Promise<void> {
    await this.#db
      .update(schema.sandboxes)
      .set({ runnerId })
      .where(eq(schema.sandboxes.id, sandboxId));
    const [row] = await this.#db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxId));
    if (row) {
      await audit(this.#ctx, {
        workspaceId: row.workspaceId,
        actorType: "runner",
        actorId: runnerId,
        verb: "sandbox.paired",
        subjectType: "sandbox",
        subjectId: sandboxId,
      });
    }
    await this.publish(sandboxId);
  }

  /**
   * A Runner connected or sent a new inventory. For a sandbox's Runner with its
   * repo cloned, this binds the waiting task to it, so normal dispatch sends it.
   */
  async runnerConnected(runnerId: string): Promise<void> {
    const [runner] = await this.#db
      .select()
      .from(schema.runners)
      .where(eq(schema.runners.id, runnerId));
    if (!runner?.ephemeral || !runner.sandboxId) return;
    const [sbx] = await this.#db
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, runner.sandboxId));
    if (!sbx || !["provisioning", "ready", "busy"].includes(sbx.state)) {
      await this.#revokeRunner(runner.id, runner.workspaceId);
      return;
    }
    if (sbx.state !== "provisioning" || !sbx.taskId) return;
    const [task] = await this.#db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, sbx.taskId));
    if (!task) return;
    const [repo] = await this.#db
      .select()
      .from(schema.repos)
      .where(
        and(
          eq(schema.repos.runnerId, runner.id),
          eq(schema.repos.name, task.repoName),
          isNull(schema.repos.removedAt),
        ),
      );
    if (!repo) return; // Not cloned yet. A later inventory, or the boot timeout, settles it.
    const bound = await this.#db
      .update(schema.tasks)
      .set({ runnerId: runner.id, repoId: repo.id })
      .where(
        and(
          eq(schema.tasks.id, task.id),
          isNull(schema.tasks.runnerId),
          eq(schema.tasks.state, "queued"),
        ),
      )
      .returning({ id: schema.tasks.id });
    const [ready] = await this.#db
      .update(schema.sandboxes)
      .set({ state: "ready", readyAt: new Date() })
      .where(and(eq(schema.sandboxes.id, sbx.id), eq(schema.sandboxes.state, "provisioning")))
      .returning();
    if (ready) {
      await audit(this.#ctx, {
        workspaceId: sbx.workspaceId,
        actorType: "runner",
        actorId: runner.id,
        verb: "sandbox.ready",
        subjectType: "sandbox",
        subjectId: sbx.id,
        details: { taskId: task.id, bound: bound.length > 0 },
      });
      await this.publish(sbx.id);
    }
    if (bound.length) await this.#publishTask(task.id);
  }

  /** The task was sent to the sandbox's Runner. */
  async taskDispatched(sandboxId: string): Promise<void> {
    const [row] = await this.#db
      .update(schema.sandboxes)
      .set({ state: "busy" })
      .where(and(eq(schema.sandboxes.id, sandboxId), eq(schema.sandboxes.state, "ready")))
      .returning({ id: schema.sandboxes.id });
    if (row) await this.publish(sandboxId);
  }

  // ------------------------------------------------------------- teardown

  /**
   * Task service hook. Once the task is over and its delivery steps are done,
   * the sandbox goes.
   */
  async onTaskSettled(taskId: string): Promise<void> {
    const [task] = await this.#db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (!task?.sandboxId || !isTerminalTask(task.state)) return;
    const open = await this.#db
      .select({ state: schema.actions.state })
      .from(schema.actions)
      .where(eq(schema.actions.taskId, taskId));
    if (!open.every((a) => isTerminalAction(a.state))) return;
    const sandboxId = task.sandboxId;
    this.#inBackground("sandbox teardown", () => this.teardown(sandboxId));
  }

  /**
   * Destroys a sandbox: revokes its Runner, removes it at the provider, and
   * records its minutes. A failed sandbox keeps its failure. Safe to call more
   * than once.
   */
  async teardown(sandboxId: string): Promise<void> {
    if (this.#tearingDown.has(sandboxId)) return;
    this.#tearingDown.add(sandboxId);
    try {
      const [sbx] = await this.#db
        .select()
        .from(schema.sandboxes)
        .where(eq(schema.sandboxes.id, sandboxId));
      if (!sbx || sbx.state === "destroyed") return;
      let row = sbx;
      if (sbx.state !== "failed" && sbx.state !== "releasing") {
        const [releasing] = await this.#db
          .update(schema.sandboxes)
          .set({ state: "releasing" })
          .where(and(eq(schema.sandboxes.id, sandboxId), eq(schema.sandboxes.state, sbx.state)))
          .returning();
        if (!releasing) return;
        row = releasing;
        await audit(this.#ctx, {
          workspaceId: row.workspaceId,
          actorType: "system",
          verb: "sandbox.releasing",
          subjectType: "sandbox",
          subjectId: sandboxId,
        });
        await this.publish(sandboxId);
      }

      // The code can't pair anything any more, and the Runner is cut off.
      await this.#db
        .update(schema.runnerEnrollments)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.runnerEnrollments.sandboxId, sandboxId),
            isNull(schema.runnerEnrollments.usedAt),
          ),
        );
      const [runner] = await this.#db
        .select({ id: schema.runners.id })
        .from(schema.runners)
        .where(eq(schema.runners.sandboxId, sandboxId));
      const runnerId = row.runnerId ?? runner?.id ?? null;
      if (runnerId) await this.#revokeRunner(runnerId, row.workspaceId);

      if (row.externalId && !(await this.#destroyExternal(row, row.externalId))) return;

      const destroyedAt = new Date();
      const minutes = sandboxMinutes({ ...row, destroyedAt: null }, destroyedAt);
      const [done] = await this.#db
        .update(schema.sandboxes)
        .set({ state: "destroyed", destroyedAt, minutes })
        .where(eq(schema.sandboxes.id, sandboxId))
        .returning();
      await audit(this.#ctx, {
        workspaceId: row.workspaceId,
        actorType: "system",
        verb: "sandbox.destroyed",
        subjectType: "sandbox",
        subjectId: sandboxId,
        details: {
          minutes: Math.round(minutes * 100) / 100,
          externalId: row.externalId,
          failure: done?.failure ?? null,
        },
      });
      await this.publish(sandboxId);
      await this.#publishTask(row.taskId);
      await this.pump(row.workspaceId);
    } finally {
      this.#tearingDown.delete(sandboxId);
    }
  }

  /** Removes the provider's resource. Returns false when the provider refused, so a sweep retries. */
  async #destroyExternal(row: SandboxRow, externalId: string): Promise<boolean> {
    const [install] = await this.#db
      .select()
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.id, row.providerInstallationId));
    const connector = install ? this.#ctx.registry.connector(install.connectorId) : undefined;
    if (!install || !connector?.executionProvider) {
      this.#ctx.log.warn(
        { sandboxId: row.id, externalId },
        "sandbox provider is gone, so its resource can't be removed",
      );
      return true;
    }
    try {
      const pctx = await this.#providerContext(install, connector);
      await connector.executionProvider.destroy(
        { ...pctx, signal: AbortSignal.timeout(DESTROY_TIMEOUT_MS) },
        externalId,
      );
      return true;
    } catch (err) {
      this.#ctx.log.error({ err, sandboxId: row.id }, "sandbox destroy failed; the sweep retries");
      return false;
    }
  }

  async #revokeRunner(runnerId: string, workspaceId: string) {
    const [revoked] = await this.#db
      .update(schema.runners)
      .set({ revokedAt: new Date(), online: false })
      .where(and(eq(schema.runners.id, runnerId), isNull(schema.runners.revokedAt)))
      .returning({ id: schema.runners.id });
    this.#ctx.runners.disconnect(runnerId, Error_Code.REVOKED, "the sandbox was destroyed");
    if (!revoked) return;
    await this.#ctx.tasks.runnerRevoked(runnerId);
    await audit(this.#ctx, {
      workspaceId,
      actorType: "system",
      verb: "runner.revoked",
      subjectType: "runner",
      subjectId: runnerId,
      details: { reason: "sandbox destroyed" },
    });
  }

  /** Fails a sandbox that never got going, ends its task, and tears it down. */
  async #fail(sbx: SandboxRow, failure: string) {
    await this.#markFailed(sbx.id, failure);
    if (sbx.taskId)
      await this.#ctx.tasks.end(sbx.taskId, `Couldn't run it in a sandbox: ${failure}`);
    await this.teardown(sbx.id);
  }

  /**
   * Records why a sandbox is going before its task is ended, so the teardown
   * the task's settling starts keeps the reason.
   */
  async #markFailed(sandboxId: string, failure: string) {
    const [row] = await this.#db
      .update(schema.sandboxes)
      .set({ state: "failed", failure })
      .where(
        and(eq(schema.sandboxes.id, sandboxId), inArray(schema.sandboxes.state, NOT_DESTROYED)),
      )
      .returning();
    if (!row) return;
    await audit(this.#ctx, {
      workspaceId: row.workspaceId,
      actorType: "system",
      verb: "sandbox.failed",
      subjectType: "sandbox",
      subjectId: sandboxId,
      details: { failure },
    });
    await this.publish(sandboxId);
  }

  /** Destroys a sandbox on request. Its task is interrupted if it's still going. */
  async destroy(workspaceId: string, sandboxId: string, userId: string): Promise<boolean> {
    const [sbx] = await this.#db
      .select()
      .from(schema.sandboxes)
      .where(
        and(eq(schema.sandboxes.id, sandboxId), eq(schema.sandboxes.workspaceId, workspaceId)),
      );
    if (!sbx || sbx.state === "destroyed") return false;
    await audit(this.#ctx, {
      workspaceId,
      actorType: "user",
      actorId: userId,
      verb: "sandbox.destroy_requested",
      subjectType: "sandbox",
      subjectId: sandboxId,
    });
    await this.#markFailed(sandboxId, "Destroyed from the Sandboxes page.");
    if (sbx.taskId) await this.#ctx.tasks.end(sbx.taskId, "You destroyed its sandbox.");
    await this.teardown(sandboxId);
    return true;
  }

  // ------------------------------------------------------------- sweep

  /**
   * Runs every minute: boot timeouts, lifetimes, waiting requests, stuck
   * teardowns, and resources the provider still has that Sling doesn't.
   */
  async sweep(): Promise<void> {
    const db = this.#db;
    const now = Date.now();

    const stuck = await db
      .select()
      .from(schema.sandboxes)
      .where(
        and(
          eq(schema.sandboxes.state, "provisioning"),
          lt(schema.sandboxes.provisioningAt, new Date(now - BOOT_TIMEOUT_MS)),
        ),
      );
    for (const s of stuck) {
      await this.#fail(s, "Its Runner didn't connect within 10 minutes.");
    }

    const expired = await db
      .select()
      .from(schema.sandboxes)
      .where(
        and(
          inArray(schema.sandboxes.state, ["provisioning", "ready", "busy", "releasing"]),
          isNotNull(schema.sandboxes.expiresAt),
          lt(schema.sandboxes.expiresAt, new Date(now)),
        ),
      );
    for (const s of expired) {
      const limit =
        s.expiresAt && s.provisioningAt
          ? Math.round((s.expiresAt.getTime() - s.provisioningAt.getTime()) / 60_000)
          : null;
      const failure = limit
        ? `It reached its ${limit}-minute lifetime.`
        : "It reached its lifetime limit.";
      await this.#markFailed(s.id, failure);
      if (s.taskId) await this.#ctx.tasks.end(s.taskId, `The sandbox was destroyed: ${failure}`);
      await this.teardown(s.id);
    }

    const unfinished = await db
      .select({ id: schema.sandboxes.id })
      .from(schema.sandboxes)
      .where(
        and(
          inArray(schema.sandboxes.state, ["releasing", "failed"]),
          lt(schema.sandboxes.updatedAt, new Date(now - TEARDOWN_RETRY_MS)),
        ),
      );
    for (const s of unfinished) await this.teardown(s.id);

    const waiting = await db
      .selectDistinct({ workspaceId: schema.sandboxes.workspaceId })
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.state, "requested"));
    for (const w of waiting) await this.pump(w.workspaceId);

    await this.#sweepOrphans();
  }

  /** Destroys what providers still run with Sling's label but Sling has no live sandbox for. */
  async #sweepOrphans() {
    const installs = await this.#db
      .select()
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.enabled, true));
    for (const install of installs) {
      const connector = this.#ctx.registry.connector(install.connectorId);
      const provider = connector?.executionProvider;
      if (!connector || !provider) continue;
      let listed: { externalId: string; sandboxId: string | null }[];
      let pctx: ProviderContext<unknown, unknown>;
      try {
        pctx = await this.#providerContext(install, connector);
        listed = await provider.list({ ...pctx, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      } catch (err) {
        this.#ctx.log.warn({ err, installationId: install.id }, "sandbox provider list failed");
        continue;
      }
      if (listed.length === 0) continue;
      const ids = listed.flatMap((l) => (l.sandboxId ? [l.sandboxId] : []));
      const live = new Set(
        ids.length
          ? (
              await this.#db
                .select({ id: schema.sandboxes.id })
                .from(schema.sandboxes)
                .where(
                  and(
                    inArray(schema.sandboxes.id, ids),
                    inArray(schema.sandboxes.state, NOT_DESTROYED),
                  ),
                )
            ).map((r) => r.id)
          : [],
      );
      for (const item of listed) {
        if (item.sandboxId && live.has(item.sandboxId)) continue;
        try {
          await provider.destroy(
            { ...pctx, signal: AbortSignal.timeout(DESTROY_TIMEOUT_MS) },
            item.externalId,
          );
          await audit(this.#ctx, {
            workspaceId: install.workspaceId,
            actorType: "system",
            verb: "sandbox.orphan_destroyed",
            subjectType: "sandbox",
            subjectId: item.sandboxId ?? item.externalId,
            details: { externalId: item.externalId, providerInstallationId: install.id },
          });
        } catch (err) {
          this.#ctx.log.warn(
            { err, installationId: install.id, externalId: item.externalId },
            "orphan sandbox destroy failed",
          );
        }
      }
    }
  }

  // ------------------------------------------------------------- events

  async publish(sandboxId: string): Promise<void> {
    const view = await sandboxView(this.#ctx, sandboxId);
    if (!view) return;
    const [row] = await this.#db
      .select({ workspaceId: schema.sandboxes.workspaceId })
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, sandboxId));
    if (row) this.#ctx.hub.publish(row.workspaceId, { type: "sandbox.updated", sandbox: view });
  }

  async #publishTask(taskId: string | null) {
    if (!taskId) return;
    const view = await taskView(this.#ctx, taskId);
    if (!view) return;
    const [row] = await this.#db
      .select({ workspaceId: schema.tasks.workspaceId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    if (row) this.#ctx.hub.publish(row.workspaceId, { type: "task.updated", task: view });
  }
}
