import {
  type ActionState,
  DEPLOY_METHODS,
  type DeployCheck,
  type DeployTargetView,
  MERGE_METHODS,
  newId,
} from "@sling/core";
import { type DeployHook, type DeployLastCheck, schema } from "@sling/db";
import type { RepoActionOutput, RepoActionResult } from "@sling/runner-protocol";
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { decryptSecret, encryptSecret, SECRET_KEY_VERSION } from "../crypto.ts";
import type { Actor } from "../http/session.ts";
import { keyFromInput } from "../routing/router.ts";
import type { RunnerSession } from "../runners/gateway.ts";
import { runChecks } from "./checks.ts";
import { DeploySteps } from "./steps.ts";
import { Verifier } from "./verify.ts";

export type TargetRow = typeof schema.deployTargets.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;
type ActionRow = typeof schema.actions.$inferSelect;

/** Verify waits this long before its first check when the host deploys on merge. */
export const MERGE_SETTLE_SECONDS = 60;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 3600;
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_SETTLE_SECONDS = 1800;
export const MAX_CHECKS = 5;

/** A target the request can't create or change, with the status to answer. */
export class DeployInputError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

const httpUrl = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, `${what} must be an http or https URL`);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

const CheckInput = z.object({
  url: httpUrl("A check's URL"),
  status: z.number().int().min(100).max(599).nullable().optional(),
  contains: z.string().max(500).nullable().optional(),
});

const HookInput = z.object({
  url: httpUrl("The hook URL").optional(),
  httpMethod: z.enum(["POST", "GET"]).optional(),
  headerName: z.string().trim().max(100).nullable().optional(),
  headerValue: z.string().max(4000).nullable().optional(),
});

export const TargetFields = {
  name: z.string().trim().min(1).max(80),
  remoteKey: z.string().trim().min(1).max(300),
  method: z.enum(DEPLOY_METHODS),
  mergeMethod: z.enum(MERGE_METHODS).optional(),
  runnerId: z.string().max(100).nullable().optional(),
  hook: HookInput.nullable().optional(),
  checks: z.array(CheckInput).min(1).max(MAX_CHECKS),
  versionUrl: httpUrl("The version URL").nullable().optional(),
  settleSeconds: z.number().int().min(0).max(MAX_SETTLE_SECONDS).optional(),
  timeoutSeconds: z.number().int().min(MIN_TIMEOUT_SECONDS).max(MAX_TIMEOUT_SECONDS).optional(),
};
export const TargetInput = z.object(TargetFields);
export const TargetPatch = z.object(TargetFields).partial();
export type TargetInput = z.infer<typeof TargetInput>;
export type TargetPatch = z.infer<typeof TargetPatch>;

/** What `deploys.check` and the assistant learn from checking a target. */
export interface CheckOutcome {
  target: TargetRow;
  before: DeployLastCheck | null;
  after: DeployLastCheck;
}

function normalizeChecks(checks: z.infer<typeof CheckInput>[]): DeployCheck[] {
  return checks.map((c) => ({
    url: c.url,
    status: c.status ?? null,
    contains: c.contains ? c.contains : null,
  }));
}

/** A hook from the request, filled in from the stored one where the request leaves parts out. */
function mergeHook(
  input: z.infer<typeof HookInput>,
  stored: DeployHook | null,
): DeployHook | DeployInputError {
  const url = input.url ?? stored?.url;
  if (!url) return new DeployInputError("A deploy hook needs its URL.");
  const out: DeployHook = { url, httpMethod: input.httpMethod ?? stored?.httpMethod ?? "POST" };
  if (input.headerName === undefined) {
    if (stored?.headerName && stored.headerValue !== undefined) {
      out.headerName = stored.headerName;
      out.headerValue = input.headerValue ?? stored.headerValue;
    }
    return out;
  }
  const name = input.headerName?.trim() ?? "";
  if (!name) return out;
  if (!HEADER_NAME.test(name)) {
    return new DeployInputError(`${name} isn't a valid header name.`);
  }
  const value =
    input.headerValue ?? (stored?.headerName === name ? stored.headerValue : undefined) ?? null;
  if (value === null || value === "") {
    return new DeployInputError("The hook's header needs a value.");
  }
  if (/[\r\n]/.test(value)) return new DeployInputError("The header value can't span lines.");
  out.headerName = name;
  out.headerValue = value;
  return out;
}

function lastCheckView(c: DeployLastCheck | null): DeployTargetView["lastCheck"] {
  return c ? { at: c.at, up: c.up, failures: c.failures, results: c.results } : null;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.code;
  return code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505";
}

