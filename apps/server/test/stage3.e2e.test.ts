/**
 * Routing and sandboxes end to end, with real Postgres, the control plane
 * in-process, two real sling-runner machines with fake-codex, a TypeScript
 * Runner for labels and Claude Code, and the execution providers from
 * test/fixtures/providers.ts. A scripted mock model plays the assistant.
 *
 * Needs Docker, and the Rust binaries built first:
 *   cargo build -p sling-runner -p sling-harness-codex
 *
 * The process provider test runs the real `sling-runner sandbox`, and skips
 * itself when the Runner build doesn't have that command yet.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  ApprovalView,
  RoutingView,
  RunDetailView,
  RunnerView,
  SandboxListView,
  SandboxSettingsView,
  SandboxView,
  TaskView,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { Error_Code } from "@sling/runner-protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { loadRouterInput } from "../src/routing/inputs.ts";
import { route } from "../src/routing/router.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { withinBudget } from "./fixtures/budget.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";
import { calls, recordNode } from "./fixtures/nodes.ts";
import {
  createFakeProvider,
  createProcessProvider,
  hasSandboxCommand,
} from "./fixtures/providers.ts";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");
const FAKE_CODEX = join(ROOT, "target/debug/fake-codex");
const HAS_SANDBOX_COMMAND = existsSync(RUNNER) && hasSandboxCommand(RUNNER);

/** A remote on a host that never resolves, so machines share a repo identity without network. */
const REMOTE = "https://git.sling.invalid/acme/site.git";
const KEY = "git.sling.invalid/acme/site";

const SECRETS = {
  openai: "sk-openai-e2e-5bd9c1e07a",
  anthropic: "sk-ant-e2e-77f3a2c9d1",
  git: "ghp_e2eGitToken0f9e8d7c6b",
  provider: "fake-provider-token-3c4d5e",
};

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

/** Tool calls the assistant makes next, one per user message. */
const plan: { tool: string; input: unknown }[] = [];

/** Calls the planned tool, then repeats the tool's result back as its reply. */
const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const last = options.prompt.at(-1);
    if (last?.role === "tool") {
      const result = last.content.find((p) => p.type === "tool-result");
      return text(`Tool result: ${JSON.stringify(result?.output)}`);
    }
    const userText =
      last?.role === "user"
        ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        : "";
    if (userText.startsWith("[Sling update]")) return text("Noted.");
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

const fake = createFakeProvider();
let proc: ReturnType<typeof createProcessProvider>;
let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let dir: string;
let bare: string;
let cookie = "";
let origin = "";
const runners: Record<string, ChildProcess | null> = { alpha: null, bravo: null };
const ids: Record<string, string> = {};
let iosMac: FakeRunner;
let fakeHost: { id: string };

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function raw(method: string, path: string, body?: unknown) {
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
  return { status: res.status, body: data ? JSON.parse(data) : null, text: data };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.body as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  });
}

const runnerEnv = (name: string) => ({
  ...process.env,
  SLING_RUNNER_HOME: join(dir, name),
  FAKE_CODEX_DELAY_MS: "40",
  SLING_RUNNER_LOG: "warn",
  GIT_TERMINAL_PROMPT: "0",
});

const execFileAsync = promisify(execFile);

async function runnerCli(name: string, ...args: string[]) {
  const { stdout } = await execFileAsync(RUNNER, args, { env: runnerEnv(name), encoding: "utf8" });
  return stdout;
}

function startRunner(name: string) {
  runners[name] = spawn(RUNNER, ["run"], { env: runnerEnv(name), stdio: "ignore" });
}

async function stopRunner(name: string, signal: NodeJS.Signals = "SIGTERM") {
  const r = runners[name];
  runners[name] = null;
  if (!r || r.exitCode !== null) return;
  await new Promise<void>((ok) => {
    r.once("exit", () => ok());
    r.kill(signal);
  });
}

/** A machine with its own clone of site, whose origin is the shared remote. */
async function pairMachine(name: string) {
  const clone = join(dir, `${name}-site`);
  git(dir, "clone", "-q", bare, clone);
  git(clone, "remote", "set-url", "origin", REMOTE);
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await runnerCli(name, "repo", "add", clone, "--name", "site");
  await runnerCli(name, "config", "set", "codex-bin", FAKE_CODEX);
  // Otherwise a real `claude` on PATH would make Claude Code look installed.
  await runnerCli(name, "config", "set", "claude-bin", join(dir, "no-claude-here"));
  await runnerCli(name, "pair", server.url, code, "--name", name);
  startRunner(name);
}

interface CreatedTask {
  id: string;
  state: string;
  environment: string;
  routing: RoutingView;
  approvalId: string | null;
}

const task = async (id: string) => (await api<{ task: TaskView }>("GET", `/api/tasks/${id}`)).task;
const machines = () => api<RunnerView[]>("GET", "/api/runners");
const sandboxes = () => api<SandboxListView>("GET", "/api/sandboxes");
const sandbox = async (id: string | null) =>
  (await sandboxes()).sandboxes.find((s) => s.id === id) ?? null;

async function newTask(body: Record<string, unknown>): Promise<CreatedTask> {
  return api<CreatedTask>("POST", "/api/tasks", {
    repo: "site",
    title: "A change",
    objective: "Change something.",
    deliver: "local",
    mode: "auto",
    ...body,
  });
}

async function workspace() {
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers);
  if (!m) throw new Error("no workspace");
  return { workspaceId: m.workspaceId, userId: m.userId };
}

async function setFakeBehavior(behavior: "boot" | "no-boot" | "fail-create") {
  await api("PATCH", `/api/installations/${fakeHost.id}`, { config: { behavior } });
}

