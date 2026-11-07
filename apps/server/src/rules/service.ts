import {
  type PermissionMode,
  type RuleInput,
  type RuleOfferView,
  type RuleView,
  START_RULE_EVENTS,
  START_RULE_MODES,
} from "@sling/core";
import { z } from "zod";
import type { CheckChange } from "../checks/service.ts";
import type { AppContext } from "../context.ts";
import type { Actor } from "../http/session.ts";

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
  match: z
    .record(z.string().min(1).max(100), z.string().min(1).max(500))
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
}

export interface RuleService {
  list(workspaceId: string): Promise<RuleView[]>;
  /** Throws RuleInputError for a rule that can't exist. Audits `rule.created`. */
  create(actor: Actor, input: RuleInput): Promise<RuleView>;
  /** Revokes it, audits `rule.revoked`, and publishes `rule.updated`. Null when there's none. */
  revoke(actor: Actor, id: string): Promise<RuleView | null>;
  /**
   * The allow rule that lets this call through without asking, or null.
   * Only in Supervised and Auto, and never for merges, deploys, commands
   * outside the sandbox, setup changes, or saving a rule.
   */
  allowing(call: RuleCall): Promise<RuleView | null>;
  /** Counts a use of a rule that let a call through, and audits `rule.used`. */
  used(rule: RuleView, call: RuleCall): Promise<void>;
  /** What Always allow on this call's card would make. Null when no rule can cover it. */
  offer(call: RuleCall): Promise<RuleOfferView | null>;
  /** Opens the chats that start rules ask for when a check changes state. */
  checkChanged(change: CheckChange): Promise<void>;
}

/** Standing answers. Until it's built there are none, so everything still asks. */
export class Rules implements RuleService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async list(): Promise<RuleView[]> {
    return [];
  }

  async create(): Promise<RuleView> {
    void this.#ctx;
    throw new RuleInputError("Rules aren't available on this server yet.", 501);
  }

  async revoke(): Promise<RuleView | null> {
    return null;
  }

  async allowing(): Promise<RuleView | null> {
    return null;
  }

  async used(): Promise<void> {}

  async offer(): Promise<RuleOfferView | null> {
    return null;
  }

  async checkChanged(): Promise<void> {}
}
