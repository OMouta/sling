/**
 * Permission modes (D14). Each mode sets the Codex sandbox and which actions
 * need an approval. This table is the one place that decides that.
 */
export const PERMISSION_MODES = ["read-only", "supervised", "auto", "full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_MODE: PermissionMode = "auto";

export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Things a task can do after the harness finishes. */
export const ACTION_KINDS = ["push", "open_pr", "merge", "deploy"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ModePolicy {
  label: string;
  description: string;
  sandbox: Sandbox;
  /** Whether the harness may change files at all. */
  writes: boolean;
  /** Actions that wait for a person before running. */
  approvalRequired: readonly ActionKind[];
}

export const MODE_POLICY: Record<PermissionMode, ModePolicy> = {
  "read-only": {
    label: "Read-only",
    description: "Codex can look but not change anything.",
    sandbox: "read-only",
    writes: false,
    approvalRequired: ACTION_KINDS,
  },
  supervised: {
    label: "Supervised",
    description: "Codex edits its worktree. Push, PR, merge, and deploy ask first.",
    sandbox: "workspace-write",
    writes: true,
    approvalRequired: ["push", "open_pr", "merge", "deploy"],
  },
  auto: {
    label: "Auto",
    description: "Pushes branches and opens PRs on its own. Merge and deploy ask first.",
    sandbox: "workspace-write",
    writes: true,
    approvalRequired: ["merge", "deploy"],
  },
  "full-access": {
    label: "Full access",
    description: "Nothing asks, and Codex runs without a sandbox.",
    sandbox: "danger-full-access",
    writes: true,
    approvalRequired: [],
  },
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function modeRank(mode: PermissionMode): number {
  return PERMISSION_MODES.indexOf(mode);
}

/** True when `mode` is at or below `cap`. */
export function modeWithinCap(mode: PermissionMode, cap: PermissionMode): boolean {
  return modeRank(mode) <= modeRank(cap);
}

export function needsApproval(mode: PermissionMode, action: ActionKind): boolean {
  return MODE_POLICY[mode].approvalRequired.includes(action);
}