beforeAll(async () => {
  if (!existsSync(RUNNER) || !existsSync(FAKE_CODEX)) {
    throw new Error("Build the Runner first: cargo build -p sling-runner -p sling-harness-codex");
  }
  if (!HAS_SANDBOX_COMMAND) {
    console.warn(
      "sling-runner has no `sandbox` command in this build, so the process provider test is skipped. The fake provider covers the same flow in-process.",
    );
  }
  dir = mkdtempSync(join(tmpdir(), "sling-e2e3-"));
  proc = createProcessProvider({
    runnerBin: RUNNER,
    workDir: join(dir, "sandboxes"),
    extraEnv: { FAKE_CODEX_DELAY_MS: "40" },
  });
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
    testing: { sandboxCodexBin: FAKE_CODEX, allowLocalCloneUrls: true },
  };
  server = await startServer(config, {
    model,
    jobs: false,
    connectors: [fake.connector, proc.connector],
    nodes: [recordNode],
  });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });

  bare = join(dir, "remote.git");
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# site\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "-u", "origin", "main");

  // alpha pairs first, so it wins ties on pairing order.
  await pairMachine("alpha");
  await until(
    "alpha online",
    async () => (await machines()).find((m) => m.name === "alpha")?.online,
  );
  await pairMachine("bravo");
  await until(
    "bravo online",
    async () => (await machines()).find((m) => m.name === "bravo")?.online,
  );
  for (const m of await machines()) ids[m.name] = m.id;
}, 180_000);

