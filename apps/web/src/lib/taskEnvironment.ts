import type { RoutingView, SandboxState, TaskState, TaskView } from "@sling/core";

const SETTLED: ReadonlySet<TaskState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "rejected",
  "interrupted",
]);

export type EnvironmentSummary =
  | { kind: "machine"; text: string }
  | { kind: "sandbox"; text: string; state: SandboxState; sandboxId: string | null }
  | { kind: "waiting"; text: string }
  | { kind: "none"; text: string };

/**
 * Where a task runs, in a few words for its card. A task has no machine until
 * it's bound, so before that this says what it's waiting for.
 */
export function environmentSummary(task: TaskView, awaitingApproval: boolean): EnvironmentSummary {
  if (awaitingApproval) return { kind: "waiting", text: "waiting for approval" };
  const env = task.environment;
  const settled = SETTLED.has(task.state);
  if (env.kind === "sandbox") {
    if (env.sandboxState === null) {
      return settled
        ? { kind: "none", text: "no sandbox started" }
        : { kind: "waiting", text: "waiting for a sandbox" };
    }
    return {
      kind: "sandbox",
      text: env.providerName ? `in a sandbox on ${env.providerName}` : "in a sandbox",
      state: env.sandboxState,
      sandboxId: env.sandboxId,
    };
  }
  if (task.runnerName) return { kind: "machine", text: `on ${task.runnerName}` };
  return settled
    ? { kind: "none", text: "no machine took it" }
    : { kind: "waiting", text: "waiting for a machine" };
}

/** The machines the router looked at, eligible ones first, otherwise in its order. */
export function sortConsidered(considered: RoutingView["considered"]): RoutingView["considered"] {
  return [...considered].sort((a, b) => Number(b.eligible) - Number(a.eligible));
}