/**
 * Deploy targets, their health checks, and the merge, deploy, and verify
 * steps of a task's delivery.
 */
export class DeployService {
  readonly #ctx: AppContext;
  readonly steps: DeploySteps;
  readonly verifier: Verifier;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
    this.steps = new DeploySteps(ctx, this);
    this.verifier = new Verifier(ctx, this);
  }

  get #db() {
    return this.#ctx.db;
  }

  // ------------------------------------------------------------- lifecycle

  /** Starts the verify worker and settles steps a previous process left in flight. */
  async start(boss: PgBoss): Promise<void> {
    await this.verifier.start(boss);
    await this.steps.recover();
  }

  /** Runs every minute: machine steps nobody answered, and verify jobs that went missing. */
  async sweep(): Promise<void> {
    await this.steps.sweep();
    await this.verifier.sweep();
  }

  /** Resolves when hook calls and API merges in flight have finished. */
  idle(): Promise<void> {
    return this.steps.idle();
  }

  // ------------------------------------------------------------- runner messages

  /** Output from a deploy command running on a machine. */
  repoActionOutput(session: RunnerSession, out: RepoActionOutput): Promise<void> {
    return this.steps.output(session, out);
  }

  /** A machine's answer to a merge or deploy. */
  repoActionResult(session: RunnerSession, result: RepoActionResult): Promise<void> {
    return this.steps.result(session, result);
  }

  /** A machine connected or sent a new inventory: steps waiting for it may go now. */
  machineConnected(runnerId: string): Promise<void> {
    return this.steps.machineConnected(runnerId);
  }

  /** Starts a merge, deploy, or verify step that's ready. */
  startStep(task: TaskRow, action: ActionRow): Promise<void> {
    return this.steps.start(task, action);
  }

  // ------------------------------------------------------------- reads

  async row(workspaceId: string, id: string): Promise<TargetRow | null> {
    const [row] = await this.#db
      .select()
      .from(schema.deployTargets)
      .where(
        and(eq(schema.deployTargets.id, id), eq(schema.deployTargets.workspaceId, workspaceId)),
      );
    return row ?? null;
  }

  /** A target by its ID or its name, which matches without regard to case. */
  async find(workspaceId: string, idOrName: string): Promise<TargetRow | null> {
    const want = idOrName.trim();
    if (!want) return null;
    const [row] = await this.#db
      .select()
      .from(schema.deployTargets)
      .where(
        and(
          eq(schema.deployTargets.workspaceId, workspaceId),
          or(
            eq(schema.deployTargets.id, want),
            sql`lower(${schema.deployTargets.name}) = ${want.toLowerCase()}`,
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The target of a repo, by its normalized remote. */
  async forRemote(workspaceId: string, remoteKey: string | null): Promise<TargetRow | null> {
    if (!remoteKey) return null;
    const [row] = await this.#db
      .select()
      .from(schema.deployTargets)
      .where(
        and(
          eq(schema.deployTargets.workspaceId, workspaceId),
          eq(schema.deployTargets.remoteKey, remoteKey),
        ),
      );
    return row ?? null;
  }

  async rows(workspaceId: string): Promise<TargetRow[]> {
    return this.#db
      .select()
      .from(schema.deployTargets)
      .where(eq(schema.deployTargets.workspaceId, workspaceId))
      .orderBy(asc(schema.deployTargets.name));
  }

  async list(workspaceId: string): Promise<DeployTargetView[]> {
    return this.views(await this.rows(workspaceId));
  }

  async view(workspaceId: string, id: string): Promise<DeployTargetView | null> {
    const row = await this.row(workspaceId, id);
    if (!row) return null;
    const [view] = await this.views([row]);
    return view ?? null;
  }

  /** Views for several targets, with three queries whatever their number. */
  async views(rows: TargetRow[]): Promise<DeployTargetView[]> {
    if (rows.length === 0) return [];
    const runnerIds = [...new Set(rows.flatMap((r) => (r.runnerId ? [r.runnerId] : [])))];
    const [runners, deploys] = await Promise.all([
      runnerIds.length
        ? this.#db
            .select({
              id: schema.runners.id,
              name: schema.runners.name,
              remoteKey: schema.repos.remoteKey,
              deployCommand: schema.repos.deployCommand,
            })
            .from(schema.runners)
            .leftJoin(
              schema.repos,
              and(eq(schema.repos.runnerId, schema.runners.id), isNull(schema.repos.removedAt)),
            )
            .where(inArray(schema.runners.id, runnerIds))
        : [],
      this.#db
        .selectDistinctOn([schema.actions.targetId], {
          targetId: schema.actions.targetId,
          taskId: schema.actions.taskId,
          taskTitle: schema.tasks.title,
          commitSha: schema.actions.commitSha,
          state: schema.actions.state,
          finishedAt: schema.actions.finishedAt,
          sentAt: schema.actions.sentAt,
          createdAt: schema.actions.createdAt,
        })
        .from(schema.actions)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.actions.taskId))
        .where(
          and(
            inArray(
              schema.actions.targetId,
              rows.map((r) => r.id),
            ),
            notInArray(schema.actions.state, ["queued", "skipped"]),
          ),
        )
        .orderBy(
          schema.actions.targetId,
          desc(schema.actions.createdAt),
          desc(schema.actions.position),
        ),
    ]);
    const lastDeploy = new Map(deploys.map((d) => [d.targetId, d]));
    return rows.map((t) => {
      const machine = runners.filter((r) => r.id === t.runnerId);
      const d = lastDeploy.get(t.id);
      return {
        id: t.id,
        name: t.name,
        remoteKey: t.remoteKey,
        method: t.method,
        mergeMethod: t.mergeMethod,
        runnerId: t.method === "command" ? t.runnerId : null,
        runnerName: t.method === "command" ? (machine[0]?.name ?? null) : null,
        command:
          t.method === "command"
            ? (machine.find((m) => m.remoteKey === t.remoteKey)?.deployCommand ?? "")
            : null,
        hook:
          t.method === "hook" && t.hookCredentialId
            ? {
                httpMethod: t.hookMethod ?? "POST",
                host: t.hookHost ?? "",
                hasHeader: t.hookHasHeader,
              }
            : null,
        checks: t.checks,
        versionUrl: t.versionUrl,
        settleSeconds: t.settleSeconds,
        timeoutSeconds: t.timeoutSeconds,
        lastCheck: lastCheckView(t.lastCheck),
        lastDeploy: d
          ? {
              taskId: d.taskId,
              taskTitle: d.taskTitle,
              commitSha: d.commitSha,
              at: (d.finishedAt ?? d.sentAt ?? d.createdAt).toISOString(),
              state: d.state as ActionState,
            }
          : null,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      };
    });
  }

  /** The decrypted hook. Never send it to a browser or a log. */
  async readHook(target: TargetRow): Promise<DeployHook | null> {
    if (!target.hookCredentialId) return null;
    const [cred] = await this.#db
      .select({ ciphertext: schema.credentials.ciphertext })
      .from(schema.credentials)
      .where(eq(schema.credentials.id, target.hookCredentialId));
    if (!cred) return null;
    return JSON.parse(decryptSecret(this.#ctx.secretsKey, cred.ciphertext)) as DeployHook;
  }

  async publish(targetId: string | null | undefined): Promise<void> {
    if (!targetId) return;
    const [row] = await this.#db
      .select()
      .from(schema.deployTargets)
      .where(eq(schema.deployTargets.id, targetId));
    if (!row) return;
    const [view] = await this.views([row]);
    if (view)
      this.#ctx.hub.publish(row.workspaceId, { type: "deploy_target.updated", target: view });
  }

  // ------------------------------------------------------------- writes

  async #checkRunner(workspaceId: string, runnerId: string | null | undefined) {
    if (!runnerId) {
      throw new DeployInputError("A command deploy needs the machine that runs the command.");
    }
    const [runner] = await this.#db
      .select({ id: schema.runners.id })
      .from(schema.runners)
      .where(
        and(
          eq(schema.runners.id, runnerId),
          eq(schema.runners.workspaceId, workspaceId),
          isNull(schema.runners.revokedAt),
          eq(schema.runners.ephemeral, false),
        ),
      );
    if (!runner) throw new DeployInputError("That machine isn't one of yours.");
  }

  async #checkUnique(workspaceId: string, name: string, remote: string, except?: string) {
    const clash = await this.#db
      .select({
        id: schema.deployTargets.id,
        name: schema.deployTargets.name,
        remoteKey: schema.deployTargets.remoteKey,
      })
      .from(schema.deployTargets)
      .where(
        and(
          eq(schema.deployTargets.workspaceId, workspaceId),
          or(
            sql`lower(${schema.deployTargets.name}) = ${name.toLowerCase()}`,
            eq(schema.deployTargets.remoteKey, remote),
          ),
        ),
      );
    for (const c of clash) {
      if (c.id === except) continue;
      if (c.remoteKey === remote) {
        throw new DeployInputError(`${remote} already has a deploy target, ${c.name}.`, 409);
      }
      throw new DeployInputError(`There's already a deploy target called ${c.name}.`, 409);
    }
  }

  #remote(input: string): string {
    const key = keyFromInput(input);
    if (!key) {
      throw new DeployInputError(
        "The repo must be a remote such as github.com/owner/name, or its URL.",
      );
    }
    return key;
  }

  async #writeHook(
    owner: { workspaceId: string; ownerId: string },
    credentialId: string | null,
    hook: DeployHook,
  ): Promise<string> {
    const ciphertext = encryptSecret(this.#ctx.secretsKey, JSON.stringify(hook));
    if (credentialId) {
      const updated = await this.#db
        .update(schema.credentials)
        .set({ ciphertext, keyVersion: SECRET_KEY_VERSION })
        .where(eq(schema.credentials.id, credentialId))
        .returning({ id: schema.credentials.id });
      if (updated.length) return credentialId;
    }
    const id = newId("crd");
    await this.#db.insert(schema.credentials).values({
      id,
      workspaceId: owner.workspaceId,
      ownerId: owner.ownerId,
      kind: "deploy_hook",
      ciphertext,
      keyVersion: SECRET_KEY_VERSION,
    });
    return id;
  }

  async #dropHook(credentialId: string | null) {
    if (!credentialId) return;
    await this.#db.delete(schema.credentials).where(eq(schema.credentials.id, credentialId));
  }

  async create(actor: Actor, input: TargetInput): Promise<DeployTargetView> {
    const remote = this.#remote(input.remoteKey);
    await this.#checkUnique(actor.workspaceId, input.name, remote);
    if (input.method === "command") await this.#checkRunner(actor.workspaceId, input.runnerId);
    let hook: DeployHook | null = null;
    if (input.method === "hook") {
      if (!input.hook?.url) throw new DeployInputError("A deploy hook needs its URL.");
      const merged = mergeHook(input.hook, null);
      if (merged instanceof DeployInputError) throw merged;
      hook = merged;
    }
    const id = newId("dpt");
    const credentialId = hook
      ? await this.#writeHook({ workspaceId: actor.workspaceId, ownerId: actor.userId }, null, hook)
      : null;
    try {
      await this.#db.insert(schema.deployTargets).values({
        id,
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        name: input.name,
        remoteKey: remote,
        method: input.method,
        mergeMethod: input.mergeMethod ?? "squash",
        runnerId: input.method === "command" ? (input.runnerId ?? null) : null,
        hookCredentialId: credentialId,
        hookHost: hook ? new URL(hook.url).host : null,
        hookMethod: hook?.httpMethod ?? null,
        hookHasHeader: Boolean(hook?.headerName),
        checks: normalizeChecks(input.checks),
        versionUrl: input.versionUrl ?? null,
        settleSeconds: input.settleSeconds ?? (input.method === "merge" ? MERGE_SETTLE_SECONDS : 0),
        timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      });
    } catch (err) {
      await this.#dropHook(credentialId);
      if (isUniqueViolation(err)) {
        throw new DeployInputError("A deploy target with that name or repo already exists.", 409);
      }
      throw err;
    }
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "deploy_target.created",
      subjectType: "deploy_target",
      subjectId: id,
      details: { name: input.name, remoteKey: remote, method: input.method },
    });
    const view = await this.view(actor.workspaceId, id);
    if (!view) throw new Error("deploy target vanished");
    this.#ctx.hub.publish(actor.workspaceId, { type: "deploy_target.updated", target: view });
    return view;
  }

  async update(actor: Actor, id: string, patch: TargetPatch): Promise<DeployTargetView> {
    const row = await this.row(actor.workspaceId, id);
    if (!row) throw new DeployInputError("No such deploy target.", 404);
    const name = patch.name ?? row.name;
    const remote = patch.remoteKey !== undefined ? this.#remote(patch.remoteKey) : row.remoteKey;
    if (name !== row.name || remote !== row.remoteKey) {
      await this.#checkUnique(actor.workspaceId, name, remote, row.id);
    }
    const method = patch.method ?? row.method;
    const runnerId =
      method === "command" ? (patch.runnerId !== undefined ? patch.runnerId : row.runnerId) : null;
    if (method === "command") await this.#checkRunner(actor.workspaceId, runnerId);

    let credentialId = row.hookCredentialId;
    let hookFields: Partial<TargetRow> = {};
    if (method === "hook") {
      const stored = await this.readHook(row);
      if (patch.hook) {
        const merged = mergeHook(patch.hook, stored);
        if (merged instanceof DeployInputError) throw merged;
        credentialId = await this.#writeHook(
          { workspaceId: row.workspaceId, ownerId: row.ownerId },
          credentialId,
          merged,
        );
        hookFields = {
          hookCredentialId: credentialId,
          hookHost: new URL(merged.url).host,
          hookMethod: merged.httpMethod,
          hookHasHeader: Boolean(merged.headerName),
        };
      } else if (!stored) {
        throw new DeployInputError("A deploy hook needs its URL.");
      }
    } else if (credentialId) {
      // The hook isn't needed any more, so its secret goes.
      hookFields = {
        hookCredentialId: null,
        hookHost: null,
        hookMethod: null,
        hookHasHeader: false,
      };
    }

    const changed: string[] = Object.keys(patch).filter(
      (k) => patch[k as keyof TargetPatch] !== undefined,
    );
    try {
      await this.#db
        .update(schema.deployTargets)
        .set({
          name,
          remoteKey: remote,
          method,
          runnerId,
          ...hookFields,
          ...(patch.mergeMethod ? { mergeMethod: patch.mergeMethod } : {}),
          ...(patch.checks ? { checks: normalizeChecks(patch.checks) } : {}),
          ...(patch.versionUrl !== undefined ? { versionUrl: patch.versionUrl } : {}),
          ...(patch.settleSeconds !== undefined ? { settleSeconds: patch.settleSeconds } : {}),
          ...(patch.timeoutSeconds !== undefined ? { timeoutSeconds: patch.timeoutSeconds } : {}),
          // A different repo or different checks make the last check meaningless.
          ...(patch.checks || remote !== row.remoteKey ? { lastCheck: null } : {}),
        })
        .where(eq(schema.deployTargets.id, row.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DeployInputError("A deploy target with that name or repo already exists.", 409);
      }
      throw err;
    }
    if (method !== "hook" && row.hookCredentialId) await this.#dropHook(row.hookCredentialId);
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "deploy_target.updated",
      subjectType: "deploy_target",
      subjectId: row.id,
      details: { name, remoteKey: remote, method, changed },
    });
    const view = await this.view(actor.workspaceId, row.id);
    if (!view) throw new Error("deploy target vanished");
    this.#ctx.hub.publish(actor.workspaceId, { type: "deploy_target.updated", target: view });
    return view;
  }

  async remove(actor: Actor, id: string): Promise<boolean> {
    const [row] = await this.#db
      .delete(schema.deployTargets)
      .where(
        and(
          eq(schema.deployTargets.id, id),
          eq(schema.deployTargets.workspaceId, actor.workspaceId),
        ),
      )
      .returning();
    if (!row) return false;
    await this.#dropHook(row.hookCredentialId);
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "deploy_target.removed",
      subjectType: "deploy_target",
      subjectId: row.id,
      details: { name: row.name, remoteKey: row.remoteKey, method: row.method },
    });
    this.#ctx.hub.publish(actor.workspaceId, { type: "deploy_target.removed", id: row.id });
    return true;
  }

  // ------------------------------------------------------------- checks

  /**
   * Runs a target's checks now and saves what they saw: up when every check
   * passed, and how many checks in a row failed.
   */
  async checkTarget(target: TargetRow): Promise<CheckOutcome> {
    const results = await runChecks(target.checks);
    const up = results.every((r) => r.ok);
    return this.#db.transaction(async (tx) => {
      const [current] = await tx
        .select({ lastCheck: schema.deployTargets.lastCheck })
        .from(schema.deployTargets)
        .where(eq(schema.deployTargets.id, target.id))
        .for("update");
      const before = current?.lastCheck ?? null;
      const at = new Date().toISOString();
      const after: DeployLastCheck = {
        at,
        up,
        failures: up ? 0 : (before?.failures ?? 0) + 1,
        results,
        since: before && before.up === up && before.since ? before.since : at,
      };
      await tx
        .update(schema.deployTargets)
        // A check isn't a change to the target, so updatedAt stays.
        .set({ lastCheck: after, updatedAt: sql`${schema.deployTargets.updatedAt}` })
        .where(eq(schema.deployTargets.id, target.id));
      return { target: { ...target, lastCheck: after }, before, after };
    });
  }

  /** Runs a target's checks now, saves what they saw, and returns the target. */
  async check(workspaceId: string, targetId: string): Promise<DeployTargetView | null> {
    const row = await this.row(workspaceId, targetId);
    if (!row) return null;
    const { target } = await this.checkTarget(row);
    const [view] = await this.views([target]);
    if (view) this.#ctx.hub.publish(workspaceId, { type: "deploy_target.updated", target: view });
    return view ?? null;
  }
}
