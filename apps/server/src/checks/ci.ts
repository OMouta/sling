/**
 * A delivered PR's CI. The machine that has the repo reads it with
 * `gh pr checks`, since that's where the user is logged in to GitHub. A
 * sandbox's PR, or one no machine can read, goes through GitHub's API with
 * the workspace's GitHub token.
 */
import { randomBytes } from "node:crypto";
import { schema } from "@sling/db";
import {
  create,
  EnvelopeSchema,
  RepoAction_Kind,
  type RepoActionResult,
  RepoActionResult_Outcome,
} from "@sling/runner-protocol";
import type { VerifyResult } from "@sling/workflow";
import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { githubPull } from "../deploys/steps.ts";
import type { RunnerSession } from "../runners/gateway.ts";
import { readSecrets } from "../sandboxes/settings.ts";

/** How long a PR's CI is waited for. */
export const CI_LIMIT_SECONDS = 30 * 60;
/** CI that hasn't reported a single check by then probably doesn't run on this repo. */
const NO_CI_AFTER_MS = 3 * 60_000;
const MACHINE_ANSWER_MS = 60_000;
const GITHUB_TIMEOUT_MS = 20_000;
const POLL_SECONDS = 30;

export type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface CiRun {
  name: string;
  bucket: Bucket;
}

/** "PR #12" from a pull request URL. */
export function prLabel(url: string | null | undefined): string | null {
  const n = url ? /\/pull\/(\d+)/.exec(url)?.[1] : undefined;
  return n ? `PR #${n}` : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function names(runs: CiRun[]): string {
  const shown = runs.slice(0, 3).map((r) => r.name);
  return runs.length > 3 ? `${shown.join(", ")} and ${runs.length - 3} more` : shown.join(", ");
}

/**
 * What a PR's checks add up to. Any failure fails it; any still running
 * waits; skipped ones don't count. No checks at all waits for a few
 * minutes, then says there's no CI.
 */
export function summarizeCi(runs: CiRun[], waitedMs: number): VerifyResult {
  const counted = runs.filter((r) => r.bucket !== "skipping");
  const failed = counted.filter((r) => r.bucket === "fail" || r.bucket === "cancel");
  const pending = counted.filter((r) => r.bucket === "pending");
  if (failed.length > 0) {
    return {
      state: "failed",
      message: `CI failed: ${names(failed)} (${failed.length} of ${counted.length})`,
    };
  }
  if (pending.length > 0) {
    return {
      state: "waiting",
      message: `CI running: ${counted.length - pending.length} of ${plural(counted.length, "check")} done`,
      retryAfterSeconds: POLL_SECONDS,
    };
  }
  if (counted.length > 0) {
    return { state: "passed", message: `CI passed: ${plural(counted.length, "check")}` };
  }
  if (waitedMs < NO_CI_AFTER_MS) {
    return {
      state: "waiting",
      message: "Waiting for CI to start",
      retryAfterSeconds: POLL_SECONDS,
    };
  }
  return { state: "unchecked", message: "No CI ran on this PR" };
}

/** A check run or commit status from GitHub's API, as a bucket. */
export function bucketOf(status: string | null, conclusion: string | null): Bucket {
  if (status && status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
    case "neutral":
      return "pass";
    case "skipped":
      return "skipping";
    case "cancelled":
      return "cancel";
    default:
      return "fail";
  }
}

function statusBucket(state: string): Bucket {
  if (state === "success") return "pass";
  if (state === "pending") return "pending";
  return "fail";
}

// ------------------------------------------------------------- the machine

const waiting = new Map<
  string,
  { runnerId: string; resolve: (r: RepoActionResult) => void; timer: NodeJS.Timeout }
>();

/** A machine's answer to a CI read. False when nothing asked for it. */
export function ciAnswer(session: RunnerSession, r: RepoActionResult): boolean {
  if (r.kind !== RepoAction_Kind.CI) return false;
  session.send(
    create(EnvelopeSchema, { body: { case: "repoActionAck", value: { requestId: r.requestId } } }),
  );
  const w = waiting.get(r.requestId);
  if (!w || w.runnerId !== session.runnerId) return true;
  clearTimeout(w.timer);
  waiting.delete(r.requestId);
  w.resolve(r);
  return true;
}

async function askMachine(
  ctx: AppContext,
  runnerId: string,
  repo: string,
  prUrl: string,
  checkId: string,
): Promise<RepoActionResult | null> {
  const requestId = `${checkId}.${randomBytes(4).toString("hex")}`;
  const answer = new Promise<RepoActionResult | null>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      resolve(null);
    }, MACHINE_ANSWER_MS);
    timer.unref();
    waiting.set(requestId, { runnerId, resolve, timer });
  });
  const sent = ctx.runners.send(
    runnerId,
    create(EnvelopeSchema, {
      body: {
        case: "repoAction",
        value: { requestId, kind: RepoAction_Kind.CI, taskId: "", repo, prUrl },
      },
    }),
  );
  if (!sent) {
    const w = waiting.get(requestId);
    if (w) clearTimeout(w.timer);
    waiting.delete(requestId);
    return null;
  }
  return answer;
}

