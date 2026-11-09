/**
 * Stage 1 end to end: real Postgres, the control plane in-process, the real
 * sling-runner binary, and fake-codex standing in for Codex. A scripted mock
 * model plays the master agent.
 *
 * Needs Docker, and the Rust binaries built first:
 *   cargo build -p sling-runner -p sling-harness-codex
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");
const FAKE_CODEX = join(ROOT, "target/debug/fake-codex");

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

const call = (toolName: string, input: unknown) =>
  respond(
    [{ type: "tool-call", toolCallId: `call_${toolName}`, toolName, input: JSON.stringify(input) }],
    "tool-calls",
  );

/**
 * Plays the master agent: list machines, delegate to the first one, then
 * report back when a [Sling update] arrives.
 */
const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const last = options.prompt.at(-1);
    if (last?.role === "tool") {
      const result = last.content.find((p) => p.type === "tool-result");
      if (result?.toolName === "list_machines") {
        const output = result.output as {
          type: "json";
          value: { id: string; repos: { name: string }[] }[];
        };
        const machine = output.value[0];
        return call("delegate_coding_task", {
          machineId: machine?.id,
          repo: machine?.repos[0]?.name,
          title: "Add a dark mode line",
          objective: "Add a line to SLING_FAKE.md saying dark mode is supported.",
          deliver: "push",
        });
      }
      return text("Started the task on your machine.");
    }
    const userText =
      last?.role === "user"
        ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        : "";
    if (userText.startsWith("[Sling update]")) {
      return text(`Update received: ${userText.split("\n")[0]}`);
    }
    return call("list_machines", {});
  },
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let dir: string;
let runner: ChildProcess | null = null;
let cookie = "";
let origin = "";

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
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
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
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  });
}

const runnerEnv = () => ({
  ...process.env,
  SLING_RUNNER_HOME: join(dir, "runner"),
  FAKE_CODEX_DELAY_MS: "40",
  SLING_RUNNER_LOG: "warn",
});

const execFileAsync = promisify(execFile);

/** Async on purpose: the server runs in this process and must keep serving. */
async function runnerCli(...args: string[]) {
  const { stdout } = await execFileAsync(RUNNER, args, { env: runnerEnv(), encoding: "utf8" });
  return stdout;
}

function startRunner() {
  runner = spawn(RUNNER, ["run"], { env: runnerEnv(), stdio: "ignore" });
}

async function stopRunner(signal: NodeJS.Signals = "SIGTERM") {
  const r = runner;
  runner = null;
  if (!r || r.exitCode !== null) return;
  await new Promise<void>((ok) => {
    r.once("exit", () => ok());
    r.kill(signal);
  });
}

interface Runner {
  id: string;
  online: boolean;
  repos: { name: string }[];
  maxMode: string;
}
interface Task {
  id: string;
  state: string;
  actions: { kind: string; state: string; approvalId: string | null }[];
  commitSha: string | null;
}

async function machine(): Promise<Runner> {
  const list = await api<Runner[]>("GET", "/api/runners");
  const r = list[0];
  if (!r) throw new Error("no runner");
  return r;
}

const task = async (id: string) => (await api<{ task: Task }>("GET", `/api/tasks/${id}`)).task;

beforeAll(async () => {
  if (!existsSync(RUNNER) || !existsSync(FAKE_CODEX)) {
    throw new Error("Build the Runner first: cargo build -p sling-runner -p sling-harness-codex");
  }
  dir = mkdtempSync(join(tmpdir(), "sling-e2e-"));
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
  };
  server = await startServer(config, { model, jobs: false });

  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });

  // A repo with a local bare remote, so pushes are real but stay on disk.
  const remote = join(dir, "remote.git");
  const repo = join(dir, "site");
  mkdirSync(repo);
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# site\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");

  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await runnerCli("repo", "add", repo);
  await runnerCli("config", "set", "codex-bin", FAKE_CODEX);
  await runnerCli("pair", server.url, code, "--name", "e2e-box");
  startRunner();
  await until("runner online", async () => (await machine()).online);
}, 120_000);

