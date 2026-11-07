import {
  type ActionState,
  DEPLOY_METHODS,
  type DeployCheck,
  type DeployMethod,
  type DeployTargetView,
  MERGE_METHODS,
  type MergeMethod,
  newId,
  type SiteCheckConfig,
} from "@sling/core";
import { type DeployHook, type DeployLastCheck, schema } from "@sling/db";
import type { RepoActionOutput, RepoActionResult } from "@sling/runner-protocol";
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { audit } from "../audit.ts";
import { ciAnswer } from "../checks/ci.ts";
import type { AppContext } from "../context.ts";
import { decryptSecret, encryptSecret, SECRET_KEY_VERSION } from "../crypto.ts";
import type { Actor } from "../http/session.ts";
import { keyFromInput } from "../routing/router.ts";
import type { RunnerSession } from "../runners/gateway.ts";
import { DeploySteps } from "./steps.ts";
import { Verifier } from "./verify.ts";

export type TargetRow = typeof schema.deployTargets.$inferSelect;
type CheckRow = typeof schema.checks.$inferSelect;
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

/** What a target's site check saw last, as the deploy target view shows it. */
function lastCheckOf(c: CheckRow | undefined): DeployTargetView["lastCheck"] {
  const r = c?.lastResult;
  if (!c || !r || r.detail.kind !== "site") return null;
  return { at: r.at, up: r.passed, failures: c.failures, results: r.detail.checks };
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

  /** A machine's answer to a merge or deploy, or to a read of a PR's CI. */
  async repoActionResult(session: RunnerSession, result: RepoActionResult): Promise<void> {
    if (ciAnswer(session, result)) return;
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

  /**
   * Views for several targets, with a few queries whatever their number. Their
   * URLs and last check come from their site checks, which callers that have
   * them pass in.
   */
  async views(rows: TargetRow[], checks?: Map<string, CheckRow>): Promise<DeployTargetView[]> {
    if (rows.length === 0) return [];
    const runnerIds = [...new Set(rows.flatMap((r) => (r.runnerId ? [r.runnerId] : [])))];
    const missing = rows.flatMap((r) => (r.checkId && !checks?.has(r.checkId) ? [r.checkId] : []));
    const [runners, deploys, loaded] = await Promise.all([
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
      missing.length
        ? this.#db.select().from(schema.checks).where(inArray(schema.checks.id, missing))
        : [],
    ]);
    const checkOf = new Map(checks);
    for (const c of loaded) checkOf.set(c.id, c);
    const lastDeploy = new Map(deploys.map((d) => [d.targetId, d]));
    return rows.map((t) => {
      const machine = runners.filter((r) => r.id === t.runnerId);
      const d = lastDeploy.get(t.id);
      const check = t.checkId ? checkOf.get(t.checkId) : undefined;
      const site = check?.config.kind === "site" ? check.config : null;
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
        checks: site?.checks ?? t.checks,
        versionUrl: site ? site.versionUrl : t.versionUrl,
        settleSeconds: t.settleSeconds,
        timeoutSeconds: t.timeoutSeconds,
        lastCheck: lastCheckOf(check),
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

  /**
   * Checks what `create` or `update` would refuse about a target's name, repo,
   * and machine, without saving anything. Returns the normalized repo.
   */
  async precheck(
    workspaceId: string,
    input: { name: string; remoteKey: string; method: string; runnerId?: string | null },
    except?: string,
  ): Promise<string> {
    const remote = this.#remote(input.remoteKey);
    await this.#checkUnique(workspaceId, input.name, remote, except);
    if (input.method === "command") await this.#checkRunner(workspaceId, input.runnerId);
    return remote;
  }

  /**
   * Gives a site check a deploy: a target row for the repo, pointing at the
   * check, with a copy of its URLs. Throws DeployInputError for one that
   * can't exist.
   */
  async attach(
    actor: Actor,
    checkId: string,
    name: string,
    site: SiteCheckConfig,
    input: DeployFields,
  ): Promise<TargetRow> {
    const remote = this.#remote(input.remoteKey);
    await this.#checkUnique(actor.workspaceId, name, remote);
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
    let row: TargetRow | undefined;
    try {
      [row] = await this.#db
        .insert(schema.deployTargets)
        .values({
          id,
          workspaceId: actor.workspaceId,
          ownerId: actor.userId,
          name,
          remoteKey: remote,
          method: input.method,
          mergeMethod: input.mergeMethod ?? "squash",
          runnerId: input.method === "command" ? (input.runnerId ?? null) : null,
          hookCredentialId: credentialId,
          hookHost: hook ? new URL(hook.url).host : null,
          hookMethod: hook?.httpMethod ?? null,
          hookHasHeader: Boolean(hook?.headerName),
          checkId,
          checks: site.checks,
          versionUrl: site.versionUrl,
          settleSeconds:
            input.settleSeconds ?? (input.method === "merge" ? MERGE_SETTLE_SECONDS : 0),
          timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        })
        .returning();
    } catch (err) {
      await this.#dropHook(credentialId);
      if (isUniqueViolation(err)) {
        throw new DeployInputError("A deploy target with that name or repo already exists.", 409);
      }
      throw err;
    }
    if (!row) throw new Error("deploy target not saved");
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "deploy_target.created",
      subjectType: "deploy_target",
      subjectId: id,
      details: { name, remoteKey: remote, method: input.method, checkId },
    });
    return row;
  }

  /** Changes how a site check deploys. Parts the patch leaves out stay. */
  async patchDeploy(
    actor: Actor,
    row: TargetRow,
    name: string,
    site: SiteCheckConfig,
    patch: Partial<DeployFields>,
  ): Promise<TargetRow> {
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
    const changed = Object.keys(patch).filter((k) => patch[k as keyof DeployFields] !== undefined);
    if (name !== row.name) changed.unshift("name");
    let saved: TargetRow | undefined;
    try {
      [saved] = await this.#db
        .update(schema.deployTargets)
        .set({
          name,
          remoteKey: remote,
          method,
          runnerId,
          ...hookFields,
          checks: site.checks,
          versionUrl: site.versionUrl,
          ...(patch.mergeMethod ? { mergeMethod: patch.mergeMethod } : {}),
          ...(patch.settleSeconds !== undefined ? { settleSeconds: patch.settleSeconds } : {}),
          ...(patch.timeoutSeconds !== undefined ? { timeoutSeconds: patch.timeoutSeconds } : {}),
        })
        .where(eq(schema.deployTargets.id, row.id))
        .returning();
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
    return saved ?? row;
  }

  /** Keeps a target's name and its copy of the URLs in step with its check. */
  async syncFromCheck(row: TargetRow, name: string, site: SiteCheckConfig): Promise<void> {
    if (name !== row.name) await this.#checkUnique(row.workspaceId, name, row.remoteKey, row.id);
    await this.#db
      .update(schema.deployTargets)
      .set({ name, checks: site.checks, versionUrl: site.versionUrl })
      .where(eq(schema.deployTargets.id, row.id));
  }

  /** Stops a site check deploying: its target and the hook's secret go. */
  async detach(actor: Actor, row: TargetRow): Promise<void> {
    const [gone] = await this.#db
      .delete(schema.deployTargets)
      .where(eq(schema.deployTargets.id, row.id))
      .returning();
    if (!gone) return;
    await this.#dropHook(gone.hookCredentialId);
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "deploy_target.removed",
      subjectType: "deploy_target",
      subjectId: gone.id,
      details: { name: gone.name, remoteKey: gone.remoteKey, method: gone.method },
    });
    this.#ctx.hub.publish(actor.workspaceId, { type: "deploy_target.removed", id: gone.id });
  }

  // ------------------------------------------------------------- the old API, on checks

  /** Adds a target: a site check with its URLs, that deploys the repo. */
  async create(actor: Actor, input: TargetInput): Promise<DeployTargetView> {
    const check = await this.#ctx.checks.create(actor, {
      name: input.name,
      config: {
        kind: "site",
        checks: normalizeChecks(input.checks),
        versionUrl: input.versionUrl ?? null,
      },
      deploy: deployFields(input),
    });
    if (!check.deploy) throw new Error("deploy target vanished");
    const view = await this.view(actor.workspaceId, check.deploy.id);
    if (!view) throw new Error("deploy target vanished");
    return view;
  }

  async update(actor: Actor, id: string, patch: TargetPatch): Promise<DeployTargetView> {
    const row = await this.row(actor.workspaceId, id);
    if (!row?.checkId) throw new DeployInputError("No such deploy target.", 404);
    const check = await this.#ctx.checks.row(actor.workspaceId, row.checkId);
    if (check?.config.kind !== "site") throw new DeployInputError("No such deploy target.", 404);
    const site: SiteCheckConfig = {
      kind: "site",
      checks: patch.checks ? normalizeChecks(patch.checks) : check.config.checks,
      versionUrl: patch.versionUrl !== undefined ? patch.versionUrl : check.config.versionUrl,
    };
    const name = patch.name ?? row.name;
    // The deploy part first, which says what it refuses about the name and repo.
    const saved = await this.patchDeploy(actor, row, name, site, deployFields(patch));
    if (name !== check.name || patch.checks || patch.versionUrl !== undefined) {
      await this.#ctx.checks.update(actor, check.id, {
        name,
        ...(patch.checks || patch.versionUrl !== undefined ? { config: site } : {}),
      });
    } else {
      await this.publish(saved.id);
    }
    const view = await this.view(actor.workspaceId, row.id);
    if (!view) throw new Error("deploy target vanished");
    return view;
  }

  /** Removes a target and the site check it deploys through. */
  async remove(actor: Actor, id: string): Promise<boolean> {
    const row = await this.row(actor.workspaceId, id);
    if (!row) return false;
    if (row.checkId) return this.#ctx.checks.remove(actor, row.checkId);
    await this.detach(actor, row);
    return true;
  }

  // ------------------------------------------------------------- checks

  /** The URLs and version URL a target's site check has now. */
  async site(target: TargetRow): Promise<SiteCheckConfig> {
    if (target.checkId) {
      const [c] = await this.#db
        .select({ config: schema.checks.config })
        .from(schema.checks)
        .where(eq(schema.checks.id, target.checkId));
      if (c?.config.kind === "site") return c.config;
    }
    return { kind: "site", checks: target.checks, versionUrl: target.versionUrl };
  }

  /**
   * Runs a target's site check now. What `deploys.check` reports as a change
   * is against what it saw itself last time, which it keeps on the target.
   */
  async checkTarget(target: TargetRow): Promise<CheckOutcome> {
    const view = target.checkId
      ? await this.#ctx.checks.run(target.workspaceId, target.checkId)
      : null;
    const result = view?.lastResult;
    const at = result?.at ?? new Date().toISOString();
    const results = result?.detail.kind === "site" ? result.detail.checks : [];
    const after: DeployLastCheck = {
      at,
      up: result?.passed ?? false,
      failures: view?.failures ?? 0,
      results,
      since: view?.stateSince ?? at,
    };
    const before = target.lastCheck;
    await this.#db
      .update(schema.deployTargets)
      // A check isn't a change to the target, so updatedAt stays.
      .set({ lastCheck: after, updatedAt: sql`${schema.deployTargets.updatedAt}` })
      .where(eq(schema.deployTargets.id, target.id));
    return { target: { ...target, lastCheck: after }, before, after };
  }

  /** Runs a target's checks now, saves what they saw, and returns the target. */
  async check(workspaceId: string, targetId: string): Promise<DeployTargetView | null> {
    const row = await this.row(workspaceId, targetId);
    if (!row?.checkId) return null;
    await this.#ctx.checks.run(workspaceId, row.checkId);
    return this.view(workspaceId, targetId);
  }
}

/** How a target deploys, as a site check's deploy section takes it. */
export interface DeployFields {
  remoteKey: string;
  method: DeployMethod;
  mergeMethod?: MergeMethod | undefined;
  runnerId?: string | null | undefined;
  hook?: z.infer<typeof HookInput> | null | undefined;
  settleSeconds?: number | undefined;
  timeoutSeconds?: number | undefined;
}

function deployFields(input: TargetInput): DeployFields;
function deployFields(input: TargetPatch): Partial<DeployFields>;
function deployFields(input: TargetPatch): Partial<DeployFields> {
  const out: Partial<DeployFields> = {};
  if (input.remoteKey !== undefined) out.remoteKey = input.remoteKey;
  if (input.method !== undefined) out.method = input.method;
  if (input.mergeMethod !== undefined) out.mergeMethod = input.mergeMethod;
  if (input.runnerId !== undefined) out.runnerId = input.runnerId;
  if (input.hook !== undefined) out.hook = input.hook;
  if (input.settleSeconds !== undefined) out.settleSeconds = input.settleSeconds;
  if (input.timeoutSeconds !== undefined) out.timeoutSeconds = input.timeoutSeconds;
  return out;
}
