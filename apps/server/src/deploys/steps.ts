import { randomBytes } from "node:crypto";
import type { ActionState, MergeMethod } from "@sling/core";
import { type DeployHook, schema } from "@sling/db";
import {
  create,
  EnvelopeSchema,
  RepoAction_Kind,
  type RepoActionOutput,
  type RepoActionResult,
  RepoActionResult_Outcome,
} from "@sling/runner-protocol";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import type { RunnerSession } from "../runners/gateway.ts";
import { readSecrets } from "../sandboxes/settings.ts";
import type { DeployService, TargetRow } from "./service.ts";

type TaskRow = typeof schema.tasks.$inferSelect;
type ActionRow = typeof schema.actions.$inferSelect;
type CheckRow = typeof schema.actionChecks.$inferSelect;

/** How long a merge on a machine may take before Sling stops waiting for its answer. */
export const MERGE_TIMEOUT_MS = 10 * 60_000;
/** The Runner's own limit for a deploy command, unless the machine sets another. */
export const DEPLOY_TIMEOUT_MS = 15 * 60_000;
/** Extra time a machine gets to answer after its own limit. */
export const ANSWER_GRACE_MS = 60_000;
export const HOOK_TIMEOUT_MS = 30_000;
const HOOK_ANSWER_BYTES = 1024;
const GITHUB_TIMEOUT_MS = 30_000;
/** A deploy command's stored output stops here. */
export const OUTPUT_CAP = 256 * 1024;
/** Task views are rebuilt at most this often while output streams in. */
const OUTPUT_PUBLISH_MS = 500;
export const INTERRUPTED = "Interrupted, outcome unknown";

const OUTCOME: Record<number, "succeeded" | "failed" | "refused"> = {
  [RepoActionResult_Outcome.SUCCEEDED]: "succeeded",
  [RepoActionResult_Outcome.FAILED]: "failed",
  [RepoActionResult_Outcome.REFUSED]: "refused",
};

/** The action a RepoAction request belongs to. Request IDs start with it. */
export function actionOfRequest(requestId: string): string {
  return requestId.split(".")[0] ?? "";
}

/** owner, name, and number of a github.com pull request URL. */
export function githubPull(
  url: string | null,
): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(
    url?.trim() ?? "",
  );
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export interface GitHubMerge {
  outcome: "succeeded" | "failed" | "refused";
  sha: string | null;
  message: string;
}

async function githubMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ? String(body.message).slice(0, 300) : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Merges a pull request through GitHub's REST API. A PR that's already
 * merged answers with its merge commit, so asking twice is safe. Refuses a PR
 * whose head isn't the task's branch or whose base isn't the default branch.
 */
export async function mergeOnGitHub(opts: {
  api: string;
  token: string;
  owner: string;
  repo: string;
  number: number;
  branch: string;
  base: string | null;
  method: MergeMethod;
  /** The task's commit: GitHub refuses the merge when the PR's head moved since. */
  headSha: string | null;
}): Promise<GitHubMerge> {
  const url = `${opts.api.replace(/\/+$/, "")}/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}`;
  const headers = {
    authorization: `Bearer ${opts.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Sling",
  };
  type Pull = {
    state: string;
    merged: boolean;
    merge_commit_sha: string | null;
    head: { ref: string };
    base: { ref: string };
  };
  const read = async (): Promise<{ pr: Pull } | { error: string }> => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    if (!res.ok) return { error: `GitHub answered ${res.status}: ${await githubMessage(res)}` };
    return { pr: (await res.json()) as Pull };
  };
  const first = await read();
  if ("error" in first) return { outcome: "failed", sha: null, message: first.error };
  const { pr } = first;
  if (pr.merged) {
    return {
      outcome: "succeeded",
      sha: pr.merge_commit_sha,
      message: "The pull request was already merged on GitHub.",
    };
  }
  if (pr.head.ref !== opts.branch) {
    return {
      outcome: "refused",
      sha: null,
      message: `The pull request's branch is ${pr.head.ref}, not the task's ${opts.branch}.`,
    };
  }
  if (opts.base && pr.base.ref !== opts.base) {
    return {
      outcome: "refused",
      sha: null,
      message: `The pull request goes into ${pr.base.ref}, not the default branch ${opts.base}.`,
    };
  }
  if (pr.state !== "open") {
    return { outcome: "failed", sha: null, message: "The pull request is closed." };
  }
  const res = await fetch(`${url}/merge`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      merge_method: opts.method,
      ...(opts.headSha ? { sha: opts.headSha } : {}),
    }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (res.ok) {
    const body = (await res.json()) as { sha?: string };
    return {
      outcome: "succeeded",
      sha: body.sha ?? null,
      message: `Merged on GitHub (${opts.method}).`,
    };
  }
  const why = await githubMessage(res);
  // Someone may have merged it in the meantime.
  const again = await read();
  if ("pr" in again && again.pr.merged) {
    return {
      outcome: "succeeded",
      sha: again.pr.merge_commit_sha,
      message: "The pull request was already merged on GitHub.",
    };
  }
  return {
    outcome: "failed",
    sha: null,
    message: `GitHub wouldn't merge it (${res.status}): ${why}`,
  };
}

