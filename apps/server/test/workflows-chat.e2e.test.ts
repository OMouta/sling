/**
 * Workflows the assistant writes in a chat, end to end: real Postgres and
 * pg-boss, the control plane in-process, a scripted mock model that calls
 * the workflow tools, the Discord connector with a fake REST client, and an
 * iCal feed served locally.
 *
 * Needs Docker.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  CommandApprovalView,
  LiveReplyView,
  MessageView,
  PermissionMode,
  ToolStep,
  WorkflowStepView,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { createCalendarConnector } from "@sling/integration-calendar";
import {
  createDiscordConnector,
  type DiscordRest,
  type RestResponse,
} from "@sling/integration-discord";
import type { WorkflowDetailView } from "@sling/workflow";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { instantOf } from "../src/workflows/one-time.ts";
import { SCHEDULE_QUEUE } from "../src/workflows/triggers.ts";

vi.setConfig({ testTimeout: 60_000 });

const ZONE = "Europe/Lisbon";
const CHANNEL = "222222222222222222";
const BOT_ID = "999999999999999999";

// ---------------------------------------------------------------- fakes

const posted: { channelId: string; content: string }[] = [];

const rest: DiscordRest = {
  async request(method, path, body): Promise<RestResponse> {
    if (method === "GET" && path === "/users/@me") {
      return { status: 200, body: { id: BOT_ID, username: "slingbot" } };
    }
    if (method === "GET" && path === "/applications/@me") {
      return { status: 200, body: { id: "app", flags: 1 << 19 } };
    }
    if (method === "GET" && path === "/users/@me/guilds") {
      return { status: 200, body: [{ id: "g1", name: "Home" }] };
    }
    if (method === "GET" && path === "/guilds/g1/channels") {
      return { status: 200, body: [{ id: CHANNEL, name: "general", type: 0, position: 0 }] };
    }
    const m = /^\/channels\/([^/]+)\/messages$/.exec(path);
    if (method === "POST" && m?.[1]) {
      posted.push({ channelId: m[1], content: String((body as { content?: string }).content) });
      return { status: 200, body: { id: `msg-${posted.length}`, channel_id: m[1] } };
    }
    return { status: 404, body: { message: `fake REST has no ${method} ${path}` } };
  },
};

const discord = createDiscordConnector({
  rest: () => rest,
  gateway: () => ({
    login: async () => ({ botUserId: BOT_ID, username: "slingbot" }),
    destroy: async () => {},
  }),
});

/** An event tomorrow, so a week's calendar from today has it. */
function feed(): string {
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    "UID:standup",
    `DTSTART:${day}T100000Z`,
    `DTEND:${day}T103000Z`,
    "SUMMARY:Team standup",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// ---------------------------------------------------------------- mock model

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function respond(parts: LanguageModelV4StreamPart[], reason: "stop" | "tool-calls") {
  return {
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      ...parts,
      { type: "finish", finishReason: { unified: reason, raw: undefined }, usage },
    ]),
  };
}

/** The tool calls the assistant makes, in order, one per step of its turn. */
const plan: { tool: string; input: Record<string, unknown> }[] = [];
/** What the model was handed back after each tool call. */
const heard: string[] = [];

