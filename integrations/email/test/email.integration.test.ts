/**
 * Runs the connector against GreenMail, a real IMAP and SMTP server, in Docker.
 * `pnpm --filter @sling/integration-email test:integration`
 */
import type { SourceContext, SourceStatus } from "@sling/connector-sdk";
import type { Installation, NodeContext, NodeLogger, TriggerEvent } from "@sling/workflow";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connector, type Email, type EmailConfig, type EmailCredentials } from "../src/index.ts";
import { emailReceived, messageIdFor, type ReceivedConfig, sendEmail } from "../src/nodes.ts";
import { parseEmail } from "../src/parse.ts";
import { createEmailSource, type EmailSourceOptions, markKey } from "../src/source.ts";

const IMAGE = "greenmail/standalone:2.1.15";
const USERS = [
  "creds",
  "outbox",
  "recipient",
  "fresh",
  "restart",
  "validity",
  "filters",
  "folders",
  "poll",
];

const silentLog: NodeLogger = { info() {}, warn() {}, error() {} };
const fast: EmailSourceOptions = {
  autoIdleDelayMs: 200,
  pollIntervalMs: 300,
  backoff: { initialMs: 100, maxMs: 500 },
};

let container: StartedTestContainer;
let host: string;
let smtpPort: number;
let imapPort: number;

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withEnvironment({
      GREENMAIL_OPTS: [
        "-Dgreenmail.setup.test.smtp",
        "-Dgreenmail.setup.test.imap",
        "-Dgreenmail.hostname=0.0.0.0",
        "-Dgreenmail.users.login=email",
        `-Dgreenmail.users=${USERS.map((u) => `${u}:secret@example.com`).join(",")}`,
      ].join(" "),
    })
    .withExposedPorts(3025, 3143)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  host = container.getHost();
  smtpPort = container.getMappedPort(3025);
  imapPort = container.getMappedPort(3143);
});

afterAll(async () => {
  await container?.stop();
});

function creds(user: string, overrides: Partial<EmailCredentials> = {}): EmailCredentials {
  return {
    imapHost: host,
    imapPort,
    imapSecure: false,
    smtpHost: host,
    smtpPort,
    smtpSecure: false,
    username: `${user}@example.com`,
    password: "secret",
    fromAddress: `${user}@example.com`,
    ...overrides,
  };
}

async function deliver(
  to: string,
  mail: { subject: string; text?: string; from?: string },
): Promise<void> {
  const transport = nodemailer.createTransport({ host, port: smtpPort, secure: false });
  await transport.sendMail({
    from: mail.from ?? '"Sender Person" <outbox@example.com>',
    to: `${to}@example.com`,
    subject: mail.subject,
    text: mail.text ?? mail.subject,
  });
  transport.close();
}

async function withImap<T>(user: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host,
    port: imapPort,
    secure: false,
    auth: { user: `${user}@example.com`, pass: "secret" },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  ctx: SourceContext<EmailCredentials, EmailConfig>;
  emitted: { type: string; payload: Email; dedupeKey?: string }[];
  statuses: { status: SourceStatus; detail?: string }[];
  state: Map<string, string>;
}

/** A source context with in-memory state. Pass `state` from an earlier harness to restart. */
function harness(
  credentials: EmailCredentials,
  config: Partial<EmailConfig> = {},
  shared?: Pick<Harness, "emitted" | "state">,
): Harness {
  const emitted = shared?.emitted ?? [];
  const state = shared?.state ?? new Map<string, string>();
  const statuses: Harness["statuses"] = [];
  const ctx: SourceContext<EmailCredentials, EmailConfig> = {
    installationId: "inst_mail",
    workspaceId: "ws_1",
    credentials,
    config: { folders: ["INBOX"], ...config },
    log: silentLog,
    signal: new AbortController().signal,
    async emit(event) {
      emitted.push(event as Harness["emitted"][number]);
    },
    state: {
      async get(key) {
        return state.get(key) ?? null;
      },
      async set(key, value) {
        state.set(key, value);
      },
    },
    approvals: {
      async decide() {
        return { ok: false, message: "not used" };
      },
      async reportRefused() {},
    },
    setStatus(status, detail) {
      statuses.push({ status, detail });
    },
  };
  return { ctx, emitted, statuses, state };
}

const running: { stop(): Promise<void> }[] = [];

async function start(h: Harness, options: EmailSourceOptions = fast) {
  const source = await createEmailSource(options).start(h.ctx);
  running.push(source);
  await until(() => h.statuses.at(-1)?.status === "connected");
  return source;
}

afterEach(async () => {
  while (running.length) await running.pop()?.stop();
});

const subjects = (h: Harness) => h.emitted.map((e) => e.payload.subject);

