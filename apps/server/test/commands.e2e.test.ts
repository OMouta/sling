/**
 * The assistant's shell commands end to end: real Postgres, the control
 * plane in-process, and a real sling-runner on this machine. A scripted mock
 * model plays the assistant and calls run_command. The commands only touch a
 * temporary directory.
 *
 * Needs Docker, and the Runner built first: cargo build -p sling-runner
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  ConversationPage,
  LiveReplyView,
  MessageView,
  PermissionMode,
  RunnerView,
  ToolStep,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");

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

/** The run_command call the assistant makes for the next user message. */
const plan: Record<string, unknown>[] = [];

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const last = options.prompt.at(-1);
    if (last?.role === "tool") return text("Done.");
    const next = plan.shift();
    if (!next) return text("Nothing to do.");
    return respond(
      [
        {
          type: "tool-call",
          toolCallId: `call_${newId("c")}`,
          toolName: "run_command",
          input: JSON.stringify(next),
        },
      ],
      "tool-calls",
    );
  },
});

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let dir: string;
let work: string;
let cookie = "";
let origin = "";
let runner: ChildProcess | null = null;
let sandboxReady = false;

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

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Detail {
  messages: MessageView[];
  live: LiveReplyView | null;
  agentStatus: string;
}

const detail = (id: string) => api<Detail>("GET", `/api/conversations/${id}`);

async function conversation(mode: PermissionMode) {
  const conv = await api<{ id: string }>("POST", "/api/conversations");
  await api("PATCH", `/api/conversations/${conv.id}`, { mode });
  return conv.id;
}

/** Sends a message and waits for the reply's run_command step. */
async function ask(id: string, call: Record<string, unknown>): Promise<ToolStep> {
  plan.push(call);
  const before = (await detail(id)).messages.length;
  await api("POST", `/api/conversations/${id}/messages`, { text: "Run it." });
  const reply = await until("the reply", async () => {
    const d = await detail(id);
    return d.messages.slice(before).find((m) => m.role === "assistant");
  });
  const step = reply.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
  if (!step) throw new Error("no tool step");
  return step;
}

const result = (step: ToolStep) =>
  JSON.parse(step.output ?? "null") as {
    exitCode?: number | null;
    output?: string;
    sandboxed?: boolean;
    machine?: string;
    error?: string;
  };

/** Waits for the live reply's command to ask for approval, and answers it. */
async function answer(id: string, decision: "approve" | "deny") {
  const step = await until("the approval", async () => {
    const live = (await detail(id)).live;
    return live?.steps.find(
      (s): s is ToolStep => s.kind === "tool" && s.approval?.state === "pending",
    );
  });
  expect(step.approval?.machine).toBe("laptop");
  await api("POST", `/api/conversations/${id}/commands/${step.approval?.id}`, { decision });
}

beforeAll(async () => {
  if (!existsSync(RUNNER)) throw new Error(`build the Runner first: ${RUNNER} is missing`);
  dir = mkdtempSync(join(tmpdir(), "sling-commands-"));
  work = join(dir, "work");
  await promisify(execFile)("mkdir", ["-p", work]);
  writeFileSync(join(work, "note.txt"), "hello from a file\n");

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

  const env = {
    ...process.env,
    SLING_RUNNER_HOME: join(dir, "runner"),
    SLING_RUNNER_LOG: "warn",
  };
  const cli = (...args: string[]) => promisify(execFile)(RUNNER, args, { env });
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await cli("config", "set", "codex-bin", join(dir, "no-codex-here"));
  await cli("config", "set", "claude-bin", join(dir, "no-claude-here"));
  await cli("config", "set", "max-mode", "full-access");
  await cli("pair", server.url, code, "--name", "laptop");
  runner = spawn(RUNNER, ["run"], { env, stdio: "ignore" });
  const machine = await until("the machine", async () => {
    const list = await api<RunnerView[]>("GET", "/api/runners");
    return list.find((r) => r.online && r.capabilities.some((c) => c.name === "shell"));
  });
  sandboxReady = machine.capabilities.some((c) => c.name === "shell.sandbox" && c.ready);
}, 120_000);

