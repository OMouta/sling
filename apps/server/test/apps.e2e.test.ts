/**
 * The assistant using your apps, end to end: real Postgres, the control plane
 * in-process, GreenMail for email, Radicale for the calendar, the Discord
 * connector with a fake gateway and REST client, and the ntfy extension
 * publishing to a local endpoint. A scripted mock model calls the tools. The
 * CLI part runs a real sling-runner with fake-codex's `call` scenario, which
 * calls a tool through `sling-runner mcp`.
 *
 * Needs Docker, and the Runner built first: cargo build -p sling-runner -p sling-harness-codex
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { defineConnector, type NodeSpec } from "@sling/connector-sdk";
import type {
  ExtensionPreview,
  LiveReplyView,
  MessageView,
  PermissionMode,
  RunnerView,
  ToolStep,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { buildProject, loadProject, packProject, writeCatalog } from "@sling/extension-cli";
import { createCalendarConnector } from "@sling/integration-calendar";
import {
  createDiscordConnector,
  type DiscordRest,
  type RestResponse,
} from "@sling/integration-discord";
import { createEmailConnector } from "@sling/integration-email";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appTools, readableDate } from "../src/agent/app-tools.ts";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { fireSchedule, SCHEDULE_QUEUE } from "../src/workflows/triggers.ts";
import { withinBudget } from "./fixtures/budget.ts";
import { testRuntime } from "./fixtures/in-process-runtime.ts";

vi.setConfig({ testTimeout: 90_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");
const FAKE_CODEX = join(ROOT, "target/debug/fake-codex");
const ZONE = "Europe/Lisbon";
const CHANNEL = "222222222222222222";
const BOT_ID = "999999999999999999";
const OWNER_DISCORD_ID = "111111111111111111";

// ---------------------------------------------------------------- fakes

/** Messages the bot posted, through the fake REST client. */
const posted: { channelId: string; content: string }[] = [];