afterAll(async () => {
  await stopRunner("SIGKILL");
  await server?.close();
  await pg?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

describe("Stage 1", () => {
  it("rejects a reused pairing code", async () => {
    const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
    const pair = (c: string) =>
      fetch(`${server.url}/api/runner/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: c,
          publicKey: Buffer.alloc(32, 7).toString("base64"),
          name: "x",
          os: "linux",
          arch: "x86_64",
          hostname: "x",
          version: "0",
        }),
      });
    expect((await pair(code)).status).toBe(200);
    expect((await pair(code)).status).toBe(400);
    // Clean up the extra runner so later tests see one machine.
    const all = await api<Runner[]>("GET", "/api/runners");
    for (const r of all.filter((r) => !r.online)) await api("DELETE", `/api/runners/${r.id}`);
  });

  it("delegates through the agent, runs Codex, pushes, and reports back (Auto)", async () => {
    const conv = await api<{ id: string; mode: string }>("POST", "/api/conversations");
    expect(conv.mode).toBe("auto");
    await api("POST", `/api/conversations/${conv.id}/messages`, {
      text: "Add a dark mode line to site.",
    });

    const detail = await until("task delivered and reported", async () => {
      const d = await api<{
        messages: { role: string; text: string }[];
        tasks: Task[];
      }>("GET", `/api/conversations/${conv.id}`);
      const t = d.tasks[0];
      const reported = d.messages.some(
        (m) => m.role === "assistant" && m.text.startsWith("Update received"),
      );
      return t?.state === "succeeded" && t.actions[0]?.state === "succeeded" && reported ? d : null;
    });
    const t = detail.tasks[0] as Task;
    expect(t.commitSha).toBeTruthy();
    expect(detail.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
      "assistant",
    ]);
    const branches = execFileSync("git", ["branch"], {
      cwd: join(dir, "remote.git"),
      encoding: "utf8",
    });
    expect(branches).toContain("sling/");
  });

  it("waits for approval in Supervised mode, survives a re-read, and pushes once approved", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, { mode: "supervised" });
    const r = await machine();
    const { id } = await api<{ id: string }>("POST", "/api/tasks", {
      runnerId: r.id,
      repo: "site",
      title: "Supervised change",
      objective: "Edit the file.",
      deliver: "push",
      conversationId: conv.id,
    });
    const waiting = await until("awaiting approval", async () => {
      const t = await task(id);
      return t.actions[0]?.state === "awaiting_approval" ? t : null;
    });
    expect(waiting.state).toBe("succeeded");
    const pending = (await api<{ items: { taskId: string }[] }>("GET", "/api/approvals")).items;
    expect(pending.some((a) => a.taskId === id)).toBe(true);

    await api("POST", `/api/tasks/${id}/approval`, { decision: "approve" });
    await until("pushed", async () => (await task(id)).actions[0]?.state === "succeeded");
  });

  it("cancels a running task", async () => {
    const r = await machine();
    const { id } = await api<{ id: string }>("POST", "/api/tasks", {
      runnerId: r.id,
      repo: "site",
      title: "Hang",
      objective: "[fake:hang] wait forever",
      deliver: "local",
      mode: "auto",
    });
    await until("running", async () => (await task(id)).state === "running");
    await api("POST", `/api/tasks/${id}/cancel`);
    await until("cancelled", async () => (await task(id)).state === "cancelled");
  });

  it("marks a task interrupted when the Runner is killed mid-task", async () => {
    const r = await machine();
    const { id } = await api<{ id: string }>("POST", "/api/tasks", {
      runnerId: r.id,
      repo: "site",
      title: "Hang again",
      objective: "[fake:hang] wait",
      deliver: "local",
      mode: "auto",
    });
    await until("running", async () => (await task(id)).state === "running");
    await stopRunner("SIGKILL");
    await until("offline", async () => !(await machine()).online);
    startRunner();
    await until("interrupted", async () => (await task(id)).state === "interrupted");
  });

  it("refuses a mode above the machine's cap", async () => {
    await stopRunner();
    await runnerCli("config", "set", "max-mode", "supervised");
    startRunner();
    await until("cap reported", async () => {
      const m = await machine();
      return m.online && m.maxMode === "supervised";
    });
    const r = await machine();
    await expect(
      api("POST", "/api/tasks", {
        runnerId: r.id,
        repo: "site",
        title: "Too much",
        objective: "Edit.",
        mode: "full-access",
      }),
    ).rejects.toThrow(/at most supervised/);
  });

  it("doesn't rerun a turn that already started a task when the server restarts", async () => {
    const { schema } = await import("@sling/db");
    const { newId, taskBranch } = await import("@sling/core");
    const { advance, initialCursor, recordRun } = await import("@sling/workflow");
    const { eq } = await import("drizzle-orm");
    const db = server.ctx.db;
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    const [row] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conv.id));
    if (!row) throw new Error("no conversation");
    const r = await machine();
    const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.runnerId, r.id));
    if (!repo) throw new Error("no repo");
    // A user message, then a task the interrupted turn had already created.
    await db.insert(schema.messages).values({
      id: newId("msg"),
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      conversationId: row.id,
      role: "user",
      content: { role: "user", content: "Do the thing." },
      createdAt: new Date(Date.now() - 5000),
    });
    const taskId = newId("tsk");
    await db.insert(schema.tasks).values({
      id: taskId,
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      conversationId: row.id,
      runnerId: r.id,
      repoId: repo.id,
      repoName: repo.name,
      title: "Half-finished turn",
      objective: "x",
      mode: "auto",
      state: "cancelled",
      branch: taskBranch(taskId, "x"),
    });

    // The Sling Assistant run as the dead process left it: the assistant node mid-turn.
    const assistantId = await server.ctx.workflows.assistantId(row.workspaceId);
    const [wf] = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, assistantId ?? ""));
    if (!wf?.activeVersionId) throw new Error("no Sling Assistant");
    const version = await server.ctx.engine.version(wf.activeVersionId);
    if (!version) throw new Error("no version");
    const conversation = { id: row.id, key: row.id, mode: row.mode, title: row.title };
    let cursor = initialCursor(version.graph, "chat", {
      conversation,
      key: row.id,
      message: "Do the thing.",
      messageId: "msg_x",
    });
    cursor = advance(
      version.graph,
      recordRun(cursor, "conversation", { conversation }),
      "conversation",
      "next",
    );
    expect(cursor.next).toBe("assistant");
    const runId = newId("run");
    const nodeRunId = newId("nrn");
    cursor = { ...cursor, inFlight: { nodeId: "assistant", nodeRunId, iteration: 0, attempt: 1 } };
    await db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      workflowId: wf.id,
      versionId: version.id,
      status: "running",
      triggerNodeId: "chat",
      triggerType: "app.chat_message",
      triggerPayload: { outputs: {}, installationId: null },
      concurrencyKey: row.id,
      cursor: cursor as unknown as Record<string, unknown>,
      startedAt: new Date(),
    });
    await db.insert(schema.nodeRuns).values({
      id: nodeRunId,
      runId,
      workspaceId: row.workspaceId,
      nodeId: "assistant",
      nodeType: "agent.assistant",
      status: "running",
      idempotencyKey: `${runId}:assistant:0`,
      // Stamped by this process's clock, as the engine does. The database's
      // clock can run ahead of it and sort the retry first.
      startedAt: new Date(),
    });

    const calls = model.doStreamCalls.length;
    await server.ctx.engine.recover();
    const done = await until("interrupted run finished", async () => {
      const d = await api<{
        run: { status: string };
        nodeRuns: {
          nodeId: string;
          attempt: number;
          status: string;
          error: { code: string } | null;
        }[];
      }>("GET", `/api/runs/${runId}`);
      return d.run.status === "succeeded" ? d : null;
    });
    const assistantRuns = done.nodeRuns.filter((n) => n.nodeId === "assistant");
    expect(assistantRuns.map((n) => [n.attempt, n.status, n.error?.code ?? null])).toEqual([
      [1, "failed", "interrupted"],
      [2, "succeeded", null],
    ]);
    const d = await api<{ messages: { role: string; text: string }[] }>(
      "GET",
      `/api/conversations/${conv.id}`,
    );
    expect(d.messages.at(-1)?.text).toMatch(/server restarted/);
    expect(model.doStreamCalls.length).toBe(calls);
  });

  it("revokes a Runner, which then stops for good", async () => {
    const r = await machine();
    const proc = runner;
    const exited = new Promise<number | null>((ok) => proc?.once("exit", (code) => ok(code)));
    await api("DELETE", `/api/runners/${r.id}`);
    expect(await exited).toBe(78);
    runner = null;
    expect(await api<Runner[]>("GET", "/api/runners")).toHaveLength(0);
  });
});
