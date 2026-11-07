import type { PermissionMode } from "./modes.ts";

/**
 * Rules: standing answers. An allow rule skips the question for an action
 * that would ask. A start rule opens a chat when a check changes.
 */

export const RULE_KINDS = ["allow", "start"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** Task steps an allow rule can cover. Merges and deploys always ask. */
export const RULE_TASK_STEPS = ["push", "open_pr"] as const;
export type RuleTaskStep = (typeof RULE_TASK_STEPS)[number];

/** What a check did that a start rule reacts to. */
export const START_RULE_EVENTS = ["down", "up", "met", "missed"] as const;
export type StartRuleEvent = (typeof START_RULE_EVENTS)[number];

/** Modes a start rule's chat may run in. Never Full access. */
export const START_RULE_MODES = [
  "read-only",
  "supervised",
  "auto",
] as const satisfies readonly PermissionMode[];
export type StartRuleMode = (typeof START_RULE_MODES)[number];

/** Approvals in a row, with no denial, after which a card suggests a rule. */
export const RULE_SUGGEST_AFTER = 5;

interface RuleViewBase {
  id: string;
  /** One line, such as "Email to anyone at acme.com" or "When Website goes down, Incident investigates". */
  summary: string;
  /** The approval card or the chat it was made from. Both null when made on the Rules tab. */
  createdFrom: { approvalId: string | null; conversationId: string | null };
  uses: number;
  lastUsedAt: string | null;
  /** Revoked rules stay, for the audit, and never match again. */
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AllowRuleView extends RuleViewBase {
  kind: "allow";
  /** A flagged node type such as `email.send`, `run_workflow`, or a task step: `push` or `open_pr`. */
  action: string;
  /** One account, or null for any. */
  installationId: string | null;
  installationName: string | null;
  /**
   * Pinned arguments. A value matches exactly, or as a suffix when it starts
   * with one `*`, such as `*@acme.com`. Arguments left out are free. Task
   * steps pin `repo`, as `host/owner/name`.
   */
  match: Record<string, string>;
}

export interface StartRuleView extends RuleViewBase {
  kind: "start";
  /** One check, or null for every check. */
  checkId: string | null;
  checkName: string | null;
  on: StartRuleEvent;
  /** Who answers. Null uses the default personality. */
  personalityId: string | null;
  /** The chat's first message. `{check}` and `{results}` are filled in. */
  message: string;
  mode: StartRuleMode;
}

export type RuleView = AllowRuleView | StartRuleView;

export interface AllowRuleInput {
  kind: "allow";
  action: string;
  installationId?: string | null;
  match?: Record<string, string>;
  /** The approval whose Always allow made it. */
  approvalId?: string | null;
  conversationId?: string | null;
}

export interface StartRuleInput {
  kind: "start";
  checkId: string | null;
  on: StartRuleEvent;
  personalityId?: string | null;
  message: string;
  mode: StartRuleMode;
  conversationId?: string | null;
}

/** POST /api/rules */
export type RuleInput = AllowRuleInput | StartRuleInput;

/** What an approval card's Always allow would make. */
export interface RuleOfferView {
  /** What the rule would cover, such as "Email to anyone at acme.com". */
  summary: string;
  rule: AllowRuleInput;
  /**
   * Approvals in a row of the same action and account, with no denial in the
   * last 30 days. The card says so from RULE_SUGGEST_AFTER.
   */
  streak: number;
}

/** A chat a start rule opened, as its header shows it. */
export interface ConversationStartedBy {
  kind: "rule";
  ruleId: string;
  /** The check whose change started it. */
  checkId: string | null;
  checkName: string;
  on: StartRuleEvent;
}
