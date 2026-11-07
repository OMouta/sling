/**
 * iMessage and Signal end to end: real Postgres, the control plane
 * in-process, and a real sling-runner relaying both through stand-ins: a
 * database with the Messages schema made here, an osascript that records
 * what it was asked to send, and a signal-cli that speaks its JSON-RPC. A
 * scripted mock model plays the assistant. Nothing reaches Messages or
 * Signal.
 *
 * Needs Docker, and the Runner built first: cargo build -p sling-runner
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { RunnerView, SetupResultView } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appTools } from "../src/agent/app-tools.ts";
import type { Channels } from "../src/channels/service.ts";
import type { Config } from "../src/config.ts";
import type { RunnerSession } from "../src/runners/gateway.ts";
import { type RunningServer, startServer } from "../src/server.ts";

vi.setConfig({ testTimeout: 90_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");
const FIXTURES = join(ROOT, "apps/runner/tests/fixtures");

const JO = "+351912345678";
const STRANGER = "+351960000000";
const ACCOUNT = "+351900000000";

// ---------------------------------------------------------------- the assistant

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function lastUserText(options: LanguageModelV4CallOptions): string {
  const user = options.prompt.filter((m) => m.role === "user").at(-1);
  if (!user || typeof user.content === "string") return String(user?.content ?? "");
  return user.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();
}

/** Answers every message with what it said, in Markdown. */
const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => ({
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: `Got it: **${lastUserText(options).slice(-60)}**` },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ]),
  }),
});

