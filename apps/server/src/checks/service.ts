import {
  type ActionCheckView,
  type CheckInput,
  type CheckPatch,
  type CheckResultView,
  type CheckState,
  type CheckView,
  DEPLOY_METHODS,
  type DeployCheck,
  MERGE_METHODS,
} from "@sling/core";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { TargetFields } from "../deploys/service.ts";
import type { Actor } from "../http/session.ts";

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
  contains: z.string().max(500).nullable().default(null),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
});

const ReplyConfig = z.object({
  kind: z.literal("reply"),
  from: z.string().trim().max(320).nullable().default(null),
  subject: z.string().trim().max(500).nullable().default(null),
  inReplyTo: z.string().trim().max(998).nullable().default(null),
  folder: z.string().trim().max(200).nullable().default(null),
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
  /** Registers the scheduler and the action check jobs. */
  start(boss: PgBoss): Promise<void>;
  /** Resolves once checks in flight have finished. */
  idle(): Promise<void>;
}

/** What Sling watches on its own. Until it's built there are no checks and nothing runs. */
export class Checks implements CheckService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async list(): Promise<CheckView[]> {
    return [];
  }

  async get(): Promise<CheckView | null> {
    return null;
  }

  async create(): Promise<CheckView> {
    void this.#ctx;
    throw new CheckInputError("Checks aren't available on this server yet.", 501);
  }

  async update(): Promise<CheckView | null> {
    return null;
  }

  async remove(): Promise<boolean> {
    return false;
  }

  async run(): Promise<CheckView | null> {
    return null;
  }

  async results(): Promise<CheckResultView[] | null> {
    return null;
  }

  async checkAction(): Promise<ActionCheckView | null> {
    return null;
  }

  async start(): Promise<void> {}

  async idle(): Promise<void> {}
}
