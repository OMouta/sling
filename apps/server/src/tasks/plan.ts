import {
  type ActionKind,
  type ActionState,
  type Delivery,
  type DeployMethod,
  MODE_POLICY,
  needsApproval,
  type PermissionMode,
} from "@sling/core";

export interface PlannedStep {
  kind: ActionKind;
  /** The state it's created in. */
  state: ActionState;
  requiresApproval: boolean;
}

/**
 * The merge, deploy, and verify steps for a target. A host that deploys on
 * merge has no deploy step. They start queued: their approvals come when the
 * steps before them are done.
 */
export function deploySteps(mode: PermissionMode, method: DeployMethod): PlannedStep[] {
  const kinds: ActionKind[] =
    method === "merge" ? ["merge", "verify"] : ["merge", "deploy", "verify"];
  return kinds.map((kind) => ({
    kind,
    state: "queued",
    requiresApproval: needsApproval(mode, kind),
  }));
}

/**
 * Every step after a successful task, in order: push, the PR, then for a
 * deploy, the steps for its target. Push and PR ask right away, as the mode
 * says. Read-only and a local delivery have none.
 */
export function deliveryPlan(
  deliver: Delivery,
  mode: PermissionMode,
  method: DeployMethod | null,
): PlannedStep[] {
  if (!MODE_POLICY[mode].writes || deliver === "local") return [];
  const first: ActionKind[] = deliver === "push" ? ["push"] : ["push", "open_pr"];
  const steps: PlannedStep[] = first.map((kind) => {
    const ask = needsApproval(mode, kind);
    return { kind, state: ask ? "awaiting_approval" : "ready", requiresApproval: ask };
  });
  if (deliver === "deploy" && method) steps.push(...deploySteps(mode, method));
  return steps;
}

/** Where a queued merge or deploy goes once the steps reach it. */
export function reachedState(mode: PermissionMode, kind: ActionKind): ActionState {
  return needsApproval(mode, kind) ? "awaiting_approval" : "ready";
}
