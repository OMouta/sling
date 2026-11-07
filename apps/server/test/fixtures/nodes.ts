/**
 * Node types and connectors used by the engine tests. The SIGKILL test loads
 * the same file in a child process, so everything here must work in both.
 */
import { type AnyConnector, defineConnector, type SourceContext } from "@sling/connector-sdk";
import { type AnyNodeSpec, NodeError } from "@sling/workflow";
import { z } from "zod";
import { defineNode } from "../../src/workflows/types.ts";

export interface Call {
  tag: string;
  value: unknown;
  runId: string;
  attempt: number;
  key: string;
}

/** Every `test.record` call in this process, in order. */
export const calls: Call[] = [];
const attempts = new Map<string, number>();

export const recordNode = defineNode({
  type: "test.record",
  version: 1,
  title: "Record",
  description: "Remembers its input so a test can check it.",
  category: "action",
  configSchema: z.object({ tag: z.string().default("").describe("Label for the call.") }),
  inputs: [{ name: "value", type: "any" }],
  outputs: [{ name: "value", type: "any" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (ctx, { inputs, config }) => {
    calls.push({
      tag: config.tag,
      value: inputs.value ?? null,
      runId: ctx.runId,
      attempt: ctx.attempt,
      key: ctx.idempotencyKey,
    });
    return { exec: "next", outputs: { value: inputs.value ?? null } };
  },
});

export const flakyNode = defineNode({
  type: "test.flaky",
  version: 1,
  title: "Flaky",
  description: "Fails with a retryable error the first few times.",
  category: "action",
  configSchema: z.object({
    failTimes: z.number().int().default(2).describe("Failures before success."),
  }),
  inputs: [],
  outputs: [{ name: "attempt", type: "number" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  retry: { maxAttempts: 5, backoffMs: 5 },
  run: async (ctx, { config }) => {
    const n = (attempts.get(ctx.idempotencyKey) ?? 0) + 1;
    attempts.set(ctx.idempotencyKey, n);
    if (n <= config.failTimes)
      throw new NodeError(`flake ${n}`, { code: "flaky", retryable: true });
    return { exec: "next", outputs: { attempt: ctx.attempt } };
  },
});

/** Calls of `test.side_effect`, by run. */
export const sideEffects = new Map<string, number>();

export const sideEffectNode = defineNode({
  type: "test.side_effect",
  version: 1,
  title: "Side effect",
  description: "Fails with a retryable error, but isn't idempotent, so it must not be retried.",
  category: "action",
  configSchema: z.object({}),
  inputs: [],
  outputs: [],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  retry: { maxAttempts: 5, backoffMs: 5 },
  run: async (ctx) => {
    sideEffects.set(ctx.runId, (sideEffects.get(ctx.runId) ?? 0) + 1);
    throw new NodeError("the service timed out", { code: "timeout", retryable: true });
  },
});

export const failNode = defineNode({
  type: "test.fail",
  version: 1,
  title: "Fail",
  description: "Always fails.",
  category: "action",
  configSchema: z.object({}),
  inputs: [],
  outputs: [],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async () => {
    throw new NodeError("boom", { code: "boom" });
  },
});

export const sleepNode = defineNode({
  type: "test.sleep",
  version: 1,
  title: "Sleep",
  description: "Takes a while.",
  category: "action",
  configSchema: z.object({ ms: z.number().int().default(10).describe("How long.") }),
  inputs: [{ name: "ms", type: "number" }],
  outputs: [],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (_ctx, { inputs, config }) => {
    const ms = typeof inputs.ms === "number" ? inputs.ms : config.ms;
    await new Promise((r) => setTimeout(r, ms));
    return { exec: "next" };
  },
});

/** With SLING_TEST_BLOCK=1 these never finish, so a test can kill the process mid-node. */
function blockNode(type: string, idempotent: boolean) {
  return defineNode({
    type,
    version: 1,
    title: "Block",
    description: "Hangs while SLING_TEST_BLOCK=1.",
    category: "action",
    configSchema: z.object({}),
    inputs: [],
    outputs: [{ name: "attempt", type: "number" }],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent,
    run: async (ctx) => {
      if (process.env.SLING_TEST_BLOCK === "1") await new Promise(() => {});
      return { exec: "next", outputs: { attempt: ctx.attempt } };
    },
  });
}

export const blockNode1 = blockNode("test.block", false);
export const blockSafeNode = blockNode("test.block_safe", true);

export const waitTaskNode = defineNode({
  type: "test.wait_task",
  version: 1,
  title: "Wait for a task",
  description: "Parks until a Sling task settles.",
  category: "agent",
  configSchema: z.object({ taskId: z.string().describe("Task to wait for.") }),
  inputs: [],
  outputs: [
    { name: "task", type: "task" },
    { name: "reason", type: "string" },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (_ctx, { config }) => ({ wait: { kind: "task", taskId: config.taskId } }),
  resume: async (_ctx, { resolution }) => {
    if (resolution.kind !== "task") throw new NodeError("unexpected", { code: "bad" });
    return { exec: "next", outputs: { task: resolution.task, reason: resolution.reason } };
  },
});

export const waitEventNode = defineNode({
  type: "test.wait_event",
  version: 1,
  title: "Wait for an event",
  description: "Parks until a test.ping event with its key arrives, or times out.",
  category: "logic",
  configSchema: z.object({
    key: z.string().describe("Event key."),
    timeoutMs: z.number().int().default(60_000).describe("Give up after this long."),
  }),
  expressionFields: ["key"],
  inputs: [],
  outputs: [{ name: "payload", type: "json" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (_ctx, { config }) => ({
    wait: {
      kind: "event",
      eventType: "test.ping",
      key: config.key,
      timeoutAt: new Date(Date.now() + config.timeoutMs),
    },
  }),
  resume: async (_ctx, { resolution }) => {
    if (resolution.kind === "timeout") throw new NodeError("No ping came", { code: "timeout" });
    if (resolution.kind !== "event") throw new NodeError("unexpected", { code: "bad" });
    return { exec: "next", outputs: { payload: resolution.payload } };
  },
});

export const testNodes: AnyNodeSpec[] = [
  waitEventNode,
  recordNode,
  flakyNode,
  sideEffectNode,
  failNode,
  sleepNode,
  blockNode1,
  blockSafeNode,
  waitTaskNode,
] as AnyNodeSpec[];

// ---------------------------------------------------------------- fake connector

export const fakeSource = {
  ctx: null as SourceContext<{ token: string }, { label: string }> | null,
  starts: 0,
  stops: 0,
  /** Starts left that should throw. */
  failNext: 0,
};

const fakeEvent = defineNode({
  type: "fake.event",
  version: 1,
  title: "Fake event",
  description: "Fires on events from the fake connector's source.",
  category: "trigger",
  connector: "fake",
  configSchema: z.object({
    installationId: z.string().describe("Installation."),
    topic: z.string().default("").describe("Only this topic, if set."),
  }),
  installationFields: ["installationId"],
  inputs: [],
  outputs: [
    { name: "payload", type: "json" },
    { name: "key", type: "string" },
  ],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: "fake.event",
    match: (e, config) => {
      const p = (e.payload ?? {}) as { topic?: string; key?: string };
      if (config.topic && p.topic !== config.topic) return null;
      return {
        outputs: { payload: p, key: p.key ?? "" },
        ...(p.key ? { concurrencyKey: p.key } : {}),
      };
    },
  },
});

const echoSecret = defineNode({
  type: "fake.echo_secret",
  version: 1,
  title: "Echo secret",
  description: "Leaks its installation's token into its outputs, which storage must redact.",
  category: "action",
  connector: "fake",
  configSchema: z.object({ installationId: z.string().describe("Installation.") }),
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "leak", type: "json" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  run: async (ctx, { config }) => {
    const inst = await ctx.installation<{ token: string }>(config.installationId);
    return {
      exec: "next",
      outputs: {
        leak: { token: inst.credentials.token, header: `Bearer ${inst.credentials.token}` },
        label: inst.config.label,
      },
    };
  },
});

export const fakeConnector: AnyConnector = defineConnector({
  id: "fake",
  name: "Fake",
  description: "A connector for tests.",
  credentialsSchema: z.object({
    token: z.string().min(1).describe("Token."),
    host: z.string().optional().describe("Host."),
  }),
  secretFields: ["token"],
  configSchema: z.object({ label: z.string().default("x").describe("Label.") }),
  test: async ({ credentials }) =>
    credentials.token === "good-token-123"
      ? { ok: true, detail: "fine" }
      : { ok: false, error: "bad token" },
  // Echoes the token back, so a test can see the server never passes a secret on.
  setup: async ({ credentials }) => ({
    name: `Fake for ${String(credentials.token ?? "nobody").slice(0, 4)}`,
    credentials: { token: String(credentials.token ?? ""), host: "fake.example.com" },
    config: { label: "from setup" },
    notes: [
      {
        field: "token",
        tone: credentials.token === "good-token-123" ? ("ok" as const) : ("warn" as const),
        text: "checked",
      },
    ],
  }),
  nodes: [fakeEvent, echoSecret] as AnyNodeSpec[],
  source: {
    start: async (ctx) => {
      fakeSource.starts++;
      if (fakeSource.failNext > 0) {
        fakeSource.failNext--;
        throw new Error("can't connect");
      }
      fakeSource.ctx = ctx;
      ctx.setStatus("connected");
      return {
        stop: async () => {
          fakeSource.stops++;
          if (fakeSource.ctx === ctx) fakeSource.ctx = null;
        },
      };
    },
  },
});

// ---------------------------------------------------------------- fake Discord

/** Messages the fake `discord.send_message` was asked to send. */
export const discordSent: Record<string, unknown>[] = [];

/**
 * Stands in for the real Discord connector with the same node types and
 * config keys, so the bundled template can be installed and run.
 */
export const fakeDiscord: AnyConnector = defineConnector({
  id: "discord",
  name: "Discord (fake)",
  description: "Same node types as the Discord connector, without Discord.",
  credentialsSchema: z.object({ botToken: z.string().min(1).describe("Bot token.") }),
  secretFields: ["botToken"],
  configSchema: z.object({
    allowedUserIds: z.array(z.string()).default([]).describe("Allowed users."),
  }),
  test: async () => ({ ok: true }),
  nodes: [
    defineNode({
      type: "discord.message_received",
      version: 1,
      title: "Discord message",
      description: "A Discord message.",
      category: "trigger",
      connector: "discord",
      configSchema: z.object({
        installationId: z.string().describe("Installation."),
        scope: z.enum(["dm", "channels", "any"]).default("dm").describe("Where."),
        channelIds: z.array(z.string()).default([]).describe("Channels."),
        requireMention: z.boolean().default(false).describe("Mention required."),
      }),
      installationFields: ["installationId"],
      inputs: [],
      outputs: [{ name: "message", type: "discord.message" }],
      execInput: false,
      execOutputs: [{ name: "next" }],
      idempotent: true,
      trigger: {
        event: "discord.message_received",
        match: (e) => {
          const m = e.payload as { channelId: string };
          return {
            outputs: { message: m },
            concurrencyKey: `discord:${e.installationId}:${m.channelId}`,
          };
        },
      },
    }),
    defineNode({
      type: "discord.send_message",
      version: 1,
      title: "Send Discord message",
      description: "Sends a message.",
      category: "action",
      connector: "discord",
      configSchema: z.object({
        installationId: z.string().describe("Installation."),
        channelId: z.string().optional().describe("Channel."),
        userId: z.string().optional().describe("User for a DM."),
        content: z.string().optional().describe("Text, unless the content input is wired."),
        approvalButtons: z.boolean().default(false).describe("Buttons."),
      }),
      expressionFields: ["channelId", "userId", "content"],
      installationFields: ["installationId"],
      // Same ports as the real connector's node.
      inputs: [
        { name: "content", type: "string" },
        { name: "approval", type: "approval" },
      ],
      outputs: [
        { name: "messageId", type: "string" },
        { name: "channelId", type: "string" },
      ],
      execInput: true,
      execOutputs: [{ name: "next" }],
      idempotent: false,
      run: async (ctx, { config, inputs }) => {
        const content = typeof inputs.content === "string" ? inputs.content : config.content;
        discordSent.push({ ...config, content, nonce: ctx.idempotencyKey });
        return { exec: "next", outputs: { messageId: `m${discordSent.length}` } };
      },
    }),
  ] as AnyNodeSpec[],
});
