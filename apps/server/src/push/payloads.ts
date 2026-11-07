import { createHash } from "node:crypto";
import {
  type ActionKind,
  type ActionState,
  DEFAULT_NOTIFICATIONS,
  type NotificationSettings,
  type PushPayload,
  type TaskState,
} from "@sling/core";

/**
 * What goes out in a push, and what a push service's answer means. Pure, so
 * the rules are easy to test. A push carries titles and short fixed phrases
 * only: never command output, task summaries, or message text, since it
 * passes through a third party's service and shows on a lock screen.
 */

/** Push services known to Sling. Subscriptions to anything else are refused. */
export const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;
const WINDOWS_HOST = /^[a-z0-9-]+\.notify\.windows\.com$/;

/**
 * Null when the endpoint is on a known push service, else why not. `extra`
 * lists more origins that are accepted as they are, for tests.
 */
export function endpointProblem(endpoint: string, extra: readonly string[] = []): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "The endpoint isn't a URL.";
  }
  if (extra.includes(url.origin)) return null;
  if (url.protocol !== "https:") return "Push endpoints must use HTTPS.";
  if (url.port || url.username || url.password) {
    return "Push endpoints can't name a port or carry credentials.";
  }
  const host = url.hostname;
  if ((PUSH_HOSTS as readonly string[]).includes(host) || WINDOWS_HOST.test(host)) return null;
  return `${host} isn't a push service Sling knows.`;
}