const rest: DiscordRest = {
  async request(method, path, body): Promise<RestResponse> {
    if (method === "GET" && path === "/users/@me") {
      return { status: 200, body: { id: BOT_ID, username: "slingbot" } };
    }
    if (method === "GET" && path === "/applications/@me") {
      return { status: 200, body: { id: "app", flags: 1 << 19 } };
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

/** Time spent inside the bench nodes' own run, to tell it from the tool layer's. */
const nodeMs: number[] = [];

function benchNode(
  type: string,
  sends: boolean,
): NodeSpec<{ installationId: string; text: string }> {
  return {
    type,
    version: 1,
    title: `Bench ${type}`,
    description: "Echoes its text.",
    category: "action",
    connector: "bench",
    configSchema: z.object({ installationId: z.string().min(1), text: z.string().default("") }),
    installationFields: ["installationId"],
    inputs: [],
    outputs: [{ name: "echo", type: "string" }],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: !sends,
    assistant: { sends, summary: "Echo {text}" },
    async run(ctx, { config }) {
      const t0 = performance.now();
      const inst = await ctx.installation(config.installationId);
      const out = { echo: `${config.text} with ${inst.credentials.token}` };
      nodeMs.push(performance.now() - t0);
      return { exec: "next", outputs: out };
    },
  };
}

const bench = defineConnector({
  id: "bench",
  name: "Bench",
  description: "A connector for measuring the tool layer.",
  credentialsSchema: z.object({ token: z.string().default("") }),
  secretFields: ["token"],
  configSchema: z.object({}),
  test: async () => ({ ok: true }),
  nodes: [benchNode("bench.read", false), benchNode("bench.post", true)],
});

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

const text = (t: string) =>
  respond(
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: t },
      { type: "text-end", id: "t" },
    ],
    "stop",
  );

function textOf(m: LanguageModelV4CallOptions["prompt"][number] | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
}

/** The tool call the assistant makes for the next user message. */
const plan: { tool: string; input: Record<string, unknown> }[] = [];
/** What each model call offered and was told. */
const calls: { tools: string[]; system: string; user: string }[] = [];

const BRIEFING = "Standup at 09:30 needs you first.\nNothing else is on today.";

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const user = textOf(options.prompt.findLast((m) => m.role === "user"));
    calls.push({
      tools: (options.tools ?? []).map((t) => t.name),
      system: textOf(options.prompt.find((m) => m.role === "system")),
      user,
    });
    if (options.prompt.at(-1)?.role === "tool") return text("Done.");
    if (user.includes("morning briefing")) return text(BRIEFING);
    const next = plan.shift();
    if (!next) return text("Nothing to do.");
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
let mail: StartedTestContainer;
let radicale: StartedTestContainer;
let server: RunningServer;
let ntfy: Server;
let work = "";
let cookie = "";
let origin = "";
let mailHost = "";
let imapPort = 0;
let davBase = "";
let runner: ChildProcess | null = null;
const ids = { email: "", discord: "", calendar: "", bench: "" };
/** What the local ntfy endpoint was asked to publish. */
const published: Record<string, unknown>[] = [];

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 30_000,
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

/** Sends a message that makes the assistant call `tool`, and resolves with that call's step. */
async function ask(id: string, tool: string, input: Record<string, unknown>): Promise<ToolStep> {
  plan.push({ tool, input });
  const before = (await detail(id)).messages.length;
  await api("POST", `/api/conversations/${id}/messages`, { text: `Please use ${tool}.` });
  const reply = await until("the reply", async () => {
    const d = await detail(id);
    return d.messages.slice(before).find((m) => m.role === "assistant");
  });
  const step = reply.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
  if (!step) throw new Error(`no tool step in: ${reply.text}`);
  return step;
}

/** Waits for the live reply's send to ask, checks what it shows, and answers it. */
async function answer(id: string, decision: "approve" | "deny", summary: string) {
  const step = await until("the approval", async () => {
    const live = (await detail(id)).live;
    return live?.steps.find(
      (s): s is ToolStep => s.kind === "tool" && s.approval?.state === "pending",
    );
  });
  expect(step.approval).toMatchObject({ kind: "send", machine: "", summary });
  await api("POST", `/api/conversations/${id}/commands/${step.approval?.id}`, { decision });
}

const result = (step: ToolStep) =>
  JSON.parse(step.output ?? "null") as {
    error?: string;
    installation?: string;
    output?: Record<string, unknown>;
    status?: string;
  };

async function inbox(): Promise<string[]> {
  const client = new ImapFlow({
    host: mailHost,
    port: imapPort,
    secure: false,
    auth: { user: "inbox@example.com", pass: "secret" },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  const subjects: string[] = [];
  try {
    const box = client.mailbox;
    if (box && box.exists > 0) {
      for await (const m of client.fetch("1:*", { envelope: true })) {
        subjects.push(m.envelope?.subject ?? "");
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return subjects;
}

async function auditRows() {
  const rows = await server.ctx.db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.verb, "assistant.action"));
  return rows.map((r) => r.details as Record<string, unknown>);
}

const lisbonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());

const RADICALE_CONFIG = `[server]
hosts = 0.0.0.0:5232
[auth]
type = htpasswd
htpasswd_filename = /config/users
htpasswd_encryption = plain
[rights]
type = owner_only
[storage]
filesystem_folder = /data/collections
`;

async function dav(method: string, path: string, body = "", contentType = "application/xml") {
  const res = await fetch(`${davBase}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from("ana:app-pass").toString("base64")}`,
      "content-type": contentType,
      depth: "1",
    },
    body: body || undefined,
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  if (!existsSync(RUNNER) || !existsSync(FAKE_CODEX)) {
    throw new Error(`build the Runner and fake-codex first: ${RUNNER}`);
  }
  work = mkdtempSync(join(tmpdir(), "sling-apps-"));

  // The ntfy extension, packed into a catalog of our own. It's given
  // localNetwork, since its server here is a plain-HTTP one on loopback, which
  // the real network broker refuses otherwise.
  const included = join(work, "included");
  const variant = join(work, "ntfy");
  cpSync(join(ROOT, "extensions", "ntfy"), variant, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  const manifestPath = join(variant, "sling-extension.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.permissions.network.localNetwork = true;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const project = await loadProject(variant);
  await buildProject(project);
  await packProject(project, { outDir: included });
  await writeCatalog(included, { name: "Included with Sling" });

  ntfy = createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"healthy":true}');
      return;
    }
    if (req.method === "POST" && req.url === "/") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const msg = JSON.parse(body) as Record<string, unknown>;
      published.push(msg);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "m1", time: 1, event: "message", topic: msg.topic }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => ntfy.listen(0, "127.0.0.1", ok));

  [pg, mail, radicale] = await Promise.all([
    new PostgreSqlContainer("postgres:18-alpine").start(),
    new GenericContainer("greenmail/standalone:2.1.15")
      .withEnvironment({
        GREENMAIL_OPTS: [
          "-Dgreenmail.setup.test.smtp",
          "-Dgreenmail.setup.test.imap",
          "-Dgreenmail.hostname=0.0.0.0",
          "-Dgreenmail.users.login=email",
          "-Dgreenmail.users=inbox:secret@example.com",
        ].join(" "),
      })
      .withExposedPorts(3025, 3143)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
    new GenericContainer("tomsquest/docker-radicale:3.8.3.0")
      .withCopyContentToContainer([
        { content: RADICALE_CONFIG, target: "/config/config" },
        { content: "ana:app-pass\n", target: "/config/users" },
      ])
      .withExposedPorts(5232)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  mailHost = mail.getHost();
  imapPort = mail.getMappedPort(3143);
  davBase = `http://${radicale.getHost()}:${radicale.getMappedPort(5232)}`;
  await until("Radicale", async () => (await dav("PROPFIND", "/")).status === 207);
  const made = await dav(
    "MKCALENDAR",
    "/ana/home/",
    '<?xml version="1.0" encoding="utf-8"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Home</D:displayname></D:prop></D:set></C:mkcalendar>',
  );
  expect(made.status).toBe(201);
  const standup = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sling tests//EN",
    "BEGIN:VEVENT",
    "UID:standup",
    "DTSTAMP:20250101T000000Z",
    "DTSTART;TZID=Europe/Lisbon:20250106T093000",
    "DTEND;TZID=Europe/Lisbon:20250106T094500",
    "RRULE:FREQ=DAILY",
    "SUMMARY:Standup",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  expect((await dav("PUT", "/ana/home/standup.ics", standup, "text/calendar")).status).toBe(201);

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "apps-e2e-secret-key-that-is-long-enough-1",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
    allowUnsignedExtensions: true,
    includedExtensionsDir: included,
    extensionCacheDir: join(work, "cache"),
  };
  server = await startServer(config, {
    model,
    jobs: false,
    connectors: [discord, createEmailConnector(), createCalendarConnector(), bench],
    extensionRuntime: testRuntime(),
  });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  await api("PUT", "/api/settings/time-zone", { timeZone: ZONE });

  const smtpPort = mail.getMappedPort(3025);
  ids.email = (
    await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "email",
      name: "Inbox",
      credentials: {
        imapHost: mailHost,
        imapPort,
        imapSecure: false,
        smtpHost: mailHost,
        smtpPort,
        smtpSecure: false,
        username: "inbox@example.com",
        password: "secret",
        fromAddress: "inbox@example.com",
      },
      config: { folders: ["INBOX"] },
    })
  ).id;
  ids.discord = (
    await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "discord",
      name: "Sling bot",
      credentials: { botToken: "fake-token" },
      config: {
        allowedUserIds: [OWNER_DISCORD_ID],
        approverUserIds: [OWNER_DISCORD_ID],
        defaultChannelId: CHANNEL,
      },
    })
  ).id;
  ids.calendar = (
    await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "calendar",
      name: "Radicale",
      credentials: { password: "app-pass" },
      config: {
        kind: "caldav",
        serverUrl: `${davBase}/`,
        username: "ana",
        defaultCalendar: "Home",
      },
    })
  ).id;
  ids.bench = (
    await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "bench",
      name: "Bench",
      credentials: { token: "bench-secret-token" },
      config: {},
    })
  ).id;

  // A real Runner whose Codex is fake-codex, for turns on a CLI.
  const env = { ...process.env, SLING_RUNNER_HOME: join(work, "runner"), SLING_RUNNER_LOG: "warn" };
  const cli = (...args: string[]) => promisify(execFile)(RUNNER, args, { env });
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await cli("config", "set", "codex-bin", FAKE_CODEX);
  await cli("config", "set", "claude-bin", join(work, "no-claude-here"));
  // Look for repos only here, not in the whole home directory.
  await cli("config", "set", "scan-roots", work);
  await cli("config", "set", "max-mode", "full-access");
  await cli("pair", server.url, code, "--name", "laptop");
  runner = spawn(RUNNER, ["run"], { env, stdio: "ignore" });
  await until("the machine with Codex", async () => {
    const list = await api<RunnerView[]>("GET", "/api/runners");
    return list.find(
      (r) => r.online && r.capabilities.some((c) => c.name === "coding.codex" && c.ready),
    );
  });
}, 240_000);

