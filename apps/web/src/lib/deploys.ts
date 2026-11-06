import {
  type ActionView,
  type DeployCheckResult,
  type DeployMethod,
  type DeployTargetView,
  type MergeMethod,
  type RepoView,
  type RunnerView,
  remoteKey,
  type SandboxRepoView,
  type ServerEvent,
  type TaskView,
} from "@sling/core";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { machinesOnly } from "./machines.ts";

/**
 * Deploy targets: one repo each that Sling knows how to deploy and check.
 * `deploy_target.updated` and `deploy_target.removed` patch the list.
 */
export const deployTargetsKey = ["deploy-targets"] as const;

export function useDeployTargets(enabled = true) {
  return useQuery({
    queryKey: deployTargetsKey,
    queryFn: () => api.get<DeployTargetView[]>("/api/deploy-targets"),
    // Realtime events keep it current, and a reconnect refetches everything.
    staleTime: 60_000,
    enabled,
  });
}

/** What `POST /api/deploy-targets` takes. `PATCH` takes any of it; leaving out `hook` keeps it. */
export interface DeployTargetInput {
  name: string;
  remoteKey: string;
  method: DeployMethod;
  mergeMethod?: MergeMethod;
  runnerId?: string;
  hook?: HookInput;
  checks: { url: string; status: number | null; contains: string | null }[];
  versionUrl: string | null;
  settleSeconds?: number;
  timeoutSeconds?: number;
}

export interface HookInput {
  url: string;
  httpMethod: "POST" | "GET";
  headerName?: string;
  headerValue?: string;
}

export const deployApi = {
  create: (body: DeployTargetInput) => api.post<DeployTargetView>("/api/deploy-targets", body),
  update: (id: string, body: Partial<DeployTargetInput>) =>
    api.patch<DeployTargetView>(`/api/deploy-targets/${id}`, body),
  remove: (id: string) => api.del<unknown>(`/api/deploy-targets/${id}`),
  /** Runs the target's checks now. */
  check: (id: string) => api.post<DeployTargetView>(`/api/deploy-targets/${id}/check`),
  /** Adds merge, deploy, and verify to a delivered PR task. Answers 409 when it can't. */
  deployTask: (taskId: string) => api.post<TaskView>(`/api/tasks/${taskId}/deploy`),
};

export function upsertTarget(qc: QueryClient, target: DeployTargetView) {
  qc.setQueryData<DeployTargetView[]>(deployTargetsKey, (list) => {
    if (!list) return list;
    const i = list.findIndex((t) => t.id === target.id);
    if (i === -1) return [...list, target].sort(byName);
    const next = list.slice();
    next[i] = target;
    return next;
  });
}

export function forgetTarget(qc: QueryClient, id: string) {
  qc.setQueryData<DeployTargetView[]>(deployTargetsKey, (list) => list?.filter((t) => t.id !== id));
}

export function applyDeployTargetEvent(
  qc: QueryClient,
  ev: Extract<ServerEvent, { type: "deploy_target.updated" | "deploy_target.removed" }>,
) {
  if (ev.type === "deploy_target.updated") upsertTarget(qc, ev.target);
  else forgetTarget(qc, ev.id);
}

function byName(a: DeployTargetView, b: DeployTargetView) {
  return a.name.localeCompare(b.name);
}

/* ---------------------------------------------------------------- Repos */

export interface KnownRemote {
  remoteKey: string;
  /** The repo on each machine that has it. */
  onMachines: { runner: RunnerView; repo: RepoView }[];
  /** On the sandbox list. */
  inSandboxes: boolean;
}

/** Every repo remote Sling knows: on paired machines, and on the sandbox list. */
export function knownRemotes(
  runners: RunnerView[],
  sandboxRepos: SandboxRepoView[] = [],
): KnownRemote[] {
  const byKey = new Map<string, KnownRemote>();
  const entry = (key: string) => {
    let e = byKey.get(key);
    if (!e) {
      e = { remoteKey: key, onMachines: [], inSandboxes: false };
      byKey.set(key, e);
    }
    return e;
  };
  for (const runner of machinesOnly(runners)) {
    for (const repo of runner.repos) {
      if (repo.remoteKey) entry(repo.remoteKey).onMachines.push({ runner, repo });
    }
  }
  for (const r of sandboxRepos) entry(r.remoteKey).inSandboxes = true;
  return [...byKey.values()].sort((a, b) => a.remoteKey.localeCompare(b.remoteKey));
}

