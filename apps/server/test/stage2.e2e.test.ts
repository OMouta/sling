/**
 * Stage 2 end to end, through the real connectors: the email connector against
 * GreenMail over IMAP and SMTP, and the Discord connector with its gateway and
 * REST client swapped for fakes. A scripted mock model plays the AI nodes and
 * the assistant. Needs Docker.
 */
import { createServer } from "node:net";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  type ButtonClick,
  createDiscordConnector,
  type DiscordRest,
  type GatewayHandlers,
  type RestResponse,
} from "@sling/integration-discord";
import { createEmailConnector } from "@sling/integration-email";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import nodemailer from "nodemailer";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

const OWNER_DISCORD_ID = "111111111111111111";
const STRANGER_DISCORD_ID = "333333333333333333";
const ALERT_CHANNEL = "222222222222222222";
const BOT_ID = "999999999999999999";
const DM_CHANNEL = "444444444444444444";

// ---------------------------------------------------------------- fakes

interface SentMessage {
  channelId: string;
  body: { content?: string; components?: unknown[]; nonce?: string };
}

const sent: SentMessage[] = [];
const gateways: GatewayHandlers[] = [];

const rest: DiscordRest = {
  async request(method, path, body): Promise<RestResponse> {
    if (method === "GET" && path === "/users/@me") {
      return { status: 200, body: { id: BOT_ID, username: "slingbot" } };
    }
    if (method === "GET" && path === "/applications/@me") {
      return { status: 200, body: { id: "app", flags: 1 << 19 } };
    }
    if (method === "POST" && path === "/users/@me/channels") {
      const recipient = (body as { recipient_id: string }).recipient_id;
      return { status: 200, body: { id: `dm-${recipient}` } };
    }
    const m = /^\/channels\/([^/]+)\/messages$/.exec(path);
    if (method === "POST" && m?.[1]) {
      sent.push({ channelId: m[1], body: body as SentMessage["body"] });
      return { status: 200, body: { id: `msg-${sent.length}`, channel_id: m[1] } };
    }
    return { status: 404, body: { message: `fake REST has no ${method} ${path}` } };
  },
};

const discord = createDiscordConnector({
  rest: () => rest,
  gateway: (handlers) => {
    gateways.push(handlers);
    return {
      login: async () => ({ botUserId: BOT_ID, username: "slingbot" }),
      destroy: async () => {},
    };
  },
});

function liveGateway(): GatewayHandlers {
  const g = gateways.at(-1);
  if (!g) throw new Error("no Discord gateway yet");
  return g;
}

interface Click {
  replies: string[];
  edits: { content: string; components: unknown[] }[];
  acknowledged: boolean;
}

function click(customId: string, userId: string): { click: ButtonClick; seen: Click } {
  const seen: Click = { replies: [], edits: [], acknowledged: false };
  return {
    seen,
    click: {
      customId,
      user: { id: userId, username: userId === OWNER_DISCORD_ID ? "owner" : "stranger" },
      message: { id: "msg-approval", channelId: ALERT_CHANNEL, content: "Approval needed" },
      acknowledge: async () => {
        seen.acknowledged = true;
      },
      replyEphemeral: async (content) => {
        seen.replies.push(content);
      },
      editMessage: async (edit) => {
        seen.edits.push(edit as Click["edits"][number]);
      },
    },
  };
}

// ---------------------------------------------------------------- mock model

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function promptText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")),
    )
    .join("\n");
}

