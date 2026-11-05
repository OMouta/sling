import {
  HARNESS_LABELS,
  HARNESSES,
  type Harness,
  harnessCapability,
  type RunnerView,
} from "@sling/core";

/** Paired machines. A sandbox's Runner is ephemeral and belongs on the Sandboxes page. */
export function machinesOnly(runners: RunnerView[]): RunnerView[] {
  return runners.filter((r) => !r.ephemeral);
}

/** The Runner adds `os:` and `arch:` labels itself; the rest come from the machine's config. */
export function isAutomaticLabel(label: string): boolean {
  return label.startsWith("os:") || label.startsWith("arch:");
}

export function splitLabels(labels: string[]): { own: string[]; automatic: string[] } {
  return {
    own: labels.filter((l) => !isAutomaticLabel(l)),
    automatic: labels.filter(isAutomaticLabel),
  };
}

export interface AgentStatus {
  harness: Harness;
  label: string;
  installed: boolean;
  ready: boolean;
  version: string;
  /** Why it isn't ready, from the Runner. */
  detail: string;
}

/** Every coding agent Sling knows, and whether this machine has it ready. */
export function codingAgents(runner: RunnerView): AgentStatus[] {
  return HARNESSES.map((harness) => {
    const cap = runner.capabilities.find((c) => c.name === harnessCapability(harness));
    return {
      harness,
      label: HARNESS_LABELS[harness],
      installed: cap !== undefined,
      ready: cap?.ready ?? false,
      version: cap?.version ?? "",
      detail: cap?.detail ?? "",
    };
  });
}

/** Capability names `codingAgents` already covers. */
export function isAgentCapability(name: string): boolean {
  return HARNESSES.some((h) => harnessCapability(h) === name);
}
