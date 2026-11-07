import type { CheckResultView, CheckState, CheckView, PushPayload } from "@sling/core";
import { reasonOf } from "./state.ts";

/** "18:05" in a time zone. */
export function clockIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** "Fri 13 Nov, 17:00" in a time zone. */
export function dayAndTimeIn(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
  return `${day.replace(",", "")}, ${clockIn(iso, timeZone)}`;
}

/** What a change says, for a push, the `checks.changed` trigger, and a start rule's message. */
export interface CheckAlert {
  title: string;
  body: string;
  /** The page a tap opens. */
  url: string;
  urgency: "normal" | "high";
  /** The short reason it went down, such as "503". Empty when it came back or was met. */
  reason: string;
  /** When it started being this way, as HH:MM in the workspace's time zone. */
  sinceTime: string;
}

const draftUrl = (draft: string, personality: string | null) => {
  const q = new URLSearchParams();
  if (personality) q.set("personality", personality);
  q.set("draft", draft);
  return `/?${q.toString()}`;
};

/**
 * The alert for a change. Going down or missing a reply opens a chat about
 * it: the one a start rule opened, or a new one with a draft that says what
 * happened, which nothing sends until you do.
 */
export function alertFor(
  check: Pick<CheckView, "id" | "name" | "kind" | "state" | "stateSince" | "deadline">,
  from: CheckState,
  result: Pick<CheckResultView, "message" | "detail" | "at">,
  opts: { timeZone: string; openChat: string | null },
): CheckAlert {
  const since = check.stateSince ?? result.at;
  const sinceTime = clockIn(since, opts.timeZone);
  const chat = opts.openChat ? `/c/${opts.openChat}` : null;
  const name = check.name;
  if (check.state === "down") {
    const reason = reasonOf(result.detail, result.message);
    const verb = check.kind === "command" ? "is failing" : "is down";
    return {
      title: `${name} ${verb}: ${reason}`.slice(0, 120),
      body: `Failing since ${sinceTime}. Tap to start a chat about it.`,
      url:
        chat ??
        draftUrl(
          `${name} ${verb} (${reason} since ${sinceTime}). Find out why and fix it.`,
          "incident",
        ),
      urgency: "high",
      reason,
      sinceTime,
    };
  }
  if (check.state === "missed") {
    const by = check.deadline ? dayAndTimeIn(check.deadline, opts.timeZone) : sinceTime;
    return {
      title: `${name}: no reply by ${by}`.slice(0, 120),
      body: "Tap to start a chat about it.",
      url: chat ?? draftUrl(`No reply came for "${name}" by ${by}. Help me follow up.`, null),
      urgency: "high",
      reason: "No reply",
      sinceTime,
    };
  }
  if (check.state === "met") {
    const match = result.detail.kind === "reply" ? result.detail.match : null;
    const who = match?.from || "Someone";
    return {
      title: name.slice(0, 120),
      body: `${who} replied${match?.subject ? `: ${match.subject}` : "."}`.slice(0, 400),
      url: chat ?? "/checks",
      urgency: "normal",
      reason: "",
      sinceTime,
    };
  }
  return {
    title: `${name} ${check.kind === "command" ? "passes again" : "is back up"}`.slice(0, 120),
    body:
      check.kind === "site"
        ? from === "down"
          ? "Every health check passes again."
          : "Every health check passes."
        : result.message,
    url: chat ?? "/checks",
    urgency: "normal",
    reason: "",
    sinceTime,
  };
}

/** The push for a change. Pushes about one check replace each other on the device. */
export function alertPayload(checkId: string, alert: CheckAlert): PushPayload {
  return { title: alert.title, body: alert.body, url: alert.url, tag: `check:${checkId}` };
}