afterAll(async () => {
  runner?.kill("SIGTERM");
  await server?.close();
  await new Promise<void>((ok) => (ntfy ? ntfy.close(() => ok()) : ok()));
  await Promise.all([pg?.stop(), mail?.stop(), radicale?.stop()]);
  if (work) rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

describe("reading", () => {
  it("offers a tool per connector action, and reads the calendar without asking in every mode", async () => {
    for (const mode of ["read-only", "supervised", "auto", "full-access"] as const) {
      const id = await conversation(mode);
      const step = await ask(id, "calendar_list_events", { from: "today" });
      expect(step.approval).toBeUndefined();
      const out = result(step);
      expect(out.installation).toBe("Radicale");
      expect(out.output?.date).toBe(lisbonToday());
      expect(out.output?.agenda).toContain("09:30–09:45: Standup (Home)");
    }
    const offered = calls.find((c) => c.tools.includes("calendar_list_events"));
    expect(offered?.tools).toEqual(
      expect.arrayContaining([
        "calendar_list_events",
        "calendar_create_event",
        "email_send",
        "discord_send_message",
        "bench_read",
      ]),
    );
    expect(offered?.system).toContain("The user's calendar, apps, and workflows:");
    expect(offered?.system).toMatch(/It's \w+day, \d+ \w+ \d{4}, \d\d:\d\d in Europe\/Lisbon\./);
    const reads = (await auditRows()).filter((r) => r.tool === "calendar_list_events");
    expect(reads).toHaveLength(4);
    expect(reads[0]).toMatchObject({
      nodeType: "calendar.list_events",
      installationId: ids.calendar,
      installation: "Radicale",
      summary: "Read calendar from today",
      decision: "not_needed",
      ok: true,
    });
  });
});

describe("sending", () => {
  it("asks before an email in Supervised and Auto, and sends it once approved", async () => {
    for (const mode of ["supervised", "auto"] as const) {
      const id = await conversation(mode);
      const subject = `Lunch moved (${mode})`;
      const pending = ask(id, "email_send", {
        to: "inbox@example.com",
        subject,
        text: "To 13:00.",
      });
      await answer(id, "approve", `Email inbox@example.com: ${subject}`);
      const step = await pending;
      expect(step.approval?.state).toBe("approved");
      expect(result(step).output?.messageId).toMatch(/\.sling@example\.com>$/);
      await until("the email in the inbox", async () => (await inbox()).includes(subject));
    }
  });

  it("sends nothing when the user declines", async () => {
    const id = await conversation("auto");
    const before = posted.length;
    const pending = ask(id, "discord_send_message", { content: "Deploying now" });
    await answer(id, "deny", "Discord message: Deploying now");
    const step = await pending;
    expect(step.approval?.state).toBe("denied");
    expect(result(step).error).toContain("Don't try another way");
    expect(posted.length).toBe(before);
  });

  it("sends nothing when the approval expires", async () => {
    server.ctx.commands.approvalWaitMs = 400;
    try {
      const id = await conversation("supervised");
      const before = posted.length;
      const step = await ask(id, "discord_send_message", { content: "Anyone there?" });
      expect(step.approval).toMatchObject({ kind: "send", state: "expired" });
      expect(result(step).error).toContain("didn't answer in time");
      expect(posted.length).toBe(before);
    } finally {
      server.ctx.commands.approvalWaitMs = 5 * 60_000;
    }
  });

  it("sends at once in Full access", async () => {
    const id = await conversation("full-access");
    const step = await ask(id, "discord_send_message", { content: "Build is green" });
    expect(step.approval).toBeUndefined();
    expect(posted.at(-1)).toEqual({ channelId: CHANNEL, content: "Build is green" });
    const email = await ask(id, "email_send", {
      to: "inbox@example.com",
      subject: "Straight out",
      text: "No approval needed.",
    });
    expect(email.approval).toBeUndefined();
    await until("the email in the inbox", async () => (await inbox()).includes("Straight out"));
  });

  it("refuses sends in Read-only", async () => {
    const id = await conversation("read-only");
    const before = posted.length;
    const step = await ask(id, "discord_send_message", { content: "Not allowed" });
    expect(step.approval).toBeUndefined();
    expect(result(step).error).toContain("Read-only");
    const email = await ask(id, "email_send", { to: "inbox@example.com", subject: "Never sent" });
    expect(result(email).error).toContain("Read-only");
    expect(posted.length).toBe(before);
    expect(await inbox()).not.toContain("Never sent");
  });

  it("adds a calendar event after approval, once", async () => {
    const id = await conversation("auto");
    const tomorrow = new Date(Date.now() + 86_400_000);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(tomorrow);
    const pending = ask(id, "calendar_create_event", {
      title: "Dentist",
      start: `${day}T15:00`,
      durationMinutes: 45,
    });
    await answer(id, "approve", `Add "Dentist" to your calendar, ${readableDate(`${day}T15:00`)}`);
    const step = await pending;
    expect(result(step).output).toMatchObject({
      created: true,
      event: { title: "Dentist", calendar: "Home" },
    });
    const listed = await ask(id, "calendar_list_events", { from: "tomorrow" });
    const events = result(listed).output?.events as { title: string }[];
    expect(events.filter((e) => e.title === "Dentist")).toHaveLength(1);
  });
});

describe("a reply check", () => {
  it("is met by a real reply in the mailbox, found through the email search", async () => {
    const check = await api<{ id: string; state: string }>("POST", "/api/checks", {
      name: "Jo answered",
      config: { kind: "reply", from: "jo@silva.pt", inReplyTo: "<quote-1@sling>" },
      installationId: ids.email,
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    });
    const run = () => api<{ state: string }>("POST", `/api/checks/${check.id}/run`);
    expect((await run()).state).toBe("waiting");

    const client = new ImapFlow({
      host: mailHost,
      port: imapPort,
      secure: false,
      auth: { user: "inbox@example.com", pass: "secret" },
      logger: false,
    });
    await client.connect();
    const mail = (subject: string, extra: string[]) =>
      [
        "From: Jo Silva <jo@silva.pt>",
        "To: inbox@example.com",
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${newId("msg")}@silva.pt>`,
        ...extra,
        "",
        "Body.",
      ].join("\r\n");
    try {
      // From Jo, but not in the thread, so it doesn't count.
      await client.append("INBOX", mail("Lunch?", []));
      expect((await run()).state).toBe("waiting");
      await client.append("INBOX", mail("Re: the quote", ["In-Reply-To: <quote-1@sling>"]));
    } finally {
      await client.logout();
    }
    expect((await run()).state).toBe("met");
    const [last] = await api<{ state: string; message: string }[]>(
      "GET",
      `/api/checks/${check.id}/results`,
    );
    expect(last?.message).toContain("Jo Silva <jo@silva.pt>");
    await api("DELETE", `/api/checks/${check.id}`);
  });
});

describe("workflows", () => {
  async function workflow(name: string, nodes: unknown[], edges: unknown[]) {
    const wf = await api<{ id: string }>("POST", "/api/workflows", { name });
    await api("PUT", `/api/workflows/${wf.id}/draft`, {
      schema: "sling.workflow/v1",
      name,
      description: `${name}, for the tests.`,
      nodes,
      edges,
    });
    expect(await api("POST", `/api/workflows/${wf.id}/publish`, { note: "" })).toMatchObject({
      ok: true,
    });
    await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
    return wf.id;
  }
  const node = (id: string, type: string, config: Record<string, unknown>, x = 0) => ({
    id,
    type,
    version: 1,
    position: { x, y: 0 },
    config,
  });
  const exec = (from: string, to: string) => ({
    id: `${from}-${to}`,
    kind: "exec",
    from: { node: from, port: "next" },
    to: { node: to, port: "in" },
  });

  it("runs a workflow with a manual trigger and returns its result, without asking when it sends nothing", async () => {
    const wfId = await workflow(
      "Greeter",
      [
        node("go", "core.manual", {}),
        node("done", "core.return", { value: '={{ "Hello " & trigger.input.name }}' }, 300),
      ],
      [exec("go", "done")],
    );
    const id = await conversation("supervised");
    const step = await ask(id, "run_workflow", { workflow: "Greeter", input: { name: "Ana" } });
    expect(step.approval).toBeUndefined();
    expect(result(step)).toEqual({ status: "succeeded", output: "Hello Ana" });
    expect((await auditRows()).find((r) => r.tool === "run_workflow")).toMatchObject({
      workflowId: wfId,
      workflow: "Greeter",
      summary: "Run the Greeter workflow",
      decision: "not_needed",
      ok: true,
      status: "succeeded",
    });
  });

  it("asks before a workflow that sends, and refuses it in Read-only", async () => {
    await workflow(
      "Mail me",
      [
        node("go", "core.manual", {}),
        node(
          "mail",
          "email.send",
          { installationId: ids.email, to: "inbox@example.com", subject: "From a workflow" },
          300,
        ),
        node("done", "core.return", { value: "sent" }, 600),
      ],
      [exec("go", "mail"), exec("mail", "done")],
    );
    const id = await conversation("auto");
    const pending = ask(id, "run_workflow", { workflow: "Mail me" });
    await answer(id, "approve", "Run the Mail me workflow");
    expect(result(await pending)).toEqual({ status: "succeeded", output: "sent" });
    await until("the workflow's email", async () => (await inbox()).includes("From a workflow"));

    const ro = await conversation("read-only");
    expect(result(await ask(ro, "run_workflow", { workflow: "Mail me" })).error).toContain(
      "Read-only",
    );
  });
});

describe("an extension's node", () => {
  it("is listed in the install dialog, and works like the built-in ones", async () => {
    const preview = await api<ExtensionPreview>("POST", "/api/extensions/preview", {
      catalogId: "included",
      extensionId: "ntfy",
      version: "1.2.0",
    });
    expect(preview.problems).toEqual([]);
    expect(preview.contents.nodes.find((n) => n.type === "ntfy.publish")?.assistant).toEqual({
      sends: true,
    });
    expect(preview.contents.nodes.find((n) => n.type === "ntfy.message_received")?.assistant).toBe(
      undefined,
    );
    await api("POST", "/api/extensions/install", {
      stagingId: preview.stagingId,
      digest: preview.digest,
      permissions: preview.permissionsKey,
      trustPublisher: false,
    });
    const port = (ntfy.address() as AddressInfo).port;
    await api("POST", "/api/installations", {
      connectorId: "ntfy",
      name: "Phone",
      credentials: {},
      config: { server: `http://127.0.0.1:${port}`, topics: [], defaultTopic: "sling-alerts" },
    });

    const id = await conversation("auto");
    const pending = ask(id, "ntfy_publish", { message: "Backup finished", title: "Backups" });
    await answer(id, "approve", "Push through ntfy: Backup finished");
    const step = await pending;
    expect(result(step).error).toBeUndefined();
    expect(published.at(-1)).toMatchObject({
      topic: "sling-alerts",
      message: "Backup finished",
      title: "Backups",
    });
  });
});

describe("a turn on a coding agent's CLI", () => {
  it("lists the app tools and asks before a send, through sling-runner mcp", async () => {
    const id = await conversation("auto");
    await api("PATCH", `/api/conversations/${id}`, {
      settings: { assistant: { provider: "codex", model: "", effort: null, fast: false } },
    });
    const call = {
      name: "email_send",
      arguments: { to: "inbox@example.com", subject: "From the CLI", text: "Hello from Codex." },
    };
    await api("POST", `/api/conversations/${id}/messages`, {
      text: `[fake:call] ${JSON.stringify(call)}`,
    });
    await answer(id, "approve", "Email inbox@example.com: From the CLI");
    const reply = await until("the CLI's reply", async () =>
      (await detail(id)).messages.find((m) => m.role === "assistant"),
    );
    expect(reply.text).toContain("Tool said:");
    expect(reply.text).toContain("messageId");
    const step = reply.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
    expect(step).toMatchObject({
      name: "email_send",
      approval: { kind: "send", state: "approved" },
    });
    await until("the CLI's email", async () => (await inbox()).includes("From the CLI"));
  });
});

describe("the audit", () => {
  it("records every call with what was decided and whether it worked", async () => {
    const rows = await auditRows();
    const decisions = new Set(rows.map((r) => r.decision));
    for (const d of ["not_needed", "approved", "denied", "expired", "refused", "full_access"]) {
      expect(decisions).toContain(d);
    }
    for (const r of rows) {
      expect(r).toMatchObject({
        tool: expect.any(String),
        conversationId: expect.stringMatching(/^cnv_/),
        summary: expect.any(String),
        ok: expect.any(Boolean),
      });
    }
    expect(rows.find((r) => r.decision === "denied")).toMatchObject({
      nodeType: "discord.send_message",
      installation: "Sling bot",
      summary: "Discord message: Deploying now",
      ok: false,
    });
  });
});

describe("the morning briefing", () => {
  it("runs from its schedule in the workspace's zone, writes the briefing, and notifies", async () => {
    const pushed: { title: string; body: string; url: string }[] = [];
    const push = server.ctx.push;
    const notify = push.notify.bind(push);
    push.notify = async (workspaceId, userId, payload, opts) => {
      pushed.push(payload);
      return notify(workspaceId, userId, payload, opts);
    };

    const wf = await api<{ id: string }>("POST", "/api/workflows", {
      templateKey: "morning-briefing",
      bindings: { $calendar: ids.calendar },
    });
    await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
    const [trigger] = await server.ctx.db
      .select()
      .from(schema.workflowTriggers)
      .where(eq(schema.workflowTriggers.workflowId, wf.id));
    if (!trigger || !server.ctx.boss) throw new Error("no schedule trigger");
    const scheduled = await server.ctx.boss.getSchedule(SCHEDULE_QUEUE, trigger.id);
    expect(scheduled).toMatchObject({ cron: "30 7 * * *", timezone: ZONE });

    const run = await fireSchedule(server.ctx, trigger.id, "briefing-job-1");
    if (!run) throw new Error("the schedule didn't start a run");
    const done = await until("the briefing run", async () => {
      const d = await api<{
        run: { status: string };
        nodeRuns: { nodeId: string; status: string }[];
      }>("GET", `/api/runs/${run.id}`);
      return d.run.status === "succeeded" || d.run.status === "failed" ? d : null;
    });
    expect(done.run.status).toBe("succeeded");
    expect(done.nodeRuns.find((n) => n.nodeId === "notify")?.status).toBe("succeeded");

    const [conv] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.externalKey, `briefing-${lisbonToday()}`));
    expect(conv?.title).toMatch(/^Briefing · \w{3} \d{1,2} \w{3}$/);
    const messages = (await detail(conv?.id ?? "")).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.text).toContain(
      "Write my morning briefing for today. Lead with what needs me first.",
    );
    expect(messages[0]?.text).toContain("09:30–09:45: Standup (Home)");
    expect(messages[1]?.text).toBe(BRIEFING);
    expect(pushed.at(-1)).toEqual({
      title: "Your morning briefing",
      body: "Standup at 09:30 needs you first.",
      url: `/c/${conv?.id}`,
      tag: expect.stringContaining(run.id),
    });

    // A new zone moves the schedule, which follows the workspace's.
    await api("PUT", "/api/settings/time-zone", { timeZone: "America/New_York" });
    expect(await server.ctx.boss.getSchedule(SCHEDULE_QUEUE, trigger.id)).toMatchObject({
      timezone: "America/New_York",
    });
    await api("PUT", "/api/settings/time-zone", { timeZone: ZONE });
    push.notify = notify;
  });
});

