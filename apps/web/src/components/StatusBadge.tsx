import type { InstallationStatus, NodeRunStatus, RunStatus, SandboxState } from "@sling/core";
import { Badge, Dot } from "./ui.tsx";

type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export const RUN_TONE: Record<RunStatus | NodeRunStatus, Tone> = {
  queued: "neutral",
  running: "accent",
  waiting: "warn",
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
  skipped: "neutral",
};

export function RunStatusBadge({ status }: { status: RunStatus | NodeRunStatus }) {
  return <Badge tone={RUN_TONE[status] ?? "neutral"}>{status}</Badge>;
}

export const INSTALLATION_TONE: Record<InstallationStatus, Tone> = {
  idle: "neutral",
  connecting: "warn",
  connected: "ok",
  error: "danger",
  disabled: "neutral",
};

export function InstallationStatusLabel({ status }: { status: InstallationStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-soft">
      <Dot tone={INSTALLATION_TONE[status] ?? "neutral"} />
      {status}
    </span>
  );
}

export const SANDBOX_TONE: Record<SandboxState, Tone> = {
  requested: "neutral",
  provisioning: "warn",
  ready: "ok",
  busy: "accent",
  releasing: "neutral",
  destroyed: "neutral",
  failed: "danger",
};

export function SandboxStateBadge({ state }: { state: SandboxState }) {
  return <Badge tone={SANDBOX_TONE[state] ?? "neutral"}>{state}</Badge>;
}