const model = new MockLanguageModelV4({
  doStream: async (options) => {
    const last = options.prompt.at(-1);
    if (last?.role === "tool") heard.push(JSON.stringify(last.content));
    const next = plan.shift();
    if (!next) {
      return respond(
        [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Done." },
          { type: "text-end", id: "t" },
        ],
        "stop",
      );
    }
    return respond(
      [
        {
          type: "tool-call",
          toolCallId: `call_${newId("c")}`,
          toolName: next.tool,
          input: JSON.stringify(next.input),
        },
      ],
      "tool-calls",
    );
  },
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let ics: Server;
let cookie = "";
let origin = "";
const ids = { discord: "", calendar: "" };

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(server.url + path, {
    method,
    headers: {
      origin,
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const t = await res.text();
  return { status: res.status, body: (t ? JSON.parse(t) : null) as unknown };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(method, path, body);
  if (res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
) {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

interface Detail {
  messages: MessageView[];
  live: LiveReplyView | null;
}

const detail = (id: string) => api<Detail>("GET", `/api/conversations/${id}`);

async function conversation(mode: PermissionMode) {
  const conv = await api<{ id: string }>("POST", "/api/conversations");
  await api("PATCH", `/api/conversations/${conv.id}`, { mode });
  return conv.id;
}

/** Sends a message whose turn makes these tool calls. Returns how many messages came before. */
async function send(id: string, ...calls: { tool: string; input: Record<string, unknown> }[]) {
  plan.push(...calls);
  const before = (await detail(id)).messages.length;
  await api("POST", `/api/conversations/${id}/messages`, { text: "Please." });
  return before;
}

/** The reply's tool steps, once the reply is saved. */
async function reply(id: string, before: number): Promise<ToolStep[]> {
  const m = await until("the reply", async () => {
    const d = await detail(id);
    return d.messages.slice(before).find((x) => x.role === "assistant");
  });
  return (m.trace?.steps ?? []).filter((s): s is ToolStep => s.kind === "tool");
}

/** The change card waiting in the live reply. */
async function card(id: string): Promise<{ step: ToolStep; approval: CommandApprovalView }> {
  const step = await until("the change card", async () => {
    const live = (await detail(id)).live;
    return live?.steps.find(
      (s): s is ToolStep => s.kind === "tool" && s.approval?.state === "pending",
    );
  });
  if (step.approval?.kind !== "change") throw new Error("not a change");
  return { step, approval: step.approval };
}

const apply = (id: string, approvalId: string) =>
  api("POST", `/api/conversations/${id}/commands/${approvalId}`, { decision: "approve" });

const result = (step: ToolStep | undefined) =>
  JSON.parse(step?.output ?? "null") as Record<string, unknown>;

/** How a run ended. */
async function settled(runId: string): Promise<string> {
  return until(`run ${runId}`, async () => {
    const r = await api<{ run: { status: string } }>("GET", `/api/runs/${runId}`);
    return ["succeeded", "failed", "cancelled"].includes(r.run.status) && r.run.status;
  });
}

const lines = (steps: WorkflowStepView[] | undefined) =>
  (steps ?? []).map((s) => (s.sends ? `${s.text} [sends]` : s.text));

async function workflowNamed(name: string) {
  const [wf] = await server.ctx.db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.name, name));
  return wf;
}

/** Every Monday at 9, this week's calendar to Discord, and a Run button to try it. */
const weekly = (cron = "0 9 * * 1") => ({
  nodes: [
    { id: "monday", type: "core.schedule", label: "Every Monday", config: { cron } },
    { id: "try", type: "core.manual", config: {} },
    {
      id: "week",
      type: "calendar.list_events",
      config: { installationId: "Personal", from: "today", days: 7 },
    },
    { id: "post", type: "discord.send_message", config: { installationId: "Sling bot" } },
  ],
  edges: [
    { from: "monday.next", to: "week.in" },
    { from: "try", to: "week" },
    { from: "week.next", to: "post.in" },
    { from: "week.agenda", to: "post.content" },
  ],
});

/** A local time in the workspace's zone, a few seconds from now. */
function soon(seconds: number): string {
  const f = new Intl.DateTimeFormat("sv-SE", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return f.format(new Date(Date.now() + seconds * 1000)).replace(" ", "T");
}

beforeAll(async () => {
  ics = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/calendar" }).end(feed());
  });
  await new Promise<void>((ok) => ics.listen(0, "127.0.0.1", ok));
  const feedUrl = `http://127.0.0.1:${(ics.address() as AddressInfo).port}/private.ics`;

  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "workflows-chat-e2e-secret-key-long-enough-1",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
  };
  server = await startServer(config, {
    model,
    jobs: false,
    connectors: [discord, createCalendarConnector()],
  });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  await api("PUT", "/api/settings/time-zone", { timeZone: ZONE });
  ids.discord = (
    await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "discord",
      name: "Sling bot",
      credentials: { botToken: "fake-token" },
      config: { defaultChannelId: CHANNEL },
    })
  ).id;
  ids.calendar = (
    await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "calendar",
      name: "Personal",
      credentials: { feedUrls: [feedUrl] },
      config: { kind: "ics", feedNames: ["Personal"] },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
  await new Promise<void>((ok) => (ics ? ics.close(() => ok()) : ok()));
});

// ---------------------------------------------------------------- tests

describe("the node catalog", () => {
  it("lists every node in short, and the ones asked for in full with the accounts that fit", async () => {
    const id = await conversation("read-only");
    const [all] = await reply(id, await send(id, { tool: "workflow_nodes", input: {} }));
    const list = result(all) as { nodes: { type: string; sends?: boolean; trigger?: boolean }[] };
    expect(list.nodes.find((n) => n.type === "core.schedule")).toMatchObject({ trigger: true });
    expect(list.nodes.find((n) => n.type === "discord.send_message")).toMatchObject({
      sends: true,
    });

    const [some] = await reply(
      id,
      await send(id, {
        tool: "workflow_nodes",
        input: { types: ["discord.send_message", "nope"] },
      }),
    );
    expect(result(some)).toMatchObject({
      nodes: [
        {
          type: "discord.send_message",
          version: 1,
          accountSettings: ["installationId"],
          accounts: ["Sling bot"],
          settings: { properties: { channelId: {}, content: {} } },
        },
      ],
      unknown: ["nope"],
    });
  });
});

describe("a workflow from chat", () => {
  let workflowId = "";

  it("shows its steps on a card, and after Apply it exists, is on, and a manual run sends", async () => {
    const id = await conversation("supervised");
    const before = await send(id, {
      tool: "create_workflow",
      input: {
        name: "Weekly calendar",
        description: "This week's calendar in Discord on Mondays.",
        definition: weekly(),
      },
    });
    const { approval } = await card(id);
    expect(approval.change).toMatchObject({
      title: "Create workflow Weekly calendar?",
      rows: [
        { label: "Name", after: "Weekly calendar" },
        { label: "Description", after: "This week's calendar in Discord on Mondays." },
        { label: "Calendar", after: "Personal" },
        { label: "Discord", after: "Sling bot" },
        { label: "On", after: "On" },
      ],
      workflow: { workflowId: null },
    });
    expect(lines(approval.change?.workflow?.steps)).toEqual([
      "Every Monday at 09:00",
      "Or when you run it",
      "Read the next 7 days of the calendar",
      "Send to Discord #general [sends]",
    ]);
    // Nothing exists until Apply.
    expect(await workflowNamed("Weekly calendar")).toBeUndefined();

    await apply(id, approval.id);
    const [step] = await reply(id, before);
    const made = result(step) as { workflow: { id: string; enabled: boolean }; version: number };
    expect(made).toMatchObject({ applied: true, version: 1, workflow: { enabled: true } });
    workflowId = made.workflow.id;
    // The saved card links to it.
    expect(step?.approval?.change?.workflow?.workflowId).toBe(workflowId);

    const wf = await api<WorkflowDetailView>("GET", `/api/workflows/${workflowId}`);
    expect(wf).toMatchObject({ enabled: true, activeVersion: 1, hasUnpublishedChanges: false });
    expect(await api("POST", `/api/workflows/${workflowId}/validate`)).toEqual({ issues: [] });
    // Accounts are stored by ID, and the nodes are laid out for the editor.
    const post = wf.active?.nodes.find((n) => n.id === "post");
    expect(post?.config.installationId).toBe(ids.discord);
    expect(new Set(wf.active?.nodes.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(4);
    const [trigger] = await server.ctx.db
      .select()
      .from(schema.workflowTriggers)
      .where(eq(schema.workflowTriggers.nodeId, "monday"));
    expect((await server.ctx.boss?.getSchedule(SCHEDULE_QUEUE, trigger?.id ?? ""))?.cron).toBe(
      "0 9 * * 1",
    );

    const run = await api<{ id: string }>("POST", `/api/workflows/${workflowId}/run`, {});
    expect(await settled(run.id)).toBe("succeeded");
    expect(posted.at(-1)).toMatchObject({ channelId: CHANNEL });
    expect(posted.at(-1)?.content).toContain("Team standup");
  });

  it("refuses an invalid graph with the validator's errors, and takes the fixed one", async () => {
    const id = await conversation("auto");
    const broken = weekly();
    broken.nodes[3] = { ...broken.nodes[3], config: { installationId: "Work bot" } } as never;
    broken.edges[3] = { from: "week.agenda", to: "post.text" };
    const before = await send(
      id,
      { tool: "create_workflow", input: { name: "Fixed later", definition: broken } },
      { tool: "create_workflow", input: { name: "Fixed later", definition: weekly() } },
    );
    const { approval } = await card(id);
    // The first call was refused with what's wrong, before any card.
    expect(JSON.parse(heard.at(-1) ?? "")).toEqual([
      expect.objectContaining({
        output: {
          type: "json",
          value: {
            error:
              "The workflow isn't valid, so nothing was shown to the user. Fix these and call create_workflow again.",
            issues: [
              "post: installationId: No discord account called Work bot. discord accounts: Sling bot.",
            ],
          },
        },
      }),
    ]);
    await apply(id, approval.id);
    const steps = await reply(id, before);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.approval).toBeUndefined();
    expect(result(steps[1])).toMatchObject({ applied: true });

    // A wrong port is the validator's to find.
    const again = await send(id, {
      tool: "create_workflow",
      input: {
        name: "Wrong port",
        definition: {
          ...weekly(),
          edges: [...weekly().edges.slice(0, 3), { from: "week.agenda", to: "post.text" }],
        },
      },
    });
    const [refused] = await reply(id, again);
    expect(result(refused)).toMatchObject({
      issues: ["post has no data input called text"],
    });
    expect(await workflowNamed("Wrong port")).toBeUndefined();
  });

  it("changes the same workflow to Tuesdays with a new graph", async () => {
    const id = await conversation("auto");
    const before = await send(id, {
      tool: "change_workflow",
      input: { workflow: "Weekly calendar", definition: weekly("0 9 * * 2") },
    });
    const { approval } = await card(id);
    expect(approval.change).toMatchObject({
      title: "Change workflow Weekly calendar?",
      rows: [{ label: "Step", before: "Every Monday at 09:00", after: "Every Tuesday at 09:00" }],
    });
    expect(lines(approval.change?.workflow?.steps)[0]).toBe("Every Tuesday at 09:00");
    await apply(id, approval.id);
    const [step] = await reply(id, before);
    expect(result(step)).toMatchObject({ applied: true, version: 2, workflow: { id: workflowId } });
    expect(step?.approval?.change?.workflow?.workflowId).toBe(workflowId);
    const wf = await api<WorkflowDetailView>("GET", `/api/workflows/${workflowId}`);
    expect(wf.active?.nodes.find((n) => n.id === "monday")?.config.cron).toBe("0 9 * * 2");
    expect(
      (await server.ctx.db.select().from(schema.workflows)).filter(
        (w) => w.name === "Weekly calendar",
      ),
    ).toHaveLength(1);
  });

  it("refuses in Read-only, and applies at once in Full access with the card shown", async () => {
    const ro = await conversation("read-only");
    const [refused] = await reply(
      ro,
      await send(ro, { tool: "create_workflow", input: { name: "Nope", definition: weekly() } }),
    );
    expect(result(refused).error).toContain("Read-only");
    expect(await workflowNamed("Nope")).toBeUndefined();

    const full = await conversation("full-access");
    const [step] = await reply(
      full,
      await send(full, {
        tool: "create_workflow",
        input: { name: "At once", definition: weekly() },
      }),
    );
    const wf = await workflowNamed("At once");
    expect(result(step)).toMatchObject({ applied: true, workflow: { id: wf?.id } });
    expect(step?.approval).toMatchObject({
      kind: "change",
      state: "approved",
      change: { workflow: { workflowId: wf?.id } },
    });

    // A second workflow with the same name is refused.
    const [dupe] = await reply(
      full,
      await send(full, {
        tool: "create_workflow",
        input: { name: "at once", definition: weekly() },
      }),
    );
    expect(result(dupe).error).toContain("There's already a workflow called at once");
  });
});

describe("a one-time schedule", () => {
  it("runs once at its local time, then turns itself off", async () => {
    const id = await conversation("full-access");
    const at = soon(4);
    const [step] = await reply(
      id,
      await send(id, {
        tool: "create_workflow",
        input: {
          name: "Call the bank",
          definition: {
            nodes: [
              { id: "at", type: "core.schedule", config: { at } },
              { id: "push", type: "app.notify", config: { title: "Call the bank" } },
            ],
            edges: [{ from: "at", to: "push" }],
          },
        },
      }),
    );
    expect(result(step)).toMatchObject({ applied: true, workflow: { enabled: true } });
    expect(lines(step?.approval?.change?.workflow?.steps)[0]).toMatch(/^Once, on \w+ \d+ \w+ at /);
    const wf = await workflowNamed("Call the bank");
    if (!wf) throw new Error("no workflow");

    const runs = () =>
      server.ctx.db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.workflowId, wf.id));
    const [run] = await until("the run", async () => {
      const list = await runs();
      return list.length > 0 && list;
    });
    // Not before its time.
    expect(run?.createdAt.getTime()).toBeGreaterThanOrEqual(instantOf(at, ZONE)?.getTime() ?? 0);
    expect(await settled(run?.id ?? "")).toBe("succeeded");
    await until("the workflow off", async () => !(await workflowNamed("Call the bank"))?.enabled);
    expect(
      await server.ctx.db
        .select()
        .from(schema.workflowTriggers)
        .where(eq(schema.workflowTriggers.workflowId, wf.id)),
    ).toEqual([]);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await runs()).toHaveLength(1);

    // Its time has passed, so it can't be turned on again as it is.
    const on = await call("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
    expect(on.status).toBe(409);
    expect((on.body as { error: string }).error).toMatch(
      /^It was set to run once, .* which has passed\./,
    );
  });

  it("is refused when its time has passed", async () => {
    const id = await conversation("full-access");
    const [step] = await reply(
      id,
      await send(id, {
        tool: "create_workflow",
        input: {
          name: "Too late",
          definition: {
            nodes: [
              { id: "when", type: "core.schedule", config: { at: "2026-01-01T09:00" } },
              { id: "push", type: "app.notify", config: { title: "Too late" } },
            ],
            edges: [{ from: "when", to: "push" }],
          },
        },
      }),
    );
    expect(result(step).issues).toEqual([
      "when: at: Thursday 1 January at 09:00 in Europe/Lisbon has already passed",
    ]);
    expect(await workflowNamed("Too late")).toBeUndefined();
  });
});