describe("connection test", () => {
  const run = (credentials: EmailCredentials, folders = ["INBOX"]) =>
    connector.test({
      credentials,
      config: { folders },
      log: silentLog,
      signal: new AbortController().signal,
    });

  it("passes against a working mailbox", async () => {
    expect(await run(creds("creds"))).toEqual({
      ok: true,
      detail: "IMAP and SMTP logins worked. Watching INBOX.",
    });
  });

  it("fails on a wrong password", async () => {
    const result = await run(creds("creds", { password: "wrong" }));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/IMAP login failed/) });
  });

  it("fails when a watched folder doesn't exist", async () => {
    const result = await run(creds("creds"), ["INBOX", "Nope"]);
    expect(result).toEqual({
      ok: false,
      error: `IMAP login worked, but there's no folder called "Nope".`,
    });
  });

  it("fails when SMTP can't be reached", async () => {
    const result = await run(creds("creds", { smtpPort: 1 }));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^SMTP check failed/) });
  });
});

describe("email.send", () => {
  it("sends over SMTP with a Message-ID from the idempotency key", async () => {
    const installation: Installation = {
      id: "inst_mail",
      connectorId: "email",
      name: "Mailbox",
      credentials: creds("outbox", { fromAddress: "Sling <outbox@example.com>" }),
      config: { folders: ["INBOX"] },
    };
    const ctx = {
      runId: "run_1",
      nodeId: "n_send",
      nodeRunId: "nr_1",
      workflowId: "wf_1",
      workspaceId: "ws_1",
      ownerId: "user_1",
      iteration: 0,
      attempt: 1,
      idempotencyKey: "run_1:n_send:0",
      signal: new AbortController().signal,
      log: silentLog,
      installation: async () => installation,
      services: undefined,
    } as unknown as NodeContext;

    const result = await sendEmail.run?.(ctx, {
      inputs: { text: "The body, from the text input." },
      config: {
        installationId: "inst_mail",
        to: "recipient@example.com",
        subject: "Weekly summary",
        text: "ignored, the input wins",
        inReplyTo: "<earlier@example.com>",
      },
    });

    const expectedId = messageIdFor("run_1:n_send:0", "outbox@example.com");
    expect(result).toEqual({ exec: "next", outputs: { messageId: expectedId } });

    const received = await withImap("recipient", async (client) => {
      await client.mailboxOpen("INBOX");
      const message =
        (await client.fetchOne("*", { uid: true, source: true }, { uid: true })) || null;
      if (!message?.source) throw new Error("nothing arrived");
      return parseEmail(message.source, { id: "x", folder: "INBOX" });
    });
    expect(received).toMatchObject({
      messageId: expectedId,
      from: { name: "Sling", address: "outbox@example.com" },
      to: [{ name: null, address: "recipient@example.com" }],
      subject: "Weekly summary",
      inReplyTo: "<earlier@example.com>",
    });
    expect(received.text.trim()).toBe("The body, from the text input.");
  });
});

