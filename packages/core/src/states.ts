/** Task lifecycle. Terminal states have no outgoing transitions. */
export const TASK_STATES = [
  "queued",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "rejected",
  "interrupted",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["dispatched", "cancelled", "failed"],
  dispatched: ["running", "rejected", "cancelled", "failed", "interrupted"],
  running: ["succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  rejected: [],
  interrupted: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTerminalTask(state: TaskState): boolean {
  return TASK_TRANSITIONS[state].length === 0;
}

/** Follow-up actions such as push and open PR. */
export const ACTION_STATES = [
  "awaiting_approval",
  "ready",
  "sent",
  "succeeded",
  "failed",
  "refused",
  "rejected",
  "expired",
  "skipped",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

const ACTION_TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  awaiting_approval: ["ready", "rejected", "expired", "skipped"],
  ready: ["sent", "skipped"],
  sent: ["succeeded", "failed", "refused", "ready"],
  succeeded: [],
  failed: [],
  refused: [],
  rejected: [],
  expired: [],
  skipped: [],
};

export function canTransitionAction(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export function isTerminalAction(state: ActionState): boolean {
  return ACTION_TRANSITIONS[state].length === 0;
}

export const APPROVAL_STATES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** Pending approvals expire after this long (decisions.md defaults). */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const DELIVERY_KINDS = ["local", "push", "pr"] as const;
export type Delivery = (typeof DELIVERY_KINDS)[number];
