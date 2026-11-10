import {
  CHECK_DOWN_AFTER,
  type CheckKind,
  type CheckResultDetail,
  type CheckState,
  type DeployCheckResult,
} from "@sling/core";
import { describeResult, downReason } from "../deploys/checks.ts";

/** What one run of a check came to, before it's saved. */
export interface RunOutcome {
  passed: boolean;
  /**
   * False when it couldn't run at all, such as when its machine is offline.
   * It's kept in the history but doesn't count as a failure.
   */
  counted: boolean;
  message: string;
  ms: number;
  detail: CheckResultDetail;
}

/**
 * How long a reply check keeps trying past its deadline when the mailbox
 * couldn't be searched, and how often it tries meanwhile.
 */
export const REPLY_GRACE_MS = 30 * 60_000;
const REPLY_RETRY_MS = 60_000;

export interface Prior {
  state: CheckState;
  failures: number;
  stateSince: Date | null;
}

export interface Next {
  state: CheckState;
  failures: number;
  stateSince: Date | null;
  /** A reply check that was met or missed stops running. */
  done: boolean;
}

/**
 * Where a run leaves a check. A site or command check goes down after two
 * failures in a row and up after one pass, and stays as it was when it
 * couldn't run. A reply check waits until a reply arrives or its deadline
 * passes, then stops. A search that failed at the deadline doesn't count as
 * no reply: it keeps trying for a while before it gives up.
 */
export function nextState(
  kind: CheckKind,
  prior: Prior,
  run: { passed: boolean; counted: boolean },
  now: Date,
  deadline: Date | null,
): Next {
  const moved = (state: CheckState, failures: number, done = false): Next => ({
    state,
    failures,
    stateSince: state === prior.state ? prior.stateSince : now,
    done,
  });
  if (kind === "reply") {
    if (prior.state === "met" || prior.state === "missed") return moved(prior.state, 0, true);
    if (run.passed) return moved("met", 0, true);
    if (deadline && now.getTime() >= deadline.getTime()) {
      const givenUp = now.getTime() >= deadline.getTime() + REPLY_GRACE_MS;
      if (run.counted || givenUp) return moved("missed", 0, true);
    }
    return moved("waiting", 0);
  }
  if (!run.counted) return moved(prior.state, prior.failures);
  if (run.passed) return moved("up", 0);
  const failures = prior.failures + 1;
  if (failures >= CHECK_DOWN_AFTER) return moved("down", failures);
  return moved(prior.state, failures);
}

/**
 * Whether a change is worth telling anyone about: going down, coming back
 * up after being down, and a reply arriving or not arriving in time. A first
 * run that passes, or a reply check that starts waiting, isn't.
 */
export function isNotable(from: CheckState, to: CheckState): boolean {
  if (from === to) return false;
  if (to === "down" || to === "met" || to === "missed") return true;
  return to === "up" && from === "down";
}

/** When the scheduler runs it next. Null once a reply check has stopped. */
export function nextRunAt(
  kind: CheckKind,
  next: Next,
  now: Date,
  intervalSeconds: number,
  deadline: Date | null,
): Date | null {
  if (next.done) return null;
  const at = now.getTime() + intervalSeconds * 1000;
  if (kind === "reply" && deadline) {
    if (now.getTime() < deadline.getTime()) return new Date(Math.min(at, deadline.getTime()));
    // Past the deadline only after a failed search: try again soon.
    const retry = now.getTime() + REPLY_RETRY_MS;
    return new Date(Math.min(at, retry, deadline.getTime() + REPLY_GRACE_MS));
  }
  return new Date(at);
}

/** A site check's one line: the first failure, or how fast it answered. */
export function siteMessage(results: DeployCheckResult[], versionSeen: boolean | null): string {
  const failed = results.find((r) => !r.ok);
  if (failed) return describeResult(failed);
  const ms = results.length ? Math.max(...results.map((r) => r.ms)) : 0;
  const status = results.length === 1 ? `Answered ${results[0]?.status} in ${ms} ms` : null;
  const all = status ?? `All ${results.length} answered as set, the slowest in ${ms} ms`;
  if (versionSeen === false) return `${all}, but the version URL shows another commit`;
  return all;
}

/** The short reason a check is down, for a notification's title: "503", or "Exited 1". */
export function reasonOf(detail: CheckResultDetail | null | undefined, message: string): string {
  if (!detail) return message;
  if (detail.kind === "site") return downReason(detail.checks) || message;
  if (detail.kind === "command") {
    if (detail.error) return detail.error;
    if (detail.timedOut) return "Timed out";
    if (detail.exitCode !== null && detail.exitCode !== 0) return `Exited ${detail.exitCode}`;
    return message;
  }
  return message;
}