/** What the repo is called on the machines that have it, for the `sling-runner` line. */
export function repoNameFor(remote: KnownRemote | undefined, key: string): string {
  return remote?.onMachines[0]?.repo.name ?? key.split("/").at(-1) ?? key;
}

/** Machines that report a deploy command for the repo, and whether each can run it. */
export function deployMachines(remote: KnownRemote | undefined) {
  return (remote?.onMachines ?? [])
    .filter(({ repo }) => repo.deployCommand.trim() !== "")
    .map(({ runner, repo }) => ({
      runner,
      command: repo.deployCommand,
      /** Why the machine would refuse, if it would. */
      blocked: !runner.deploys
        ? "deploys are off"
        : runner.maxMode === "read-only"
          ? "Read-only"
          : null,
    }))
    .sort((a, b) => a.runner.name.localeCompare(b.runner.name));
}

export function setCommandLine(repoName: string): string {
  const name = /^[\w.-]+$/.test(repoName) ? repoName : `"${repoName}"`;
  return `sling-runner repo set ${name} deploy-command "…"`;
}

/* ----------------------------------------------------------------- URLs */

/** The host of a URL, or the text itself when it isn't one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A URL without its scheme, and without a lone trailing slash. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}${u.search}`;
  } catch {
    return url;
  }
}

export function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- Checks */

/** The slowest check of the last round, which is how long the site took to answer. */
export function slowest(results: DeployCheckResult[]): number | null {
  return results.length ? Math.max(...results.map((r) => r.ms)) : null;
}

/** "200", or why there was no answer. */
export function checkStatusText(r: DeployCheckResult): string {
  return r.status === null ? "No answer" : String(r.status);
}

export const DEFAULT_SETTLE: Record<DeployMethod, number> = { merge: 60, command: 0, hook: 0 };
export const DEFAULT_TIMEOUT = 600;
export const MAX_TIMEOUT = 3600;
export const MAX_CHECKS = 5;

export const MERGE_LABEL: Record<MergeMethod, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

/** How the merge reads in a sentence: "with squash". */
export const MERGE_WORDS: Record<MergeMethod, string> = {
  squash: "with squash",
  merge: "with a merge commit",
  rebase: "with rebase",
};

/* -------------------------------------------------------------- The form */

export interface CheckDraft {
  /** Stable across edits, for React keys. */
  key: string;
  url: string;
  status: string;
  contains: string;
}

export interface TargetDraft {
  name: string;
  remoteKey: string;
  method: DeployMethod;
  mergeMethod: MergeMethod;
  runnerId: string;
  hookUrl: string;
  httpMethod: "POST" | "GET";
  headerName: string;
  headerValue: string;
  /** Editing a target with a stored hook: whether a new one replaces it. */
  replaceHook: boolean;
  checks: CheckDraft[];
  versionUrl: string;
  /** Empty means the method's default. */
  settleSeconds: string;
  timeoutSeconds: string;
}

let checkSeq = 0;
export function blankCheck(): CheckDraft {
  checkSeq += 1;
  return { key: `chk${checkSeq}`, url: "", status: "", contains: "" };
}

export function draftFor(target: DeployTargetView | null, remoteKey = ""): TargetDraft {
  if (!target) {
    return {
      name: "",
      remoteKey,
      method: "merge",
      mergeMethod: "squash",
      runnerId: "",
      hookUrl: "",
      httpMethod: "POST",
      headerName: "",
      headerValue: "",
      replaceHook: false,
      checks: [blankCheck()],
      versionUrl: "",
      settleSeconds: "",
      timeoutSeconds: "",
    };
  }
  return {
    name: target.name,
    remoteKey: target.remoteKey,
    method: target.method,
    mergeMethod: target.mergeMethod,
    runnerId: target.runnerId ?? "",
    hookUrl: "",
    httpMethod: target.hook?.httpMethod ?? "POST",
    headerName: "",
    headerValue: "",
    replaceHook: false,
    checks: (target.checks.length ? target.checks : [null]).map((c) => ({
      ...blankCheck(),
      url: c?.url ?? "",
      status: c?.status === null || c?.status === undefined ? "" : String(c.status),
      contains: c?.contains ?? "",
    })),
    versionUrl: target.versionUrl ?? "",
    settleSeconds:
      target.settleSeconds === DEFAULT_SETTLE[target.method] ? "" : String(target.settleSeconds),
    timeoutSeconds: target.timeoutSeconds === DEFAULT_TIMEOUT ? "" : String(target.timeoutSeconds),
  };
}

