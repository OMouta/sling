import {
  type ActionCheckView,
  CHECK_INTERVAL_SECONDS,
  CHECK_RESULTS_KEPT,
  type CheckConfig,
  type CheckDeployView,
  type CheckInput,
  type CheckPatch,
  type CheckResultView,
  type CheckState,
  type CheckView,
  DEPLOY_METHODS,
  type DeployCheck,
  MERGE_METHODS,
  newId,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, desc, eq, inArray, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { TargetFields, type TargetRow } from "../deploys/service.ts";
import type { Actor } from "../http/session.ts";
import { workspaceTimeZone } from "../timezone.ts";
import { CHECKS_CHANGED } from "../workflows/nodes/checks.ts";
import { ActionChecks } from "./actions.ts";
import { alertFor, alertPayload } from "./alerts.ts";
import {
  type CheckRow,
  commandRefusal,
  type MailSearch,
  nodeMailSearch,
  runCommand,
  runReply,
  runSite,
} from "./kinds.ts";
import { isNotable, nextRunAt, nextState, type RunOutcome } from "./state.ts";

export type { CheckRow } from "./kinds.ts";

/** A check the request can't create or change, with the status to answer. */
export class CheckInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The scheduler looks for due checks this often, so no check runs more often. */
export const MIN_INTERVAL_SECONDS = 30;
/** Checks that run at once, across every tick. */
export const MAX_RUNNING = 8;
/** Most due checks one tick picks up. The rest wait for the next. */
const TICK_BATCH = 200;
/** How long Sling waits for a workflow's own alert before it decides about its push. */
const ALERT_WAIT_MS = 60_000;
const DUE_QUEUE = "checks-due";

const SiteConfig = z.object({
  kind: z.literal("site"),
  checks: TargetFields.checks.transform((list): DeployCheck[] =>
    list.map((c) => ({ url: c.url, status: c.status ?? null, contains: c.contains || null })),
  ),
  versionUrl: TargetFields.versionUrl.transform((v) => v ?? null),
});

const CommandConfig = z.object({
  kind: z.literal("command"),
  command: z.string().trim().min(1).max(4000),
  contains: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .transform((v) => v || null),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
});

const ReplyConfig = z.object({
  kind: z.literal("reply"),
  from: z
    .string()
    .trim()
    .max(320)
    .nullable()
    .default(null)
    .transform((v) => v || null),
  subject: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .default(null)
    .transform((v) => v || null),
  inReplyTo: z
    .string()
    .trim()
    .max(998)
    .nullable()
    .default(null)
    .transform((v) => v || null),
  folder: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .default(null)
    .transform((v) => v || null),
});

const CheckDeploySchema = z.object({
  remoteKey: TargetFields.remoteKey,
  method: z.enum(DEPLOY_METHODS),
  mergeMethod: z.enum(MERGE_METHODS).optional(),
  runnerId: TargetFields.runnerId,
  hook: TargetFields.hook,
  settleSeconds: TargetFields.settleSeconds,
  timeoutSeconds: TargetFields.timeoutSeconds,
});

const CheckFields = {
  name: z.string().trim().min(1).max(80),
  config: z.discriminatedUnion("kind", [SiteConfig, CommandConfig, ReplyConfig]),
  enabled: z.boolean().optional(),
  intervalSeconds: z
    .number()
    .int()
    .min(MIN_INTERVAL_SECONDS)
    .max(24 * 60 * 60)
    .optional(),
  deadline: z.iso.datetime({ offset: true }).nullable().optional(),
  runnerId: z.string().min(1).max(100).nullable().optional(),
  installationId: z.string().min(1).max(100).nullable().optional(),
  notify: z.boolean().optional(),
  deploy: CheckDeploySchema.nullable().optional(),
};
export const CheckInputSchema = z.object(CheckFields) satisfies z.ZodType<CheckInput>;
export const CheckPatchSchema = z.object(CheckFields).partial() satisfies z.ZodType<CheckPatch>;
export type ParsedDeploy = z.infer<typeof CheckDeploySchema>;

/** A run that changed a check's state, for pushes, start rules, and workflows. */
export interface CheckChange {
  workspaceId: string;
  ownerId: string;
  check: CheckView;
  from: CheckState;
  result: CheckResultView;
}

/** An action outside Sling that its check should confirm. */
export type ActionCheckStart =
  | {
      /** A node the assistant ran from chat, whose spec has `verify`. */
      kind: "tool_call";
      workspaceId: string;
      ownerId: string;
      conversationId: string;
      toolCallId: string;
      nodeType: string;
      nodeVersion: number;
      installationId: string | null;
      config: Record<string, unknown>;
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      /** What the call did, for the conversation when its check fails. */
      summary?: string;
    }
  | {
      /** A task's step, such as a delivered PR waiting for its CI. */
      kind: "task_action";
      workspaceId: string;
      ownerId: string;
      actionId: string;
    };

export interface CheckService {
  list(workspaceId: string): Promise<CheckView[]>;
  get(workspaceId: string, id: string): Promise<CheckView | null>;
  /** The stored check. Null when there's no such check. */
  row(workspaceId: string, id: string): Promise<CheckRow | null>;
  /** A check by its ID or its name, which matches without regard to case. */
  find(workspaceId: string, idOrName: string): Promise<CheckRow | null>;
  /** Throws CheckInputError when the input can't make a check. Publishes `check.changed`. */
  create(actor: Actor, input: CheckInput): Promise<CheckView>;
  /** Null when there's no such check. */
  update(actor: Actor, id: string, patch: CheckPatch): Promise<CheckView | null>;
  /** Deletes it with its history and its deploy section. Publishes `check.removed`. */
  remove(actor: Actor, id: string): Promise<boolean>;
  /** Runs it now, saves the result, and returns the check. Null when there's none. */
  run(workspaceId: string, id: string): Promise<CheckView | null>;
  /** Newest first, at most CHECK_RESULTS_KEPT. Null when there's no such check. */
  results(workspaceId: string, id: string): Promise<CheckResultView[] | null>;
  /**
   * Checks an action right away and returns what that says, then keeps
   * checking in the background while it's `waiting`, publishing
   * `tool_step.check` or the task's update as it changes. Null when nothing
   * checks this kind of action.
   */
  checkAction(start: ActionCheckStart): Promise<ActionCheckView | null>;
  /**
   * Registers the action check jobs, and the scheduler unless `schedules`
   * is false, when tests call `tick` themselves.
   */
  start(boss: PgBoss, opts?: { schedules?: boolean }): Promise<void>;
  /** Resolves once checks in flight have finished. */
  idle(): Promise<void>;
  /** Runs the checks that are due now. The scheduler calls it twice a minute. */
  tick(): Promise<number>;
  /** Saves the last round of a deploy's verify as a run of its site check. */
  recordVerify(checkId: string | null, outcome: RunOutcome): Promise<void>;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.code;
  return code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505";
}

/** Waits for one of a fixed number of slots. */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((ok) => this.#waiting.push(ok));
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/**
 * What Sling watches on its own: sites, commands on machines, and replies
 * by a deadline. A scheduler runs the ones that are due, each change goes
 * out as a push, to start rules, and to workflows, and a site check can also
 * be where a repo deploys.
 */
export class Checks implements CheckService {
  readonly #ctx: AppContext;
  readonly #slots = new Slots(MAX_RUNNING);
  readonly #inflight = new Set<Promise<unknown>>();
  /** Checks a tick is running now, so a later tick leaves them be. */
  readonly #running = new Set<string>();
  readonly actions: ActionChecks;
  /** How a reply check searches a mailbox. Tests replace it. */
  mailSearch: MailSearch;
  /** Runs one check of each kind. Tests replace them to time the scheduler alone. */
  readonly kinds: Record<CheckRow["kind"], (row: CheckRow) => Promise<RunOutcome>>;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
    this.actions = new ActionChecks(ctx);
    this.mailSearch = nodeMailSearch(ctx);
    this.kinds = {
      site: (row) => runSite(row.config as Extract<CheckConfig, { kind: "site" }>),
      command: (row) =>
        runCommand(ctx, {
          ...row,
          config: row.config as Extract<CheckConfig, { kind: "command" }>,
        }),
      reply: (row) =>
        runReply(this.mailSearch, {
          workspaceId: row.workspaceId,
          ownerId: row.ownerId,
          installationId: row.installationId ?? "",
          config: row.config as Extract<CheckConfig, { kind: "reply" }>,
          since: row.createdAt,
        }),
    };
  }

  get #db() {
    return this.#ctx.db;
  }

  // ------------------------------------------------------------- lifecycle

  async start(boss: PgBoss, opts: { schedules?: boolean } = {}): Promise<void> {
    await this.adoptTargets();
    await this.actions.start(boss);
    if (opts.schedules === false) return;
    await boss.createQueue(DUE_QUEUE, { policy: "singleton", expireInSeconds: 300 });
    // pg-boss schedules by the minute; each tick sends the one half a minute later.
    await boss.schedule(DUE_QUEUE, "* * * * *", { half: false });
    await boss.work<{ half?: boolean }>(DUE_QUEUE, { pollingIntervalSeconds: 2 }, async (jobs) => {
      for (const job of jobs) {
        // A slow check mustn't hold up the next tick and every check due in it.
        this.#background("check tick", () => this.tick());
        if (!job.data?.half) {
          await boss.send(DUE_QUEUE, { half: true }, { startAfter: 30 });
        }
      }
    });
    // Checks due while the server was down run now, not at the next minute.
    await boss.send(DUE_QUEUE, { half: true });
  }

  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
    await this.actions.idle();
  }

  #background(label: string, work: () => Promise<unknown>) {
    const p = work()
      .catch((err) => this.#ctx.log.error({ err }, `${label} failed`))
      .finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
  }

  /**
   * Gives a site check to each deploy target that has none, such as one
   * added before checks existed, with the target's URLs and last check.
   */
  async adoptTargets(): Promise<number> {
    const orphans = await this.#db
      .select()
      .from(schema.deployTargets)
      .where(isNull(schema.deployTargets.checkId));
    for (const t of orphans) {
      const name = await this.#freeName(t.workspaceId, t.name);
      const id = newId("chk");
      const last = t.lastCheck;
      const failures = last?.failures ?? 0;
      const state: CheckState = !last ? "unknown" : failures >= 2 ? "down" : "up";
      const result: CheckResultView | null = last
        ? {
            id: newId("ckr"),
            checkId: id,
            at: last.at,
            passed: last.up,
            state,
            message: last.up
              ? "Every URL answered as set"
              : (() => {
                  const f = last.results.find((r) => !r.ok);
                  return f ? `${f.url}: ${f.error ?? "failed"}` : "A check failed";
                })(),
            ms: Math.max(0, ...last.results.map((r) => r.ms)),
            detail: { kind: "site", checks: last.results, versionSeen: null },
          }
        : null;
      await this.#db.transaction(async (tx) => {
        await tx.insert(schema.checks).values({
          id,
          workspaceId: t.workspaceId,
          ownerId: t.ownerId,
          kind: "site",
          name,
          config: { kind: "site", checks: t.checks, versionUrl: t.versionUrl },
          intervalSeconds: CHECK_INTERVAL_SECONDS.site,
          state,
          stateSince: last ? new Date(last.since ?? last.at) : null,
          failures,
          lastResult: result,
          lastRunAt: last ? new Date(last.at) : null,
          nextRunAt: new Date(),
          createdAt: t.createdAt,
        });
        if (result) {
          await tx.insert(schema.checkResults).values({
            id: result.id,
            checkId: id,
            at: new Date(result.at),
            passed: result.passed,
            state: result.state,
            message: result.message,
            ms: result.ms,
            detail: result.detail,
          });
        }
        await tx
          .update(schema.deployTargets)
          .set({ checkId: id, updatedAt: sql`${schema.deployTargets.updatedAt}` })
          .where(eq(schema.deployTargets.id, t.id));
      });
    }
    return orphans.length;
  }

  async #freeName(workspaceId: string, want: string): Promise<string> {
    const rows = await this.#db
      .select({ name: schema.checks.name })
      .from(schema.checks)
      .where(eq(schema.checks.workspaceId, workspaceId));
    const taken = new Set(rows.map((r) => r.name.toLowerCase()));
    if (!taken.has(want.toLowerCase())) return want;
    for (let i = 2; ; i++) {
      const name = `${want} ${i}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  // ------------------------------------------------------------- reads

  async row(workspaceId: string, id: string): Promise<CheckRow | null> {
    const [row] = await this.#db
      .select()
      .from(schema.checks)
      .where(and(eq(schema.checks.id, id), eq(schema.checks.workspaceId, workspaceId)));
    return row ?? null;
  }

  /** A check by its ID or its name, which matches without regard to case. */
  async find(workspaceId: string, idOrName: string): Promise<CheckRow | null> {
    const want = idOrName.trim();
    if (!want) return null;
    const [row] = await this.#db
      .select()
      .from(schema.checks)
      .where(
        and(
          eq(schema.checks.workspaceId, workspaceId),
          sql`(${schema.checks.id} = ${want} or lower(${schema.checks.name}) = ${want.toLowerCase()})`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async rows(workspaceId: string): Promise<CheckRow[]> {
    return this.#db
      .select()
      .from(schema.checks)
      .where(eq(schema.checks.workspaceId, workspaceId))
      .orderBy(sql`lower(${schema.checks.name})`);
  }

  async list(workspaceId: string): Promise<CheckView[]> {
    return this.views(await this.rows(workspaceId));
  }

  async get(workspaceId: string, id: string): Promise<CheckView | null> {
    const row = await this.row(workspaceId, id);
    if (!row) return null;
    const [view] = await this.views([row]);
    return view ?? null;
  }

  /** The deploy target that deploys through a check. */
  async targetOf(checkId: string): Promise<TargetRow | null> {
    const [t] = await this.#db
      .select()
      .from(schema.deployTargets)
      .where(eq(schema.deployTargets.checkId, checkId));
    return t ?? null;
  }

  /** Views for several checks, in a few queries whatever their number. */
  async views(rows: CheckRow[]): Promise<CheckView[]> {
    if (rows.length === 0) return [];
    const runnerIds = [...new Set(rows.flatMap((r) => (r.runnerId ? [r.runnerId] : [])))];
    const installationIds = [
      ...new Set(rows.flatMap((r) => (r.installationId ? [r.installationId] : []))),
    ];
    const siteIds = rows.filter((r) => r.kind === "site").map((r) => r.id);
    const [runners, installations, targets] = await Promise.all([
      runnerIds.length
        ? this.#db
            .select({ id: schema.runners.id, name: schema.runners.name })
            .from(schema.runners)
            .where(inArray(schema.runners.id, runnerIds))
        : [],
      installationIds.length
        ? this.#db
            .select({
              id: schema.connectorInstallations.id,
              name: schema.connectorInstallations.name,
            })
            .from(schema.connectorInstallations)
            .where(inArray(schema.connectorInstallations.id, installationIds))
        : [],
      siteIds.length
        ? this.#db
            .select()
            .from(schema.deployTargets)
            .where(inArray(schema.deployTargets.checkId, siteIds))
        : [],
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const deployViews = targets.length ? await this.#ctx.deploys.views(targets, byId) : [];
    const deployOf = new Map<string, CheckDeployView>();
    targets.forEach((t, i) => {
      const v = deployViews[i];
      if (!t.checkId || !v) return;
      deployOf.set(t.checkId, {
        id: v.id,
        remoteKey: v.remoteKey,
        method: v.method,
        mergeMethod: v.mergeMethod,
        runnerId: v.runnerId,
        runnerName: v.runnerName,
        command: v.command,
        hook: v.hook,
        settleSeconds: v.settleSeconds,
        timeoutSeconds: v.timeoutSeconds,
        lastDeploy: v.lastDeploy,
      });
    });
    const runnerName = new Map(runners.map((r) => [r.id, r.name]));
    const installationName = new Map(installations.map((i) => [i.id, i.name]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      config: r.config,
      enabled: r.enabled,
      intervalSeconds: r.intervalSeconds,
      deadline: iso(r.deadline),
      runnerId: r.runnerId,
      runnerName: r.runnerId ? (runnerName.get(r.runnerId) ?? null) : null,
      installationId: r.installationId,
      installationName: r.installationId ? (installationName.get(r.installationId) ?? null) : null,
      state: r.state,
      stateSince: iso(r.stateSince),
      failures: r.failures,
      lastResult: r.lastResult ?? null,
      nextRunAt: r.enabled ? iso(r.nextRunAt) : null,
      notify: r.notify,
      deploy: deployOf.get(r.id) ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async results(workspaceId: string, id: string): Promise<CheckResultView[] | null> {
    const row = await this.row(workspaceId, id);
    if (!row) return null;
    const rows = await this.#db
      .select()
      .from(schema.checkResults)
      .where(eq(schema.checkResults.checkId, id))
      .orderBy(desc(schema.checkResults.at))
      .limit(CHECK_RESULTS_KEPT);
    return rows.map((r) => ({
      id: r.id,
      checkId: r.checkId,
      at: r.at.toISOString(),
      passed: r.passed,
      state: r.state,
      message: r.message,
      ms: r.ms,
      detail: r.detail,
    }));
  }

  /** Publishes a check, and its deploy target when it has one. */
  async publish(row: CheckRow): Promise<CheckView | null> {
    const [view] = await this.views([row]);
    if (!view) return null;
    this.#ctx.hub.publish(row.workspaceId, { type: "check.changed", check: view });
    if (view.deploy) await this.#ctx.deploys.publish(view.deploy.id);
    return view;
  }

  // ------------------------------------------------------------- writes

  async #checkName(workspaceId: string, name: string, except?: string) {
    const [clash] = await this.#db
      .select({ id: schema.checks.id, name: schema.checks.name })
      .from(schema.checks)
      .where(
        and(
          eq(schema.checks.workspaceId, workspaceId),
          sql`lower(${schema.checks.name}) = ${name.toLowerCase()}`,
          ...(except ? [ne(schema.checks.id, except)] : []),
        ),
      )
      .limit(1);
    if (clash) throw new CheckInputError(`There's already a check called ${clash.name}.`, 409);
  }

  async #checkMachine(workspaceId: string, runnerId: string | null | undefined) {
    if (!runnerId) throw new CheckInputError("A command check needs the machine it runs on.");
    const [runner] = await this.#db
      .select({ name: schema.runners.name, capabilities: schema.runners.capabilities })
      .from(schema.runners)
      .where(
        and(
          eq(schema.runners.id, runnerId),
          eq(schema.runners.workspaceId, workspaceId),
          isNull(schema.runners.revokedAt),
          eq(schema.runners.ephemeral, false),
        ),
      );
    if (!runner) throw new CheckInputError("That machine isn't one of yours.");
    // A machine that hasn't reported yet has no capabilities to go by.
    if (runner.capabilities.length === 0) return;
    const refused = commandRefusal(runner);
    if (refused) throw new CheckInputError(`${refused} A command check can't run there.`);
  }

  async #checkMailbox(workspaceId: string, installationId: string | null | undefined) {
    if (!installationId)
      throw new CheckInputError("A reply check needs the email account it watches.");
    const [inst] = await this.#db
      .select({ connectorId: schema.connectorInstallations.connectorId })
      .from(schema.connectorInstallations)
      .where(
        and(
          eq(schema.connectorInstallations.id, installationId),
          eq(schema.connectorInstallations.workspaceId, workspaceId),
        ),
      );
    if (!inst) throw new CheckInputError("That email account isn't one of yours.");
    if (inst.connectorId !== "email") {
      throw new CheckInputError("A reply check watches an email account.");
    }
  }

  #checkDeadline(deadline: string | null | undefined): Date {
    if (!deadline) throw new CheckInputError("A reply check needs a deadline.");
    const at = new Date(deadline);
    if (at.getTime() <= Date.now()) throw new CheckInputError("The deadline has passed already.");
    return at;
  }

  #parse<T>(schemaOf: z.ZodType<T>, input: unknown): T {
    const parsed = schemaOf.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CheckInputError(
        issue ? `${issue.path.join(".") || "value"}: ${issue.message}` : "Invalid check.",
      );
    }
    return parsed.data;
  }

  async create(actor: Actor, raw: CheckInput): Promise<CheckView> {
    const input = this.#parse(CheckInputSchema, raw);
    const kind = input.config.kind;
    const deploy = input.deploy ?? null;
    if (deploy && kind !== "site") throw new CheckInputError("Only a site check can deploy.");
    // A deploy's own clashes come first: its name is the target's too.
    if (deploy) {
      await this.#ctx.deploys.precheck(actor.workspaceId, { ...deploy, name: input.name });
    }
    await this.#checkName(actor.workspaceId, input.name);
    let deadline: Date | null = null;
    if (kind === "command") await this.#checkMachine(actor.workspaceId, input.runnerId);
    if (kind === "reply") {
      await this.#checkMailbox(actor.workspaceId, input.installationId);
      deadline = this.#checkDeadline(input.deadline);
    }
    const id = newId("chk");
    try {
      await this.#db.insert(schema.checks).values({
        id,
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        kind,
        name: input.name,
        config: input.config,
        enabled: input.enabled ?? true,
        intervalSeconds: input.intervalSeconds ?? CHECK_INTERVAL_SECONDS[kind],
        deadline,
        runnerId: kind === "command" ? (input.runnerId ?? null) : null,
        installationId: kind === "reply" ? (input.installationId ?? null) : null,
        notify: input.notify ?? true,
        nextRunAt: new Date(),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new CheckInputError(`There's already a check called ${input.name}.`, 409);
      }
      throw err;
    }
    if (deploy && input.config.kind === "site") {
      try {
        await this.#ctx.deploys.attach(actor, id, input.name, input.config, deploy);
      } catch (err) {
        await this.#db.delete(schema.checks).where(eq(schema.checks.id, id));
        throw err;
      }
    }
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "check.created",
      subjectType: "check",
      subjectId: id,
      details: { name: input.name, kind },
    });
    const row = await this.row(actor.workspaceId, id);
    if (!row) throw new Error("check vanished");
    const view = await this.publish(row);
    if (!view) throw new Error("check vanished");
    return view;
  }

  async update(actor: Actor, id: string, raw: CheckPatch): Promise<CheckView | null> {
    const patch = this.#parse(CheckPatchSchema, raw);
    const row = await this.row(actor.workspaceId, id);
    if (!row) return null;
    if (patch.config && patch.config.kind !== row.kind) {
      throw new CheckInputError("A check's kind can't change.");
    }
    const name = patch.name ?? row.name;
    if (name !== row.name) await this.#checkName(actor.workspaceId, name, row.id);
    const target = row.kind === "site" ? await this.targetOf(row.id) : null;
    if (patch.deploy && row.kind !== "site")
      throw new CheckInputError("Only a site check can deploy.");

    const runnerId = patch.runnerId !== undefined ? patch.runnerId : row.runnerId;
    if (row.kind === "command" && patch.runnerId !== undefined) {
      await this.#checkMachine(actor.workspaceId, runnerId);
    }
    const installationId =
      patch.installationId !== undefined ? patch.installationId : row.installationId;
    if (row.kind === "reply" && patch.installationId !== undefined) {
      await this.#checkMailbox(actor.workspaceId, installationId);
    }
    let deadline = row.deadline;
    if (row.kind === "reply" && patch.deadline !== undefined) {
      deadline = this.#checkDeadline(patch.deadline);
    }
    const config = (patch.config ?? row.config) as CheckConfig;
    const configChanged =
      (patch.config !== undefined && JSON.stringify(patch.config) !== JSON.stringify(row.config)) ||
      (row.kind === "command" && runnerId !== row.runnerId) ||
      (row.kind === "reply" &&
        (installationId !== row.installationId || deadline?.getTime() !== row.deadline?.getTime()));

    // The deploy section first: when it's refused, nothing about the check changes.
    if (patch.deploy === null && target) {
      await this.#ctx.deploys.detach(actor, target);
    } else if (patch.deploy && config.kind === "site") {
      if (target) await this.#ctx.deploys.patchDeploy(actor, target, name, config, patch.deploy);
      else {
        await this.#ctx.deploys.precheck(actor.workspaceId, { ...patch.deploy, name });
        await this.#ctx.deploys.attach(actor, row.id, name, config, patch.deploy);
      }
    } else if (target && (name !== row.name || configChanged) && config.kind === "site") {
      await this.#ctx.deploys.syncFromCheck(target, name, config);
    }

    const enabled = patch.enabled ?? row.enabled;
    const changed = Object.keys(raw).filter((k) => raw[k as keyof CheckPatch] !== undefined);
    try {
      await this.#db
        .update(schema.checks)
        .set({
          name,
          config,
          enabled,
          intervalSeconds: patch.intervalSeconds ?? row.intervalSeconds,
          deadline,
          runnerId: row.kind === "command" ? runnerId : null,
          installationId: row.kind === "reply" ? installationId : null,
          notify: patch.notify ?? row.notify,
          // What it watches changed, so what it saw before says nothing now.
          ...(configChanged
            ? {
                state: "unknown" as const,
                stateSince: null,
                failures: 0,
                lastResult: null,
                nextRunAt: new Date(),
              }
            : {}),
          ...(enabled && !row.enabled && !configChanged
            ? { nextRunAt: row.kind === "reply" && row.nextRunAt === null ? null : new Date() }
            : {}),
        })
        .where(eq(schema.checks.id, row.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new CheckInputError(`There's already a check called ${name}.`, 409);
      }
      throw err;
    }
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "check.updated",
      subjectType: "check",
      subjectId: row.id,
      details: { name, kind: row.kind, changed },
    });
    const saved = await this.row(actor.workspaceId, row.id);
    return saved ? this.publish(saved) : null;
  }

  async remove(actor: Actor, id: string): Promise<boolean> {
    const row = await this.row(actor.workspaceId, id);
    if (!row) return false;
    const target = await this.targetOf(row.id);
    if (target) await this.#ctx.deploys.detach(actor, target);
    const [gone] = await this.#db
      .delete(schema.checks)
      .where(and(eq(schema.checks.id, id), eq(schema.checks.workspaceId, actor.workspaceId)))
      .returning({ id: schema.checks.id });
    if (!gone) return false;
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "check.removed",
      subjectType: "check",
      subjectId: row.id,
      details: { name: row.name, kind: row.kind },
    });
    this.#ctx.hub.publish(actor.workspaceId, { type: "check.removed", id: row.id });
    return true;
  }

  // ------------------------------------------------------------- running

  async run(workspaceId: string, id: string): Promise<CheckView | null> {
    const row = await this.row(workspaceId, id);
    if (!row) return null;
    const saved = await this.#slots.run(() => this.execute(row));
    if (!saved) return null;
    const [view] = await this.views([saved]);
    return view ?? null;
  }

  /**
   * Runs the checks that are due, at most eight at once across ticks, and
   * resolves when they've finished. Each is claimed first, by moving its next
   * run on, and one still running from an earlier tick is left out, so two
   * ticks never run the same check.
   */
  async tick(): Promise<number> {
    const running = [...this.#running];
    const due = this.#db
      .select({ id: schema.checks.id })
      .from(schema.checks)
      .where(
        and(
          eq(schema.checks.enabled, true),
          lte(schema.checks.nextRunAt, new Date()),
          running.length ? notInArray(schema.checks.id, running) : undefined,
        ),
      )
      .orderBy(schema.checks.nextRunAt)
      .limit(TICK_BATCH)
      .for("update", { skipLocked: true });
    const claimed = await this.#db
      .update(schema.checks)
      .set({
        nextRunAt: sql`now() + make_interval(secs => ${schema.checks.intervalSeconds})`,
        updatedAt: sql`${schema.checks.updatedAt}`,
      })
      .where(inArray(schema.checks.id, due))
      .returning();
    for (const row of claimed) this.#running.add(row.id);
    await Promise.all(
      claimed.map((row) =>
        this.#slots
          .run(() => this.execute(row))
          .catch((err) => this.#ctx.log.error({ err, checkId: row.id }, "check failed to run"))
          .finally(() => this.#running.delete(row.id)),
      ),
    );
    return claimed.length;
  }

  /**
   * Runs a check, or saves an outcome that was already seen, such as the
   * last round of a deploy's verify. Saves the result, keeps the newest 100,
   * moves its state, and tells everyone who should hear about a change.
   */
  async execute(row: CheckRow, given?: RunOutcome): Promise<CheckRow | null> {
    let outcome: RunOutcome;
    try {
      outcome = given ?? (await this.kinds[row.kind](row));
    } catch (err) {
      outcome = {
        passed: false,
        counted: false,
        message: `Didn't run: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        ms: 0,
        detail:
          row.kind === "site"
            ? { kind: "site", checks: [], versionSeen: null }
            : row.kind === "command"
              ? {
                  kind: "command",
                  exitCode: null,
                  output: "",
                  timedOut: false,
                  error: String(err),
                }
              : { kind: "reply", match: null, error: String(err) },
      };
    }
    const now = new Date();
    const done = await this.#db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.checks)
        .where(eq(schema.checks.id, row.id))
        .for("update");
      if (!current) return null;
      const next = nextState(
        current.kind,
        { state: current.state, failures: current.failures, stateSince: current.stateSince },
        outcome,
        now,
        current.deadline,
      );
      const result: CheckResultView = {
        id: newId("ckr"),
        checkId: current.id,
        at: now.toISOString(),
        passed: outcome.passed,
        state: next.state,
        message: outcome.message.slice(0, 500),
        ms: outcome.ms,
        detail: outcome.detail,
      };
      await tx.insert(schema.checkResults).values({
        id: result.id,
        checkId: current.id,
        at: now,
        passed: result.passed,
        state: result.state,
        message: result.message,
        ms: result.ms,
        detail: result.detail,
      });
      const [saved] = await tx
        .update(schema.checks)
        .set({
          state: next.state,
          stateSince: next.stateSince,
          failures: next.failures,
          lastResult: result,
          lastRunAt: now,
          nextRunAt: nextRunAt(current.kind, next, now, current.intervalSeconds, current.deadline),
          // A run isn't a change to the check's settings.
          updatedAt: sql`${schema.checks.updatedAt}`,
        })
        .where(eq(schema.checks.id, current.id))
        .returning();
      return saved ? { saved, from: current.state, result } : null;
    });
    if (!done) return null;
    await this.#prune(row.id);
    const view = await this.publish(done.saved);
    if (view && isNotable(done.from, done.saved.state)) {
      await this.#changed(done.saved, view, done.from, done.result).catch((err) =>
        this.#ctx.log.error({ err, checkId: row.id }, "couldn't tell anyone a check changed"),
      );
    }
    return done.saved;
  }

  async #prune(checkId: string) {
    const keep = this.#db
      .select({ id: schema.checkResults.id })
      .from(schema.checkResults)
      .where(eq(schema.checkResults.checkId, checkId))
      .orderBy(desc(schema.checkResults.at))
      .limit(CHECK_RESULTS_KEPT);
    await this.#db
      .delete(schema.checkResults)
      .where(
        and(eq(schema.checkResults.checkId, checkId), notInArray(schema.checkResults.id, keep)),
      );
  }

  // ------------------------------------------------------------- changes

  /**
   * A check changed state: start rules first, so the alert can open the
   * chat one started, then workflows listening on `checks.changed`, then
   * the push, unless a workflow sends its own.
   */
  async #changed(row: CheckRow, view: CheckView, from: CheckState, result: CheckResultView) {
    const ctx = this.#ctx;
    const change: CheckChange = {
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      check: view,
      from,
      result,
    };
    let openChat: string | null = null;
    try {
      const [started] = await ctx.rules.checkChanged(change);
      openChat = started?.conversationId ?? null;
    } catch (err) {
      ctx.log.error({ err, checkId: row.id }, "start rules failed");
    }
    const timeZone = await workspaceTimeZone(ctx, row.workspaceId);
    const alert = alertFor(view, from, result, { timeZone, openChat });
    await audit(ctx, {
      workspaceId: row.workspaceId,
      actorType: "system",
      verb: `check.${view.state}`,
      subjectType: "check",
      subjectId: row.id,
      details: { name: row.name, from, to: view.state, message: result.message },
    });
    const runs = await ctx.events.emit({
      type: CHECKS_CHANGED,
      workspaceId: row.workspaceId,
      payload: {
        check: {
          id: view.id,
          name: view.name,
          kind: view.kind,
          state: view.state,
          from,
          message: result.message,
          reason: alert.reason,
          since: view.stateSince ?? result.at,
          sinceTime: alert.sinceTime,
          results: result.detail,
          deployTarget: view.deploy?.id ?? null,
        },
        open: alert.url,
        conversationId: openChat,
      },
      dedupeKey: `check:${row.id}:${result.id}`,
    });
    if (!row.notify) return;
    const push = async () => {
      await ctx.push.notify(row.workspaceId, row.ownerId, alertPayload(row.id, alert), {
        urgency: alert.urgency,
        ttlSeconds: 60 * 60,
      });
    };
    if (await this.#olderSiteAlert(row.workspaceId, view)) return;
    const notifying = await this.#mayNotify(runs);
    if (notifying.length === 0) return push();
    // Wait for those runs, and push unless one of them did.
    this.#background("check alert", async () => {
      if (!(await this.#notified(notifying))) await push();
    });
  }

  /** The runs this change started whose workflow has a Notify my devices step. */
  async #mayNotify(runs: { id: string; versionId: string }[]): Promise<string[]> {
    const ids: string[] = [];
    for (const run of runs) {
      const version = await this.#ctx.engine.version(run.versionId);
      if (version?.definition.nodes.some((n) => n.type === "app.notify")) ids.push(run.id);
    }
    return ids;
  }

  /**
   * Whether one of these runs pushed. Gives them a minute to finish; one
   * still going after that is taken to push when it gets there.
   */
  async #notified(runIds: string[]): Promise<boolean> {
    const end = Date.now() + ALERT_WAIT_MS;
    for (;;) {
      const [pushed] = await this.#db
        .select({ id: schema.nodeRuns.id })
        .from(schema.nodeRuns)
        .where(
          and(
            inArray(schema.nodeRuns.runId, runIds),
            eq(schema.nodeRuns.nodeType, "app.notify"),
            eq(schema.nodeRuns.status, "succeeded"),
          ),
        )
        .limit(1);
      if (pushed) return true;
      const [going] = await this.#db
        .select({ id: schema.workflowRuns.id })
        .from(schema.workflowRuns)
        .where(
          and(
            inArray(schema.workflowRuns.id, runIds),
            inArray(schema.workflowRuns.status, ["queued", "running", "waiting"]),
          ),
        )
        .limit(1);
      if (!going) return false;
      if (Date.now() >= end) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Whether an older Site down alert, one that still checks deploy targets
   * every minute, pushes about this change, so Sling's own push would be a
   * second one.
   */
  async #olderSiteAlert(workspaceId: string, view: CheckView): Promise<boolean> {
    if (!view.deploy) return false;
    const enabled = await this.#db
      .select({ versionId: schema.workflows.activeVersionId })
      .from(schema.workflows)
      .where(
        and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.enabled, true)),
      );
    for (const w of enabled) {
      if (!w.versionId) continue;
      const version = await this.#ctx.engine.version(w.versionId);
      const types = new Set(version?.definition.nodes.map((n) => n.type));
      if (types.has("deploys.check") && types.has("app.notify")) return true;
    }
    return false;
  }

  // ------------------------------------------------------------- actions

  checkAction(start: ActionCheckStart): Promise<ActionCheckView | null> {
    return this.actions.begin(start);
  }

  /** Saves the last round of a deploy's verify as a run of its site check. */
  async recordVerify(checkId: string | null, outcome: RunOutcome): Promise<void> {
    if (!checkId) return;
    const [row] = await this.#db.select().from(schema.checks).where(eq(schema.checks.id, checkId));
    if (row) await this.#slots.run(() => this.execute(row, outcome));
  }

  /** Runs work in the background that `idle` waits for. */
  background(label: string, work: () => Promise<unknown>) {
    this.#background(label, work);
  }
}
