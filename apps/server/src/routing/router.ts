/**
 * Decides where a coding task runs: which machine, a sandbox, or nowhere, with
 * a one-line reason for every machine it looked at. Pure: the caller loads the
 * machines, the sandbox repo list, and the providers, and acts on the decision.
 */
import {
  HARNESS_LABELS,
  type Harness,
  harnessCapability,
  modeWithinCap,
  type PermissionMode,
  type RoutingView,
  remoteKey,
} from "@sling/core";

export const ENVIRONMENTS = ["auto", "machine", "sandbox"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface MachineRepo {
  id: string;
  name: string;
  remoteKey: string | null;
  /** When a task last ran in this repo on this machine. */
  lastTaskAt: Date | null;
}

export interface MachineCandidate {
  id: string;
  name: string;
  online: boolean;
  /** Effective labels, automatic `os:` and `arch:` included. */
  labels: string[];
  capabilities: { name: string; ready: boolean; detail: string }[];
  maxMode: PermissionMode;
  maxConcurrentTasks: number;
  /** Tasks queued on, dispatched to, or running on it. */
  load: number;
  pairedAt: Date;
  repos: MachineRepo[];
}

export interface SandboxRepoEntry {
  remoteKey: string;
  cloneUrl: string;
  defaultBranch: string;
  network: boolean;
}

export interface ProviderEntry {
  /** Installation ID. */
  id: string;
  /** Installation name, for example `docker-host`. */
  name: string;
  /** Connector name, for example `Docker`. */
  connectorName: string;
}

export interface RouteRequest {
  /** A repo name, a remote key such as `github.com/a/site`, or a remote URL. */
  repo: string;
  harness: Harness;
  labels: string[];
  environment: Environment;
  machineId: string | null;
  providerInstallationId: string | null;
}

export interface RouterInput {
  request: RouteRequest;
  /** The conversation's permission mode. */
  mode: PermissionMode;
  /** The workspace's machines: not revoked, not sandboxes. */
  machines: MachineCandidate[];
  sandboxRepos: SandboxRepoEntry[];
  /** Enabled execution provider installations, oldest first. */
  providers: ProviderEntry[];
  sandboxBudget: { usedMinutes: number; budgetMinutes: number };
  now: Date;
}

export type RouteDecision =
  | {
      kind: "machine";
      runnerId: string;
      runnerName: string;
      repoId: string;
      repoName: string;
      /** Every eligible machine is at its task limit; the task waits in this one's queue. */
      queued: boolean;
    }
  | {
      kind: "sandbox";
      /** True when no machine could take it and the user has to approve the sandbox first. */
      fallback: boolean;
      provider: ProviderEntry;
      repo: SandboxRepoEntry;
      repoName: string;
      /** Why no machine could take it, one line per machine. Empty for a requested sandbox. */
      reasons: string[];
    }
  | { kind: "refused"; message: string; reasons: string[] };

export interface RouteResult {
  decision: RouteDecision;
  routing: RoutingView;
}

/** Labels a sandbox satisfies. Sandboxes run the Linux sandbox image. */
const SANDBOX_LABELS = new Set(["os:linux"]);

/** Labels compare trimmed and lowercased. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * A remote key from user input: a remote URL, or an already normalized
 * `host/owner/name`. Null for a plain repo name.
 */
export function keyFromInput(input: string): string | null {
  const fromUrl = remoteKey(input);
  if (fromUrl) return fromUrl;
  const s = input
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  // A host has a dot (or is localhost), then at least owner and name.
  if (/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?\/[^\s/]+(\/[^\s/]+)+$/.test(s)) return s;
  return null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface RepoTarget {
  /** What the user called it, for messages. */
  display: string;
  /** The name asked for, when a name was given. */
  name: string | null;
  /** Remote keys that identify the repo. Empty for a repo without a remote. */
  keys: Set<string>;
}

function resolveRepo(input: RouterInput): RepoTarget | { ambiguous: string[] } {
  const raw = input.request.repo.trim();
  const key = keyFromInput(raw);
  if (key) return { display: key, name: null, keys: new Set([key]) };
  const keys = new Set<string>();
  for (const m of input.machines) {
    for (const r of m.repos) if (r.name === raw && r.remoteKey) keys.add(r.remoteKey);
  }
  if (keys.size > 1) return { ambiguous: [...keys].sort() };
  if (keys.size === 0 && !input.machines.some((m) => m.repos.some((r) => r.name === raw))) {
    // No machine knows the name. A sandbox repo whose last path segment matches will do.
    const lower = raw.toLowerCase();
    const matches = input.sandboxRepos.filter((s) => s.remoteKey.split("/").at(-1) === lower);
    if (matches.length === 1 && matches[0]) keys.add(matches[0].remoteKey);
  }
  return { display: raw, name: raw, keys };
}

function findRepo(m: MachineCandidate, target: RepoTarget): MachineRepo | undefined {
  return (
    (target.name !== null ? m.repos.find((r) => r.name === target.name) : undefined) ??
    m.repos.find((r) => r.remoteKey !== null && target.keys.has(r.remoteKey))
  );
}

interface Considered {
  machine: MachineCandidate;
  repo: MachineRepo | undefined;
  problems: string[];
  free: number;
}

function check(input: RouterInput, target: RepoTarget, m: MachineCandidate): Considered {
  const { request, mode } = input;
  const repo = findRepo(m, target);
  const free = m.maxConcurrentTasks - m.load;
  if (request.environment === "machine" && request.machineId && m.id !== request.machineId) {
    return { machine: m, repo, problems: ["not the machine you asked for"], free };
  }
  const problems: string[] = [];
  if (!m.online) problems.push("offline");
  if (!repo) problems.push(`doesn't have ${target.display}`);
  const agent = HARNESS_LABELS[request.harness];
  const cap = m.capabilities.find((c) => c.name === harnessCapability(request.harness));
  if (!cap) problems.push(`${agent} isn't installed`);
  else if (!cap.ready) problems.push(`${agent} isn't ready${cap.detail ? ` (${cap.detail})` : ""}`);
  const labels = new Set(m.labels.map(normalizeLabel));
  const missing = request.labels.filter((l) => !labels.has(l));
  if (missing.length) {
    problems.push(
      `doesn't have the ${plural(missing.length, "label", "labels")} ${missing.join(", ")}`,
    );
  }
  if (!modeWithinCap(mode, m.maxMode)) {
    problems.push(`allows at most ${m.maxMode} mode, and this conversation is in ${mode}`);
  }
  return { machine: m, repo, problems, free };
}

/** Best first: the named machine, most free slots, ran the repo last, paired first. */
function rank(a: Considered, b: Considered, named: string | null): number {
  if (named) {
    const an = a.machine.id === named ? 0 : 1;
    const bn = b.machine.id === named ? 0 : 1;
    if (an !== bn) return an - bn;
  }
  if (a.free !== b.free) return b.free - a.free;
  const at = a.repo?.lastTaskAt?.getTime() ?? -1;
  const bt = b.repo?.lastTaskAt?.getTime() ?? -1;
  if (at !== bt) return bt - at;
  return a.machine.pairedAt.getTime() - b.machine.pairedAt.getTime();
}

function slots(c: Considered): string {
  const free = Math.max(0, c.free);
  return `${free} of ${c.machine.maxConcurrentTasks} ${plural(c.machine.maxConcurrentTasks, "slot", "slots")} free`;
}

/** Why the first machine beat the second, in a few words. */
function whyPicked(
  best: Considered,
  next: Considered | undefined,
  named: string | null,
  repo: string,
) {
  if (named && best.machine.id === named) return "you asked for it";
  if (!next) return "it's the only machine that can take it";
  if (best.free !== next.free) return `it has the most free slots (${slots(best)})`;
  const bt = best.repo?.lastTaskAt?.getTime() ?? -1;
  const nt = next.repo?.lastTaskAt?.getTime() ?? -1;
  if (bt !== nt) return `it ran ${repo} most recently, so its worktrees and caches are warm`;
  return "it was paired first";
}

type SandboxOption =
  | { ok: true; provider: ProviderEntry; repo: SandboxRepoEntry; repoName: string }
  | { ok: false; reason: string };

function sandboxOption(input: RouterInput, target: RepoTarget): SandboxOption {
  const { request } = input;
  if (target.keys.size === 0) {
    const known = input.machines.some((m) => m.repos.some((r) => r.name === target.name));
    return {
      ok: false,
      reason: known
        ? `${target.display} has no remote, so a sandbox has nothing to clone`
        : `Sling doesn't know a repo called ${target.display}`,
    };
  }
  const repo = input.sandboxRepos.find((s) => target.keys.has(s.remoteKey));
  if (!repo) {
    const key = [...target.keys][0] ?? target.display;
    return {
      ok: false,
      reason: `${key} isn't allowed in sandboxes. Turn on Allow in sandboxes for it on the Machines page`,
    };
  }
  const unsupported = request.labels.filter((l) => !SANDBOX_LABELS.has(l));
  if (unsupported.length) {
    return {
      ok: false,
      reason: `sandboxes don't have the ${plural(unsupported.length, "label", "labels")} ${unsupported.join(", ")}`,
    };
  }
  let provider: ProviderEntry | undefined;
  if (request.providerInstallationId) {
    provider = input.providers.find((p) => p.id === request.providerInstallationId);
    if (!provider) {
      return {
        ok: false,
        reason: `there's no enabled sandbox provider with the ID ${request.providerInstallationId}`,
      };
    }
  } else {
    provider = input.providers[0];
    if (!provider) {
      return {
        ok: false,
        reason: "no sandbox provider is set up. Add one, such as Docker, under Connectors",
      };
    }
  }
  const { usedMinutes, budgetMinutes } = input.sandboxBudget;
  if (usedMinutes >= budgetMinutes) {
    return {
      ok: false,
      reason: `this month's ${budgetMinutes} sandbox minutes are used up. Raise the budget in Settings to run more`,
    };
  }
  const repoName = target.name ?? repo.remoteKey.split("/").at(-1) ?? repo.remoteKey;
  return { ok: true, provider, repo, repoName };
}

function sandboxPhrase(p: ProviderEntry): string {
  return `a ${p.connectorName} sandbox on ${p.name}`;
}

export function route(raw: RouterInput): RouteResult {
  const labels = [...new Set(raw.request.labels.map(normalizeLabel).filter(Boolean))];
  const input: RouterInput = { ...raw, request: { ...raw.request, labels } };
  const { request, now } = input;
  const decidedAt = now.toISOString();
  const resolved = resolveRepo(input);
  if ("ambiguous" in resolved) {
    const message = `More than one repo is called ${request.repo} (${resolved.ambiguous.join(", ")}). Name it by its remote instead.`;
    return {
      decision: { kind: "refused", message, reasons: [message] },
      routing: { target: null, reason: message, considered: [], decidedAt },
    };
  }
  const target = resolved;

  if (request.environment === "sandbox") {
    const opt = sandboxOption(input, target);
    if (!opt.ok) {
      const message = `Can't run it in a sandbox: ${opt.reason}.`;
      return {
        decision: { kind: "refused", message, reasons: [capitalize(opt.reason)] },
        routing: { target: null, reason: message, considered: [], decidedAt },
      };
    }
    return {
      decision: {
        kind: "sandbox",
        fallback: false,
        provider: opt.provider,
        repo: opt.repo,
        repoName: opt.repoName,
        reasons: [],
      },
      routing: {
        target: {
          kind: "sandbox",
          providerInstallationId: opt.provider.id,
          providerName: opt.provider.name,
        },
        reason: `Runs in ${sandboxPhrase(opt.provider)}, as you asked.`,
        considered: [],
        decidedAt,
      },
    };
  }

  const named = request.machineId;
  const all = input.machines.map((m) => check(input, target, m));
  const eligible = all.filter((c) => c.problems.length === 0).sort((a, b) => rank(a, b, named));
  const best = eligible[0];

  if (best?.repo) {
    const why = whyPicked(best, eligible[1], named, target.display);
    const queued = best.free <= 0;
    const considered = all.map((c) => {
      const base = { runnerId: c.machine.id, runnerName: c.machine.name };
      if (c === best) {
        return {
          ...base,
          eligible: true,
          reason: queued ? `Picked, though busy: ${why}` : `Picked: ${why}`,
        };
      }
      if (c.problems.length === 0) {
        return { ...base, eligible: true, reason: `Eligible, ${slots(c)}` };
      }
      return { ...base, eligible: false, reason: capitalize(c.problems.join("; ")) };
    });
    const reason = queued
      ? `Queued on ${best.machine.name}: every machine that can take it is busy, and ${why}.`
      : `Runs on ${best.machine.name}: ${why}.`;
    return {
      decision: {
        kind: "machine",
        runnerId: best.machine.id,
        runnerName: best.machine.name,
        repoId: best.repo.id,
        repoName: best.repo.name,
        queued,
      },
      routing: {
        target: { kind: "machine", runnerId: best.machine.id, runnerName: best.machine.name },
        reason,
        considered,
        decidedAt,
      },
    };
  }

  const considered = all.map((c) => ({
    runnerId: c.machine.id,
    runnerName: c.machine.name,
    eligible: false,
    reason: capitalize(c.problems.join("; ")),
  }));
  const reasons = considered.map((c) => `${c.runnerName}: ${c.reason}`);
  if (named && !input.machines.some((m) => m.id === named)) {
    reasons.unshift(`There's no machine with the ID ${named}`);
  }
  if (input.machines.length === 0) reasons.push("No machines are paired");

  if (request.environment === "auto") {
    const opt = sandboxOption(input, target);
    if (opt.ok) {
      return {
        decision: {
          kind: "sandbox",
          fallback: true,
          provider: opt.provider,
          repo: opt.repo,
          repoName: opt.repoName,
          reasons,
        },
        routing: {
          target: {
            kind: "sandbox",
            providerInstallationId: opt.provider.id,
            providerName: opt.provider.name,
          },
          reason: `No machine can take it, so it can run in ${sandboxPhrase(opt.provider)} once you approve.`,
          considered,
          decidedAt,
        },
      };
    }
    reasons.push(`It can't go to a sandbox either: ${opt.reason}`);
  }

  const message = `No machine can take this task.\n${reasons.map((r) => `- ${r}`).join("\n")}`;
  return {
    decision: { kind: "refused", message, reasons },
    routing: {
      target: null,
      reason: "No machine can take it.",
      considered,
      decidedAt,
    },
  };
}