/** Whether the hook's fields are being filled in, as opposed to kept. */
export function editsHook(d: TargetDraft, editing: DeployTargetView | null): boolean {
  return d.method === "hook" && (!editing?.hook || d.replaceHook);
}

export type DraftErrors = Record<string, string>;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function seconds(text: string, min: number, max: number): number | null | "bad" {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : "bad";
}

/** Problems with a draft, keyed by field: `name`, `check.0.url`, and so on. */
export function validateDraft(
  d: TargetDraft,
  ctx: { targets: DeployTargetView[]; editing: DeployTargetView | null },
): DraftErrors {
  const e: DraftErrors = {};
  const name = d.name.trim();
  const others = ctx.targets.filter((t) => t.id !== ctx.editing?.id);
  if (!name) e.name = "Give it a name.";
  else if (others.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    e.name = "Another target has this name.";
  }
  if (!d.remoteKey) e.remoteKey = "Pick a repo.";
  else if (others.some((t) => t.remoteKey === d.remoteKey)) {
    e.remoteKey = "This repo has a target already.";
  }
  if (d.method === "command" && !d.runnerId) e.runnerId = "Pick the machine that deploys it.";
  if (editsHook(d, ctx.editing)) {
    if (!d.hookUrl.trim()) e.hookUrl = "Paste the deploy hook's URL.";
    else if (!isHttpUrl(d.hookUrl.trim())) e.hookUrl = "Use an http or https URL.";
    const hn = d.headerName.trim();
    if (hn && !HEADER_NAME.test(hn)) e.header = "A header name has no spaces or colons.";
    else if (hn && !d.headerValue) e.header = "Add the header's value, or clear its name.";
    else if (!hn && d.headerValue) e.header = "Add the header's name, or clear its value.";
  }
  d.checks.forEach((c, i) => {
    if (!c.url.trim()) e[`check.${i}.url`] = "Add the URL to check.";
    else if (!isHttpUrl(c.url.trim())) e[`check.${i}.url`] = "Use an http or https URL.";
    if (c.status.trim() && seconds(c.status, 100, 599) === "bad") {
      e[`check.${i}.status`] = "A status is 100 to 599.";
    }
  });
  if (d.versionUrl.trim() && !isHttpUrl(d.versionUrl.trim())) {
    e.versionUrl = "Use an http or https URL.";
  }
  if (seconds(d.settleSeconds, 0, MAX_TIMEOUT) === "bad") {
    e.settleSeconds = `Whole seconds, up to ${MAX_TIMEOUT}.`;
  }
  if (seconds(d.timeoutSeconds, 10, MAX_TIMEOUT) === "bad") {
    e.timeoutSeconds = `Whole seconds, 10 to ${MAX_TIMEOUT}.`;
  }
  return e;
}

/** The request body for a valid draft. */
export function draftBody(d: TargetDraft, editing: DeployTargetView | null): DeployTargetInput {
  const settle = seconds(d.settleSeconds, 0, MAX_TIMEOUT);
  const timeout = seconds(d.timeoutSeconds, 10, MAX_TIMEOUT);
  const body: DeployTargetInput = {
    name: d.name.trim(),
    remoteKey: d.remoteKey,
    method: d.method,
    mergeMethod: d.mergeMethod,
    checks: d.checks.map((c) => ({
      url: c.url.trim(),
      status: c.status.trim() ? Number(c.status) : null,
      contains: c.contains ? c.contains : null,
    })),
    versionUrl: d.versionUrl.trim() || null,
    settleSeconds: typeof settle === "number" ? settle : DEFAULT_SETTLE[d.method],
    timeoutSeconds: typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT,
  };
  if (d.method === "command") body.runnerId = d.runnerId;
  if (editsHook(d, editing)) {
    const headerName = d.headerName.trim();
    body.hook = {
      url: d.hookUrl.trim(),
      httpMethod: d.httpMethod,
      ...(headerName ? { headerName, headerValue: d.headerValue } : {}),
    };
  }
  return body;
}

