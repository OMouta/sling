import type {
  DeployCheck,
  DeployCheckResult,
  DeployMethod,
  DeployTargetView,
  MergeMethod,
} from "./api.ts";

/**
 * Checks: what Sling watches on its own. A site answering, a command on a
 * machine exiting 0, or an email reply arriving before a deadline. A site
 * check can also deploy, which is where deploy targets live.
 */

export const CHECK_KINDS = ["site", "command", "reply"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/**
 * `unknown` until the first run. `site` and `command` are then `up` or `down`;
 * `reply` is `waiting`, then `met` or `missed`, and stops.
 */
export const CHECK_STATES = ["unknown", "up", "down", "waiting", "met", "missed"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/** Seconds between runs when a check doesn't set its own. */
export const CHECK_INTERVAL_SECONDS: Record<CheckKind, number> = {
  site: 60,
  command: 5 * 60,
  reply: 5 * 60,
};

/** Failed runs in a row that turn a site or command check down. One pass turns it up. */
export const CHECK_DOWN_AFTER = 2;

/** Results kept per check. Older ones are dropped. */
export const CHECK_RESULTS_KEPT = 100;

/** Most URLs a site check answers for. */
export const SITE_CHECK_URLS_MAX = 5;

/** Every URL answers as set, and the version URL shows the deployed commit when there's a deploy. */
export interface SiteCheckConfig {
  kind: "site";
  checks: DeployCheck[];
  versionUrl: string | null;
}

/**
 * A command that passes when it exits 0, and its output holds `contains` when
 * that's set. It runs in the Runner's read-only sandbox on the check's machine.
 */
export interface CommandCheckConfig {
  kind: "command";
  command: string;
  contains: string | null;
  timeoutSeconds: number;
}

/** An email arriving on the check's account, matching every field that's set, before the deadline. */
export interface ReplyCheckConfig {
  kind: "reply";
  from: string | null;
  subject: string | null;
  /** The Message-ID of the email it answers, to match its thread. */
  inReplyTo: string | null;
  /** INBOX when null. */
  folder: string | null;
}

export type CheckConfig = SiteCheckConfig | CommandCheckConfig | ReplyCheckConfig;

/** An email that met a reply check. */
export interface ReplyMatch {
  id: string;
  from: string;
  subject: string;
  date: string;
}

/** What one run saw, by kind. */
export type CheckResultDetail =
  | { kind: "site"; checks: DeployCheckResult[]; versionSeen: boolean | null }
  | {
      kind: "command";
      /** Null when it never ran or was killed. */
      exitCode: number | null;
      /** Redacted and shortened. */
      output: string;
      timedOut: boolean;
      /** Why it didn't run, such as the machine being offline or commands being off there. */
      error: string | null;
    }
  | { kind: "reply"; match: ReplyMatch | null; error: string | null };

export interface CheckResultView {
  id: string;
  checkId: string;
  at: string;
  passed: boolean;
  /** The check's state after this run. */
  state: CheckState;
  /** One line, such as "Answered 200 in 140 ms" or "Exited 1". */
  message: string;
  ms: number;
  detail: CheckResultDetail;
}

/**
 * The deploy part of a site check: the deploy target that moved onto it. Its
 * `id` is the target's, which tasks and their steps keep pointing at.
 */
export type CheckDeployView = Pick<
  DeployTargetView,
  | "id"
  | "remoteKey"
  | "method"
  | "mergeMethod"
  | "runnerId"
  | "runnerName"
  | "command"
  | "hook"
  | "settleSeconds"
  | "timeoutSeconds"
  | "lastDeploy"
>;

export interface CheckView {
  id: string;
  name: string;
  kind: CheckKind;
  config: CheckConfig;
  /** Off pauses it: the scheduler skips it until it's on again. */
  enabled: boolean;
  intervalSeconds: number;
  /** `reply` only: when it turns missed. */
  deadline: string | null;
  /** `command` only: the machine it runs on. */
  runnerId: string | null;
  runnerName: string | null;
  /** `reply` only: the email account it watches. */
  installationId: string | null;
  installationName: string | null;
  state: CheckState;
  /** When it last changed state. Null before its first run. */
  stateSince: string | null;
  /** Failed runs in a row. */
  failures: number;
  lastResult: CheckResultView | null;
  /** Null once a reply check has stopped, or while it's off. */
  nextRunAt: string | null;
  /** Push to its owner when it changes state. */
  notify: boolean;
  /** `site` only: how it deploys, when it does. */
  deploy: CheckDeployView | null;
  createdAt: string;
  updatedAt: string;
}

/** How a site check deploys, as POST and PATCH /api/checks take it. */
export interface CheckDeployInput {
  remoteKey: string;
  method: DeployMethod;
  mergeMethod?: MergeMethod;
  /** `command` only: the machine that runs the repo's deploy command. */
  runnerId?: string | null;
  /** `hook` only. Parts left out keep what's stored. */
  hook?: {
    url?: string;
    httpMethod?: "POST" | "GET";
    headerName?: string | null;
    headerValue?: string | null;
  } | null;
  settleSeconds?: number;
  timeoutSeconds?: number;
}

/** POST /api/checks */
export interface CheckInput {
  name: string;
  config: CheckConfig;
  enabled?: boolean;
  /** Defaults by kind, from CHECK_INTERVAL_SECONDS. */
  intervalSeconds?: number;
  /** `reply`: required, in the future. */
  deadline?: string | null;
  /** `command`: required. */
  runnerId?: string | null;
  /** `reply`: required, an email installation. */
  installationId?: string | null;
  notify?: boolean;
  /** `site` only. Null stops deploying. */
  deploy?: CheckDeployInput | null;
}

/** PATCH /api/checks/:id. A check's kind can't change. */
export type CheckPatch = Partial<CheckInput>;

/** What a check of an action outside Sling said: an email's bounce, an event read back, a PR's CI. */
export const ACTION_CHECK_STATES = ["passed", "failed", "waiting", "unchecked"] as const;
export type ActionCheckState = (typeof ACTION_CHECK_STATES)[number];

/**
 * On a tool step or a task's step. `waiting` is checked again later.
 * `unchecked` means Sling couldn't check, and says why; a step with nothing
 * to check has no check at all.
 */
export interface ActionCheckView {
  state: ActionCheckState;
  /** One line, such as "In Work, Mon 9 Nov 10:00" or "Bounced: mailbox not found". */
  message: string;
  /** When it was last checked. */
  at: string;
}
