import { SLING_EVENTS } from "@sling/workflow";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { isTimeZone } from "../../timezone.ts";
import { oneTimeAt, parseLocal } from "../one-time.ts";
import { defineNode } from "../types.ts";

const next = [{ name: "next" }];

interface ChatPayload {
  conversation: Record<string, unknown>;
  key: string;
  message: string;
  messageId: string;
}

interface UpdatePayload {
  conversation: Record<string, unknown>;
  key: string;
  note: string;
  taskId: string | null;
  reason: string;
}

const conversationOutputs = [
  { name: "conversation", type: "conversation", description: "The conversation." },
  {
    name: "key",
    type: "string",
    description: "The conversation's key: its external key, or its ID for web chats.",
  },
];

/** Five or six space-separated cron fields. */
const CRON = /^(\S+\s+){4,5}\S+$/;

/** Why pg-boss would refuse a cron expression, read the way it reads them. Null when it's fine. */
function cronProblem(cron: string): string | null {
  try {
    CronExpressionParser.parse(cron, { tz: "UTC", strict: false });
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return why.replace(/^Constraint error, /, "");
  }
}

export const manualTrigger = defineNode({
  type: "core.manual",
  version: 1,
  title: "Manual run",
  description:
    "Starts the workflow from the editor's Run button, POST /api/workflows/:id/run, or another workflow's Invoke workflow node.",
  category: "trigger",
  configSchema: z.object({
    sampleInput: z
      .string()
      .optional()
      .describe("Example input JSON, offered when you press Run.")
      .meta({ widget: "json" }),
  }),
  inputs: [],
  outputs: [{ name: "input", type: "json", description: "The input JSON the run was given." }],
  execInput: false,
  execOutputs: next,
  idempotent: true,
  trigger: {
    event: SLING_EVENTS.manual,
    match: (e) => ({ outputs: { input: (e.payload as { input?: unknown })?.input ?? null } }),
  },
});

/** A schedule has a cron expression or a one-time `at`, never both. */
function checkSchedule(config: Record<string, unknown>) {
  const cron = typeof config.cron === "string" ? config.cron.trim() : "";
  const at = oneTimeAt(config);
  const tz = typeof config.timezone === "string" ? config.timezone.trim() : "";
  const issues: { field: string; message: string }[] = [];
  if (cron && at)
    issues.push({ field: "at", message: "Set a cron expression or a time, not both" });
  else if (at && !parseLocal(at))
    issues.push({
      field: "at",
      message: "Use a local date and time, for example 2026-11-09T17:00",
    });
  else if (!at && !CRON.test(cron))
    issues.push({ field: "cron", message: "Use five cron fields, for example */5 * * * *" });
  else if (!at) {
    const problem = cronProblem(cron);
    if (problem)
      issues.push({ field: "cron", message: `This cron expression can't run: ${problem}` });
  }
  if (tz && !isTimeZone(tz))
    issues.push({ field: "timezone", message: `${tz} isn't a time zone, such as Europe/Lisbon` });
  return issues;
}

export const scheduleTrigger = defineNode({
  type: "core.schedule",
  version: 1,
  title: "Schedule",
  description:
    "Starts the workflow on a cron schedule, or once at a time you set, after which the workflow turns itself off.",
  category: "trigger",
  configSchema: z.object({
    cron: z
      .string()
      .default("")
      .describe(
        "Cron expression: minute, hour, day of month, month, day of week. For example */5 * * * * runs every five minutes. Leave empty when it runs once.",
      ),
    at: z
      .string()
      .default("")
      .describe(
        "Runs once, at this local date and time, such as 2026-11-09T17:00, and then turns the workflow off. Leave empty to use the cron expression.",
      ),
    timezone: z
      .string()
      .default("")
      .describe(
        "Time zone the schedule follows, such as Europe/Lisbon. Leave empty to follow the workspace's time zone from Settings.",
      ),
  }),
  checkConfig: checkSchedule,
  inputs: [],
  outputs: [
    { name: "firedAt", type: "string", description: "When the schedule fired, as an ISO time." },
  ],
  execInput: false,
  execOutputs: next,
  idempotent: true,
  trigger: {
    event: SLING_EVENTS.schedule,
    match: (e) => ({ outputs: { firedAt: e.at.toISOString() } }),
  },
});

