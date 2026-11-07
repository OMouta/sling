/**
 * Runs the connector against GreenMail, a real IMAP and SMTP server, in Docker.
 * `pnpm --filter @sling/integration-email test:integration`
 */
import type {
  AnyNodeSpec,
  Installation,
  NodeContext,
  NodeLogger,
  SourceContext,
  SourceStatus,
  TriggerEvent,
  TriggerMatch,
} from "@sling/connector-sdk";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connector, type Email, type EmailConfig, type EmailCredentials } from "../src/index.ts";
import {
  emailReceived,
  messageIdFor,
  type ReceivedConfig,
  readEmail,
  searchEmail,
  sendEmail,
} from "../src/nodes.ts";
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
  "searcher",
  "bouncer",
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
    expect(result).toEqual({
      exec: "next",
      outputs: { messageId: expectedId, sentAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
    });

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

/** A node context whose one installation is `user`'s mailbox. */
function nodeContext(user: string, overrides: Partial<NodeContext> = {}): NodeContext {
  const installation: Installation = {
    id: "inst_mail",
    connectorId: "email",
    name: "Mailbox",
    credentials: creds(user),
    config: { folders: ["INBOX"] },
  };
  return {
    runId: "chat:conv_1",
    nodeId: "email_send",
    nodeRunId: "call_1",
    workflowId: "",
    workspaceId: "ws_1",
    ownerId: "user_1",
    iteration: 0,
    attempt: 1,
    idempotencyKey: "chat:call_1",
    signal: new AbortController().signal,
    log: silentLog,
    installation: async () => installation,
    services: undefined,
    ...overrides,
  } as unknown as NodeContext;
}

/** Runs a node's `run` and hands back its outputs. */
async function outputsOf<T>(
  spec: AnyNodeSpec,
  ctx: NodeContext,
  config: Record<string, unknown>,
): Promise<T> {
  const out = await spec.run?.(ctx, { inputs: {}, config });
  if (!out || !("exec" in out)) throw new Error(`${spec.type} returned no outputs`);
  return out.outputs as T;
}

async function append(user: string, folder: string, raw: string, flags: string[] = []) {
  await withImap(user, (client) => client.append(folder, raw, flags));
}

describe("email.search and email.read", () => {
  beforeAll(async () => {
    await withImap("searcher", (client) => client.mailboxCreate("Archive"));
    const msg = (from: string, subject: string, date: string, body: string) =>
      [
        `From: ${from}`,
        "To: searcher@example.com",
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: <${subject.replace(/\W+/g, "-").toLowerCase()}@example.com>`,
        "",
        body,
        "",
      ].join("\r\n");
    await append(
      "searcher",
      "INBOX",
      msg(
        "Jo Silva <jo@silva.pt>",
        "Invoice for October",
        "Mon, 2 Nov 2026 09:00:00 +0000",
        "Hi, the invoice is attached. It's 120 euros.",
      ),
      ["\\Seen"],
    );
    await append(
      "searcher",
      "INBOX",
      msg(
        "Ana <ana@example.com>",
        "Lunch on Friday?",
        "Wed, 4 Nov 2026 12:00:00 +0000",
        "Are you free for lunch?",
      ),
    );
    await append(
      "searcher",
      "INBOX",
      [
        "From: Jo Silva <jo@silva.pt>",
        "To: searcher@example.com",
        "Subject: Invoice paid?",
        "Date: Fri, 6 Nov 2026 16:30:00 +0000",
        "Message-ID: <invoice-paid@silva.pt>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Did the <b>invoice</b> go through?</p><p>Jo</p></body></html>",
        "--mix",
        'Content-Type: application/pdf; name="invoice-2026-10.pdf"',
        'Content-Disposition: attachment; filename="invoice-2026-10.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("%PDF-1.4 fake invoice").toString("base64"),
        "--mix--",
        "",
      ].join("\r\n"),
    );
    await append(
      "searcher",
      "Archive",
      msg(
        "Jo Silva <jo@silva.pt>",
        "Old invoice",
        "Thu, 1 Oct 2026 09:00:00 +0000",
        "Last month's invoice.",
      ),
    );
  });

  const search = (config: Record<string, unknown>) =>
    outputsOf<{ messages: Record<string, unknown>[]; total: number }>(
      searchEmail,
      nodeContext("searcher"),
      { installationId: "inst_mail", ...config },
    );

  it("finds messages by sender and words, newest first, with a snippet of each", async () => {
    const found = await search({ from: "jo@silva.pt", text: "invoice" });
    expect(found.total).toBe(2);
    expect(found.messages.map((m) => m.subject)).toEqual(["Invoice paid?", "Invoice for October"]);
    const [paid, october] = found.messages;
    expect(paid).toMatchObject({
      id: expect.stringMatching(/^INBOX:\d+:3$/),
      messageId: "<invoice-paid@silva.pt>",
      from: { name: "Jo Silva", address: "jo@silva.pt" },
      to: [{ name: null, address: "searcher@example.com" }],
      date: "2026-11-06T16:30:00.000Z",
      unread: true,
      snippet: "Did the invoice go through? Jo",
    });
    expect(october).toMatchObject({
      unread: false,
      snippet: "Hi, the invoice is attached. It's 120 euros.",
    });
  });

  it("narrows by subject, dates, and whether it's been read", async () => {
    expect((await search({ subject: "lunch" })).messages.map((m) => m.subject)).toEqual([
      "Lunch on Friday?",
    ]);
    expect((await search({ unread: false })).messages.map((m) => m.subject)).toEqual([
      "Invoice for October",
    ]);
    expect((await search({ unread: true })).total).toBe(2);
    expect((await search({ text: "nothing-like-this" })).messages).toEqual([]);
    expect((await search({ limit: 1 })).messages.map((m) => m.subject)).toEqual(["Invoice paid?"]);
  });

  it("searches another folder, and says which ones there are when it can't find one", async () => {
    expect((await search({ folder: "archive" })).messages.map((m) => m.subject)).toEqual([
      "Old invoice",
    ]);
    await expect(search({ folder: "Bills" })).rejects.toThrow(
      /There's no folder called Bills\. Folders: .*Archive/,
    );
  });

  it("reads a message's text from its HTML, with its attachments by name and size", async () => {
    const [paid] = (await search({ subject: "paid" })).messages;
    const { message } = await outputsOf<{ message: Record<string, unknown> }>(
      readEmail,
      nodeContext("searcher"),
      { installationId: "inst_mail", id: paid?.id },
    );
    expect(message).toMatchObject({
      id: paid?.id,
      messageId: "<invoice-paid@silva.pt>",
      folder: "INBOX",
      from: { name: "Jo Silva", address: "jo@silva.pt" },
      subject: "Invoice paid?",
      unread: true,
      truncated: false,
      attachments: [{ name: "invoice-2026-10.pdf", size: 21, contentType: "application/pdf" }],
    });
    expect(String(message.text).replace(/\s+/g, " ").trim()).toBe("Did the invoice go through? Jo");
    // Reading it from chat leaves it unread.
    expect((await search({ subject: "paid" })).messages[0]?.unread).toBe(true);
  });

  it("refuses an ID that doesn't point at a message", async () => {
    const read = (id: string) =>
      outputsOf(readEmail, nodeContext("searcher"), { installationId: "inst_mail", id });
    const [any] = (await search({})).messages;
    const validity = String(any?.id).split(":")[1];
    await expect(read(`INBOX:${validity}:999`)).rejects.toThrow(/There's no message/);
    await expect(read("INBOX:1:1")).rejects.toThrow(/renumbered INBOX/);
  });
});

describe("email.send's check", () => {
  /** Sends a message from the bouncer's mailbox through the node, the way chat does. */
  async function send(key: string, to: string) {
    return outputsOf<{ messageId: string; sentAt: string }>(
      sendEmail,
      nodeContext("bouncer", { idempotencyKey: key }),
      { installationId: "inst_mail", to, subject: "Invoice", text: "Here it is." },
    );
  }
  const verify = (outputs: Record<string, unknown>, to: string, attempt = 1) =>
    sendEmail.verify?.(nodeContext("bouncer", { attempt }), {
      inputs: {},
      config: { installationId: "inst_mail", to, subject: "Invoice", text: "Here it is." },
      outputs,
    });

  it("waits while nothing has bounced, ignoring the message itself in the inbox", async () => {
    const sent = await send("chat:call_self", "bouncer@example.com");
    // The copy sent to its own mailbox holds the same Message-ID, and isn't a bounce.
    await until(async () =>
      withImap("bouncer", async (c) => {
        const status = await c.status("INBOX", { messages: true });
        return status !== false && status.messages === 1;
      }),
    );
    expect(await verify(sent, "bouncer@example.com")).toEqual({
      state: "waiting",
      message: "Watching for a bounce",
      retryAfterSeconds: 30,
    });
  });

  it("fails when a bounce naming it arrives, and passes after the watch with none", async () => {
    const sent = await send("chat:call_bounce", "jo@silva.invalid");
    await append(
      "bouncer",
      "INBOX",
      [
        "From: Mail Delivery System <MAILER-DAEMON@mx.example.com>",
        "To: bouncer@example.com",
        "Subject: Undelivered Mail Returned to Sender",
        "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type=delivery-status; boundary="r"',
        "",
        "--r",
        "Content-Type: text/plain",
        "",
        "This is the mail system. Your message could not be delivered.",
        "",
        "--r",
        "Content-Type: message/delivery-status",
        "",
        "Reporting-MTA: dns; mx.example.com",
        "",
        "Final-Recipient: rfc822; jo@silva.invalid",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 <jo@silva.invalid>: Recipient address rejected",
        "",
        "--r",
        "Content-Type: text/rfc822-headers",
        "",
        "From: bouncer@example.com",
        "To: jo@silva.invalid",
        "Subject: Invoice",
        `Message-ID: ${sent.messageId}`,
        "",
        "--r--",
        "",
      ].join("\r\n"),
    );
    expect(await verify(sent, "jo@silva.invalid", 2)).toEqual({
      state: "failed",
      message: "Bounced: mailbox not found",
    });

    // Another send, sent long enough ago that the watch is over, with no bounce of its own.
    const quiet = await send("chat:call_quiet", "ana@example.com");
    const earlier = new Date(Date.parse(quiet.sentAt) - 11 * 60_000).toISOString();
    expect(await verify({ ...quiet, sentAt: earlier }, "ana@example.com", 9)).toEqual({
      state: "passed",
      message: "No bounce after 10 minutes",
    });
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
          // The email trigger matches synchronously.
          return trigger.match(event, {
            installationId: "inst_mail",
            ...config,
          } as ReceivedConfig) as TriggerMatch | null;
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