describe("measured", () => {
  it("adds little to a connector action: the tool layer's own time per call", async () => {
    const id = await conversation("full-access");
    const [conv] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id));
    if (!conv) throw new Error("no conversation");
    const scope = { workspaceId: conv.workspaceId, ownerId: conv.ownerId, conversationId: id };
    const t0 = performance.now();
    const tools = await appTools(server.ctx, scope);
    const buildMs = performance.now() - t0;
    type Exec = (input: unknown, o: { toolCallId: string; messages: [] }) => Promise<unknown>;
    const measure = async (name: "bench_read" | "bench_post") => {
      const run = tools[name]?.execute as unknown as Exec;
      const overhead: number[] = [];
      for (let i = 0; i < 60; i++) {
        nodeMs.length = 0;
        const s = performance.now();
        const out = (await run(
          { text: `hi ${i}` },
          { toolCallId: `bench_${name}_${i}`, messages: [] },
        )) as {
          output: { echo: string };
        };
        const total = performance.now() - s;
        // The installation's secret never reaches the model.
        expect(out.output.echo).toBe(`hi ${i} with [redacted]`);
        if (i >= 10) overhead.push(total - (nodeMs[0] ?? 0));
      }
      overhead.sort((a, b) => a - b);
      return {
        median: overhead[Math.floor(overhead.length / 2)] ?? 0,
        p95: overhead[Math.floor(overhead.length * 0.95)] ?? 0,
      };
    };
    const read = await measure("bench_read");
    const send = await measure("bench_post");
    console.log(
      `tool layer per connector action: read median ${read.median.toFixed(2)} ms (p95 ${read.p95.toFixed(2)}), send in Full access median ${send.median.toFixed(2)} ms (p95 ${send.p95.toFixed(2)}); building the turn's ${Object.keys(tools).length} app tools ${buildMs.toFixed(1)} ms`,
    );
    withinBudget(read.median, 5);
    withinBudget(send.median, 5);
  });
});