/** An HTTP header name (RFC 9110 token), as a webhook's event ID header. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const RUN_LIMITS = [1, 2, 3, 5, 10, 25, 50] as const;

export const webhookConfig = z.object({
  auth: z
    .union([
      z.literal("token").meta({ title: "URL only" }),
      z.literal("signed").meta({ title: "Signed" }),
    ])
    .default("token")
    .describe(
      "Signed requests also need X-Sling-Timestamp and X-Sling-Signature, made with the signing secret.",
    )
    .meta({ title: "Requests", widget: "segmented" }),
  eventIdHeader: z
    .string()
    .trim()
    .max(100)
    .default("x-sling-event-id")
    .describe("A second request with the same event ID in this header starts no run.")
    .meta({ title: "Event ID header" }),
  maxConcurrentRuns: z
    .union([
      z.literal(0).meta({ title: "No limit" }),
      ...RUN_LIMITS.map((n) => z.literal(n).meta({ title: String(n) })),
    ])
    .default(0)
    .describe("Requests while this many runs are unfinished get 429 Too Many Requests.")
    .meta({ title: "Runs at once" }),
});

export type WebhookConfig = z.infer<typeof webhookConfig>;

export const webhookTrigger = defineNode({
  type: "core.webhook",
  version: 1,
  title: "Webhook",
  description:
    "Starts the workflow when something POSTs to its URL. The URL appears in the workflow once it's published. Unless it takes signed requests only, anyone with the URL can start a run, so treat it like a password.",
  category: "trigger",
  configSchema: webhookConfig,
  checkConfig: (config) => {
    const header = typeof config.eventIdHeader === "string" ? config.eventIdHeader.trim() : "";
    return header && !HEADER_NAME.test(header)
      ? [{ field: "eventIdHeader", message: `${header} isn't a header name` }]
      : [];
  },
  inputs: [],
  outputs: [
    { name: "body", type: "json", description: "The request body, parsed if it was JSON." },
    {
      name: "headers",
      type: "json",
      description: "Request headers, without cookies or authorization.",
    },
    { name: "query", type: "json", description: "Query string parameters." },
  ],
  execInput: false,
  execOutputs: next,
  idempotent: true,
  trigger: {
    event: SLING_EVENTS.webhook,
    match: (e) => ({ outputs: (e.payload ?? {}) as Record<string, unknown> }),
  },
});

export const chatMessageTrigger = defineNode({
  type: "app.chat_message",
  version: 1,
  title: "Chat message",
  description:
    "A message sent in the Sling web app. The message is already saved in the conversation when this fires.",
  category: "trigger",
  configSchema: z.object({}),
  inputs: [],
  outputs: [
    ...conversationOutputs,
    { name: "message", type: "string", description: "The message text." },
    { name: "messageId", type: "string", description: "ID of the saved message." },
  ],
  execInput: false,
  execOutputs: next,
  idempotent: true,
  trigger: {
    event: SLING_EVENTS.chatMessage,
    match: (e) => {
      const p = e.payload as ChatPayload;
      return {
        outputs: {
          conversation: p.conversation,
          key: p.key,
          message: p.message,
          messageId: p.messageId,
        },
        concurrencyKey: p.key,
      };
    },
  },
});

export const conversationUpdateTrigger = defineNode({
  type: "sling.conversation_update",
  version: 1,
  title: "Conversation update",
  description:
    "A note Sling adds to a conversation this workflow owns, for example when a task it started finishes or needs approval. The note is already saved in the conversation.",
  category: "trigger",
  configSchema: z.object({}),
  inputs: [],
  outputs: [
    ...conversationOutputs,
    { name: "note", type: "string", description: "The note's text." },
    { name: "taskId", type: "string", description: "The task the note is about, if any." },
    { name: "reason", type: "string", description: "finished, approval_needed, or delivered." },
  ],
  execInput: false,
  execOutputs: next,
  idempotent: true,
  trigger: {
    event: SLING_EVENTS.conversationUpdate,
    match: (e) => {
      const p = e.payload as UpdatePayload;
      return {
        outputs: {
          conversation: p.conversation,
          key: p.key,
          note: p.note,
          taskId: p.taskId,
          reason: p.reason,
        },
        concurrencyKey: p.key,
      };
    },
  },
});

const SETTLE_REASONS = ["finished", "approval_needed", "delivered"] as const;

export const taskSettledTrigger = defineNode({
  type: "sling.task_settled",
  version: 1,
  title: "Task settled",
  description: "Any Sling coding task finishing, waiting for approval, or finishing delivery.",
  category: "trigger",
  configSchema: z.object({
    reasons: z
      .array(z.enum(SETTLE_REASONS))
      .default([])
      .describe("Only fire for these reasons. Empty means all of them."),
  }),
  inputs: [],
  outputs: [
    { name: "task", type: "task", description: "The task and how it settled." },
    { name: "reason", type: "string", description: "finished, approval_needed, or delivered." },
  ],
  execInput: false,
  execOutputs: next,
  idempotent: true,
  trigger: {
    event: SLING_EVENTS.taskSettled,
    match: (e, config) => {
      const p = e.payload as {
        task: Record<string, unknown>;
        reason: (typeof SETTLE_REASONS)[number];
      };
      if (config.reasons.length > 0 && !config.reasons.includes(p.reason)) return null;
      return { outputs: { task: p.task, reason: p.reason } };
    },
  },
});

export const approvalRequestedTrigger = defineNode({
  type: "sling.approval_requested",
  version: 1,
  title: "Approval requested",
  description:
    "A new pending approval: a push or pull request in Supervised mode, running a task in a sandbox because no machine could take it, or a workflow's Approval node.",
  category: "trigger",
  configSchema: z.object({}),
  inputs: [],
  outputs: [{ name: "approval", type: "approval", description: "The pending approval." }],
  execInput: false,
  execOutputs: next,
  idempotent: true,
  trigger: {
    event: SLING_EVENTS.approvalRequested,
    match: (e) => ({ outputs: { approval: (e.payload as { approval: unknown }).approval } }),
  },
});

export const triggerNodes = [
  manualTrigger,
  scheduleTrigger,
  webhookTrigger,
  chatMessageTrigger,
  conversationUpdateTrigger,
  taskSettledTrigger,
  approvalRequestedTrigger,
];