/** A user's categories, with anything never set at its default. */
export function notificationSettings(
  stored: Partial<NotificationSettings> | null | undefined,
): NotificationSettings {
  const out = { ...DEFAULT_NOTIFICATIONS };
  for (const key of Object.keys(out) as (keyof NotificationSettings)[]) {
    const v = stored?.[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

export type Delivery = "delivered" | "gone" | "failed";

/** Failed deliveries in a row after which a subscription is dropped. */
export const MAX_FAILURES = 10;

/** What a push service's status code means for the subscription. */
export function deliveryOf(status: number): Delivery {
  // RFC 8030 answers 201; a few services answer other 2xx codes for the same thing.
  if (status >= 200 && status < 300) return "delivered";
  if (status === 404 || status === 410) return "gone";
  return "failed";
}

/**
 * RFC 8030's `Topic`: a push still waiting at the push service is replaced
 * by a newer one with the same topic. At most 32 base64url characters.
 */
export function topicFor(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/** The most a push's JSON may take, well under the 4 KB push services accept. */
export const MAX_PAYLOAD_BYTES = 3 * 1024;

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** The JSON a push carries, shortened to fit. */
export function encodePayload(p: PushPayload): Buffer {
  const out: PushPayload = {
    title: clip(p.title, 120),
    body: clip(p.body, 400),
    // Only paths in the app open on tap, never another site.
    url: p.url.startsWith("/") && !p.url.startsWith("//") && p.url.length <= 2000 ? p.url : "/",
    tag: clip(p.tag, 200),
  };
  let json = Buffer.from(JSON.stringify(out));
  if (json.length > MAX_PAYLOAD_BYTES) {
    out.body = clip(out.body, 100);
    json = Buffer.from(JSON.stringify(out));
  }
  if (json.length > MAX_PAYLOAD_BYTES) {
    out.url = "/";
    out.title = clip(out.title, 60);
    json = Buffer.from(JSON.stringify(out));
  }
  return json;
}

// ------------------------------------------------------------ approvals

export function taskApprovalPayload(t: {
  taskId: string;
  taskTitle: string;
  /** The steps waiting on this answer. */
  kinds: ActionKind[];
  /** The deploy target's name, for merge and deploy. */
  targetName: string | null;
  repoName: string;
}): PushPayload {
  let title = "Approve push?";
  if (t.kinds.includes("merge") || t.kinds.includes("deploy")) {
    title = `Approve deployment of ${t.targetName ?? t.repoName}?`;
  } else if (t.kinds.includes("open_pr")) {
    title = "Approve pull request?";
  }
  return { title, body: t.taskTitle, url: "/approvals", tag: `task:${t.taskId}` };
}

export function sandboxFallbackPayload(t: { taskId: string; taskTitle: string }): PushPayload {
  return {
    title: "Run in a sandbox?",
    body: `No machine can take “${t.taskTitle}”.`,
    url: "/approvals",
    tag: `task:${t.taskId}`,
  };
}

export function workflowApprovalPayload(a: {
  approvalId: string;
  title: string;
  workflowName: string | null;
}): PushPayload {
  return {
    title: a.title,
    body: a.workflowName
      ? `${a.workflowName} is waiting for you.`
      : "A workflow is waiting for you.",
    url: "/approvals",
    tag: `approval:${a.approvalId}`,
  };
}

/** A command or a send waiting in a chat. It shares the chat's tag, so the reply that follows replaces it. */
export function chatApprovalPayload(a: {
  conversationId: string;
  conversationTitle: string;
  kind: "command" | "send" | "change";
  machine: string;
  summary: string;
}): PushPayload {
  const title =
    a.kind === "change"
      ? a.summary || "Change Sling's setup?"
      : a.kind === "send"
        ? `Approve: ${a.summary || "send a message"}?`
        : a.machine
          ? `Run a command on ${a.machine}?`
          : "Run a command?";
  return {
    title,
    body: a.conversationTitle,
    url: `/c/${a.conversationId}`,
    tag: `conv:${a.conversationId}`,
  };
}

// ------------------------------------------------------------ tasks

const FAILED_TASK: Partial<Record<TaskState, string>> = {
  failed: "Failed",
  rejected: "Failed",
  interrupted: "Stopped",
};

const DONE_STEP: Record<ActionKind, string> = {
  push: "Pushed the branch.",
  open_pr: "Opened the pull request.",
  merge: "Merged.",
  deploy: "Deployed.",
  verify: "Deployed and verified.",
};

const STEP_NAME: Record<ActionKind, string> = {
  push: "push",
  open_pr: "pull request",
  merge: "merge",
  deploy: "deploy",
  verify: "verify",
};

/**
 * A task reaching the end: finished, failed, or delivered. Null when there's
 * nothing to say, as when the user cancelled it or turned a step down.
 */
export function taskSettledPayload(t: {
  id: string;
  title: string;
  repoName: string;
  state: TaskState;
  filesChanged: number | null;
  actions: { kind: ActionKind; state: ActionState }[];
  reason: "finished" | "delivered";
}): PushPayload | null {
  const base = { url: `/tasks/${t.id}`, tag: `task:${t.id}` };
  if (t.reason === "finished") {
    const failed = FAILED_TASK[t.state];
    if (failed) return { ...base, title: `${failed}: ${t.title}`, body: t.repoName };
    if (t.state !== "succeeded") return null;
    const changes =
      t.filesChanged === null || t.filesChanged === 0
        ? "no changes"
        : t.filesChanged === 1
          ? "1 file changed"
          : `${t.filesChanged} files changed`;
    return { ...base, title: `Done: ${t.title}`, body: `${t.repoName}, ${changes}.` };
  }
  if (t.actions.some((a) => a.state === "rejected")) return null;
  const stuck = t.actions.find((a) => a.state !== "succeeded");
  if (stuck) {
    const body =
      stuck.kind === "verify" && stuck.state === "failed"
        ? "Deployed, but the checks still fail."
        : stuck.state === "expired"
          ? `The ${STEP_NAME[stuck.kind]} approval expired.`
          : stuck.state === "skipped"
            ? "A step was skipped."
            : `The ${STEP_NAME[stuck.kind]} step ${stuck.state === "refused" ? "was refused" : "failed"}.`;
    return { ...base, title: `Couldn't deliver: ${t.title}`, body };
  }
  const last = t.actions.at(-1);
  return {
    ...base,
    title: `Delivered: ${t.title}`,
    body: last ? DONE_STEP[last.kind] : t.repoName,
  };
}

// ------------------------------------------------------------ replies

export function replyPayload(c: {
  conversationId: string;
  conversationTitle: string;
  personalityName: string | null;
}): PushPayload {
  return {
    title: c.conversationTitle,
    body: `${c.personalityName ?? "Sling"} replied.`,
    url: `/c/${c.conversationId}`,
    tag: `conv:${c.conversationId}`,
  };
}