/* ---------------------------------------------------------------- Tasks */

const DEPLOY_STEPS: ReadonlySet<string> = new Set(["merge", "deploy", "verify"]);

export function isDeployStep(a: ActionView): boolean {
  return DEPLOY_STEPS.has(a.kind);
}

/** The merge and deploy approvals wait together, after the PR exists. */
export function awaitsDeployApproval(task: TaskView): boolean {
  return task.actions.some(
    (a) => a.state === "awaiting_approval" && (a.kind === "merge" || a.kind === "deploy"),
  );
}

/** A delivered PR that hasn't been merged or deployed yet. */
export function canDeployLater(task: TaskView): boolean {
  return (
    task.state === "succeeded" &&
    task.actions.some((a) => a.kind === "open_pr" && a.state === "succeeded") &&
    !task.actions.some(isDeployStep)
  );
}

/** "PR #12" from a GitHub or GitLab pull request URL. */
export function prLabel(url: string | null | undefined): string | null {
  const n = url ? /\/(?:pull|merge_requests)\/(\d+)/.exec(url)?.[1] : undefined;
  return n ? `PR #${n}` : null;
}

/** The repo a task ran in, on its machine or on any machine with a repo of that name. */
export function taskRepo(task: TaskView, runners: RunnerView[] | undefined): RepoView | undefined {
  const own = runners
    ?.find((r) => r.id === task.runnerId)
    ?.repos.find((r) => r.name === task.repoName);
  if (own?.remoteKey) return own;
  for (const r of runners ?? []) {
    const repo = r.repos.find((x) => x.name === task.repoName && x.remoteKey);
    if (repo) return repo;
  }
  return own;
}

/**
 * The target a task deploys to: the one its steps name, else the one for its
 * repo's remote.
 */
export function targetForTask(
  task: TaskView,
  targets: DeployTargetView[] | undefined,
  runners: RunnerView[] | undefined,
): DeployTargetView | undefined {
  if (!targets?.length) return undefined;
  const named = task.actions.find((a) => a.targetId)?.targetId;
  if (named) return targets.find((t) => t.id === named);
  const key = task.remoteKey ?? taskRepo(task, runners)?.remoteKey;
  return key ? targets.find((t) => t.remoteKey === key) : undefined;
}

/** The target for a remote URL, as an approval carries it. */
export function targetForRemote(
  remoteUrl: string,
  targets: DeployTargetView[] | undefined,
): DeployTargetView | undefined {
  const key = remoteKey(remoteUrl);
  return key ? targets?.find((t) => t.remoteKey === key) : undefined;
}

/** What a deploy approval says will happen, in order. */
export interface DeployPlan {
  /** "PR #12", or the branch when there's no PR. */
  what: string;
  into: string;
  mergeMethod: MergeMethod | null;
  method: DeployMethod | null;
  command: string | null;
  machine: string | null;
  hookHost: string | null;
  /** Hosts the checks reach, in order, once each. */
  checks: string[];
}

export function deployPlan(input: {
  prUrl: string | null;
  branch: string;
  defaultBranch: string | null;
  target: DeployTargetView | undefined;
}): DeployPlan {
  const t = input.target;
  return {
    what: prLabel(input.prUrl) ?? input.branch,
    into: input.defaultBranch || "the default branch",
    mergeMethod: t?.mergeMethod ?? null,
    method: t?.method ?? null,
    command: t?.command || null,
    machine: t?.runnerName ?? null,
    hookHost: t?.hook?.host ?? null,
    checks: [...new Set((t?.checks ?? []).map((c) => hostOf(c.url)))],
  };
}