const model = new MockLanguageModelV4({
  // ai.extract asks for structured output.
  doGenerate: async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          summary: "The quarterly numbers are due Friday.",
          actionItems: ["Send the Q3 report", "Book the review"],
        }),
      },
    ],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  }),
  // agent.assistant streams a reply.
  doStream: async (options) => {
    const said = promptText(options);
    const reply = said.includes("hello sling") ? "Hi from Sling over Discord." : "Noted.";
    return {
      stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: reply },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ]),
    };
  },
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let mail: StartedTestContainer;
let server: RunningServer;
let cookie = "";
let origin = "";
let mailHost = "";
let smtpPort = 0;
let imapPort = 0;

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
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
  const data = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data}`);
  return (data ? JSON.parse(data) : null) as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

async function deliver(from: string, subject: string, text: string) {
  const transport = nodemailer.createTransport({ host: mailHost, port: smtpPort, secure: false });
  await transport.sendMail({ from, to: "inbox@example.com", subject, text });
  transport.close();
}

interface Installation {
  id: string;
  status: string;
}
interface Workflow {
  id: string;
  activeVersion: number | null;
  enabled: boolean;
}
interface Run {
  id: string;
  status: string;
  versionNumber: number;
}
interface NodeRun {
  nodeId: string;
  status: string;
  execPort: string | null;
}

async function installation(id: string) {
  const all = await api<Installation[]>("GET", "/api/installations");
  return all.find((i) => i.id === id);
}

const runs = (workflowId: string) => api<Run[]>("GET", `/api/workflows/${workflowId}/runs`);
const runDetail = (runId: string) =>
  api<{ run: Run; nodeRuns: NodeRun[] }>("GET", `/api/runs/${runId}`);

let discordId = "";
let emailId = "";

beforeAll(async () => {
  [pg, mail] = await Promise.all([
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
  ]);
  mailHost = mail.getHost();
  smtpPort = mail.getMappedPort(3025);
  imapPort = mail.getMappedPort(3143);

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "e2e-secret-key-that-is-long-enough-1234",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
  };
  server = await startServer(config, {
    model,
    connectors: [
      discord,
      createEmailConnector({
        autoIdleDelayMs: 200,
        pollIntervalMs: 300,
        backoff: { initialMs: 100, maxMs: 500 },
      }),
    ],
  });

  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });

  discordId = (
    await api<Installation>("POST", "/api/installations", {
      connectorId: "discord",
      name: "Sling bot",
      credentials: { botToken: "fake-token" },
      config: {
        allowedUserIds: [OWNER_DISCORD_ID],
        approverUserIds: [OWNER_DISCORD_ID],
        defaultChannelId: ALERT_CHANNEL,
      },
    })
  ).id;
  emailId = (
    await api<Installation>("POST", "/api/installations", {
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
}, 180_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([pg?.stop(), mail?.stop()]);
});

async function install(templateKey: string): Promise<Workflow> {
  const wf = await api<Workflow>("POST", "/api/workflows", {
    templateKey,
    bindings: { $discord: discordId, $email: emailId },
  });
  await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
  return wf;
}

// ---------------------------------------------------------------- tests

describe("Stage 2", { timeout: 60_000 }, () => {
  it("passes the connection tests", async () => {
    expect(await api("POST", `/api/installations/${emailId}/test`)).toMatchObject({ ok: true });
    expect(await api("POST", `/api/installations/${discordId}/test`)).toMatchObject({ ok: true });
  });

  it("summarizes mail from an important sender into Discord, and ignores everyone else", async () => {
    const wf = await install("important-email-to-discord");
    await until(
      "mailbox connected",
      async () => (await installation(emailId))?.status === "connected",
    );

    await deliver("Boss <boss@example.com>", "Q3 numbers", "Please send the Q3 report by Friday.");
    const posted = await until("Discord post", () =>
      sent.find((m) => m.body.content?.includes("Q3")),
    );
    expect(posted.channelId).toBe(ALERT_CHANNEL);
    expect(posted.body.content).toContain("**Q3 numbers**");
    expect(posted.body.content).toContain("From boss@example.com");
    expect(posted.body.content).toContain("The quarterly numbers are due Friday.");
    expect(posted.body.content).toContain("- Send the Q3 report");
    expect(posted.body.nonce).toBeTruthy();

    const [first] = await until("a succeeded run", async () => {
      const list = await runs(wf.id);
      return list.length === 1 && list[0]?.status === "succeeded" ? list : null;
    });
    const detail = await runDetail(first?.id ?? "");
    expect(detail.nodeRuns.map((n) => n.nodeId)).toEqual([
      "email",
      "important",
      "summarize",
      "keep",
      "notify",
    ]);
    expect(detail.nodeRuns.find((n) => n.nodeId === "important")?.execPort).toBe("true");

    const before = sent.length;
    await deliver("Newsletter <news@example.com>", "Big sale", "Everything must go.");
    await until("a second run", async () => (await runs(wf.id)).length === 2);
    const second = (await runs(wf.id))[0];
    const branch = await until("second run finished", async () => {
      const d = await runDetail(second?.id ?? "");
      return d.run.status === "succeeded" ? d : null;
    });
    expect(branch.nodeRuns.find((n) => n.nodeId === "important")?.execPort).toBe("false");
    expect(branch.nodeRuns.some((n) => n.nodeId === "notify")).toBe(false);
    expect(sent.length).toBe(before);
  });

  it("runs the next email on a newly published version", async () => {
    const list = await api<{ id: string; name: string }[]>("GET", "/api/workflows");
    const wfId = list.find((w) => w.name === "Important email to Discord")?.id ?? "";
    const detail = await api<{
      draft: { nodes: { id: string; config: Record<string, unknown> }[] };
    }>("GET", `/api/workflows/${wfId}`);
    const draft = detail.draft;
    const cond = draft.nodes.find((n) => n.id === "important");
    if (!cond) throw new Error("no condition node");
    cond.config.condition = '$lowercase(inputs.value.from.address) in ["news@example.com"]';
    await api("PUT", `/api/workflows/${wfId}/draft`, draft);
    const published = await api<{ ok: boolean; version: number }>(
      "POST",
      `/api/workflows/${wfId}/publish`,
      { note: "Newsletters only" },
    );
    expect(published).toMatchObject({ ok: true, version: 2 });

    await deliver("Newsletter <news@example.com>", "Version two", "Now it counts.");
    const latest = await until("run on version 2", async () => {
      const r = (await runs(wfId))[0];
      return r?.versionNumber === 2 && r.status === "succeeded" ? r : null;
    });
    const nodes = (await runDetail(latest.id)).nodeRuns;
    expect(nodes.find((n) => n.nodeId === "important")?.execPort).toBe("true");
    // Version 1's runs stay inspectable.
    const old = (await runs(wfId)).filter((r) => r.versionNumber === 1);
    expect(old.length).toBe(2);
    expect((await runDetail(old[0]?.id ?? "")).nodeRuns.length).toBeGreaterThan(0);
    await api("PATCH", `/api/workflows/${wfId}`, { enabled: false });
  });

  it("answers in Discord through the same assistant, and ignores strangers", async () => {
    await install("discord-assistant");
    const gw = await until("Discord gateway", () => gateways.at(-1));
    const base = {
      channelId: DM_CHANNEL,
      guildId: null,
      system: false,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      botRoleId: null,
      createdAt: new Date(),
    };
    gw.message({
      ...base,
      id: "100000000000000001",
      author: { id: STRANGER_DISCORD_ID, username: "stranger", bot: false },
      content: "hello sling, I'm not allowed",
    });
    gw.message({
      ...base,
      id: "100000000000000002",
      author: { id: OWNER_DISCORD_ID, username: "owner", bot: false },
      content: "hello sling",
    });
    const reply = await until("assistant reply in Discord", () =>
      sent.find((m) => m.channelId === DM_CHANNEL),
    );
    expect(reply.body.content).toBe("Hi from Sling over Discord.");
    expect(sent.filter((m) => m.channelId === DM_CHANNEL)).toHaveLength(1);

    const convs = (
      await api<{ items: { id: string; title: string }[] }>("GET", "/api/conversations")
    ).items;
    const conv = convs.find((c) => c.title.startsWith("Discord: owner"));
    expect(conv).toBeTruthy();
    const detail = await api<{ messages: { role: string; text: string }[] }>(
      "GET",
      `/api/conversations/${conv?.id}`,
    );
    expect(detail.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello sling"],
      ["assistant", "Hi from Sling over Discord."],
    ]);
  });

  it("approves from Discord only for allowlisted approvers", async () => {
    await install("approval-notifications-discord");
    const flow = await api<Workflow>("POST", "/api/workflows", { name: "Needs a yes" });
    await api("PUT", `/api/workflows/${flow.id}/draft`, {
      schema: "sling.workflow/v1",
      name: "Needs a yes",
      description: "",
      nodes: [
        { id: "go", type: "core.manual", version: 1, position: { x: 0, y: 0 }, config: {} },
        {
          id: "ask",
          type: "human.approval",
          version: 1,
          position: { x: 300, y: 0 },
          config: { title: "Ship the release?" },
        },
        {
          id: "done",
          type: "core.return",
          version: 1,
          position: { x: 600, y: 0 },
          config: { value: "shipped" },
        },
      ],
      edges: [
        {
          id: "e1",
          kind: "exec",
          from: { node: "go", port: "next" },
          to: { node: "ask", port: "in" },
        },
        {
          id: "e2",
          kind: "exec",
          from: { node: "ask", port: "approved" },
          to: { node: "done", port: "in" },
        },
      ],
    });
    expect(await api("POST", `/api/workflows/${flow.id}/publish`, { note: "" })).toMatchObject({
      ok: true,
    });
    const run = await api<Run | { run: Run }>("POST", `/api/workflows/${flow.id}/run`, {
      input: {},
    });
    const runId = "run" in run ? run.run.id : run.id;

    const ask = await until("approval DM with buttons", () =>
      sent.find((m) => m.body.components && m.body.content?.includes("Ship the release?")),
    );
    const buttons = JSON.stringify(ask.body.components);
    const approvalId = /sling:approval:([^:"]+):approve/.exec(buttons)?.[1];
    expect(approvalId).toBeTruthy();

    const refused = click(`sling:approval:${approvalId}:approve`, STRANGER_DISCORD_ID);
    liveGateway().button(refused.click);
    await until("refusal reply", () => refused.seen.replies.length > 0);
    expect(refused.seen.replies[0]).toBe("You can't approve this.");
    expect((await runDetail(runId)).run.status).toBe("waiting");

    const accepted = click(`sling:approval:${approvalId}:approve`, OWNER_DISCORD_ID);
    liveGateway().button(accepted.click);
    const finished = await until("run approved", async () => {
      const d = await runDetail(runId);
      return d.run.status === "succeeded" ? d : null;
    });
    expect(finished.nodeRuns.find((n) => n.nodeId === "ask")?.execPort).toBe("approved");
    expect(accepted.seen.edits.length).toBe(1);

    const approvals = await api<{ id: string; state: string }[]>(
      "GET",
      "/api/approvals?state=approved",
    );
    expect(approvals.some((a) => a.id === approvalId)).toBe(true);
    const audit = await server.ctx.db.query.auditEvents.findMany();
    expect(audit.some((a) => a.verb === "approval.refused" && a.subjectId === approvalId)).toBe(
      true,
    );
    const approved = audit.find(
      (a) => a.verb === "approval.approved" && a.subjectId === approvalId,
    );
    expect(approved?.details).toMatchObject({ via: "discord", externalUserId: OWNER_DISCORD_ID });
  });
});