describe("email source", () => {
  it("doesn't backfill on first start, then emits new mail with the email shape", async () => {
    await deliver("fresh", { subject: "Old 1" });
    await deliver("fresh", { subject: "Old 2" });
    const h = harness(creds("fresh"));
    await start(h);
    const mark = JSON.parse(h.state.get(markKey("INBOX")) ?? "{}");
    expect(mark.uid).toBe(2);

    await deliver("fresh", { subject: "New one", text: "Hello there" });
    await until(() => h.emitted.length === 1);
    await pause(800);
    expect(h.emitted).toHaveLength(1);

    const [event] = h.emitted;
    const id = `INBOX:${mark.uidValidity}:3`;
    expect(event?.type).toBe("email.received");
    expect(event?.dedupeKey).toBe(id);
    expect(event?.payload).toEqual({
      id,
      messageId: expect.stringMatching(/^<.+@.+>$/),
      folder: "INBOX",
      from: { name: "Sender Person", address: "outbox@example.com" },
      to: [{ name: null, address: "fresh@example.com" }],
      cc: [],
      subject: "New one",
      date: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      text: expect.stringMatching(/^Hello there\s*$/),
      html: null,
      inReplyTo: null,
    });
    expect(JSON.parse(h.state.get(markKey("INBOX")) ?? "{}")).toEqual({
      uidValidity: mark.uidValidity,
      uid: 3,
    });
  });

  it("emits each message exactly once across a restart", async () => {
    const first = harness(creds("restart"));
    const source = await start(first);
    await deliver("restart", { subject: "Before restart" });
    await until(() => first.emitted.length === 1);
    await pause(500);
    await source.stop();

    // Arrives while nothing is watching.
    await deliver("restart", { subject: "While stopped" });

    const second = harness(creds("restart"), {}, first);
    await start(second);
    await until(() => first.emitted.length === 2);
    await deliver("restart", { subject: "After restart" });
    await until(() => first.emitted.length === 3);
    await pause(800);

    expect(subjects(first)).toEqual(["Before restart", "While stopped", "After restart"]);
    const keys = first.emitted.map((e) => e.dedupeKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("starts from the newest message when UIDVALIDITY changes", async () => {
    await deliver("validity", { subject: "Already here 1" });
    await deliver("validity", { subject: "Already here 2" });
    const h = harness(creds("validity"));
    h.state.set(markKey("INBOX"), JSON.stringify({ uidValidity: "1", uid: 0 }));
    await start(h);
    await pause(800);
    expect(h.emitted).toEqual([]);
    const mark = JSON.parse(h.state.get(markKey("INBOX")) ?? "{}");
    expect(mark.uidValidity).not.toBe("1");
    expect(mark.uid).toBe(2);

    await deliver("validity", { subject: "After reset" });
    await until(() => h.emitted.length === 1);
    expect(subjects(h)).toEqual(["After reset"]);
  });

  it("feeds the trigger's from and subject filters", async () => {
    const h = harness(creds("filters"));
    await start(h);
    await deliver("filters", { subject: "Urgent: Q4 plan", from: "Boss <boss@corp.example>" });
    await deliver("filters", { subject: "Big sale", from: "news@shop.example" });
    await deliver("filters", { subject: "Lunch?", from: "Boss <boss@corp.example>" });
    await until(() => h.emitted.length === 3);

    const trigger = emailReceived.trigger;
    if (!trigger) throw new Error("trigger missing");
    const matching = (config: Record<string, unknown>) =>
      h.emitted
        .map((e) => {
          const event: TriggerEvent = {
            type: e.type,
            workspaceId: "ws_1",
            installationId: "inst_mail",
            payload: e.payload,
            at: new Date(),
          };
          return trigger.match(event, { installationId: "inst_mail", ...config } as ReceivedConfig);
        })
        .filter((m) => m !== null)
        .map((m) => (m.outputs.email as Email).subject);

    expect(matching({})).toEqual(["Urgent: Q4 plan", "Big sale", "Lunch?"]);
    expect(matching({ fromContains: "BOSS@corp" })).toEqual(["Urgent: Q4 plan", "Lunch?"]);
    expect(matching({ fromContains: "boss", subjectContains: "urgent" })).toEqual([
      "Urgent: Q4 plan",
    ]);
    expect(matching({ subjectContains: "SALE" })).toEqual(["Big sale"]);
    expect(matching({ folder: "Receipts" })).toEqual([]);
  });

  it("watches several folders, each with its own mark", async () => {
    await withImap("folders", (client) => client.mailboxCreate("Receipts"));
    const h = harness(creds("folders"), { folders: ["INBOX", "Receipts"] });
    await start(h);
    expect(h.statuses.at(-1)).toEqual({
      status: "connected",
      detail: "Watching INBOX, Receipts",
    });

    await withImap("folders", (client) =>
      client.append(
        "Receipts",
        "From: shop@example.com\r\nTo: folders@example.com\r\nSubject: Your receipt\r\n\r\nThanks!\r\n",
      ),
    );
    await deliver("folders", { subject: "Inbox mail" });
    await until(() => h.emitted.length === 2);

    const byFolder = Object.fromEntries(h.emitted.map((e) => [e.payload.folder, e]));
    expect(byFolder.Receipts?.payload.subject).toBe("Your receipt");
    expect(byFolder.Receipts?.dedupeKey).toMatch(/^Receipts:\d+:1$/);
    expect(byFolder.INBOX?.payload.subject).toBe("Inbox mail");
    expect(h.state.has(markKey("Receipts"))).toBe(true);
  });

  it("polls when IDLE is off", async () => {
    const h = harness(creds("poll"));
    await start(h, { ...fast, idle: false });
    await deliver("poll", { subject: "Found by polling" });
    await until(() => h.emitted.length === 1);
    expect(subjects(h)).toEqual(["Found by polling"]);
  });

  it("reports a failed login and keeps retrying until stopped", async () => {
    const h = harness(creds("creds", { password: "wrong" }));
    const source = await createEmailSource(fast).start(h.ctx);
    await until(() => h.statuses.filter((s) => s.status === "error").length >= 2);
    await source.stop();
    expect(h.statuses.find((s) => s.status === "error")?.detail).toMatch(/IMAP login failed/);
    const count = h.statuses.length;
    await pause(600);
    expect(h.statuses.length).toBe(count);
  });
});