afterAll(async () => {
  runner?.kill("SIGTERM");
  await server?.close();
  await pg?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("commands on the user's machine", () => {
  it("reads files in the sandbox without asking, and can't write there", async (t) => {
    if (!sandboxReady) t.skip();
    const id = await conversation("auto");
    const read = await ask(id, { command: "cat note.txt", cwd: work });
    expect(read.status).toBe("done");
    expect(read.approval).toBeUndefined();
    expect(result(read)).toMatchObject({
      machine: "laptop",
      sandboxed: true,
      exitCode: 0,
      output: "hello from a file\n",
    });

    const write = await ask(id, { command: "touch made.txt", cwd: work });
    expect(result(write).sandboxed).toBe(true);
    expect(result(write).exitCode).not.toBe(0);
    expect(existsSync(join(work, "made.txt"))).toBe(false);
  });

  it("asks before leaving the sandbox, and runs it once approved", async () => {
    const id = await conversation("auto");
    const pending = ask(id, { command: "touch approved.txt", cwd: work, outsideSandbox: true });
    await answer(id, "approve");
    const step = await pending;
    expect(step.approval?.state).toBe("approved");
    expect(result(step)).toMatchObject({ sandboxed: false, exitCode: 0 });
    expect(existsSync(join(work, "approved.txt"))).toBe(true);

    const audited = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.verb, "command.run"));
    expect(audited.map((e) => e.details)).toContainEqual(
      expect.objectContaining({
        command: "touch approved.txt",
        conversationId: id,
        sandboxed: false,
        exitCode: 0,
      }),
    );
    const [approved] = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.verb, "command.approved"));
    expect(approved?.details).toMatchObject({ command: "touch approved.txt" });
  });

  it("doesn't run what the user declines", async () => {
    const id = await conversation("supervised");
    const pending = ask(id, { command: "touch declined.txt", cwd: work, outsideSandbox: true });
    await answer(id, "deny");
    const step = await pending;
    expect(step.approval?.state).toBe("denied");
    expect(result(step).error).toContain("declined");
    expect(existsSync(join(work, "declined.txt"))).toBe(false);
    // An answer that came too late is refused.
    await expect(
      api("POST", `/api/conversations/${id}/commands/${step.approval?.id}`, {
        decision: "approve",
      }),
    ).rejects.toThrow(/409/);
  });

  it("never leaves the sandbox in Read-only", async () => {
    const id = await conversation("read-only");
    const step = await ask(id, { command: "touch nope.txt", cwd: work, outsideSandbox: true });
    expect(result(step).error).toContain("Read-only");
    expect(existsSync(join(work, "nope.txt"))).toBe(false);
  });

  it("runs right away in Full access, and reports a failing command and a bad cwd", async () => {
    const id = await conversation("full-access");
    const step = await ask(id, { command: "touch full.txt && echo made; exit 4", cwd: work });
    expect(step.approval).toBeUndefined();
    expect(result(step)).toMatchObject({ sandboxed: false, exitCode: 4, output: "made\n" });
    expect(existsSync(join(work, "full.txt"))).toBe(true);

    const bad = await ask(id, { command: "ls", cwd: join(work, "missing") });
    expect(result(bad).error).toContain("isn't a directory");
  });
});

// Full access runs these commands without asking, whether or not this
// machine can sandbox them. In Auto, a machine without a sandbox asks first.
describe("the conversation list", () => {
  it("leaves out empty conversations, and shows each one's latest message and status", async () => {
    const empty = await api<{ id: string }>("POST", "/api/conversations");
    const id = await conversation("full-access");
    await ask(id, { command: "echo listed", cwd: work });
    const list = (await api<ConversationPage>("GET", "/api/conversations")).items;
    expect(list.some((c) => c.id === empty.id)).toBe(false);
    const row = list.find((c) => c.id === id);
    expect(row).toMatchObject({
      preview: "Done.",
      previewRole: "assistant",
      taskCount: 0,
      waiting: false,
      agentStatus: "idle",
      source: "app",
    });
    expect(list[0]?.id).toBe(id);
  });

  it("finds conversations by what was said in them", async () => {
    const id = await conversation("full-access");
    plan.push({ command: "true", cwd: work });
    await api("POST", `/api/conversations/${id}/messages`, { text: "Look for the zebra file" });
    await until("its reply", async () =>
      (await detail(id)).messages.some((m) => m.role === "assistant"),
    );
    const hits = (await api<ConversationPage>("GET", "/api/conversations?q=ZEBRA")).items;
    expect(hits.map((c) => c.id)).toEqual([id]);
    expect((await api<ConversationPage>("GET", "/api/conversations?q=100%25")).items).toEqual([]);
  });

  it("marks a conversation with a command waiting for the user", async () => {
    const id = await conversation("auto");
    const pending = ask(id, { command: "touch waiting.txt", cwd: work, outsideSandbox: true });
    await until("the approval", async () => {
      const page = await api<ConversationPage>("GET", "/api/conversations?filter=waiting");
      return (
        page.counts?.waiting === 1 &&
        page.items.find((c) => c.id === id && c.waiting && c.agentStatus === "thinking")
      );
    });
    await answer(id, "deny");
    await pending;
    const list = (await api<ConversationPage>("GET", "/api/conversations")).items;
    expect(list.find((c) => c.id === id)?.waiting).toBe(false);
  });
});
