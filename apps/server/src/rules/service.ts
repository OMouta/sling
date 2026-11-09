import {
  type AllowRuleInput,
  type AllowRuleView,
  newId,
  type PermissionMode,
  type RuleInput,
  type RuleOfferView,
  type RuleView,
  START_RULE_EVENTS,
  START_RULE_MODES,
  type StartRuleInput,
} from "@sling/core";
import { type Db, schema } from "@sling/db";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { CheckChange } from "../checks/service.ts";
import type { AppContext } from "../context.ts";
import type { Actor } from "../http/session.ts";
import { defaultPersonality, usablePersonality } from "../personalities/service.ts";
import { matchesAll, normalizePattern, offeredPattern, patternError } from "./match.ts";
import { type StartedChat, startChats } from "./start.ts";
import { allowSummary, startSummary } from "./summary.ts";

/** A rule the request can't make, with the status to answer. */
export class RuleInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const Id = z.string().min(1).max(100);

const AllowRuleSchema = z.object({
  kind: z.literal("allow"),
  action: z.string().min(1).max(200),
  installationId: Id.nullable().optional(),
  // An empty value pins an argument to being left out, such as a Discord
  // message to a channel with no user.
  match: z
    .record(z.string().min(1).max(100), z.string().max(500))
    .refine((m) => Object.keys(m).length <= 20, "A rule pins at most 20 arguments")
    .optional(),
  approvalId: Id.nullable().optional(),
  conversationId: Id.nullable().optional(),
});

const StartRuleSchema = z.object({
  kind: z.literal("start"),
  checkId: Id.nullable(),
  on: z.enum(START_RULE_EVENTS),
  personalityId: Id.nullable().optional(),
  message: z.string().trim().min(1).max(4000),
  mode: z.enum(START_RULE_MODES),
  conversationId: Id.nullable().optional(),
});

export const RuleInputSchema = z.discriminatedUnion("kind", [
  AllowRuleSchema,
  StartRuleSchema,
]) satisfies z.ZodType<RuleInput>;

/** An action about to ask the user, as an allow rule sees it. */
export interface RuleCall {
  workspaceId: string;
  ownerId: string;
  /** A flagged node type, `run_workflow`, `push`, or `open_pr`. */
  action: string;
  installationId: string | null;
  /** The call's arguments. Task steps pass `{ repo }`, as `host/owner/name`. */
  args: Record<string, unknown>;
  /** The mode of the chat or task it's in. */
  mode: PermissionMode;
  conversationId: string | null;
  /** A task's step: for the audit. */
  taskId?: string | null;
  actionId?: string | null;
}

export interface RuleService {
  list(workspaceId: string): Promise<RuleView[]>;
  /** Throws RuleInputError for a rule that can't exist. Audits `rule.created`. */
  create(actor: Actor, input: RuleInput): Promise<RuleView>;
  /** The summary a rule would have, checked as create checks it, without saving anything. */
  describe(workspaceId: string, input: RuleInput): Promise<string>;
  /** Revokes it, audits `rule.revoked`, and publishes `rule.updated`. Null when there's none. */
  revoke(actor: Actor, id: string): Promise<RuleView | null>;
  /**
   * The allow rule that lets this call through without asking, or null.
   * Only in Supervised and Auto, and never for merges, deploys, commands
   * outside the sandbox, setup changes, or saving a rule.
   */
  allowing(call: RuleCall): Promise<RuleView | null>;
  /**
   * Counts a use of a rule that let a call through, and audits `rule.used`.
   * `db` is a transaction the call's own writes are in.
   */
  used(rule: RuleView, call: RuleCall, db?: Db): Promise<void>;
  /** What Always allow on this call's card would make. Null when no rule can cover it. */
  offer(call: RuleCall, streak?: number): Promise<RuleOfferView | null>;
  /**
   * Opens the chats that start rules ask for when a check changes state, and
   * starts their first turns. Returns the chats it opened, for the alert's
   * push to link to; their turns run on after it returns.
   */
  checkChanged(change: CheckChange): Promise<StartedChat[]>;
}

/** What a rule may cover, and the arguments it may pin. */
interface Cover {
  fields: readonly string[];
  /** For a summary without wording of its own. */
  title: string;
  /** Node types only: the connector its accounts belong to. */
  connector: string | null;
}

/** Never covered, whatever the input says. Merges and deploys aren't actions here at all. */
const NEVER = new Set(["merge", "deploy", "run_command", "deploy_task", "save_rule"]);