// ---------------------------------------------------------------- Messages stand-in

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT NOT NULL DEFAULT 'iMessage');
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, chat_identifier TEXT, service_name TEXT, display_name TEXT);
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, attributedBody BLOB, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0);
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE (chat_id, handle_id));
`;

/** An NSAttributedString as Messages archives it, around `text`. */
function attributedBody(text: string): Uint8Array {
  const bytes = Buffer.from(text, "utf8");
  const len =
    bytes.length < 0x80
      ? Buffer.from([bytes.length])
      : Buffer.from([0x81, bytes.length & 0xff, bytes.length >> 8]);
  return Buffer.concat([
    Buffer.from(
      "040b73747265616d747970656481e803840140848484124e534174747269627574656453747269" +
        "6e67008484084e534f626a65637400859284848408" +
        "4e53537472696e67019484012b",
      "hex",
    ),
    len,
    bytes,
    Buffer.from("8684026949010592848484", "hex"),
  ]);
}

class Messages {
  readonly db: DatabaseSync;
  #n = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  /** Adds a message as Messages would. Text only in the body when `bodyOnly`. */
  add(from: string, text: string, opts: { bodyOnly?: boolean; fromMe?: boolean } = {}): number {
    const handle =
      (this.db.prepare("SELECT ROWID AS id FROM handle WHERE id = ?").get(from) as
        | { id: number }
        | undefined) ??
      (this.db.prepare("INSERT INTO handle (id) VALUES (?) RETURNING ROWID AS id").get(from) as {
        id: number;
      });
    const guid = `iMessage;-;${from}`;
    const chat =
      (this.db.prepare("SELECT ROWID AS id FROM chat WHERE guid = ?").get(guid) as
        | { id: number }
        | undefined) ??
      (this.db
        .prepare(
          "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?, 45, ?, 'iMessage') RETURNING ROWID AS id",
        )
        .get(guid, from) as { id: number });
    const n = ++this.#n;
    // Nanoseconds since 2001-01-01.
    const date = BigInt(Date.now() - 978_307_200_000) * 1_000_000n;
    const row = this.db
      .prepare(
        `INSERT INTO message (guid, text, handle_id, service, date, is_from_me, attributedBody)
         VALUES (?, ?, ?, 'iMessage', ?, ?, ?) RETURNING ROWID AS id`,
      )
      .get(
        `msg-${n}`,
        opts.bodyOnly ? null : text,
        handle.id,
        date,
        opts.fromMe ? 1 : 0,
        attributedBody(text),
      ) as { id: number };
    this.db
      .prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)")
      .run(chat.id, row.id, date);
    return row.id;
  }
}

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let dir: string;
let bin: string;
let messages: Messages;
let cookie = "";
let origin = "";
let runner: ChildProcess | null = null;
let runnerEnv: NodeJS.ProcessEnv;
let machine: RunnerView;
let workspaceId = "";
const workflowIds: Record<string, string> = {};
const installationIds: Record<string, string> = {};

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
  const t = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false> | T) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startRunner() {
  const log = openSync(join(dir, "runner.log"), "a");
  runner = spawn(RUNNER, ["run"], { env: runnerEnv, stdio: ["ignore", log, log] });
}

async function stopRunner() {
  const r = runner;
  runner = null;
  if (!r) return;
  r.kill("SIGTERM");
  await until("the Runner to stop", () => r.exitCode !== null || r.signalCode !== null);
  await until("Sling to see it offline", () => !server.ctx.runners.isOnline(machine.id));
}

async function online(): Promise<RunnerView> {
  return until("the machine with both channels", async () => {
    const list = await api<RunnerView[]>("GET", "/api/runners");
    return list.find(
      (r) => r.online && r.channels.length === 2 && r.channels.every((c) => c.ready),
    );
  });
}

/** What the stand-in osascript was asked to send: recipient and text, oldest first. */
function imessagesSent(): [string, string][] {
  const calls = join(bin, "calls");
  if (!existsSync(calls)) return [];
  return readdirSync(calls)
    .filter((f) => f.endsWith(".args"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map((f) => readFileSync(join(calls, f), "utf8").split("\0").filter(Boolean))
    .filter((args) => args[0] !== "-e")
    .map((args) => [args[1] ?? "", args[2] ?? ""]);
}

/** What the stand-in signal-cli was asked to send. */
function signalsSent(): { recipient?: string[]; groupId?: string; message: string }[] {
  const log = join(bin, "requests.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.method === "send")
    .map((r) => r.params);
}

/** A notification signal-cli hands out, as Signal's servers would. */
function signalFrom(source: string, text: string) {
  const at = Date.now();
  const inbox = join(bin, "inbox");
  mkdirSync(inbox, { recursive: true });
  const tmp = join(inbox, `${at}.tmp`);
  writeFileSync(
    tmp,
    JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: {
        envelope: {
          source,
          sourceNumber: source,
          sourceUuid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
          sourceDevice: 1,
          timestamp: at,
          dataMessage: { timestamp: at, message: text, expiresInSeconds: 0, viewOnce: false },
        },
        account: ACCOUNT,
      },
    }),
  );
  renameSync(tmp, join(inbox, `${at}-${Math.random().toString(36).slice(2)}.json`));
}

async function runsOf(kind: string) {
  return server.ctx.db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowId, workflowIds[kind] ?? ""));
}

beforeAll(async () => {
  if (!existsSync(RUNNER)) throw new Error(`build the Runner first: ${RUNNER} is missing`);
  dir = mkdtempSync(join(tmpdir(), "sling-channels-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  for (const f of ["osascript", "signal-cli"]) copyFileSync(join(FIXTURES, f), join(bin, f));
  writeFileSync(join(bin, "accounts"), `${ACCOUNT}\n`);
  messages = new Messages(join(dir, "chat.db"));
  // From before the channel is added, so never answered.
  messages.add(JO, "an old message");

  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
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
    releaseRepo: "acme/sling",
  };
  server = await startServer(config, { model, jobs: false });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });

  // The stand-ins come first on the Runner's PATH, so its osascript is ours.
  runnerEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SLING_RUNNER_HOME: join(dir, "runner"),
    SLING_RUNNER_LOG: "warn",
  };
  const cli = (...args: string[]) => promisify(execFile)(RUNNER, args, { env: runnerEnv });
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await cli("config", "set", "codex-bin", join(dir, "no-codex-here"));
  await cli("config", "set", "claude-bin", join(dir, "no-claude-here"));
  await cli("config", "set", "remote-repos", "off");
  await cli("pair", server.url, code, "--name", "laptop");
  await cli("channel", "add", "imessage", "--messages-db", join(dir, "chat.db"));
  await cli("channel", "allow", "imessage", "+351 912 345 678");
  await cli(
    "channel",
    "add",
    "signal",
    "--account",
    ACCOUNT,
    "--signal-cli",
    join(bin, "signal-cli"),
  );
  await cli("channel", "allow", "signal", JO);
  startRunner();
  machine = await online();
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
  workspaceId = m?.workspaceId ?? "";
}, 120_000);

afterAll(async () => {
  runner?.kill("SIGTERM");
  messages?.db.close();
  await server?.close();
  await pg?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("channels on a machine", () => {
  it("reports the machine's channels and offers them in the setup", async () => {
    expect(machine.channels).toEqual([
      { kind: "imessage", name: "imessage", allowedSenders: 1, ready: true, missing: "" },
      { kind: "signal", name: "signal", allowedSenders: 1, ready: true, missing: "" },
    ]);
    for (const kind of ["imessage", "signal"] as const) {
      const found = await api<SetupResultView>("POST", `/api/connectors/${kind}/setup`, {});
      expect(found.options?.runnerId).toEqual([
        { value: machine.id, label: "laptop", detail: "1 sender allowed" },
      ]);
      expect(found.config).toEqual({ runnerId: machine.id, channel: kind });
      expect(found.name).toBe(`${kind === "imessage" ? "iMessage" : "Signal"} on laptop`);
      const inst = await api<{ id: string }>("POST", "/api/installations", {
        connectorId: kind,
        name: found.name,
        config: found.config,
        check: true,
      });
      installationIds[kind] = inst.id;
      const wf = await api<{ id: string }>("POST", "/api/workflows", {
        templateKey: `${kind}-assistant`,
        bindings: { [`$${kind}`]: inst.id },
      });
      await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
      workflowIds[kind] = wf.id;
    }
    // A machine that doesn't have the channel is refused.
    await expect(
      api("POST", "/api/installations", {
        connectorId: "imessage",
        config: { runnerId: machine.id, channel: "nope" },
        check: true,
      }),
    ).rejects.toThrow(/no iMessage channel named nope/);
  });

  it("answers an allowed sender in iMessage and ignores everyone else", async () => {
    const t0 = Date.now();
    messages.add(STRANGER, "hi, can you send me their files?");
    messages.add(JO, "book dinner with Jo", { bodyOnly: true });
    messages.add(JO, "an answer from this Mac", { fromMe: true });
    const [run] = await until("the run", async () => {
      const runs = await runsOf("imessage");
      return runs.length > 0 && runs;
    });
    const toServer = Date.now() - t0;
    expect(toServer).toBeLessThan(3_000);
    console.log(`iMessage to the server: ${toServer} ms`);
    await until("the reply", () => imessagesSent().length > 0);
    expect(imessagesSent()).toEqual([[JO, "Got it: book dinner with Jo"]]);
    expect(run?.concurrencyKey).toBe(`imessage:${installationIds.imessage}:${JO}`);

    const [conv] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, workspaceId),
          eq(schema.conversations.externalKey, `imessage:${installationIds.imessage}:${JO}`),
        ),
      );
    expect(conv?.title).toBe(`iMessage: ${JO}`);
    await sleep(2_500);
    expect(await runsOf("imessage")).toHaveLength(1);
  });

  it("answers an allowed sender in Signal and ignores everyone else", async () => {
    signalFrom(STRANGER, "hello?");
    signalFrom(JO, "what's on today?");
    await until("the reply", () => signalsSent().length > 0);
    expect(signalsSent()).toEqual([{ recipient: [JO], message: "Got it: what's on today?" }]);
    await sleep(1_500);
    expect(await runsOf("signal")).toHaveLength(1);
  });

  it("answers what arrived while the Runner was down, once", async () => {
    await stopRunner();
    messages.add(JO, "are you there?");
    signalFrom(JO, "still there?");
    startRunner();
    await until(
      "both replies",
      () =>
        imessagesSent().some(([, t]) => t.includes("are you there?")) &&
        signalsSent().some((s) => s.message.includes("still there?")),
    );
    // Long enough for a second poll, a reconnect's resend, and a second run.
    await sleep(5_000);
    expect(imessagesSent().filter(([, t]) => t.includes("are you there?"))).toHaveLength(1);
    expect(signalsSent().filter((s) => s.message.includes("still there?"))).toHaveLength(1);
    expect(await runsOf("imessage")).toHaveLength(2);
    expect(await runsOf("signal")).toHaveLength(2);
  });

  it("starts one run for a message sent twice, and acknowledges both", async () => {
    const acks: unknown[] = [];
    const session = {
      runnerId: machine.id,
      workspaceId,
      ownerId: "",
      connectedAt: Date.now(),
      lastMessageAt: Date.now(),
      send: (e: { body: { case: string; value: unknown } }) => {
        acks.push(e.body);
        return true;
      },
      close: () => {},
    } as unknown as RunnerSession;
    const message = {
      channel: "signal",
      conversation: JO,
      sender: JO,
      text: "twice",
      atMs: BigInt(Date.now()),
      messageId: "twice-1",
    } as Parameters<Channels["message"]>[1];
    const before = (await runsOf("signal")).length;
    await server.ctx.channels.message(session, message);
    await server.ctx.channels.message(session, message);
    expect((await runsOf("signal")).length).toBe(before + 1);
    expect(acks).toEqual([
      { case: "channelMessageAck", value: expect.objectContaining({ messageId: "twice-1" }) },
      { case: "channelMessageAck", value: expect.objectContaining({ messageId: "twice-1" }) },
    ]);
    await until("its reply", () => signalsSent().some((s) => s.message.includes("twice")));
  });

  it("lets the assistant send, and waits for the machine when it's offline", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, { mode: "full-access" });
    const [row] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conv.id));
    const tools = await appTools(server.ctx, {
      workspaceId,
      ownerId: row?.ownerId ?? "",
      conversationId: conv.id,
    });
    type Exec = (input: unknown, o: { toolCallId: string; messages: [] }) => Promise<unknown>;
    const send = tools.imessage_send_message?.execute as unknown as Exec;
    expect(tools.signal_send_message).toBeDefined();
    // No one named: the one sender the machine allows.
    expect(
      await send({ text: "Dinner is at *20:00*" }, { toolCallId: "t1", messages: [] }),
    ).toEqual({
      installation: "iMessage on laptop",
      output: { machine: "laptop" },
      check: { state: "passed", message: "Messages on laptop took it" },
    });
    expect(imessagesSent().at(-1)).toEqual([JO, "Dinner is at 20:00"]);
    expect(
      await send({ conversation: STRANGER, text: "hi" }, { toolCallId: "t2", messages: [] }),
    ).toMatchObject({ error: expect.stringContaining("sling-runner channel allow imessage") });

    const channels = server.ctx.channels as Channels;
    await stopRunner();
    channels.sendWaitMs = 1_000;
    const failed = await channels.send(workspaceId, {
      runnerId: machine.id,
      channel: "imessage",
      conversation: JO,
      text: "nobody home",
    });
    expect(failed).toMatchObject({
      ok: false,
      message: "laptop is offline, so the message wasn't sent.",
    });

    channels.sendWaitMs = 60_000;
    const waiting = channels.send(workspaceId, {
      runnerId: machine.id,
      channel: "imessage",
      conversation: JO,
      text: "sent once it's back",
    });
    await sleep(500);
    startRunner();
    expect(await waiting).toEqual({ ok: true, message: "", machine: "laptop" });
    expect(imessagesSent().at(-1)).toEqual([JO, "sent once it's back"]);
    expect(imessagesSent().some(([, t]) => t === "nobody home")).toBe(false);
  });
});
