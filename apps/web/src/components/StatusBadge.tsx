import type {
  ActionView,
  InstallationStatus,
  NodeRunStatus,
  RunStatus,
  SandboxState,
  TaskState,
} from "@sling/core";
import { Badge, Dot, type Tone } from "./ui.tsx";

/*
 * One word or two for every state Sling shows, so a badge, a dot's text and
 * the timeline name the same state the same way.
 */

export const TASK_STATE: Record<TaskState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  dispatched: { label: "Starting", tone: "accent" },
  running: { label: "Running", tone: "accent" },
  succeeded: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rejected: { label: "Refused by machine", tone: "danger" },
  interrupted: { label: "Interrupted", tone: "warn" },
};

/** A step after a task, such as a push or a deploy. */
export const ACTION_STATE: Record<ActionView["state"], string> = {
  queued: "Not started",
  awaiting_approval: "Waiting for approval",
  ready: "Ready",
  sent: "In progress",
  succeeded: "Done",
  failed: "Failed",
  refused: "Refused by machine",
  rejected: "Rejected",
  expired: "Approval expired",
  skipped: "Skipped",
};

export const RUN_STATE: Record<RunStatus | NodeRunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  waiting: { label: "Waiting", tone: "warn" },
  succeeded: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export const RUN_TONE = Object.fromEntries(
  Object.entries(RUN_STATE).map(([k, v]) => [k, v.tone]),
) as Record<RunStatus | NodeRunStatus, Tone>;

export function RunStatusBadge({ status }: { status: RunStatus | NodeRunStatus }) {
  const s = RUN_STATE[status];
  return <Badge tone={s?.tone ?? "neutral"}>{s?.label ?? status}</Badge>;
}

export const INSTALLATION_STATE: Record<InstallationStatus, { label: string; tone: Tone }> = {
  idle: { label: "Idle", tone: "neutral" },
  connecting: { label: "Connecting", tone: "warn" },
  connected: { label: "Connected", tone: "ok" },
  error: { label: "Error", tone: "danger" },
  disabled: { label: "Off", tone: "neutral" },
};

export function InstallationStatusLabel({ status }: { status: InstallationStatus }) {
  const s = INSTALLATION_STATE[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-soft">
      <Dot tone={s?.tone ?? "neutral"} />
      {s?.label ?? status}
    </span>
  );
}

export const SANDBOX_STATE: Record<SandboxState, { label: string; tone: Tone }> = {
  requested: { label: "Queued", tone: "neutral" },
  provisioning: { label: "Starting", tone: "warn" },
  ready: { label: "Ready", tone: "ok" },
  busy: { label: "In use", tone: "accent" },
  releasing: { label: "Stopping", tone: "neutral" },
  destroyed: { label: "Removed", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export function SandboxStateBadge({ state }: { state: SandboxState }) {
  const s = SANDBOX_STATE[state];
  return <Badge tone={s?.tone ?? "neutral"}>{s?.label ?? state}</Badge>;
}