afterAll(async () => {
  await stopRunner("alpha", "SIGKILL");
  await stopRunner("bravo", "SIGKILL");
  iosMac?.close();
  for (const s of fake.state.live.values()) s.runner?.close();
  for (const s of proc?.sandboxes.values() ?? []) s.child.kill("SIGKILL");
  await server?.close();
  await pg?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- routing

describe("routing between machines", () => {
  it("reports labels and remote keys for machines", async () => {
    const list = await machines();
    expect(list.map((m) => m.name)).toEqual(["alpha", "bravo"]);
    for (const m of list) {
      expect(m.ephemeral).toBe(false);
      expect(m.sandboxId).toBeNull();
      expect(m.labels.some((l) => l.startsWith("os:"))).toBe(true);
      expect(m.labels.some((l) => l.startsWith("arch:"))).toBe(true);
      expect(m.repos).toMatchObject([{ name: "site", remoteKey: KEY }]);
    }
  });

  it("auto-routes by free slots, then by who ran the repo last, then by pairing order", async () => {
    const first = await newTask({ title: "Hang one", objective: "[fake:hang] one" });
    expect(first.environment).toBe("machine");
    expect(first.routing.target).toMatchObject({ kind: "machine", runnerName: "alpha" });
    expect(first.routing.reason).toBe("Runs on alpha: it was paired first.");
    expect(first.routing.considered).toEqual([
      {
        runnerId: ids.alpha,
        runnerName: "alpha",
        eligible: true,
        reason: "Picked: it was paired first",
      },
      {
        runnerId: ids.bravo,
        runnerName: "bravo",
        eligible: true,
        reason: "Eligible, 2 of 2 slots free",
      },
    ]);
    await until("first running", async () => (await task(first.id)).state === "running");

    const second = await newTask({ title: "Hang two", objective: "[fake:hang] two" });
    expect(second.routing.reason).toBe(
      "Runs on bravo: it has the most free slots (2 of 2 slots free).",
    );
    await until("second running", async () => (await task(second.id)).state === "running");

    const third = await newTask({ title: "Hang three", objective: "[fake:hang] three" });
    expect(third.routing.reason).toBe(
      "Runs on bravo: it ran site most recently, so its worktrees and caches are warm.",
    );
    const view = await task(third.id);
    expect(view).toMatchObject({
      runnerName: "bravo",
      harness: "codex",
      environment: { kind: "machine", sandboxId: null, sandboxState: null, providerName: null },
      routing: { reason: third.routing.reason },
    });

    for (const t of [first, second, third]) await api("POST", `/api/tasks/${t.id}/cancel`);
    for (const t of [first, second, third]) {
      await until("cancelled", async () => (await task(t.id)).state === "cancelled");
    }
  });

  it("decides in well under 20 ms, database reads included", async () => {
    const { workspaceId } = await workspace();
    const request = {
      repo: "site",
      harness: "codex" as const,
      labels: [],
      environment: "auto" as const,
      machineId: null,
      providerInstallationId: null,
    };
    await loadRouterInput(server.ctx, workspaceId, request, "auto");
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      route(await loadRouterInput(server.ctx, workspaceId, request, "auto"));
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    withinBudget(times[Math.floor(times.length * 0.95)] ?? Infinity, 20);
  });

  it("puts a named machine first, and keeps runnerId working", async () => {
    const named = await newTask({ machineId: ids.bravo, title: "Named machine" });
    expect(named.routing.reason).toBe("Runs on bravo: you asked for it.");
    await until("named done", async () => (await task(named.id)).state === "succeeded");

    const old = await api<CreatedTask>("POST", "/api/tasks", {
      runnerId: ids.alpha,
      repo: "site",
      title: "Old client",
      objective: "Edit.",
      deliver: "local",
    });
    expect(old.routing.target).toMatchObject({ runnerName: "alpha" });
    expect(old.routing.considered.find((c) => c.runnerName === "bravo")?.reason).toBe(
      "Not the machine you asked for",
    );
    await until("old done", async () => (await task(old.id)).state === "succeeded");
  });

  it("routes by label and by coding agent, and uses the default agent", async () => {
    const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
    iosMac = new FakeRunner({
      url: server.url,
      name: "ios-mac",
      repos: [{ name: "site", remoteUrl: REMOTE }],
      harnesses: ["codex", "claude-code"],
      labels: ["iOS", "xcode"],
      os: "macos",
      arch: "aarch64",
    });
    await iosMac.pair(code);
    await iosMac.connect();
    const mac = (await machines()).find((m) => m.name === "ios-mac");
    expect(mac?.labels).toEqual(["ios", "xcode", "os:macos", "arch:aarch64"]);

    const build = await newTask({ title: "Run the iOS build", labels: ["ios"] });
    expect(build.routing.target).toMatchObject({ runnerName: "ios-mac" });
    expect(build.routing.considered.find((c) => c.runnerName === "alpha")?.reason).toBe(
      "Doesn't have the label ios",
    );
    await until("ios build done", async () => (await task(build.id)).state === "succeeded");

    const claude = await newTask({ title: "With Claude Code", harness: "claude-code" });
    expect(claude.routing.target).toMatchObject({ runnerName: "ios-mac" });
    expect(claude.routing.considered.find((c) => c.runnerName === "bravo")?.reason).toBe(
      "Claude Code isn't installed",
    );
    await until("claude done", async () => (await task(claude.id)).state === "succeeded");
    expect(iosMac.assigned.at(-1)).toMatchObject({ taskId: claude.id, harness: "claude-code" });
    expect((await task(claude.id)).harness).toBe("claude-code");

    const settings = await api<SandboxSettingsView>("PUT", "/api/settings/sandboxes", {
      defaultHarness: "claude-code",
    });
    expect(settings.defaultHarness).toBe("claude-code");
    const byDefault = await newTask({ title: "Default agent" });
    expect(byDefault.routing.target).toMatchObject({ runnerName: "ios-mac" });
    await until("default done", async () => (await task(byDefault.id)).state === "succeeded");
    expect(iosMac.assigned.at(-1)).toMatchObject({ harness: "claude-code" });
    await api("PUT", "/api/settings/sandboxes", { defaultHarness: "codex" });

    const gpu = await raw("POST", "/api/tasks", {
      repo: "site",
      title: "Train it",
      objective: "Train the model.",
      labels: ["gpu"],
    });
    expect(gpu.status).toBe(400);
    expect(gpu.body.error).toMatch(/^No machine can take this task\./);
    expect(gpu.body.reasons.slice(0, 3)).toEqual([
      "alpha: Doesn't have the label gpu",
      "bravo: Doesn't have the label gpu",
      "ios-mac: Doesn't have the label gpu",
    ]);
  });

  it("delegates through the assistant without picking a machine, and explains refusals", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    plan.push({
      tool: "delegate_coding_task",
      input: {
        repo: "site",
        title: "Fix the footer",
        objective: "Change the footer year to 2026.",
        deliver: "local",
      },
    });
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Fix the footer." });
    const started = await until("assistant reply", async () => {
      const d = await api<{ messages: { role: string; text: string }[] }>(
        "GET",
        `/api/conversations/${conv.id}`,
      );
      return d.messages.find((m) => m.role === "assistant" && m.text.startsWith("Tool result"));
    });
    // ios-mac ran site last, in the label and agent test.
    expect(started.text).toContain('"machine":"ios-mac"');
    expect(started.text).toContain("Runs on ios-mac: it ran site most recently");
    // The footer task finishes at once and its update gets a reply of its own. Wait for it,
    // or the update can land after the next message and that turn answers it instead.
    await until("reply to the task's update", async () => {
      const d = await api<{ messages: { role: string; text: string }[] }>(
        "GET",
        `/api/conversations/${conv.id}`,
      );
      return d.messages.some((m) => m.role === "assistant" && m.text === "Noted.");
    });

    plan.push({
      tool: "delegate_coding_task",
      input: {
        repo: "site",
        title: "Train the model",
        objective: "Train it on the GPU box.",
        labels: ["gpu"],
      },
    });
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Train it on a GPU." });
    const refused = await until("refusal reply", async () => {
      const d = await api<{ messages: { role: string; text: string }[] }>(
        "GET",
        `/api/conversations/${conv.id}`,
      );
      return d.messages.find((m) => m.role === "assistant" && m.text.includes("reasons"));
    });
    expect(refused.text).toContain("alpha: Doesn't have the label gpu");
  });

  it("keeps a machine online that reconnects while its old connection's last frame is handled", async () => {
    const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
    const quick = new FakeRunner({ url: server.url, name: "quick-restart", repos: [] });
    const id = await quick.pair(code);
    await quick.connect();
    // Hold the server on the old connection's last frame.
    let release = () => {};
    const held = new Promise<void>((ok) => {
      release = ok;
    });
    const slow = vi.spyOn(server.ctx.tasks, "inventoryUpdated").mockImplementationOnce(() => held);
    quick.sendInventory();
    await until("the frame held", async () => slow.mock.calls.length > 0);
    quick.close();
    await until("the old connection gone", async () => !server.ctx.runners.isOnline(id));
    await quick.connect();
    release();
    await until("the held frame handled", async () => slow.mock.results[0]?.type === "return");
    await new Promise((ok) => setTimeout(ok, 300));
    expect((await machines()).find((m) => m.id === id)?.online).toBe(true);
    slow.mockRestore();
    quick.close();
    await api("DELETE", `/api/runners/${id}`);
  });
});

// ---------------------------------------------------------------- sandboxes

describe("sandboxes", () => {
  it("never sends a repo that isn't allowed to a sandbox", async () => {
    await stopRunner("alpha");
    await stopRunner("bravo");
    iosMac.close();
    await until("machines offline", async () => (await machines()).every((m) => !m.online));
    fakeHost = await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "test-fake",
      name: "fake-host",
      credentials: { token: SECRETS.provider },
      config: {},
    });

    const auto = await raw("POST", "/api/tasks", {
      repo: "site",
      title: "Offline change",
      objective: "Change it.",
    });
    expect(auto.status).toBe(400);
    expect(auto.body.reasons).toEqual([
      "alpha: Offline",
      "bravo: Offline",
      "ios-mac: Offline",
      `It can't go to a sandbox either: ${KEY} isn't allowed in sandboxes. Turn on Allow in sandboxes for it on the Machines page`,
    ]);
    const asked = await raw("POST", "/api/tasks", {
      repo: "site",
      title: "Sandbox change",
      objective: "Change it.",
      environment: "sandbox",
    });
    expect(asked.status).toBe(400);
    expect(asked.body.error).toBe(
      `Can't run it in a sandbox: ${KEY} isn't allowed in sandboxes. Turn on Allow in sandboxes for it on the Machines page.`,
    );
    expect(fake.state.specs).toHaveLength(0);
  });

  it("validates the sandbox repo list", async () => {
    const path = `/api/sandbox-repos/${encodeURIComponent("github.com/acme/site")}`;
    const http = await raw("PUT", path, { cloneUrl: "http://github.com/acme/site.git" });
    expect(http).toMatchObject({ status: 400, body: { error: "The clone URL must use HTTPS." } });
    const creds = await raw("PUT", path, { cloneUrl: "https://x:tok@github.com/acme/site.git" });
    expect(creds.status).toBe(400);
    const other = await raw("PUT", path, { cloneUrl: "https://github.com/acme/other.git" });
    expect(other.body.error).toBe(
      "The clone URL is for github.com/acme/other, not github.com/acme/site.",
    );
    const ok = await api<{ cloneUrl: string }>("PUT", path, {});
    expect(ok).toMatchObject({
      remoteKey: "github.com/acme/site",
      cloneUrl: "https://github.com/acme/site.git",
      defaultBranch: "main",
      network: false,
    });
    expect(await api("DELETE", path)).toEqual({ ok: true, removed: true });
    expect(await api("DELETE", path)).toEqual({ ok: true, removed: false });
    expect((await raw("PUT", "/api/sandbox-repos/site", {})).status).toBe(400);
  });

  it("offers a sandbox when no machine can take it, then provisions, delivers, and destroys it", async () => {
    const allowed = await api("PUT", `/api/sandbox-repos/${encodeURIComponent(KEY)}`, {
      cloneUrl: `file://${bare}`,
      defaultBranch: "main",
    });
    expect(allowed).toMatchObject({ remoteKey: KEY, cloneUrl: `file://${bare}` });
    expect(await api("GET", "/api/sandbox-repos")).toMatchObject([{ remoteKey: KEY }]);
    const stored = await api<{ secrets: SandboxSettingsView["secrets"] }>(
      "PUT",
      "/api/settings/sandboxes/secrets",
      { openaiApiKey: SECRETS.openai, anthropicApiKey: SECRETS.anthropic, gitToken: SECRETS.git },
    );
    expect(stored.secrets).toEqual({ openaiApiKey: true, anthropicApiKey: true, gitToken: true });

    // A workflow that hears about new approvals, as the Discord template does.
    const def = {
      schema: "sling.workflow/v1",
      name: "Approval watcher",
      description: "",
      nodes: [
        {
          id: "t",
          type: "sling.approval_requested",
          version: 1,
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: "rec",
          type: "test.record",
          version: 1,
          position: { x: 0, y: 0 },
          config: { tag: "approval" },
        },
      ],
      edges: [
        {
          id: "e1",
          kind: "exec",
          from: { node: "t", port: "next" },
          to: { node: "rec", port: "in" },
        },
        {
          id: "e2",
          kind: "data",
          from: { node: "t", port: "approval" },
          to: { node: "rec", port: "value" },
        },
      ],
    };
    const wf = await api<{ id: string }>("POST", "/api/workflows", { definition: def });
    await api("POST", `/api/workflows/${wf.id}/publish`, { note: "test" });
    await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });

    const conv = await api<{ id: string }>("POST", "/api/conversations");
    const created = await api<CreatedTask>("POST", "/api/tasks", {
      repo: "site",
      title: "Fix the footer in a sandbox",
      objective: "Change the footer.",
      deliver: "push",
      conversationId: conv.id,
    });
    expect(created).toMatchObject({ state: "queued", environment: "sandbox" });
    expect(created.approvalId).toBeTruthy();
    expect(created.routing.target).toEqual({
      kind: "sandbox",
      providerInstallationId: fakeHost.id,
      providerName: "fake-host",
    });
    expect(created.routing.reason).toBe(
      "No machine can take it, so it can run in a Fake sandbox on fake-host once you approve.",
    );

    const waiting = await task(created.id);
    expect(waiting).toMatchObject({
      runnerId: null,
      runnerName: null,
      state: "queued",
      environment: {
        kind: "sandbox",
        sandboxId: null,
        sandboxState: null,
        providerName: "fake-host",
      },
    });
    const approval = (await api<ApprovalView[]>("GET", "/api/approvals")).find(
      (a) => a.id === created.approvalId,
    );
    expect(approval).toMatchObject({
      kind: "sandbox_fallback",
      title: 'Run "Fix the footer in a sandbox" in a Fake sandbox?',
      taskId: created.id,
      actionId: null,
      task: { runnerName: "a sandbox on fake-host", remoteUrl: `file://${bare}` },
      payload: {
        taskId: created.id,
        taskTitle: "Fix the footer in a sandbox",
        remoteKey: KEY,
        cloneUrl: `file://${bare}`,
        providerInstallationId: fakeHost.id,
        providerName: "fake-host",
        harness: "codex",
        reasons: ["alpha: Offline", "bravo: Offline", "ios-mac: Offline"],
      },
    });
    const heard = await until("approval_requested fired", async () =>
      calls.find((c) => c.tag === "approval" && (c.value as { id: string }).id === approval?.id),
    );
    expect(heard.value).toMatchObject({
      kind: "sandbox_fallback",
      title: 'Run "Fix the footer in a sandbox" in a Fake sandbox?',
      summary: `Clones ${KEY} into a sandbox on fake-host and runs the task there. No machine could take it: alpha: Offline; bravo: Offline; ios-mac: Offline.`,
      url: `${origin}/approvals`,
    });
    expect(fake.state.specs).toHaveLength(0);

    await api("POST", `/api/approvals/${created.approvalId}`, { decision: "approve" });
    const done = await until("delivered and destroyed", async () => {
      const t = await task(created.id);
      return t.state === "succeeded" &&
        t.actions[0]?.state === "succeeded" &&
        t.environment.sandboxState === "destroyed"
        ? t
        : null;
    });
    expect(done.runnerName).toMatch(/^sandbox-/);
    expect(done.repoName).toBe("site");
    expect(done.environment.providerName).toBe("fake-host");

    const spec = fake.state.specs.at(-1);
    const sandboxId = done.environment.sandboxId;
    expect(spec?.sandboxId).toBe(sandboxId);
    const { workspaceId } = await workspace();
    expect(spec).toMatchObject({
      workspaceId,
      image: "sling-sandbox:latest",
      labels: { "sling.sandbox": sandboxId, "sling.workspace": workspaceId },
      lifetimeSeconds: 3600,
    });
    expect(spec?.env).toMatchObject({
      SLING_URL: origin,
      SLING_SANDBOX_ID: sandboxId,
      SLING_HARNESSES: "codex",
      SLING_MAX_MODE: "full-access",
      SLING_IDLE_EXIT_SECONDS: "900",
      OPENAI_API_KEY: SECRETS.openai,
      SLING_GIT_TOKEN: SECRETS.git,
      SLING_CODEX_BIN: FAKE_CODEX,
    });
    expect(spec?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec?.env.SLING_PAIR_CODE).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(JSON.parse(spec?.env.SLING_REPOS ?? "")).toEqual([
      { name: "site", cloneUrl: `file://${bare}`, defaultBranch: "main", network: false },
    ]);

    const booted = fake.state.live.get(`fake-${sandboxId}`) ?? null;
    expect(booted).toBeNull();
    expect(fake.state.destroyed).toContain(`fake-${sandboxId}`);

    const listed = await sandbox(sandboxId);
    expect(listed).toMatchObject({
      state: "destroyed",
      providerInstallationId: fakeHost.id,
      providerName: "fake-host",
      connectorId: "test-fake",
      taskId: created.id,
      taskTitle: "Fix the footer in a sandbox",
      image: "sling-sandbox:latest",
      externalId: `fake-${sandboxId}`,
      failure: null,
    });
    expect(listed?.readyAt).toBeTruthy();
    expect(listed?.destroyedAt).toBeTruthy();
    expect(listed?.runnerId).toBe(done.runnerId);
    expect(listed?.minutes).toBeGreaterThanOrEqual(0);

    // Its Runner is revoked, hidden from machines, and its code can't pair again.
    const [runnerRow] = await server.ctx.db
      .select()
      .from(schema.runners)
      .where(eq(schema.runners.id, done.runnerId ?? ""));
    expect(runnerRow).toMatchObject({ ephemeral: true, sandboxId });
    expect(runnerRow?.revokedAt).toBeTruthy();
    expect((await machines()).map((m) => m.name)).toEqual(["alpha", "bravo", "ios-mac"]);
    const again = new FakeRunner({ url: server.url, name: "replay", repos: [] });
    await expect(again.pair(spec?.env.SLING_PAIR_CODE ?? "")).rejects.toThrow(/400/);

    // The conversation hears where it ran.
    const d = await until("settle note", async () => {
      const c = await api<{ messages: { role: string; text: string }[] }>(
        "GET",
        `/api/conversations/${conv.id}`,
      );
      return c.messages.find((m) => m.role === "system");
    });
    expect(d.text).toContain("in a sandbox on fake-host, repo site: succeeded.");

    const verbs = (
      await server.ctx.db
        .select({ verb: schema.auditEvents.verb })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.subjectId, sandboxId ?? ""))
    ).map((a) => a.verb);
    expect(verbs).toEqual(
      expect.arrayContaining([
        "sandbox.requested",
        "sandbox.provisioning",
        "sandbox.created",
        "sandbox.paired",
        "sandbox.ready",
        "sandbox.busy",
        "sandbox.releasing",
        "sandbox.destroyed",
      ]),
    );
    await api("PATCH", `/api/workflows/${wf.id}`, { enabled: false });
  });

  it.skipIf(!HAS_SANDBOX_COMMAND)(
    "runs the real sling-runner sandbox through the process provider, pushes, and removes it",
    async () => {
      const local = await api<{ id: string }>("POST", "/api/installations", {
        connectorId: "test-process",
        name: "local-proc",
        config: {},
      });
      const created = await newTask({
        title: "Real sandbox change",
        objective: "Add a line to SLING_FAKE.md.",
        deliver: "push",
        environment: "sandbox",
        providerInstallationId: local.id,
      });
      expect(created.routing.target).toMatchObject({ kind: "sandbox", providerName: "local-proc" });
      const done = await until(
        "pushed and destroyed",
        async () => {
          const t = await task(created.id);
          if (["failed", "rejected", "interrupted"].includes(t.state)) {
            throw new Error(`task ${t.state}: ${t.error}`);
          }
          return t.state === "succeeded" &&
            t.actions[0]?.state === "succeeded" &&
            t.environment.sandboxState === "destroyed"
            ? t
            : null;
        },
        90_000,
      );
      const branches = execFileSync("git", ["branch"], { cwd: bare, encoding: "utf8" });
      expect(branches).toContain(done.branch);
      const entry = proc.sandboxes.get(`proc-${done.environment.sandboxId}`);
      expect(entry).toBeTruthy();
      await entry?.exited;
      await api("DELETE", `/api/installations/${local.id}`);
    },
    120_000,
  );

  it("cancels the task when the fallback is rejected, from Discord or the app", async () => {
    const before = fake.state.specs.length;
    const created = await newTask({ title: "Declined in Discord" });
    expect(created.approvalId).toBeTruthy();
    const { workspaceId, userId } = await workspace();
    expect(
      await server.ctx.tasks.decide(workspaceId, created.approvalId ?? "", userId, false, {
        via: "discord",
        externalUserId: "1234",
      }),
    ).toBe(true);
    const t = await until("cancelled", async () => {
      const v = await task(created.id);
      return v.state === "cancelled" ? v : null;
    });
    expect(t.error).toBe("You chose not to run it in a sandbox, so it was cancelled.");

    const inApp = await newTask({ title: "Declined in the app" });
    expect(await api("POST", `/api/tasks/${inApp.id}/approval`, { decision: "reject" })).toEqual({
      decided: 1,
    });
    await until("cancelled too", async () => (await task(inApp.id)).state === "cancelled");
    expect(fake.state.specs).toHaveLength(before);
  });

  it("cancels the task when the fallback approval expires", async () => {
    const created = await newTask({ title: "Nobody answered" });
    await server.ctx.db
      .update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.approvals.id, created.approvalId ?? ""));
    await server.ctx.tasks.sweep();
    const t = await task(created.id);
    expect(t).toMatchObject({
      state: "cancelled",
      error: "Nobody approved running it in a sandbox within 24 hours, so it was cancelled.",
    });
  });

  it("makes a request wait at the concurrent limit, and starts it when a slot frees", async () => {
    await api("PUT", "/api/settings/sandboxes", { concurrentLimit: 1 });
    const a = await newTask({
      title: "Sandbox A",
      objective: "[fake:hang] a",
      environment: "sandbox",
    });
    expect(a.routing.reason).toBe("Runs in a Fake sandbox on fake-host, as you asked.");
    const aRunning = await until("A running", async () => {
      const t = await task(a.id);
      return t.state === "running" && t.environment.sandboxState === "busy" ? t : null;
    });
    const b = await newTask({
      title: "Sandbox B",
      objective: "[fake:hang] b",
      environment: "sandbox",
    });
    const bWaiting = await task(b.id);
    expect(bWaiting).toMatchObject({
      state: "queued",
      environment: { kind: "sandbox", sandboxState: "requested" },
    });
    const list = await sandboxes();
    expect(list.usage).toMatchObject({ running: 1, concurrentLimit: 1 });

    await api("POST", `/api/tasks/${a.id}/cancel`);
    await until("A's sandbox destroyed", async () => {
      return (await sandbox(aRunning.environment.sandboxId))?.state === "destroyed";
    });
    await until("B running", async () => {
      const t = await task(b.id);
      return t.state === "running" && t.environment.sandboxState === "busy";
    });
    await api("POST", `/api/tasks/${b.id}/cancel`);
    await until(
      "B destroyed",
      async () => (await task(b.id)).environment.sandboxState === "destroyed",
    );
    await api("PUT", "/api/settings/sandboxes", { concurrentLimit: 2 });
  });

  it("refuses new sandboxes once the monthly minutes are used up", async () => {
    const { workspaceId, userId } = await workspace();
    const spentId = newId("sbx");
    await server.ctx.db.insert(schema.sandboxes).values({
      id: spentId,
      workspaceId,
      ownerId: userId,
      providerInstallationId: fakeHost.id,
      state: "destroyed",
      remoteKey: KEY,
      readyAt: new Date(Date.now() - 5 * 60_000),
      destroyedAt: new Date(),
      minutes: 5,
    });
    // Offered while there's budget, then approved after it's gone.
    const late = await newTask({ title: "Approved too late" });
    await api("PUT", "/api/settings/sandboxes", {
      monthlyMinutesBudget: 1,
      costPerHour: { [fakeHost.id]: 1.2 },
    });

    const asked = await raw("POST", "/api/tasks", {
      repo: "site",
      title: "Over budget",
      objective: "Change it.",
      environment: "sandbox",
    });
    expect(asked.status).toBe(400);
    expect(asked.body.error).toBe(
      "Can't run it in a sandbox: this month's 1 sandbox minutes are used up. Raise the budget in Settings to run more.",
    );
    const auto = await raw("POST", "/api/tasks", {
      repo: "site",
      title: "Over budget too",
      objective: "Change it.",
    });
    expect(auto.body.reasons.at(-1)).toBe(
      "It can't go to a sandbox either: this month's 1 sandbox minutes are used up. Raise the budget in Settings to run more",
    );
    const usage = (await sandboxes()).usage;
    expect(usage.monthMinutes).toBeGreaterThanOrEqual(5);
    expect(usage.monthlyMinutesBudget).toBe(1);
    expect(usage.estimatedMonthCost).toBeGreaterThanOrEqual(0.1);

    await api("POST", `/api/approvals/${late.approvalId}`, { decision: "approve" });
    const failed = await until("approved too late fails", async () => {
      const t = await task(late.id);
      return t.state === "failed" ? t : null;
    });
    expect(failed.error).toBe(
      "Couldn't run it in a sandbox: This month's 1 sandbox minutes are used up. Raise the budget in Settings to run more.",
    );
    await server.ctx.sandboxes.idle();
    expect(await sandbox(failed.environment.sandboxId)).toMatchObject({
      state: "destroyed",
      failure:
        "This month's 1 sandbox minutes are used up. Raise the budget in Settings to run more.",
    });

    await server.ctx.db.delete(schema.sandboxes).where(eq(schema.sandboxes.id, spentId));
    await api("PUT", "/api/settings/sandboxes", { monthlyMinutesBudget: 600, costPerHour: {} });
  });

  it("destroys a sandbox past its lifetime and interrupts its task", async () => {
    const created = await newTask({
      title: "Runs too long",
      objective: "[fake:hang] forever",
      environment: "sandbox",
    });
    const running = await until("running in a sandbox", async () => {
      const t = await task(created.id);
      return t.state === "running" && t.environment.sandboxState === "busy" ? t : null;
    });
    const sandboxId = running.environment.sandboxId ?? "";
    const booted = fake.state.live.get(`fake-${sandboxId}`);
    await server.ctx.db
      .update(schema.sandboxes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sandboxes.id, sandboxId));
    await server.ctx.sandboxes.sweep();
    await server.ctx.sandboxes.idle();
    const t = await task(created.id);
    expect(t).toMatchObject({
      state: "interrupted",
      error: "The sandbox was destroyed: It reached its 60-minute lifetime.",
    });
    expect(await sandbox(sandboxId)).toMatchObject({
      state: "destroyed",
      failure: "It reached its 60-minute lifetime.",
    });
    expect(booted?.runner?.errors).toContain(Error_Code.REVOKED);
  });

  it("fails a sandbox whose Runner never connects", async () => {
    await setFakeBehavior("no-boot");
    const created = await newTask({ title: "Never boots", environment: "sandbox" });
    const provisioning = await until("provisioning", async () => {
      const t = await task(created.id);
      const s = await sandbox(t.environment.sandboxId);
      return s?.state === "provisioning" && s.externalId ? s : null;
    });
    await server.ctx.db
      .update(schema.sandboxes)
      .set({ provisioningAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(schema.sandboxes.id, provisioning.id));
    await server.ctx.sandboxes.sweep();
    await server.ctx.sandboxes.idle();
    expect(await task(created.id)).toMatchObject({
      state: "failed",
      error: "Couldn't run it in a sandbox: Its Runner didn't connect within 10 minutes.",
    });
    expect(await sandbox(provisioning.id)).toMatchObject({
      state: "destroyed",
      failure: "Its Runner didn't connect within 10 minutes.",
    });
    expect(fake.state.destroyed).toContain(provisioning.externalId);
    await setFakeBehavior("boot");
  });

  it("fails a sandbox the provider can't start, without leaking the provider's token", async () => {
    await setFakeBehavior("fail-create");
    const created = await newTask({ title: "Provider says no", environment: "sandbox" });
    const t = await until("failed", async () => {
      const v = await task(created.id);
      return v.state === "failed" ? v : null;
    });
    expect(t.error).toBe(
      "Couldn't run it in a sandbox: The provider couldn't start it: the fake host refused token [redacted]",
    );
    await server.ctx.sandboxes.idle();
    const s = await sandbox(t.environment.sandboxId);
    expect(s).toMatchObject({ state: "destroyed", externalId: null });
    expect(s?.failure).not.toContain(SECRETS.provider);
    await setFakeBehavior("boot");
  });

  it("destroys sandboxes from the Sandboxes page", async () => {
    const created = await newTask({
      title: "Destroy me",
      objective: "[fake:hang] wait",
      environment: "sandbox",
    });
    const running = await until("running", async () => {
      const t = await task(created.id);
      return t.state === "running" ? t : null;
    });
    const id = running.environment.sandboxId ?? "";
    expect(await api("POST", `/api/sandboxes/${id}/destroy`)).toEqual({ ok: true });
    expect(await task(created.id)).toMatchObject({
      state: "interrupted",
      error: "You destroyed its sandbox.",
    });
    expect(await sandbox(id)).toMatchObject({
      state: "destroyed",
      failure: "Destroyed from the Sandboxes page.",
    });
    expect((await raw("POST", `/api/sandboxes/${id}/destroy`)).status).toBe(409);
    expect((await raw("POST", "/api/sandboxes/sbx_nope/destroy")).status).toBe(404);
  });

  it("removes what the provider still runs after Sling destroyed it", async () => {
    const gone = (await sandboxes()).sandboxes.find((s) => s.state === "destroyed");
    if (!gone) throw new Error("no destroyed sandbox");
    fake.state.strays.set("fake-leftover", gone.id);
    fake.state.strays.set("fake-unlabelled", null);
    const destroyedBefore = fake.state.destroyed.length;
    await server.ctx.sandboxes.sweep();
    expect(fake.state.destroyed.slice(destroyedBefore).sort()).toEqual([
      "fake-leftover",
      "fake-unlabelled",
    ]);
    expect(fake.state.strays.size).toBe(0);
    const audits = await server.ctx.db
      .select({ verb: schema.auditEvents.verb, details: schema.auditEvents.details })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.verb, "sandbox.orphan_destroyed"));
    expect(audits).toHaveLength(2);
  });

  it("refuses to delete a provider that still has a sandbox", async () => {
    await setFakeBehavior("no-boot");
    const created = await newTask({ title: "Keeps the provider", environment: "sandbox" });
    const t = await until("provisioning", async () => {
      const v = await task(created.id);
      return v.environment.sandboxState === "provisioning" ? v : null;
    });
    const del = await raw("DELETE", `/api/installations/${fakeHost.id}`);
    expect(del.status).toBe(409);
    await api("POST", `/api/sandboxes/${t.environment.sandboxId}/destroy`);
    await setFakeBehavior("boot");
  });

  it("lets a workflow delegate to a sandbox and see where the task ran", async () => {
    const def = {
      schema: "sling.workflow/v1",
      name: "Sandbox delegate",
      description: "",
      nodes: [
        { id: "t", type: "core.manual", version: 1, position: { x: 0, y: 0 }, config: {} },
        {
          id: "w",
          type: "agent.delegate_coding_task",
          version: 1,
          position: { x: 0, y: 0 },
          config: {
            repo: KEY,
            title: "Workflow sandbox task",
            objective: "Change it from a workflow.",
            deliver: "local",
            environment: "sandbox",
            providerInstallationId: "fake-host",
          },
        },
        {
          id: "rec",
          type: "test.record",
          version: 1,
          position: { x: 0, y: 0 },
          config: { tag: "wf-task" },
        },
      ],
      edges: [
        {
          id: "e1",
          kind: "exec",
          from: { node: "t", port: "next" },
          to: { node: "w", port: "in" },
        },
        {
          id: "e2",
          kind: "exec",
          from: { node: "w", port: "next" },
          to: { node: "rec", port: "in" },
        },
        {
          id: "e3",
          kind: "data",
          from: { node: "w", port: "task" },
          to: { node: "rec", port: "value" },
        },
      ],
    };
    const wf = await api<{ id: string }>("POST", "/api/workflows", { definition: def });
    await api("POST", `/api/workflows/${wf.id}/publish`, { note: "test" });
    const run = await api<{ id: string }>("POST", `/api/workflows/${wf.id}/run`, { input: null });
    const done = await until("run finished", async () => {
      const r = await api<RunDetailView>("GET", `/api/runs/${run.id}`);
      return ["succeeded", "failed"].includes(r.run.status) ? r : null;
    });
    expect(done.run.error).toBeNull();
    const rec = calls.find((c) => c.tag === "wf-task" && c.runId === run.id);
    expect(rec?.value).toMatchObject({
      title: "Workflow sandbox task",
      state: "succeeded",
      runnerName: "a sandbox on fake-host",
      environment: "sandbox",
      providerName: "fake-host",
      settleReason: "finished",
    });
    const taskId = (rec?.value as { id: string } | undefined)?.id ?? "";
    await until("its sandbox destroyed", async () => {
      return (await task(taskId)).environment.sandboxState === "destroyed";
    });
  });

  it("never shows secrets in API responses or audit details", async () => {
    const pairCodes = fake.state.specs.map((s) => s.env.SLING_PAIR_CODE ?? "").filter(Boolean);
    expect(pairCodes.length).toBeGreaterThan(3);
    const views = await Promise.all(
      [
        "/api/sandboxes",
        "/api/settings/sandboxes",
        "/api/sandbox-repos",
        "/api/tasks",
        "/api/approvals?state=pending",
        "/api/approvals?state=approved",
        "/api/approvals?state=rejected",
        "/api/approvals?state=expired",
        "/api/installations",
        "/api/runners",
        "/api/connectors",
        "/api/settings",
      ].map((p) => raw("GET", p).then((r) => r.text)),
    );
    const audit = await server.ctx.db.select().from(schema.auditEvents);
    const events = await server.ctx.db.select().from(schema.taskEvents);
    const messages = await server.ctx.db.select().from(schema.messages);
    const nodeRuns = await server.ctx.db.select().from(schema.nodeRuns);
    const haystack = [
      ...views,
      JSON.stringify(audit),
      JSON.stringify(events),
      JSON.stringify(messages),
      JSON.stringify(nodeRuns),
    ].join("\n");
    for (const secret of [...Object.values(SECRETS), ...pairCodes]) {
      expect(haystack).not.toContain(secret);
    }
    const settings = await api<SandboxSettingsView>("GET", "/api/settings/sandboxes");
    expect(settings).toEqual({
      defaultHarness: "codex",
      concurrentLimit: 2,
      lifetimeMinutes: 60,
      monthlyMinutesBudget: 600,
      costPerHour: {},
      secrets: { openaiApiKey: true, anthropicApiKey: true, gitToken: true },
    });
    const cleared = await api<{ secrets: SandboxSettingsView["secrets"] }>(
      "PUT",
      "/api/settings/sandboxes/secrets",
      { anthropicApiKey: "" },
    );
    expect(cleared.secrets).toEqual({ openaiApiKey: true, anthropicApiKey: false, gitToken: true });
    const connectors = await api<{ id: string; isExecutionProvider?: boolean }[]>(
      "GET",
      "/api/connectors",
    );
    expect(connectors.find((c) => c.id === "test-fake")?.isExecutionProvider).toBe(true);
  });

  it("publishes sandbox views with the fields the Sandboxes page needs", async () => {
    const list = await sandboxes();
    const sample: SandboxView | undefined = list.sandboxes[0];
    expect(Object.keys(sample ?? {}).sort()).toEqual(
      [
        "connectorId",
        "destroyedAt",
        "externalId",
        "failure",
        "id",
        "image",
        "minutes",
        "providerInstallationId",
        "providerName",
        "readyAt",
        "requestedAt",
        "runnerId",
        "state",
        "taskId",
        "taskTitle",
      ].sort(),
    );
  });
});