/** Reads at most `max` bytes of a body as text. */
async function readStart(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/** Calls a deploy hook. Any 2xx means it took the deploy. */
export async function callHook(
  hook: DeployHook,
  timeoutMs = HOOK_TIMEOUT_MS,
): Promise<{ ok: boolean; message: string }> {
  const headers: Record<string, string> = { "user-agent": "Sling" };
  if (hook.headerName && hook.headerValue) headers[hook.headerName] = hook.headerValue;
  const scrub = (text: string) => {
    let out = text;
    for (const secret of [hook.url, hook.headerValue]) {
      if (secret && secret.length >= 6) out = out.split(secret).join("[hidden]");
    }
    return out;
  };
  try {
    const res = await fetch(hook.url, {
      method: hook.httpMethod,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = scrub((await readStart(res, HOOK_ANSWER_BYTES)).trim());
    const ok = res.status >= 200 && res.status <= 299;
    const said = answer ? `: ${answer}` : ".";
    return {
      ok,
      message: ok
        ? `The deploy hook accepted it (${res.status})${said}`
        : `The deploy hook answered ${res.status}${said}`,
    };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return {
        ok: false,
        message: `The deploy hook didn't answer within ${Math.round(timeoutMs / 1000)} s, so Sling can't tell whether a deploy started.`,
      };
    }
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
    return {
      ok: false,
      message: scrub(
        `Couldn't reach the deploy hook: ${cause ?? (err instanceof Error ? err.message : String(err))}`,
      ),
    };
  }
}

const LAST_LOOK_GRACE_MS = 2 * 60_000;

/** Whether a check ended because it ran out of time, not because CI said so. */
function ranOut(check: Pick<CheckRow, "checkedAt" | "giveUpAt">, now: Date): boolean {
  const end = check.giveUpAt?.getTime();
  if (end === undefined) return false;
  return (check.checkedAt ?? now).getTime() >= end;
}

export type CiGate =
  | { kind: "merge" }
  | { kind: "wait"; message: string }
  | { kind: "fail"; message: string }
  /** The PR's check gave up before this merge was asked for, so it's checked again. */
  | { kind: "recheck" };

/**
 * Whether a merge nobody approves may go, from the PR's CI check: once CI
 * passed, or when the PR has no CI. Failed CI, or CI still running when the
 * check gives up, stops it.
 */
export function ciGate(
  check: Pick<CheckRow, "state" | "message" | "checkedAt" | "giveUpAt"> | null,
  mergeCreatedAt: Date,
  now = new Date(),
): CiGate {
  if (!check) return { kind: "wait", message: "Waiting for CI before merging." };
  const said = check.message.replace(/\.$/, "");
  switch (check.state) {
    case "passed":
      return { kind: "merge" };
    case "failed":
      return { kind: "fail", message: `${said}. The PR wasn't merged.` };
    case "waiting":
      // Its last look is due at the limit itself, so give that a moment to land.
      if (check.giveUpAt && now.getTime() >= check.giveUpAt.getTime() + LAST_LOOK_GRACE_MS) {
        return { kind: "fail", message: "CI didn't finish in time. The PR wasn't merged." };
      }
      return { kind: "wait", message: `${said || "Waiting for CI"}. Merging once it passes.` };
    case "unchecked":
      if (!ranOut(check, now)) return { kind: "merge" };
      if (check.giveUpAt && check.giveUpAt.getTime() < mergeCreatedAt.getTime()) {
        return { kind: "recheck" };
      }
      return { kind: "fail", message: `${said}. The PR wasn't merged.` };
  }
}

interface MachineChoice {
  runnerId: string;
  runnerName: string;
  repoName: string;
  defaultBranch: string;
}

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * The merge, deploy, and verify steps: where each runs, what it sends, and
 * what comes back. The task service decides when a step may start; this
 * starts it and reports back through `ctx.tasks.advance`.
 */
export class DeploySteps {
  readonly #ctx: AppContext;
  readonly #targets: DeployService;
  readonly #inflight = new Set<Promise<void>>();
  readonly #publishTimers = new Map<string, NodeJS.Timeout>();

  constructor(ctx: AppContext, targets: DeployService) {
    this.#ctx = ctx;
    this.#targets = targets;
  }

  get #db() {
    return this.#ctx.db;
  }

  async idle(): Promise<void> {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
    for (const t of this.#publishTimers.values()) clearTimeout(t);
    this.#publishTimers.clear();
  }

  /** Work that outlives the request that started it, such as a hook call. */
  #background(label: string, work: () => Promise<void>) {
    const p = work()
      .catch((err) => this.#ctx.log.error({ err }, `${label} failed`))
      .finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
  }

  // ------------------------------------------------------------- bookkeeping

  /** The newest step of a kind on a task. */
  async #latest(taskId: string, kind: ActionRow["kind"]): Promise<ActionRow | null> {
    const [row] = await this.#db
      .select()
      .from(schema.actions)
      .where(and(eq(schema.actions.taskId, taskId), eq(schema.actions.kind, kind)))
      .orderBy(desc(schema.actions.position))
      .limit(1);
    return row ?? null;
  }

  async #target(action: ActionRow): Promise<TargetRow | null> {
    if (!action.targetId) return null;
    const [row] = await this.#db
      .select()
      .from(schema.deployTargets)
      .where(eq(schema.deployTargets.id, action.targetId));
    return row ?? null;
  }

  /**
   * Ends a step that's ready or in flight, then lets the task go on. Returns
   * false when the step had already moved on.
   */
  async #end(
    action: ActionRow,
    state: Extract<ActionState, "succeeded" | "failed" | "refused">,
    fields: { message: string; commitSha?: string | null; url?: string | null },
    from: ActionState[] = ["ready", "sent"],
  ): Promise<boolean> {
    const [done] = await this.#db
      .update(schema.actions)
      .set({
        state,
        message: fields.message.slice(0, 4000),
        ...(fields.commitSha !== undefined ? { commitSha: fields.commitSha } : {}),
        ...(fields.url !== undefined ? { url: fields.url } : {}),
        finishedAt: new Date(),
      })
      .where(and(eq(schema.actions.id, action.id), inArray(schema.actions.state, from)))
      .returning();
    if (!done) return false;
    await this.#audit(done, state);
    await this.#targets.publish(done.targetId);
    await this.#ctx.tasks.advance(done.taskId);
    return true;
  }

  async #audit(action: ActionRow, outcome: string) {
    await audit(this.#ctx, {
      workspaceId: action.workspaceId,
      actorType: action.runnerId ? "runner" : "system",
      actorId: action.runnerId,
      verb: `action.${action.kind}.${outcome}`,
      subjectType: "action",
      subjectId: action.id,
      details: {
        taskId: action.taskId,
        targetId: action.targetId,
        commitSha: action.commitSha,
        message: action.message,
      },
    });
  }

  /** Keeps a ready step ready, and says what it waits for. */
  async #wait(action: ActionRow, message: string) {
    if (action.message === message) return;
    await this.#db
      .update(schema.actions)
      .set({ message })
      .where(and(eq(schema.actions.id, action.id), eq(schema.actions.state, "ready")));
    await this.#ctx.tasks.publish(action.taskId);
  }

  /** Moves a ready step to sent. False when another caller got there first. */
  async #claim(action: ActionRow, fields: Partial<ActionRow> = {}): Promise<boolean> {
    const [claimed] = await this.#db
      .update(schema.actions)
      .set({ state: "sent", sentAt: new Date(), message: null, ...fields })
      .where(and(eq(schema.actions.id, action.id), eq(schema.actions.state, "ready")))
      .returning({ id: schema.actions.id });
    return Boolean(claimed);
  }

  /**
   * Sends a RepoAction once the step is marked sent, so a fast answer finds
   * it. Puts the step back when the machine went away in between.
   */
  async #sendRepoAction(
    action: ActionRow,
    machine: MachineChoice,
    value: {
      kind: RepoAction_Kind;
      branch?: string;
      prUrl?: string;
      mergeMethod?: string;
      title?: string;
      body?: string;
      commitSha?: string;
    },
    extra: Partial<ActionRow> = {},
  ): Promise<boolean> {
    const requestId = `${action.id}.${randomBytes(4).toString("hex")}`;
    if (!(await this.#claim(action, { runnerId: machine.runnerId, requestId, ...extra }))) {
      return false;
    }
    const sent = this.#ctx.runners.send(
      machine.runnerId,
      create(EnvelopeSchema, {
        body: {
          case: "repoAction",
          value: {
            requestId,
            taskId: action.taskId,
            repo: machine.repoName,
            defaultBranch: machine.defaultBranch,
            ...value,
          },
        },
      }),
    );
    if (!sent) {
      await this.#db
        .update(schema.actions)
        .set({ state: "ready", sentAt: null, requestId: null, runnerId: null })
        .where(and(eq(schema.actions.id, action.id), eq(schema.actions.requestId, requestId)));
      await this.#wait(action, `Waiting for ${machine.runnerName} to come back online.`);
      return false;
    }
    await this.#ctx.tasks.publish(action.taskId);
    await this.#targets.publish(action.targetId);
    return true;
  }

  // ------------------------------------------------------------- starting

  /** Starts a ready merge, deploy, or verify step. */
  async start(task: TaskRow, action: ActionRow): Promise<void> {
    const target = await this.#target(action);
    if (!target) {
      await this.#end(action, "failed", { message: "The deploy target was removed." });
      return;
    }
    if (action.kind === "merge") return this.#startMerge(task, action, target);
    if (action.kind === "deploy") return this.#startDeploy(task, action, target);
    if (action.kind === "verify") {
      const merge = await this.#latest(task.id, "merge");
      if (!merge?.commitSha) {
        await this.#end(action, "failed", {
          message: "The merge didn't say which commit it made.",
        });
        return;
      }
      if (await this.#claim(action, { commitSha: merge.commitSha })) {
        await this.#targets.verifier.begin(action, target, merge.commitSha);
        await this.#ctx.tasks.publish(task.id);
        await this.#targets.publish(target.id);
      }
    }
  }

  /**
   * The machine that merges: the task's own while it's online, else any
   * online machine with the repo that takes merges. A sandbox's Runner never
   * does, since it's gone once the PR is open.
   */
  async #mergeMachine(task: TaskRow, target: TargetRow): Promise<MachineChoice | { wait: string }> {
    const rows = await this.#db
      .select({
        runnerId: schema.runners.id,
        runnerName: schema.runners.name,
        deploys: schema.runners.deploys,
        repoName: schema.repos.name,
        defaultBranch: schema.repos.defaultBranch,
      })
      .from(schema.repos)
      .innerJoin(schema.runners, eq(schema.runners.id, schema.repos.runnerId))
      .where(
        and(
          eq(schema.repos.workspaceId, task.workspaceId),
          eq(schema.repos.remoteKey, target.remoteKey),
          isNull(schema.repos.removedAt),
          isNull(schema.runners.revokedAt),
          eq(schema.runners.ephemeral, false),
        ),
      )
      .orderBy(asc(schema.runners.pairedAt));
    const online = (r: { runnerId: string }) => this.#ctx.runners.isOnline(r.runnerId);
    // The task's machine gets it even with deploys off, so its own refusal shows on the task.
    const own = rows.find((r) => r.runnerId === task.runnerId && online(r));
    if (own) return own;
    const other = rows.find((r) => online(r) && r.deploys);
    if (other) return other;
    if (rows.length === 0) {
      return { wait: `Waiting for a machine with ${target.remoteKey}. None of yours has it.` };
    }
    const why = rows.map((r) =>
      online(r) ? `${r.runnerName} (deploys off)` : `${r.runnerName} (offline)`,
    );
    return { wait: `Waiting for a machine that can merge it: ${list(why)}.` };
  }

  async #startMerge(task: TaskRow, action: ActionRow, target: TargetRow) {
    const pr = await this.#latest(task.id, "open_pr");
    const prUrl = pr?.state === "succeeded" ? pr.url : null;
    const pull = githubPull(prUrl);
    // A merge you approved goes when you say. One that nobody approves waits for CI.
    if (pr && pull && !action.requiresApproval && !(await this.#ciAllows(task, action, pr))) {
      return;
    }
    if (task.environment === "sandbox" && pull) {
      const { gitToken } = await readSecrets(this.#ctx, task.workspaceId);
      if (gitToken) return this.#mergeThroughGitHub(task, action, target, pull, gitToken);
    }
    const machine = await this.#mergeMachine(task, target);
    if ("wait" in machine) return this.#wait(action, machine.wait);
    await this.#sendRepoAction(action, machine, {
      kind: RepoAction_Kind.MERGE,
      branch: task.branch,
      prUrl: prUrl ?? "",
      mergeMethod: target.mergeMethod,
      title: task.title,
      body: pr?.prBody ?? task.summary ?? task.objective,
    });
  }

  /**
   * Whether the PR's CI lets the merge go now. Otherwise the merge waits,
   * and the PR's check moves the task on when it changes, or the merge
   * fails when CI failed or didn't finish in time.
   */
  async #ciAllows(task: TaskRow, action: ActionRow, pr: ActionRow): Promise<boolean> {
    const [check] = await this.#db
      .select()
      .from(schema.actionChecks)
      .where(eq(schema.actionChecks.actionId, pr.id));
    const gate = ciGate(check ?? null, action.createdAt);
    if (gate.kind === "merge") return true;
    if (gate.kind === "fail") {
      await this.#end(action, "failed", { message: gate.message }, ["ready"]);
      return false;
    }
    if (gate.kind === "recheck" && check) {
      await this.#db
        .delete(schema.actionChecks)
        .where(
          and(eq(schema.actionChecks.id, check.id), eq(schema.actionChecks.state, "unchecked")),
        );
    }
    if (!check || gate.kind === "recheck") {
      // Usually started already, when the PR opened. Starting it twice is safe.
      this.#background("PR CI check", async () => {
        await this.#ctx.checks.checkAction({
          kind: "task_action",
          workspaceId: task.workspaceId,
          ownerId: task.ownerId,
          actionId: pr.id,
        });
      });
    }
    await this.#wait(
      action,
      gate.kind === "wait" ? gate.message : "Waiting for CI before merging.",
    );
    return false;
  }

  async #defaultBranch(task: TaskRow, remoteKey: string): Promise<string | null> {
    const [listed] = await this.#db
      .select({ defaultBranch: schema.sandboxRepos.defaultBranch })
      .from(schema.sandboxRepos)
      .where(
        and(
          eq(schema.sandboxRepos.workspaceId, task.workspaceId),
          eq(schema.sandboxRepos.remoteKey, remoteKey),
        ),
      );
    if (listed) return listed.defaultBranch;
    if (!task.repoId) return null;
    const [repo] = await this.#db
      .select({ defaultBranch: schema.repos.defaultBranch })
      .from(schema.repos)
      .where(eq(schema.repos.id, task.repoId));
    return repo?.defaultBranch ?? null;
  }

  async #mergeThroughGitHub(
    task: TaskRow,
    action: ActionRow,
    target: TargetRow,
    pull: { owner: string; repo: string; number: number },
    token: string,
  ) {
    if (!(await this.#claim(action, { runnerId: null, requestId: null }))) return;
    await this.#ctx.tasks.publish(task.id);
    await this.#targets.publish(target.id);
    const base = await this.#defaultBranch(task, target.remoteKey);
    const api = this.#ctx.config.testing?.githubApiUrl ?? "https://api.github.com";
    this.#background("GitHub merge", async () => {
      let result: GitHubMerge;
      try {
        result = await mergeOnGitHub({
          api,
          token,
          ...pull,
          branch: task.branch,
          base,
          method: target.mergeMethod,
          headSha: task.commitSha,
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        result = {
          outcome: "failed",
          sha: null,
          message: timedOut
            ? "GitHub didn't answer within 30 s."
            : `Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const sent = { ...action, state: "sent" as const };
      await this.#end(
        sent,
        result.outcome,
        {
          message: result.message,
          commitSha: result.sha,
          url: `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`,
        },
        ["sent"],
      );
    });
  }

  async #startDeploy(task: TaskRow, action: ActionRow, target: TargetRow) {
    const merge = await this.#latest(task.id, "merge");
    const sha = merge?.commitSha;
    if (!sha) {
      await this.#end(action, "failed", { message: "The merge didn't say which commit it made." });
      return;
    }
    if (target.method === "merge") {
      await this.#end(action, "succeeded", {
        message: "The host deploys on merge, so there was nothing to run.",
        commitSha: sha,
      });
      return;
    }
    if (target.method === "hook") return this.#startHook(action, target, sha);

    if (!target.runnerId) {
      await this.#end(action, "failed", {
        message: "No machine is set to run the deploy command.",
        commitSha: sha,
      });
      return;
    }
    const [row] = await this.#db
      .select({
        runnerId: schema.runners.id,
        runnerName: schema.runners.name,
        revokedAt: schema.runners.revokedAt,
        repoName: schema.repos.name,
        defaultBranch: schema.repos.defaultBranch,
      })
      .from(schema.runners)
      .leftJoin(
        schema.repos,
        and(
          eq(schema.repos.runnerId, schema.runners.id),
          eq(schema.repos.remoteKey, target.remoteKey),
          isNull(schema.repos.removedAt),
        ),
      )
      .where(eq(schema.runners.id, target.runnerId))
      .limit(1);
    if (!row || row.revokedAt) {
      await this.#end(action, "failed", {
        message: "The machine set to run the deploy command was removed.",
        commitSha: sha,
      });
      return;
    }
    if (!row.repoName || !row.defaultBranch) {
      await this.#end(action, "failed", {
        message: `${row.runnerName} doesn't have ${target.remoteKey}, so it can't deploy it.`,
        commitSha: sha,
      });
      return;
    }
    if (!this.#ctx.runners.isOnline(row.runnerId)) {
      await this.#wait(
        action,
        `Waiting for ${row.runnerName} to come online to run the deploy command.`,
      );
      return;
    }
    await this.#sendRepoAction(
      action,
      {
        runnerId: row.runnerId,
        runnerName: row.runnerName,
        repoName: row.repoName,
        defaultBranch: row.defaultBranch,
      },
      { kind: RepoAction_Kind.DEPLOY, commitSha: sha },
      { commitSha: sha },
    );
  }

  async #startHook(action: ActionRow, target: TargetRow, sha: string) {
    const hook = await this.#targets.readHook(target);
    if (!hook) {
      await this.#end(action, "failed", {
        message: "The deploy target has no hook.",
        commitSha: sha,
      });
      return;
    }
    // Marked sent before the call: a restart in the middle leaves it marked, and it's never called twice.
    if (!(await this.#claim(action, { runnerId: null, requestId: null, commitSha: sha }))) return;
    await this.#ctx.tasks.publish(action.taskId);
    this.#background("deploy hook", async () => {
      const r = await callHook(hook);
      await this.#end(
        { ...action, state: "sent" },
        r.ok ? "succeeded" : "failed",
        {
          message: r.message,
        },
        ["sent"],
      );
    });
  }

  // ------------------------------------------------------------- answers

  async output(session: RunnerSession, out: RepoActionOutput): Promise<void> {
    if (!out.chunk) return;
    const chunk = out.chunk.length > OUTPUT_CAP ? out.chunk.slice(0, OUTPUT_CAP) : out.chunk;
    const [row] = await this.#db
      .update(schema.actions)
      .set({
        output: sql`left(coalesce(${schema.actions.output}, '') || ${chunk}, ${OUTPUT_CAP})`,
      })
      .where(
        and(
          eq(schema.actions.id, actionOfRequest(out.requestId)),
          eq(schema.actions.requestId, out.requestId),
          eq(schema.actions.runnerId, session.runnerId),
          eq(schema.actions.state, "sent"),
          sql`coalesce(length(${schema.actions.output}), 0) < ${OUTPUT_CAP}`,
        ),
      )
      .returning({ taskId: schema.actions.taskId });
    if (row) this.#publishSoon(row.taskId);
  }

  #publishSoon(taskId: string) {
    if (this.#publishTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.#publishTimers.delete(taskId);
      void this.#ctx.tasks.publish(taskId).catch(() => {});
    }, OUTPUT_PUBLISH_MS);
    timer.unref();
    this.#publishTimers.set(taskId, timer);
  }

  async result(session: RunnerSession, r: RepoActionResult): Promise<void> {
    const ack = () =>
      session.send(
        create(EnvelopeSchema, {
          body: { case: "repoActionAck", value: { requestId: r.requestId } },
        }),
      );
    const [action] = await this.#db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, actionOfRequest(r.requestId)));
    if (!action || action.requestId !== r.requestId || action.runnerId !== session.runnerId) {
      // Not ours, or replaced by a later request. Ack so the machine forgets it.
      ack();
      return;
    }
    const outcome = OUTCOME[r.outcome] ?? "failed";
    let message = r.message.trim().slice(0, 4000);
    if (outcome === "failed" && r.exitCode !== undefined) {
      message = `${message}${message ? " " : ""}The command exited with ${r.exitCode}.`;
    }
    if (!message) {
      message =
        outcome === "succeeded"
          ? action.kind === "merge"
            ? "Merged."
            : "Deployed."
          : "The machine didn't say why.";
    }
    if (action.state !== "sent") {
      if (action.message?.startsWith(INTERRUPTED)) {
        await this.#db
          .update(schema.actions)
          .set({
            message: `${action.message} An answer came later: ${outcome}. ${message}`.slice(
              0,
              4000,
            ),
          })
          .where(eq(schema.actions.id, action.id));
        await this.#ctx.tasks.publish(action.taskId);
      }
      ack();
      return;
    }
    const sha = r.commitSha.trim() || null;
    const ended = await this.#end(
      action,
      outcome,
      {
        message,
        ...(action.kind === "merge" ? { commitSha: sha, url: r.url.trim() || null } : {}),
        ...(action.kind === "deploy" && sha ? { commitSha: sha } : {}),
      },
      ["sent"],
    );
    if (!ended) this.#ctx.log.debug({ actionId: action.id }, "repo action answered twice");
    ack();
  }

  // ------------------------------------------------------------- recovery

  /** Steps that wait for a machine try again when one connects. */
  async machineConnected(runnerId: string): Promise<void> {
    const [runner] = await this.#db
      .select({ workspaceId: schema.runners.workspaceId, ephemeral: schema.runners.ephemeral })
      .from(schema.runners)
      .where(eq(schema.runners.id, runnerId));
    if (!runner || runner.ephemeral) return;
    const waiting = await this.#db
      .selectDistinct({ taskId: schema.actions.taskId })
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.workspaceId, runner.workspaceId),
          eq(schema.actions.state, "ready"),
          inArray(schema.actions.kind, ["merge", "deploy"]),
        ),
      );
    for (const w of waiting) await this.#ctx.tasks.advance(w.taskId);
  }

  /**
   * At startup. A hook call that was in flight may or may not have started a
   * deploy, so it's never made again on its own. A merge through GitHub is
   * safe to ask again.
   */
  async recover(): Promise<void> {
    const hooks = await this.#db
      .update(schema.actions)
      .set({
        state: "failed",
        message: `${INTERRUPTED}: the server restarted while it was calling the deploy hook, so Sling won't call it again on its own.`,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.actions.kind, "deploy"),
          eq(schema.actions.state, "sent"),
          isNull(schema.actions.runnerId),
        ),
      )
      .returning();
    const merges = await this.#db
      .update(schema.actions)
      .set({ state: "ready", sentAt: null })
      .where(
        and(
          eq(schema.actions.kind, "merge"),
          eq(schema.actions.state, "sent"),
          isNull(schema.actions.runnerId),
        ),
      )
      .returning();
    for (const a of hooks) {
      await this.#audit(a, "interrupted");
      await this.#targets.publish(a.targetId);
    }
    for (const taskId of new Set([...hooks, ...merges].map((a) => a.taskId))) {
      await this.#ctx.tasks.advance(taskId);
    }
  }

  /** Machine steps whose machine never answered, past its limit and a minute. */
  async sweep(): Promise<void> {
    const sent = await this.#db
      .select({
        action: schema.actions,
        runnerName: schema.runners.name,
        deployTimeoutSeconds: schema.repos.deployTimeoutSeconds,
      })
      .from(schema.actions)
      .leftJoin(schema.runners, eq(schema.runners.id, schema.actions.runnerId))
      .leftJoin(schema.deployTargets, eq(schema.deployTargets.id, schema.actions.targetId))
      .leftJoin(
        schema.repos,
        and(
          eq(schema.repos.runnerId, schema.actions.runnerId),
          eq(schema.repos.remoteKey, schema.deployTargets.remoteKey),
          isNull(schema.repos.removedAt),
        ),
      )
      .where(
        and(
          eq(schema.actions.state, "sent"),
          inArray(schema.actions.kind, ["merge", "deploy"]),
          isNotNull(schema.actions.runnerId),
        ),
      );
    const now = Date.now();
    for (const { action, runnerName, deployTimeoutSeconds } of sent) {
      // A deploy command may run as long as its machine allows, which the machine reports.
      const deployLimit = deployTimeoutSeconds ? deployTimeoutSeconds * 1000 : DEPLOY_TIMEOUT_MS;
      const limit = (action.kind === "merge" ? MERGE_TIMEOUT_MS : deployLimit) + ANSWER_GRACE_MS;
      if (!action.sentAt || now - action.sentAt.getTime() < limit) continue;
      await this.#end(
        action,
        "failed",
        {
          message: `${INTERRUPTED}: ${runnerName ?? "the machine"} didn't answer within ${Math.round(limit / 60_000)} minutes.`,
        },
        ["sent"],
      );
    }
  }
}
