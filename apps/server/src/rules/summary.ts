/**
 * A rule as one line a person reads: on the card's Always allow, on the
 * Rules tab, and in the audit. Built by the server, never taken from input.
 */
import type { StartRuleEvent } from "@sling/core";
import { words } from "../agent/setup-change.ts";
import { describePattern } from "./match.ts";

export interface AllowSummaryInput {
  action: string;
  match: Record<string, string>;
  /** The node's title, such as "Send email", for actions without their own wording. */
  title: string;
  /** Named when the rule pins one account and there's more than one to tell apart. */
  installationName: string | null;
  /** `run_workflow`: the workflow's name. */
  workflowName?: string | null;
}

/** "owner/name" out of "host/owner/name". */
function repoName(key: string): string {
  const parts = key.split("/");
  return parts.length >= 3 ? parts.slice(1).join("/") : key;
}

function pinned(match: Record<string, string>, field: string): string | undefined {
  return Object.hasOwn(match, field) ? (match[field] ?? "") : undefined;
}

function generic(title: string, match: Record<string, string>): string {
  const said = Object.entries(match).map(([field, pattern]) => {
    const label = words(field.replace(/Id$/, "")).toLowerCase();
    return pattern === "" ? `no ${label}` : `${label} ${describePattern(pattern)}`;
  });
  return said.length ? `${title}, ${said.join(", ")}` : title;
}

function phrase(input: AllowSummaryInput): string {
  const { action, match } = input;
  switch (action) {
    case "push": {
      const repo = pinned(match, "repo");
      return repo ? `Pushing task branches to ${repoName(repo)}` : "Pushing task branches";
    }
    case "open_pr": {
      const repo = pinned(match, "repo");
      return repo ? `Opening pull requests on ${repoName(repo)}` : "Opening pull requests";
    }
    case "run_workflow": {
      if (pinned(match, "workflow") === undefined) return "Running any workflow";
      return `Running the ${input.workflowName ?? "chosen"} workflow`;
    }
    case "email.send": {
      const to = pinned(match, "to");
      return to ? `Email to ${describePattern(to)}` : "Any email";
    }
    case "calendar.create_event": {
      const calendar = pinned(match, "calendar");
      if (calendar === undefined) return "Adding events to any calendar";
      return calendar === ""
        ? "Adding events to the default calendar"
        : `Adding events to ${describePattern(calendar)}`;
    }
    case "discord.send_message": {
      const channel = pinned(match, "channelId");
      const user = pinned(match, "userId");
      if (channel) return `Discord messages in channel ${describePattern(channel)}`;
      if (user) return `Discord messages to user ${describePattern(user)}`;
      if (channel === "" && user === "") return "Discord messages to the default channel";
      return "Any Discord message";
    }
    case "telegram.send_message": {
      const chat = pinned(match, "chatId");
      return chat ? `Telegram messages to chat ${describePattern(chat)}` : "Any Telegram message";
    }
    default:
      return generic(input.title, match);
  }
}

/** "Email to anyone at acme.com", with " · Work" when the account needs naming. */
export function allowSummary(input: AllowSummaryInput): string {
  const line = phrase(input);
  const out = input.installationName ? `${line} · ${input.installationName}` : line;
  return out.length > 200 ? `${out.slice(0, 199)}…` : out;
}

const EVENT_WORDS: Record<StartRuleEvent, string> = {
  down: "goes down",
  up: "comes back up",
  met: "gets its reply",
  missed: "misses its deadline",
};

/** What the chat a start rule opens is called, such as "Website went down". */
export const STARTED_TITLE: Record<StartRuleEvent, string> = {
  down: "went down",
  up: "came back up",
  met: "got its reply",
  missed: "missed its deadline",
};

/** "When Website goes down, Incident investigates." */
export function startSummary(input: {
  checkName: string | null;
  on: StartRuleEvent;
  personalityName: string;
}): string {
  const check = input.checkName ?? "any check";
  const does = input.on === "down" || input.on === "missed" ? "investigates" : "follows up";
  return `When ${check} ${EVENT_WORDS[input.on]}, ${input.personalityName} ${does}`;
}