/** Modes where an allow rule can answer. Read-only refuses sends, and Full access never asks. */
const RULE_MODES: readonly PermissionMode[] = ["supervised", "auto"];

/** How far back a card counts approvals in a row. */
const STREAK_DAYS = 30;
/** Most decisions a streak looks at. */
const STREAK_MAX = 100;

type RuleRow = typeof schema.rules.$inferSelect;

function toView(
  r: RuleRow,
  names: { installationName: string | null; checkName: string | null },
): RuleView {
  const base = {
    id: r.id,
    summary: r.summary,
    createdFrom: { approvalId: r.approvalId, conversationId: r.conversationId },
    uses: r.uses,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  if (r.kind === "start") {
    return {
      ...base,
      kind: "start",
      checkId: r.checkId,
      checkName: names.checkName,
      on: r.on ?? "down",
      personalityId: r.personalityId,
      message: r.message ?? "",
      mode: r.mode ?? "read-only",
    };
  }
  return {
    ...base,
    kind: "allow",
    action: r.action ?? "",
    installationId: r.installationId,
    installationName: names.installationName,
    match: r.match,
  };
}

/** Standing answers: allow rules that skip a question, and start rules that open a chat. */
export class Rules implements RuleService {
  readonly #ctx: AppContext;
  /**
   * Active allow rules by workspace, so matching a call reads no database.
   * Rules change only through this service, which drops the entry.
   */
  readonly #allow = new Map<string, Promise<AllowRuleView[]>>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async #views(where: ReturnType<typeof and>): Promise<RuleView[]> {
    const rows = await this.#ctx.db
      .select({
        rule: schema.rules,
        installationName: schema.connectorInstallations.name,
        checkName: schema.checks.name,
      })
      .from(schema.rules)
      .leftJoin(
        schema.connectorInstallations,
        eq(schema.connectorInstallations.id, schema.rules.installationId),
      )
      .leftJoin(schema.checks, eq(schema.checks.id, schema.rules.checkId))
      .where(where)
      .orderBy(desc(schema.rules.createdAt));
    return rows.map((r) =>
      toView(r.rule, { installationName: r.installationName, checkName: r.checkName }),
    );
  }

  async #one(id: string): Promise<RuleView | null> {
    const [view] = await this.#views(and(eq(schema.rules.id, id)));
    return view ?? null;
  }

  list(workspaceId: string): Promise<RuleView[]> {
    return this.#views(and(eq(schema.rules.workspaceId, workspaceId)));
  }

  #active(workspaceId: string): Promise<AllowRuleView[]> {
    let cached = this.#allow.get(workspaceId);
    if (!cached) {
      cached = this.#views(
        and(
          eq(schema.rules.workspaceId, workspaceId),
          eq(schema.rules.kind, "allow"),
          isNull(schema.rules.revokedAt),
        ),
      ).then((list) => list.filter((r): r is AllowRuleView => r.kind === "allow"));
      // A failed load isn't kept, so the next call tries again.
      cached.catch(() => this.#allow.delete(workspaceId));
      this.#allow.set(workspaceId, cached);
    }
    return cached;
  }

  #cover(action: string): Cover | null {
    if (NEVER.has(action)) return null;
    if (action === "push") return { fields: ["repo"], title: "Push", connector: null };
    if (action === "open_pr") return { fields: ["repo"], title: "Open PR", connector: null };
    if (action === "run_workflow") {
      return { fields: ["workflow"], title: "Run workflow", connector: null };
    }
    const spec = this.#ctx.registry.latest(action);
    if (!spec?.assistant?.sends || spec.trigger || !spec.connector) return null;
    return {
      fields: spec.assistant.ruleFields ?? [],
      title: spec.title,
      connector: spec.connector,
    };
  }

  async #publish(workspaceId: string, id: string): Promise<RuleView | null> {
    const view = await this.#one(id);
    if (view) this.#ctx.hub.publish(workspaceId, { type: "rule.updated", rule: view });
    return view;
  }

  // ------------------------------------------------------------- making rules

  async create(actor: Actor, input: RuleInput): Promise<RuleView> {
    const id =
      input.kind === "allow"
        ? await this.#createAllow(actor, input)
        : await this.#createStart(actor, input);
    const view = await this.#publish(actor.workspaceId, id);
    if (!view) throw new Error("rule insert failed");
    return view;
  }

  /** The account a rule pins, checked to be one of the action's own. */
  async #installation(
    workspaceId: string,
    cover: Cover,
    id: string | null | undefined,
  ): Promise<{ id: string; name: string } | null> {
    if (!id) return null;
    if (!cover.connector) throw new RuleInputError("This action doesn't use an account.");
    const [row] = await this.#ctx.db
      .select({
        id: schema.connectorInstallations.id,
        name: schema.connectorInstallations.name,
        connectorId: schema.connectorInstallations.connectorId,
      })
      .from(schema.connectorInstallations)
      .where(
        and(
          eq(schema.connectorInstallations.id, id),
          eq(schema.connectorInstallations.workspaceId, workspaceId),
        ),
      );
    if (!row) throw new RuleInputError("That account doesn't exist.", 404);
    if (row.connectorId !== cover.connector) {
      throw new RuleInputError(`${row.name} isn't an account this action can use.`);
    }
    return { id: row.id, name: row.name };
  }

  /** Whether the account needs naming: its connector has another one. */
  async #manyAccounts(workspaceId: string, connector: string | null): Promise<boolean> {
    if (!connector) return false;
    const [row] = await this.#ctx.db
      .select({ n: count() })
      .from(schema.connectorInstallations)
      .where(
        and(
          eq(schema.connectorInstallations.workspaceId, workspaceId),
          eq(schema.connectorInstallations.connectorId, connector),
        ),
      );
    return (row?.n ?? 0) > 1;
  }

  async #workflowName(workspaceId: string, id: string | undefined): Promise<string | null> {
    if (!id) return null;
    const [wf] = await this.#ctx.db
      .select({ name: schema.workflows.name })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, workspaceId)));
    return wf?.name ?? null;
  }

  /** The rule's summary, as the card and the Rules tab say it. */
  async #allowSummary(
    workspaceId: string,
    cover: Cover,
    action: string,
    match: Record<string, string>,
    installation: { id: string; name: string } | null,
  ): Promise<string> {
    const named = installation && (await this.#manyAccounts(workspaceId, cover.connector));
    return allowSummary({
      action,
      match,
      title: cover.title,
      installationName: named ? installation.name : null,
      workflowName:
        action === "run_workflow" ? await this.#workflowName(workspaceId, match.workflow) : null,
    });
  }

  async describe(workspaceId: string, input: RuleInput): Promise<string> {
    const ready =
      input.kind === "allow"
        ? await this.#prepareAllow(workspaceId, input)
        : await this.#prepareStart(workspaceId, input);
    return ready.summary;
  }

  /** An allow rule's pins and account, checked, and its summary. */
  async #prepareAllow(workspaceId: string, input: AllowRuleInput) {
    const cover = this.#cover(input.action);
    if (!cover) {
      throw new RuleInputError(
        `${input.action} can't have an allow rule. Rules cover sends from chat, workflow runs, and a task's push and pull request, never merges, deploys, commands, or setup changes.`,
      );
    }
    const match: Record<string, string> = {};
    for (const [field, raw] of Object.entries(input.match ?? {})) {
      if (!cover.fields.includes(field)) {
        throw new RuleInputError(
          cover.fields.length
            ? `A rule for ${input.action} can pin ${cover.fields.join(", ")}, not ${field}.`
            : `A rule for ${input.action} can't pin arguments, only the account.`,
        );
      }
      const problem = patternError(raw);
      if (problem) throw new RuleInputError(problem);
      match[field] = normalizePattern(raw);
    }
    if (input.action === "run_workflow" && match.workflow) {
      if (!(await this.#workflowName(workspaceId, match.workflow))) {
        throw new RuleInputError("That workflow doesn't exist.", 404);
      }
    }
    const installation = await this.#installation(workspaceId, cover, input.installationId);
    const summary = await this.#allowSummary(workspaceId, cover, input.action, match, installation);
    return { match, installation, summary };
  }

  async #createAllow(actor: Actor, input: AllowRuleInput): Promise<string> {
    const { match, installation, summary } = await this.#prepareAllow(actor.workspaceId, input);
    // The same rule twice, as from a double click, is the one already there.
    const existing = (await this.#active(actor.workspaceId)).find(
      (r) =>
        r.action === input.action &&
        r.installationId === (installation?.id ?? null) &&
        JSON.stringify(Object.entries(r.match).sort()) ===
          JSON.stringify(Object.entries(match).sort()),
    );
    if (existing) return existing.id;

    const conversationId = await this.#conversation(actor.workspaceId, input.conversationId);
    const id = newId("rul");
    await this.#ctx.db.insert(schema.rules).values({
      id,
      workspaceId: actor.workspaceId,
      ownerId: actor.userId,
      kind: "allow",
      summary,
      action: input.action,
      installationId: installation?.id ?? null,
      match,
      approvalId: input.approvalId ?? null,
      conversationId,
    });
    this.#allow.delete(actor.workspaceId);
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "rule.created",
      subjectType: "rule",
      subjectId: id,
      details: {
        kind: "allow",
        summary,
        action: input.action,
        installationId: installation?.id ?? null,
        match,
        approvalId: input.approvalId ?? null,
        conversationId,
      },
    });
    return id;
  }

  /** A chat the rule was made from, when it's in the workspace. */
  async #conversation(workspaceId: string, id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const [conv] = await this.#ctx.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(eq(schema.conversations.id, id), eq(schema.conversations.workspaceId, workspaceId)),
      );
    return conv?.id ?? null;
  }

  /** A start rule's check and personality, checked, and its summary. */
  async #prepareStart(workspaceId: string, input: StartRuleInput) {
    let checkName: string | null = null;
    if (input.checkId) {
      const [check] = await this.#ctx.db
        .select({ name: schema.checks.name, kind: schema.checks.kind })
        .from(schema.checks)
        .where(
          and(eq(schema.checks.id, input.checkId), eq(schema.checks.workspaceId, workspaceId)),
        );
      if (!check) throw new RuleInputError("That check doesn't exist.", 404);
      const replies = check.kind === "reply";
      if (replies !== (input.on === "met" || input.on === "missed")) {
        throw new RuleInputError(
          replies
            ? `${check.name} waits for a reply, so a rule starts on met or missed.`
            : `${check.name} goes up and down, so a rule starts on down or up.`,
        );
      }
      checkName = check.name;
    }
    const personality = input.personalityId
      ? await usablePersonality(this.#ctx.db, workspaceId, input.personalityId)
      : await defaultPersonality(this.#ctx.db, workspaceId);
    if (input.personalityId && !personality) {
      throw new RuleInputError("That personality doesn't exist anymore.", 404);
    }
    const summary = startSummary({
      checkName,
      on: input.on,
      personalityName: personality?.name ?? "Sling",
    });
    return { summary };
  }

  async #createStart(actor: Actor, input: StartRuleInput): Promise<string> {
    const { summary } = await this.#prepareStart(actor.workspaceId, input);
    const conversationId = await this.#conversation(actor.workspaceId, input.conversationId);
    const id = newId("rul");
    await this.#ctx.db.insert(schema.rules).values({
      id,
      workspaceId: actor.workspaceId,
      ownerId: actor.userId,
      kind: "start",
      summary,
      checkId: input.checkId,
      on: input.on,
      personalityId: input.personalityId ?? null,
      message: input.message,
      mode: input.mode,
      conversationId,
    });
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "rule.created",
      subjectType: "rule",
      subjectId: id,
      details: {
        kind: "start",
        summary,
        checkId: input.checkId,
        on: input.on,
        personalityId: input.personalityId ?? null,
        mode: input.mode,
        conversationId,
      },
    });
    return id;
  }

  async revoke(actor: Actor, id: string): Promise<RuleView | null> {
    const mine = and(eq(schema.rules.id, id), eq(schema.rules.workspaceId, actor.workspaceId));
    const [row] = await this.#ctx.db
      .update(schema.rules)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(mine, isNull(schema.rules.revokedAt)))
      .returning({ id: schema.rules.id, summary: schema.rules.summary, kind: schema.rules.kind });
    this.#allow.delete(actor.workspaceId);
    // Already revoked answers with the rule as it is.
    if (!row) return (await this.#views(mine))[0] ?? null;
    await audit(this.#ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "rule.revoked",
      subjectType: "rule",
      subjectId: row.id,
      details: { kind: row.kind, summary: row.summary },
    });
    return this.#publish(actor.workspaceId, row.id);
  }

  // ------------------------------------------------------------- matching

  async allowing(call: RuleCall): Promise<RuleView | null> {
    if (!RULE_MODES.includes(call.mode)) return null;
    if (!this.#cover(call.action)) return null;
    const rules = await this.#active(call.workspaceId);
    return (
      rules.find(
        (r) =>
          r.action === call.action &&
          (r.installationId === null || r.installationId === call.installationId) &&
          matchesAll(r.match, call.args),
      ) ?? null
    );
  }

  async used(rule: RuleView, call: RuleCall, db: Db = this.#ctx.db): Promise<void> {
    await db
      .update(schema.rules)
      .set({ uses: sql`${schema.rules.uses} + 1`, lastUsedAt: new Date() })
      .where(eq(schema.rules.id, rule.id));
    await audit(
      { db, log: this.#ctx.log },
      {
        workspaceId: call.workspaceId,
        actorType: "system",
        verb: "rule.used",
        subjectType: "rule",
        subjectId: rule.id,
        details: {
          kind: rule.kind,
          summary: rule.summary,
          action: call.action,
          installationId: call.installationId,
          conversationId: call.conversationId,
          ...(call.taskId ? { taskId: call.taskId } : {}),
          ...(call.actionId ? { actionId: call.actionId } : {}),
        },
      },
    );
    // Its count on the Rules tab. A transaction commits before anyone reloads it.
    void this.#publish(call.workspaceId, rule.id).catch(() => {});
  }

  async offer(call: RuleCall, knownStreak?: number): Promise<RuleOfferView | null> {
    if (!RULE_MODES.includes(call.mode)) return null;
    const cover = this.#cover(call.action);
    if (!cover) return null;
    const match: Record<string, string> = {};
    for (const field of cover.fields) match[field] = offeredPattern(call.args[field]);
    const installation = call.installationId
      ? await this.#installation(call.workspaceId, cover, call.installationId).catch(() => null)
      : null;
    const [summary, streak] = await Promise.all([
      this.#allowSummary(call.workspaceId, cover, call.action, match, installation),
      knownStreak === undefined ? this.#streak(call) : Promise.resolve(knownStreak),
    ]);
    return {
      summary,
      rule: {
        kind: "allow",
        action: call.action,
        installationId: installation?.id ?? null,
        match,
        ...(call.conversationId ? { conversationId: call.conversationId } : {}),
      },
      streak,
    };
  }

  /**
   * Approvals in a row of this action and account, newest first, up to the
   * first denial, in the last 30 days. Chat answers live in the audit log;
   * a task's push and PR answers are approval rows, per repo.
   */
  async #streak(call: RuleCall): Promise<number> {
    const since = sql`now() - make_interval(days => ${STREAK_DAYS})`;
    let decisions: string[];
    if (call.action === "push" || call.action === "open_pr") {
      const repo = typeof call.args.repo === "string" ? call.args.repo : "";
      if (!repo) return 0;
      const rows = await this.#ctx.db
        .select({ state: schema.approvals.state })
        .from(schema.approvals)
        .innerJoin(schema.actions, eq(schema.actions.id, schema.approvals.actionId))
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.approvals.taskId))
        .leftJoin(schema.repos, eq(schema.repos.id, schema.tasks.repoId))
        .leftJoin(schema.sandboxes, eq(schema.sandboxes.id, schema.tasks.sandboxId))
        .where(
          and(
            eq(schema.approvals.workspaceId, call.workspaceId),
            eq(schema.approvals.kind, "task_action"),
            eq(schema.actions.kind, call.action),
            inArray(schema.approvals.state, ["approved", "rejected"]),
            sql`${schema.approvals.decidedAt} > ${since}`,
            sql`coalesce(${schema.repos.remoteKey}, ${schema.sandboxes.remoteKey}) = ${repo}`,
          ),
        )
        .orderBy(desc(schema.approvals.decidedAt))
        .limit(STREAK_MAX);
      decisions = rows.map((r) => (r.state === "approved" ? "approved" : "denied"));
    } else {
      const d = schema.auditEvents.details;
      const which =
        call.action === "run_workflow"
          ? sql`${d}->>'tool' = 'run_workflow' and ${d}->>'workflowId' = ${String(call.args.workflow ?? "")}`
          : sql`${d}->>'nodeType' = ${call.action} and ${d}->>'installationId' = ${call.installationId ?? ""}`;
      const rows = await this.#ctx.db
        .select({ decision: sql<string>`${d}->>'decision'` })
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.workspaceId, call.workspaceId),
            eq(schema.auditEvents.verb, "assistant.action"),
            sql`${schema.auditEvents.at} > ${since}`,
            sql`${d}->>'decision' in ('approved', 'denied')`,
            which,
          ),
        )
        .orderBy(desc(schema.auditEvents.at))
        .limit(STREAK_MAX);
      decisions = rows.map((r) => r.decision);
    }
    const firstDenial = decisions.indexOf("denied");
    return firstDenial === -1 ? decisions.length : firstDenial;
  }

  // ------------------------------------------------------------- start rules

  checkChanged(change: CheckChange): Promise<StartedChat[]> {
    return startChats(this.#ctx, change, (rule, call, db) => this.used(rule, call, db));
  }
}

export type { StartedChat };