/** The online machines that have the repo, the one the task ran on first. */
async function machinesFor(ctx: AppContext, task: typeof schema.tasks.$inferSelect) {
  const remoteKey = task.repoId
    ? (
        await ctx.db
          .select({ remoteKey: schema.repos.remoteKey })
          .from(schema.repos)
          .where(eq(schema.repos.id, task.repoId))
      )[0]?.remoteKey
    : null;
  if (!remoteKey) return [];
  const rows = await ctx.db
    .select({ runnerId: schema.repos.runnerId, name: schema.repos.name })
    .from(schema.repos)
    .innerJoin(schema.runners, eq(schema.runners.id, schema.repos.runnerId))
    .where(
      and(
        eq(schema.repos.remoteKey, remoteKey),
        eq(schema.runners.workspaceId, task.workspaceId),
        eq(schema.runners.ephemeral, false),
        isNull(schema.runners.revokedAt),
        isNull(schema.repos.removedAt),
      ),
    );
  return rows
    .filter((r) => ctx.runners.isOnline(r.runnerId))
    .sort((a, b) => Number(b.runnerId === task.runnerId) - Number(a.runnerId === task.runnerId));
}

// ------------------------------------------------------------- GitHub's API

async function fromGitHub(
  ctx: AppContext,
  token: string,
  pull: { owner: string; repo: string; number: number },
): Promise<{ runs: CiRun[] } | { error: string }> {
  const api = (ctx.config.testing?.githubApiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Sling",
  };
  const get = async <T>(path: string): Promise<T | { error: string }> => {
    const res = await fetch(`${api}/repos/${pull.owner}/${pull.repo}${path}`, {
      headers,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `GitHub answered ${res.status}` };
    return (await res.json()) as T;
  };
  const pr = await get<{ head?: { sha?: string } }>(`/pulls/${pull.number}`);
  if ("error" in pr) return pr;
  const sha = pr.head?.sha;
  if (!sha) return { error: "GitHub didn't say which commit the PR is at" };
  const [runs, status] = await Promise.all([
    get<{ check_runs?: { name: string; status: string; conclusion: string | null }[] }>(
      `/commits/${sha}/check-runs?per_page=100`,
    ),
    get<{ statuses?: { context: string; state: string }[] }>(`/commits/${sha}/status`),
  ]);
  if ("error" in runs) return runs;
  const out: CiRun[] = (runs.check_runs ?? []).map((r) => ({
    name: r.name,
    bucket: bucketOf(r.status, r.conclusion),
  }));
  if (!("error" in status)) {
    for (const s of status.statuses ?? [])
      out.push({ name: s.context, bucket: statusBucket(s.state) });
  }
  return { runs: out };
}

// ------------------------------------------------------------- the check

/** What a delivered PR's CI says now. */
export async function ciStatus(
  ctx: AppContext,
  row: typeof schema.actionChecks.$inferSelect,
): Promise<VerifyResult> {
  const [found] = row.actionId
    ? await ctx.db
        .select({ action: schema.actions, task: schema.tasks })
        .from(schema.actions)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.actions.taskId))
        .where(eq(schema.actions.id, row.actionId))
    : [];
  if (!found) return { state: "unchecked", message: "The PR's step is gone" };
  const url = found.action.url ?? "";
  const pull = githubPull(url);
  if (!pull) return { state: "unchecked", message: "Sling reads CI only on GitHub" };
  const waitedMs = Date.now() - row.createdAt.getTime();
  const problems: string[] = [];

  if (!found.task.sandboxId) {
    for (const m of await machinesFor(ctx, found.task)) {
      const r = await askMachine(ctx, m.runnerId, m.name, url, row.id);
      if (!r) continue;
      if (r.outcome === RepoActionResult_Outcome.SUCCEEDED) {
        const runs = r.ciChecks.map((c) => ({ name: c.name, bucket: c.bucket as Bucket }));
        return summarizeCi(runs, waitedMs);
      }
      if (r.message) problems.push(r.message.replace(/\.$/, ""));
    }
  }
  const token = (await readSecrets(ctx, found.task.workspaceId)).gitToken;
  if (token) {
    try {
      const r = await fromGitHub(ctx, token, pull);
      if ("runs" in r) return summarizeCi(r.runs, waitedMs);
      problems.push(r.error);
    } catch (err) {
      problems.push(`Couldn't reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const why = problems[0] ?? "No machine with the repo is online, and there's no GitHub token";
  // Nothing could look this time. Keep trying while there's time.
  return { state: "waiting", message: `Can't read CI yet: ${why}`, retryAfterSeconds: 60 };
}
