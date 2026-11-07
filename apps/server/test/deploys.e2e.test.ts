/**
 * Deploys end to end: real Postgres, the control plane in-process, a git
 * remote served over HTTP, a local site to deploy and check, and a scripted
 * mock model as the assistant.
 *
 * The flows run on two machines. The TypeScript Runner in
 * test/fixtures/fake-runner.ts answers merges and deploys with real git and
 * the real Runner's refusals. The real sling-runner with fake-codex runs the
 * same flows, and skips them until its build reports `deploys` in its
 * inventory.
 *
 * Needs Docker, and the Rust binaries built first:
 *   cargo build -p sling-runner -p sling-harness-codex
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  ActionView,
  ApprovalView,
  DeployTargetView,
  PermissionMode,
  RunnerView,
  ServerEvent,
  TaskView,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { PermissionMode as ProtoMode } from "@sling/runner-protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";
import { type GitServer, serveGit } from "./fixtures/git-http.ts";
import { createFakeProvider } from "./fixtures/providers.ts";
import { TestSite } from "./fixtures/site.ts";

vi.setConfig({ testTimeout: 90_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");
const FAKE_CODEX = join(ROOT, "target/debug/fake-codex");
const HOOK_SECRET = "hook-token-5e1f9a";
const GIT_TOKEN = "ghp_deployE2eToken9c8b7a";
/** A repo the TypeScript Runner has without git, for timing many deploys. */
const BENCH_REMOTE = "https://git.sling.invalid/acme/bench.git";
const BENCH_KEY = "git.sling.invalid/acme/bench";
/** A sandbox repo whose PRs live on the fake GitHub. */
const APP_KEY = "github.com/acme/app";

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

/** Tool calls the assistant makes next, in order, across turns. */
const script: { tool: string; input: unknown }[] = [];
/** Every tool result the assistant was shown. */
const toolResults: { toolName: string; value: Record<string, unknown> }[] = [];

/**
 * Calls the scripted tools one after another, then repeats the last tool
 * result. Answers a "[Sling update]" by repeating it, the way a model reports
 * what the update says.
 */
const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const last = options.prompt.at(-1);
    if (last?.role === "tool") {
      for (const part of last.content) {
        if (part.type !== "tool-result") continue;
        const out = part.output as { type: string; value: Record<string, unknown> };
        toolResults.push({ toolName: part.toolName, value: out.value });
      }
    }
    const userText =
      last?.role === "user"
        ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        : "";
    if (userText.startsWith("[Sling update]")) return text(`Reported: ${userText}`);
    const next = script.shift();
    if (next) {
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
    }
    if (last?.role === "tool") return text("Done with the tools.");
    return text("Nothing to do.");
  },
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let dir: string;
let gitServer: GitServer;
let site: TestSite;
let cookie = "";
let origin = "";
let REMOTE = "";
let KEY = "";
let laptop: FakeRunner;
let fakeGitHub: ReturnType<typeof createHttpServer>;
let githubUrl = "";
const github = {
  merges: [] as { path: string; body: Record<string, unknown>; auth: string | undefined }[],
  pulls: new Map<number, { head: string; merged: boolean; sha: string | null }>(),
};
const fake = createFakeProvider({
  runner: { prUrl: () => "https://github.com/acme/app/pull/7" },
});
let realRunner: ChildProcess | null = null;
let realId = "";
let realReady = false;
/** Server events published while a test watches. */
const events: { at: number; event: ServerEvent }[] = [];

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as AddressInfo).port;
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  }).trim();
}

const execFileAsync = promisify(execFile);

/** Git against the HTTP remote must not block: this process serves that remote. */
async function gitAsync(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

const task = async (id: string) => (await api<{ task: TaskView }>("GET", `/api/tasks/${id}`)).task;
const step = (t: TaskView, kind: ActionView["kind"]) =>
  t.actions.filter((a) => a.kind === kind).at(-1);
const targets = () => api<DeployTargetView[]>("GET", "/api/deploy-targets");
const target = async (name: string) => {
  const t = (await targets()).find((x) => x.name === name);
  if (!t) throw new Error(`no target ${name}`);
  return t;
};
const pending = async (taskId: string) =>
  (await api<ApprovalView[]>("GET", "/api/approvals")).filter((a) => a.taskId === taskId);

async function newConversation(mode: PermissionMode, personalityId?: string) {
  const conv = await api<{ id: string }>("POST", "/api/conversations", {
    ...(personalityId ? { personalityId } : {}),
  });
  await api("PATCH", `/api/conversations/${conv.id}`, { mode });
  return conv.id;
}

interface Detail {
  messages: { role: string; text: string }[];
  tasks: TaskView[];
}
const conversation = (id: string) => api<Detail>("GET", `/api/conversations/${id}`);

async function say(conversationId: string, message: string) {
  await api("POST", `/api/conversations/${conversationId}/messages`, { text: message });
}

/** Waits for a step to reach one of the states. */
async function stepReaches(
  taskId: string,
  kind: ActionView["kind"],
  states: ActionView["state"][],
  ms = 30_000,
): Promise<TaskView> {
  return until(
    `${kind} ${states.join("/")}`,
    async () => {
      const t = await task(taskId);
      const s = step(t, kind);
      return s && states.includes(s.state) ? t : null;
    },
    ms,
  );
}

async function workspace() {
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers);
  if (!m) throw new Error("no workspace");
  return { workspaceId: m.workspaceId, userId: m.userId };
}

// ---------------------------------------------------------------- machines

/** What the flows need from a machine, whichever Runner it is. */
interface Machine {
  label: string;
  id(): string;
  /** False skips the flows: the Runner can't merge or deploy yet. */
  ready(): boolean;
  setDeploys(on: boolean): Promise<void>;
  setMaxMode(mode: "read-only" | "full-access"): Promise<void>;
  setDeployCommand(command: string | null): Promise<void>;
}

const deployCommand = (deployDir: string) =>
  `mkdir -p '${deployDir}' && cp SLING_FAKE.md '${deployDir}/SLING_FAKE.md' && printf '%s' "$SLING_DEPLOY_COMMIT" > '${deployDir}/VERSION' && echo "deployed $SLING_DEPLOY_COMMIT"`;

async function machineView(id: string) {
  return (await api<RunnerView[]>("GET", "/api/runners")).find((r) => r.id === id);
}

const fakeMachine: Machine = {
  label: "laptop",
  id: () => laptop.runnerId,
  ready: () => true,
  async setDeploys(on) {
    laptop.options.deploys = on;
    laptop.sendInventory();
    await until(
      "deploys reported",
      async () => (await machineView(laptop.runnerId))?.deploys === on,
    );
  },
  async setMaxMode(mode) {
    laptop.options.maxMode = mode === "read-only" ? ProtoMode.READ_ONLY : ProtoMode.FULL_ACCESS;
    laptop.sendInventory();
    await until(
      "max mode reported",
      async () => (await machineView(laptop.runnerId))?.maxMode === mode,
    );
  },
  async setDeployCommand(command) {
    const repo = laptop.options.repos.find((r) => r.name === "site");
    if (repo) repo.deployCommand = command ?? "";
    laptop.sendInventory();
    await until("deploy command reported", async () => {
      const r = (await machineView(laptop.runnerId))?.repos.find((x) => x.name === "site");
      return r?.deployCommand === (command ?? "");
    });
  },
};

const realEnv = () => ({
  ...process.env,
  PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
  SLING_RUNNER_HOME: join(dir, "realbox"),
  FAKE_CODEX_DELAY_MS: "40",
  SLING_RUNNER_LOG: "info",
  GIT_TERMINAL_PROMPT: "0",
});

async function realCli(...args: string[]) {
  const { stdout } = await execFileAsync(RUNNER, args, { env: realEnv(), encoding: "utf8" });
  return stdout;
}

function startReal() {
  const log = openSync(join(dir, "realbox.log"), "a");
  realRunner = spawn(RUNNER, ["run"], { env: realEnv(), stdio: ["ignore", log, log] });
}

async function stopReal(signal: NodeJS.Signals = "SIGTERM") {
  const r = realRunner;
  realRunner = null;
  if (!r || r.exitCode !== null) return;
  await new Promise<void>((ok) => {
    r.once("exit", () => ok());
    r.kill(signal);
  });
}

/** Changes the real Runner's config, then restarts it so its inventory says so. */
async function reconfigureReal(check: (r: RunnerView) => boolean, ...args: string[]) {
  await stopReal();
  await realCli(...args);
  startReal();
  await until("real Runner back", async () => {
    const r = await machineView(realId);
    return r?.online && check(r);
  });
}

const realMachine: Machine = {
  label: "realbox",
  id: () => realId,
  ready: () => realReady,
  setDeploys: (on) =>
    reconfigureReal((r) => r.deploys === on, "config", "set", "deploys", on ? "on" : "off"),
  setMaxMode: (mode) =>
    reconfigureReal((r) => r.maxMode === mode, "config", "set", "max-mode", mode),
  setDeployCommand: (command) =>
    command
      ? reconfigureReal(
          (r) => r.repos.some((x) => x.name === "site" && x.deployCommand === command),
          "repo",
          "set",
          "site",
          "deploy-command",
          command,
        )
      : reconfigureReal(
          (r) => r.repos.some((x) => x.name === "site" && x.deployCommand === ""),
          "repo",
          "unset",
          "site",
          "deploy-command",
        ),
};

/** Points the Website target at a method, run by this machine when it's a command. */
async function useMethod(m: Machine, method: "merge" | "hook" | "command", extra: object = {}) {
  const t = await target("Website");
  await api("PATCH", `/api/deploy-targets/${t.id}`, {
    method,
    settleSeconds: 0,
    timeoutSeconds: 60,
    ...(method === "command" ? { runnerId: m.id() } : {}),
    ...(method === "hook"
      ? {
          hook: {
            url: `${site.url}/hook`,
            httpMethod: "POST",
            headerName: "X-Hook-Token",
            headerValue: HOOK_SECRET,
          },
        }
      : {}),
    ...extra,
  });
  site.mode = method;
}

/** A deploy task started straight through the API, on one machine. */
async function deployTask(m: Machine, title: string, mode: PermissionMode, deliver = "deploy") {
  const conversationId = await newConversation(mode);
  const created = await api<{ id: string }>("POST", "/api/tasks", {
    repo: "site",
    title,
    objective: "Fix the health check so the site answers again.",
    deliver,
    conversationId,
    environment: "machine",
    machineId: m.id(),
  });
  return { taskId: created.id, conversationId };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sling-deploys-"));
  // The remote, served over HTTP so it has a remote key like a hosted repo.
  const bare = join(dir, "git", "acme", "site.git");
  mkdirSync(join(dir, "git", "acme"), { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "http.receivepack", "true");
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# site\n");
  writeFileSync(join(seed, "SLING_FAKE.md"), "# Fixes\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", bare, "main");
  gitServer = await serveGit(join(dir, "git"));
  REMOTE = `${gitServer.url}/acme/site.git`;
  KEY = "127.0.0.1/acme/site";

  site = new TestSite(bare, join(dir, "deployed"));
  await site.start();

  fakeGitHub = createHttpServer((req, res) => void githubHandler(req, res));
  await new Promise<void>((ok) => fakeGitHub.listen(0, "127.0.0.1", ok));
  githubUrl = `http://127.0.0.1:${(fakeGitHub.address() as AddressInfo).port}`;

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
    testing: { allowLocalCloneUrls: true, githubApiUrl: githubUrl },
  };
  server = await startServer(config, { model, jobs: false, connectors: [fake.connector] });
  const publish = server.ctx.hub.publish.bind(server.ctx.hub);
  server.ctx.hub.publish = (workspaceId, event) => {
    events.push({ at: performance.now(), event });
    if (events.length > 5000) events.splice(0, 1000);
    publish(workspaceId, event);
  };
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });

  const clone = join(dir, "laptop-site");
  await gitAsync(dir, "clone", "-q", REMOTE, clone);
  laptop = new FakeRunner({
    url: server.url,
    name: "laptop",
    repos: [
      {
        name: "site",
        remoteUrl: REMOTE,
        path: clone,
        deployCommand: deployCommand(site.deployDir),
      },
      { name: "bench", remoteUrl: BENCH_REMOTE, deployCommand: "true" },
    ],
  });
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await laptop.pair(code);
  await laptop.connect();
  await until("laptop online", async () => (await machineView(laptop.runnerId))?.online);

  await api("POST", "/api/deploy-targets", {
    name: "Website",
    remoteKey: KEY,
    method: "merge",
    checks: [{ url: `${site.url}/health`, status: null, contains: null }],
    versionUrl: `${site.url}/version`,
    settleSeconds: 0,
  });
  await api("POST", "/api/deploy-targets", {
    name: "Bench",
    remoteKey: BENCH_KEY,
    method: "merge",
    checks: [{ url: `${site.url}/ok` }],
    settleSeconds: 0,
  });

  await setUpRealRunner();
}, 180_000);

/** Pairs the real Runner, when it's built, and notes whether it can merge and deploy. */
async function setUpRealRunner() {
  if (!existsSync(RUNNER) || !existsSync(FAKE_CODEX)) {
    console.warn("No Runner build, so the real Runner's deploy flows are skipped.");
    return;
  }
  // A gh that's never logged in, so PRs fall back to a compare link and merges to plain git.
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(dir, "bin", "gh"), 0o755);
  const clone = join(dir, "real-site");
  await gitAsync(dir, "clone", "-q", REMOTE, clone);
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await realCli("repo", "add", clone, "--name", "site");
  await realCli("config", "set", "codex-bin", FAKE_CODEX);
  await realCli("config", "set", "claude-bin", join(dir, "no-claude-here"));
  // Scanning the whole home directory for repos would hold up connecting.
  mkdirSync(join(dir, "scan"));
  await realCli("config", "set", "scan-roots", join(dir, "scan"));
  try {
    await realCli("repo", "set", "site", "deploy-command", deployCommand(site.deployDir));
  } catch {
    // This build can't set a deploy command yet.
  }
  await realCli("pair", server.url, code, "--name", "realbox");
  startReal();
  let r: RunnerView;
  try {
    // Its repo shows once its inventory is in, and with it whether it takes deploys.
    r = await until("real Runner online", async () =>
      (await api<RunnerView[]>("GET", "/api/runners")).find(
        (x) => x.name === "realbox" && x.online && x.repos.some((p) => p.name === "site"),
      ),
    );
  } catch (err) {
    const log = readFileSync(join(dir, "realbox.log"), "utf8").slice(-2000);
    console.warn(
      `The real Runner didn't connect (exit ${realRunner?.exitCode}, signal ${realRunner?.signalCode}), so its deploy flows are skipped: ${err}\n${log}`,
    );
    return;
  }
  realId = r.id;
  realReady = r.deploys;
  if (!realReady) {
    console.warn(
      "This sling-runner build doesn't report deploys, so the real Runner's deploy flows are skipped.",
    );
  }
}

async function githubHandler(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const json = (status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };
  const m = /^\/repos\/acme\/app\/pulls\/(\d+)(\/merge)?$/.exec(req.url ?? "");
  const pr = m ? github.pulls.get(Number(m[1])) : undefined;
  if (!m || !pr) return json(404, { message: "Not Found" });
  if (req.headers.authorization !== `Bearer ${GIT_TOKEN}`) {
    return json(401, { message: "Bad credentials" });
  }
  if (!m[2]) {
    return json(200, {
      state: pr.merged ? "closed" : "open",
      merged: pr.merged,
      merge_commit_sha: pr.sha,
      head: { ref: pr.head },
      base: { ref: "main" },
    });
  }
  github.merges.push({
    path: req.url ?? "",
    body: JSON.parse(body),
    auth: req.headers.authorization,
  });
  pr.merged = true;
  pr.sha = "abcabc1234567890abcabc1234567890abcabc12";
  site.githubVersion = `deployed ${pr.sha}`;
  return json(200, { sha: pr.sha, merged: true, message: "Pull Request successfully merged" });
}

afterAll(async () => {
  await stopReal("SIGKILL");
  laptop?.close();
  for (const s of fake.state.live.values()) s.runner?.close();
  await server?.close();
  await pg?.stop();
  await site?.close();
  await gitServer?.close();
  fakeGitHub?.closeAllConnections();
  fakeGitHub?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- targets

describe("deploy targets", () => {
  it("validates targets and never sends a hook back", async () => {
    const bad = async (body: unknown, status = 400) => {
      const r = await raw("POST", "/api/deploy-targets", body);
      expect(r.status, r.text).toBe(status);
      return r.text;
    };
    const base = {
      name: "Docs",
      remoteKey: "github.com/acme/docs",
      method: "merge",
      checks: [{ url: "https://docs.example.com/" }],
    };
    expect(await bad({ ...base, name: "website" }, 409)).toContain(
      "There's already a deploy target called Website.",
    );
    expect(await bad({ ...base, remoteKey: KEY }, 409)).toContain(
      `${KEY} already has a deploy target, Website.`,
    );
    expect(await bad({ ...base, method: "command" })).toContain(
      "A command deploy needs the machine that runs the command.",
    );
    expect(await bad({ ...base, method: "command", runnerId: "rnr_nope" })).toContain(
      "That machine isn't one of yours.",
    );
    expect(await bad({ ...base, method: "hook" })).toContain("A deploy hook needs its URL.");
    expect(await bad({ ...base, checks: [] })).toMatch(/checks/);
    expect(await bad({ ...base, checks: Array(6).fill({ url: "https://x/" }) })).toMatch(/checks/);
    expect(await bad({ ...base, checks: [{ url: "ftp://x/" }] })).toMatch(/http or https/);
    expect(await bad({ ...base, timeoutSeconds: 3601 })).toMatch(/timeoutSeconds/);
    expect(await bad({ ...base, remoteKey: "docs" })).toMatch(/remote such as/);

    const created = await api<DeployTargetView>("POST", "/api/deploy-targets", {
      ...base,
      method: "hook",
      remoteKey: "https://github.com/Acme/docs.git",
      hook: {
        url: "https://api.netlify.example/build_hooks/abc123secret",
        httpMethod: "POST",
        headerName: "X-Token",
        headerValue: "t0ps3cret",
      },
      checks: [{ url: "https://docs.example.com/", status: 200, contains: "Docs" }],
    });
    expect(created).toMatchObject({
      name: "Docs",
      remoteKey: "github.com/acme/docs",
      method: "hook",
      mergeMethod: "squash",
      runnerId: null,
      command: null,
      hook: { httpMethod: "POST", host: "api.netlify.example", hasHeader: true },
      checks: [{ url: "https://docs.example.com/", status: 200, contains: "Docs" }],
      versionUrl: null,
      settleSeconds: 0,
      timeoutSeconds: 600,
      lastCheck: null,
      lastDeploy: null,
    });
    const listed = JSON.stringify(await targets());
    expect(listed).not.toContain("abc123secret");
    expect(listed).not.toContain("t0ps3cret");

    // A PATCH without a hook keeps the stored one; one with a new method keeps the URL.
    const kept = await api<DeployTargetView>("PATCH", `/api/deploy-targets/${created.id}`, {
      name: "Docs site",
    });
    expect(kept.hook).toEqual({ httpMethod: "POST", host: "api.netlify.example", hasHeader: true });
    const get = await api<DeployTargetView>("PATCH", `/api/deploy-targets/${created.id}`, {
      hook: { httpMethod: "GET", headerName: null },
    });
    expect(get.hook).toEqual({ httpMethod: "GET", host: "api.netlify.example", hasHeader: false });
    const row = await server.ctx.deploys.row((await workspace()).workspaceId, created.id);
    if (!row) throw new Error("no row");
    expect(await server.ctx.deploys.readHook(row)).toEqual({
      url: "https://api.netlify.example/build_hooks/abc123secret",
      httpMethod: "GET",
    });
    const [cred] = await server.ctx.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.id, row.hookCredentialId ?? ""));
    expect(cred?.kind).toBe("deploy_hook");
    expect(cred?.ciphertext).not.toContain("abc123secret");

    // Merge needs no hook, so the secret goes.
    const merged = await api<DeployTargetView>("PATCH", `/api/deploy-targets/${created.id}`, {
      method: "merge",
    });
    expect(merged.hook).toBeNull();
    expect(
      await server.ctx.db
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.id, row.hookCredentialId ?? "")),
    ).toEqual([]);

    expect(await api("DELETE", `/api/deploy-targets/${created.id}`)).toEqual({ ok: true });
    expect((await raw("DELETE", `/api/deploy-targets/${created.id}`)).status).toBe(404);
    const verbs = (
      await server.ctx.db
        .select({ verb: schema.auditEvents.verb })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.subjectId, created.id))
    ).map((a) => a.verb);
    expect(verbs).toEqual([
      "deploy_target.created",
      "deploy_target.updated",
      "deploy_target.updated",
      "deploy_target.updated",
      "deploy_target.removed",
    ]);
  });

  it("checks a target now, and counts failures in a row", async () => {
    const t = await target("Website");
    site.down = true;
    const first = await api<DeployTargetView>("POST", `/api/deploy-targets/${t.id}/check`);
    expect(first.lastCheck).toMatchObject({
      up: false,
      failures: 1,
      results: [{ url: `${site.url}/health`, ok: false, status: 500 }],
    });
    const second = await api<DeployTargetView>("POST", `/api/deploy-targets/${t.id}/check`);
    expect(second.lastCheck?.failures).toBe(2);
    expect(second.updatedAt).toBe(first.updatedAt);
    site.down = false;
    site.expect = "";
    expect((await raw("POST", "/api/deploy-targets/dpt_nope/check")).status).toBe(404);
  });

  it("shows the command a machine reports for a command target", async () => {
    await useMethod(fakeMachine, "command");
    const t = await target("Website");
    expect(t).toMatchObject({
      method: "command",
      runnerId: laptop.runnerId,
      runnerName: "laptop",
      command: deployCommand(site.deployDir),
      hook: null,
    });
    await useMethod(fakeMachine, "merge");
  });
});

// ---------------------------------------------------------------- flows

/** The deploy flows, on one machine. */
function flows(m: Machine) {
  const skipUnlessReady = (ctx: { skip: () => void }) => {
    if (!m.ready()) ctx.skip();
  };

  for (const method of ["merge", "hook", "command"] as const) {
    it(`fixes a site that's down from chat, in Auto, deploying with ${method}`, async (ctx) => {
      skipUnlessReady(ctx);
      await useMethod(m, method);
      const title = `Fix the health check (${method} on ${m.label})`;
      site.expect = title;
      const hooks = site.hookCalls.length;
      toolResults.length = 0;
      const conv = await newConversation("auto");
      script.push(
        { tool: "run_check", input: { target: "website" } },
        {
          tool: "delegate_coding_task",
          input: {
            repo: "site",
            title,
            objective: "The health check answers 500. Fix it so it answers 200.",
            deliver: "deploy",
            machineId: m.id(),
            environment: "machine",
          },
        },
      );
      await say(conv, "The site is down, fix it.");

      const delegated = await until("delegated", async () =>
        toolResults.find((r) => r.toolName === "delegate_coding_task"),
      );
      const checked = toolResults.find((r) => r.toolName === "run_check");
      expect(checked?.value).toMatchObject({
        target: "Website",
        method,
        up: false,
        checks: [{ url: `${site.url}/health`, ok: false, status: 500 }],
      });
      expect(delegated.value).toMatchObject({ deliver: "deploy", mode: "auto" });
      const taskId = String(delegated.value.taskId);

      // Push and the PR go on their own; the deploy waits for approval.
      const waiting = await stepReaches(taskId, "merge", ["awaiting_approval"]);
      expect(waiting.actions.map((a) => [a.kind, a.state])).toEqual([
        ["push", "succeeded"],
        ["open_pr", "succeeded"],
        ["merge", "awaiting_approval"],
        ...(method === "merge" ? [] : [["deploy", "awaiting_approval"]]),
        ["verify", "queued"],
      ]);
      const asks = await pending(taskId);
      expect(asks.map((a) => [a.actionKind, a.title]).sort()).toEqual(
        [
          ["merge", `Merge: ${title}`],
          ...(method === "merge" ? [] : [["deploy", `Deploy to Website: ${title}`]]),
        ].sort(),
      );
      expect(asks[0]?.payload).toMatchObject({ targetName: "Website", method });
      const asked = await until("approval update in the chat", async () =>
        (await conversation(conv)).messages.find(
          (x) => x.role === "system" && x.text.includes("approve the deployment"),
        ),
      );
      expect(asked.text).toContain("Nothing merges until they approve it");

      const decided = await api<{ decided: number }>("POST", `/api/tasks/${taskId}/approval`, {
        decision: "approve",
      });
      expect(decided.decided).toBe(method === "merge" ? 1 : 2);
      const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
      const merge = step(done, "merge");
      const verify = step(done, "verify");
      expect(verify?.state, verify?.message ?? "").toBe("succeeded");
      expect(merge).toMatchObject({ state: "succeeded", ranOn: m.label, targetName: "Website" });
      const live = await site.live();
      expect(merge?.commitSha).toBe(live.sha);
      expect(live.content).toContain(`- ${title}`);
      expect(verify?.commitSha).toBe(live.sha);
      expect(verify?.verify).toMatchObject({
        attempts: 1,
        versionSeen: true,
        checks: [{ url: `${site.url}/health`, ok: true, status: 200 }],
      });
      expect(verify?.message).toContain(`the version URL shows ${live.sha.slice(0, 7)}`);
      expect((await fetch(`${site.url}/health`)).status).toBe(200);

      const deploy = step(done, "deploy");
      if (method === "hook") {
        expect(site.hookCalls.length).toBe(hooks + 1);
        expect(site.hookCalls.at(-1)?.headers["x-hook-token"]).toBe(HOOK_SECRET);
        expect(deploy).toMatchObject({ state: "succeeded", ranOn: "Sling", commitSha: live.sha });
        expect(deploy?.message).toBe(
          `The deploy hook accepted it (200): deploying ${live.sha.slice(0, 7)}`,
        );
      }
      if (method === "command") {
        expect(deploy).toMatchObject({ state: "succeeded", ranOn: m.label, commitSha: live.sha });
        expect(deploy?.output).toContain(`deployed ${live.sha}`);
      }

      const reported = await until("the assistant reports it", async () =>
        (await conversation(conv)).messages.find(
          (x) => x.role === "assistant" && x.text.includes("The fix is live"),
        ),
      );
      expect(reported.text).toContain("Delivery step verify: succeeded after 1 attempt");
      const t = await target("Website");
      expect(t.lastDeploy).toMatchObject({ taskId, taskTitle: title, state: "succeeded" });
      // The site was down before the fix; the page shows what verify saw since.
      expect(t.lastCheck).toMatchObject({ up: true, failures: 0 });
    });
  }

  it("asks for push and PR first in Supervised, and for the deploy only once the PR exists", async (ctx) => {
    skipUnlessReady(ctx);
    await useMethod(m, "hook");
    const title = `Supervised fix on ${m.label}`;
    site.expect = title;
    const { taskId } = await deployTask(m, title, "supervised");
    const first = await stepReaches(taskId, "push", ["awaiting_approval"]);
    expect(first.actions.map((a) => [a.kind, a.state])).toEqual([
      ["push", "awaiting_approval"],
      ["open_pr", "awaiting_approval"],
      ["merge", "queued"],
      ["deploy", "queued"],
      ["verify", "queued"],
    ]);
    expect((await pending(taskId)).map((a) => a.actionKind).sort()).toEqual(["open_pr", "push"]);
    await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });

    const second = await stepReaches(taskId, "merge", ["awaiting_approval"]);
    const asks = await pending(taskId);
    expect(asks.map((a) => a.actionKind).sort()).toEqual(["deploy", "merge"]);
    const pr = step(second, "open_pr");
    expect(pr?.state).toBe("succeeded");
    expect(asks[0]?.payload).toMatchObject({ prUrl: pr?.url });
    await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
    const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
    expect(step(done, "verify")?.state).toBe("succeeded");
  });

  it("refuses a deploy in Read-only", async (ctx) => {
    skipUnlessReady(ctx);
    toolResults.length = 0;
    const conv = await newConversation("read-only");
    script.push({
      tool: "delegate_coding_task",
      input: {
        repo: "site",
        title: "Read-only deploy",
        objective: "Fix the health check so it answers 200.",
        deliver: "deploy",
        machineId: m.id(),
      },
    });
    await say(conv, "Fix it and deploy.");
    const refused = await until("refused", async () =>
      toolResults.find((r) => r.toolName === "delegate_coding_task"),
    );
    expect(refused.value.error).toBe(
      "Read-only can't deploy. The user can switch the mode in the app.",
    );
    expect((await conversation(conv)).tasks).toEqual([]);
    const direct = await raw("POST", "/api/tasks", {
      repo: "site",
      title: "Read-only deploy",
      objective: "Fix it.",
      deliver: "deploy",
      mode: "read-only",
      machineId: m.id(),
    });
    expect(direct.status).toBe(400);
  });

  it("deploys without asking in Full access", async (ctx) => {
    skipUnlessReady(ctx);
    await useMethod(m, "command");
    const title = `Full access fix on ${m.label}`;
    site.expect = title;
    const { taskId } = await deployTask(m, title, "full-access");
    const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
    expect(done.actions.map((a) => [a.kind, a.state, a.requiresApproval])).toEqual([
      ["push", "succeeded", false],
      ["open_pr", "succeeded", false],
      ["merge", "succeeded", false],
      ["deploy", "succeeded", false],
      ["verify", "succeeded", false],
    ]);
    const approvals = await server.ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.taskId, taskId));
    expect(approvals).toEqual([]);
  });

  it("says when a deploy didn't fix it, and offers a revert", async (ctx) => {
    skipUnlessReady(ctx);
    await useMethod(m, "hook", { timeoutSeconds: 10 });
    site.expect = "a fix that never ships";
    const title = `A fix that misses on ${m.label}`;
    const { taskId, conversationId } = await deployTask(m, title, "full-access");
    const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
    const verify = step(done, "verify");
    expect(step(done, "deploy")?.state).toBe("succeeded");
    expect(verify?.state).toBe("failed");
    expect(verify?.verify).toMatchObject({
      attempts: 2,
      versionSeen: true,
      checks: [{ url: `${site.url}/health`, ok: false, status: 500 }],
    });
    expect(verify?.message).toBe(
      `Verification failed after 2 attempts over ${Math.round((Date.parse(verify?.verify?.finishedAt ?? "") - Date.parse(verify?.verify?.startedAt ?? "")) / 1000)} s: ${site.url}/health: 500 (Expected 200 to 399, got 500).`,
    );
    const update = await until("the update says so", async () =>
      (await conversation(conversationId)).messages.find(
        (x) => x.role === "system" && x.text.includes("Verification failed"),
      ),
    );
    expect(update.text).toContain(`${site.url}/health answered 500 (Expected 200 to 399, got 500)`);
    expect(update.text).toContain(
      `Offer the user a revert task: a coding task in site that reverts the merged commit ${step(done, "merge")?.commitSha}, delivered with deliver "deploy".`,
    );
    await until("the assistant offers the revert", async () =>
      (await conversation(conversationId)).messages.find(
        (x) => x.role === "assistant" && x.text.includes("Offer the user a revert task"),
      ),
    );
    await useMethod(m, "hook", { timeoutSeconds: 60 });
  });

  it("deploys a delivered PR later, from the app and from the assistant", async (ctx) => {
    skipUnlessReady(ctx);
    await useMethod(m, "hook");
    // A push without a PR can't deploy later.
    const pushOnly = await deployTask(m, `Push only on ${m.label}`, "auto", "push");
    await stepReaches(pushOnly.taskId, "push", ["succeeded"]);
    const refused = await raw("POST", `/api/tasks/${pushOnly.taskId}/deploy`);
    expect(refused).toMatchObject({
      status: 409,
      body: { error: "Only a task whose pull request is open can deploy." },
    });

    const title = `Deploy later on ${m.label}`;
    site.expect = title;
    const { taskId } = await deployTask(m, title, "auto", "pr");
    await stepReaches(taskId, "open_pr", ["succeeded"]);
    const view = await api<TaskView>("POST", `/api/tasks/${taskId}/deploy`);
    expect(view.deliver).toBe("deploy");
    expect(view.actions.map((a) => [a.kind, a.state])).toEqual([
      ["push", "succeeded"],
      ["open_pr", "succeeded"],
      ["merge", "awaiting_approval"],
      ["deploy", "awaiting_approval"],
      ["verify", "queued"],
    ]);
    expect((await raw("POST", `/api/tasks/${taskId}/deploy`)).body).toEqual({
      error: "This task is already deploying.",
    });
    await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
    const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
    expect(step(done, "verify")?.state).toBe("succeeded");

    // The assistant does the same with deploy_task.
    const title2 = `Deploy later from chat on ${m.label}`;
    site.expect = title2;
    const later = await deployTask(m, title2, "auto", "pr");
    await stepReaches(later.taskId, "open_pr", ["succeeded"]);
    // The PR's update first, so the user's message is the one the assistant answers.
    await until("the PR's update answered", async () =>
      (await conversation(later.conversationId)).messages.find(
        (x) => x.role === "assistant" && x.text.startsWith("Reported:"),
      ),
    );
    toolResults.length = 0;
    script.push({ tool: "deploy_task", input: { taskId: later.taskId } });
    await say(later.conversationId, "Deploy it.");
    const answer = await until("deploy_task answered", async () =>
      toolResults.find((r) => r.toolName === "deploy_task"),
    );
    expect(answer.value).toMatchObject({
      taskId: later.taskId,
      target: "Website",
      steps: [
        { step: "merge", state: "awaiting_approval" },
        { step: "deploy", state: "awaiting_approval" },
        { step: "verify", state: "queued" },
      ],
    });
    await api("POST", `/api/tasks/${later.taskId}/approval`, { decision: "approve" });
    const live = await stepReaches(later.taskId, "verify", ["succeeded", "failed"], 60_000);
    expect(step(live, "verify")?.state).toBe("succeeded");
  });

  describe("the machine's own limits", () => {
    /** A deploy task waiting for its deploy approval, ready to be refused. */
    async function waitingDeploy(label: string) {
      await useMethod(m, "command");
      const title = `${label} on ${m.label}`;
      site.expect = title;
      const { taskId } = await deployTask(m, title, "auto");
      await stepReaches(taskId, "merge", ["awaiting_approval"]);
      return taskId;
    }

    it("refuses to merge a branch that isn't a Sling task branch", async (ctx) => {
      skipUnlessReady(ctx);
      const taskId = await waitingDeploy("Not a task branch");
      await server.ctx.db
        .update(schema.tasks)
        .set({ branch: "feature/not-from-sling" })
        .where(eq(schema.tasks.id, taskId));
      await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
      const t = await stepReaches(taskId, "merge", ["refused", "failed", "succeeded"]);
      expect(step(t, "merge")?.state).toBe("refused");
      expect(step(t, "merge")?.message).toBeTruthy();
      await stepReaches(taskId, "deploy", ["skipped"]);
    });

    it("refuses to deploy a commit that isn't on the default branch", async (ctx) => {
      skipUnlessReady(ctx);
      const taskId = await waitingDeploy("Off the default branch");
      const mergeApproval = (await pending(taskId)).find((a) => a.actionKind === "merge");
      await api("POST", `/api/approvals/${mergeApproval?.id}`, { decision: "approve" });
      const merged = await stepReaches(taskId, "merge", ["succeeded", "failed", "refused"]);
      expect(step(merged, "merge")?.state).toBe("succeeded");
      expect(step(merged, "deploy")?.state).toBe("awaiting_approval");
      // The task's own commit is on its branch, not the default branch: squash made a new one.
      await server.ctx.db
        .update(schema.actions)
        .set({ commitSha: merged.commitSha })
        .where(eq(schema.actions.id, step(merged, "merge")?.id ?? ""));
      await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
      const t = await stepReaches(taskId, "deploy", ["refused", "failed", "succeeded"]);
      expect(step(t, "deploy")?.state).toBe("refused");
      expect(step(t, "deploy")?.message).toBeTruthy();
      await stepReaches(taskId, "verify", ["skipped"]);
    });

    it("refuses any merge or deploy with deploys off", async (ctx) => {
      skipUnlessReady(ctx);
      const taskId = await waitingDeploy("Deploys off");
      await m.setDeploys(false);
      try {
        await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
        const t = await stepReaches(taskId, "merge", ["refused", "failed", "succeeded"]);
        expect(step(t, "merge")?.state).toBe("refused");
        expect(step(t, "merge")?.message).toBeTruthy();
      } finally {
        await m.setDeploys(true);
      }
    });

    it("refuses to deploy a repo with no deploy command", async (ctx) => {
      skipUnlessReady(ctx);
      const taskId = await waitingDeploy("No deploy command");
      await m.setDeployCommand(null);
      try {
        await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
        const t = await stepReaches(taskId, "deploy", ["refused", "failed", "succeeded"]);
        expect(step(t, "merge")?.state).toBe("succeeded");
        expect(step(t, "deploy")?.state).toBe("refused");
        expect(step(t, "deploy")?.message).toBeTruthy();
      } finally {
        await m.setDeployCommand(deployCommand(site.deployDir));
      }
    });

    it("refuses any merge or deploy when its max mode is Read-only", async (ctx) => {
      skipUnlessReady(ctx);
      const taskId = await waitingDeploy("Read-only machine");
      await m.setMaxMode("read-only");
      try {
        await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
        const t = await stepReaches(taskId, "merge", ["refused", "failed", "succeeded"]);
        expect(step(t, "merge")?.state).toBe("refused");
        expect(step(t, "merge")?.message).toBeTruthy();
      } finally {
        await m.setMaxMode("full-access");
      }
    });
  });
}

describe("deploys on the TypeScript Runner", () => {
  flows(fakeMachine);

  it("shows the Runner's reasons word for word", async () => {
    const reasons = (await server.ctx.db.select().from(schema.actions))
      .filter((a) => a.state === "refused")
      .map((a) => a.message);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "feature/not-from-sling isn't a Sling task branch, so this machine won't merge it.",
        expect.stringMatching(
          /^[0-9a-f]{7} isn't on origin\/main, so this machine won't deploy it\.$/,
        ),
        "Merges and deploys are off on this machine (deploys off).",
        "No deploy command is set for site on this machine.",
        "This machine's max mode is Read-only, so it doesn't merge or deploy.",
      ]),
    );
  });
});

describe("deploys on the real Runner", () => {
  flows(realMachine);
});

// ---------------------------------------------------------------- the edges

describe("restarts, quiet machines, and offline machines", () => {
  it("never calls a hook again after a restart in the middle of it", async () => {
    await useMethod(fakeMachine, "hook");
    const title = "Hook during a restart";
    site.expect = title;
    site.hookDelayMs = 1500;
    const calls = site.hookCalls.length;
    try {
      const { taskId } = await deployTask(fakeMachine, title, "full-access");
      await stepReaches(taskId, "deploy", ["sent"]);
      await until("hook called", async () => {
        // The call has started once the site has the request; it answers later.
        return (await task(taskId)).actions.some((a) => a.kind === "deploy" && a.state === "sent");
      });
      await server.ctx.deploys.steps.recover();
      const t = await stepReaches(taskId, "deploy", ["failed"]);
      expect(step(t, "deploy")?.message).toBe(
        "Interrupted, outcome unknown: the server restarted while it was calling the deploy hook, so Sling won't call it again on its own.",
      );
      expect(step(t, "verify")?.state).toBe("skipped");
      await new Promise((r) => setTimeout(r, 2000));
      expect(site.hookCalls.length).toBe(calls + 1);
      expect(step(await task(taskId), "deploy")?.state).toBe("failed");
    } finally {
      site.hookDelayMs = 0;
    }
  });

  it("ends a machine step with no answer by its limit plus a minute", async () => {
    await useMethod(fakeMachine, "merge");
    const { taskId } = await deployTask(fakeMachine, "A machine that went quiet", "auto");
    await stepReaches(taskId, "merge", ["awaiting_approval"]);
    laptop.options.answerRepoActions = false;
    try {
      await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
      const sent = await stepReaches(taskId, "merge", ["sent"]);
      await server.ctx.deploys.sweep();
      expect(step(await task(taskId), "merge")?.state).toBe("sent");
      await server.ctx.db
        .update(schema.actions)
        .set({ sentAt: new Date(Date.now() - 12 * 60_000) })
        .where(eq(schema.actions.id, step(sent, "merge")?.id ?? ""));
      await server.ctx.deploys.sweep();
      const t = await stepReaches(taskId, "merge", ["failed"]);
      expect(step(t, "merge")?.message).toBe(
        "Interrupted, outcome unknown: laptop didn't answer within 11 minutes.",
      );
      expect(step(t, "verify")?.state).toBe("skipped");
    } finally {
      laptop.options.answerRepoActions = true;
    }
  });

  it("waits for an offline machine, says which could take it, and goes once it's back", async () => {
    await useMethod(fakeMachine, "merge");
    const title = "Merge after the laptop is back";
    site.expect = title;
    const { taskId } = await deployTask(fakeMachine, title, "auto");
    await stepReaches(taskId, "merge", ["awaiting_approval"]);
    await stopReal();
    laptop.close();
    await until("laptop offline", async () => !(await machineView(laptop.runnerId))?.online);
    try {
      await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
      const waiting = await until("waiting message", async () => {
        const s = step(await task(taskId), "merge");
        return s?.state === "ready" && s.message ? s : null;
      });
      expect(waiting.message).toBe(
        `Waiting for a machine that can merge it: laptop (offline)${realId ? " and realbox (offline)" : ""}.`,
      );
    } finally {
      await laptop.connect();
      if (realId) startReal();
    }
    const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
    expect(step(done, "verify")?.state).toBe("succeeded");
    expect(step(done, "merge")?.ranOn).toBe("laptop");
  });

  it("gets a result again after a reconnect, and acknowledges it", async () => {
    await useMethod(fakeMachine, "merge");
    const title = "A result sent twice";
    site.expect = title;
    const { taskId } = await deployTask(fakeMachine, title, "auto");
    await stepReaches(taskId, "merge", ["awaiting_approval"]);
    laptop.holdNextResult = true;
    await api("POST", `/api/tasks/${taskId}/approval`, { decision: "approve" });
    await until("result held", async () => laptop.unacked.size > 0);
    const [requestId] = [...laptop.unacked.keys()];
    expect(step(await task(taskId), "merge")?.state).toBe("sent");
    laptop.close();
    await until("laptop offline", async () => !(await machineView(laptop.runnerId))?.online);
    await laptop.connect();
    const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
    expect(step(done, "merge")?.state).toBe("succeeded");
    expect(laptop.acks).toContain(requestId);
    expect(laptop.unacked.size).toBe(0);
  });
});

describe("sandbox tasks", () => {
  it("merges a sandbox's PR through GitHub, and lets the sandbox go once the PR is open", async () => {
    await api("PUT", `/api/sandbox-repos/${encodeURIComponent(APP_KEY)}`, {
      cloneUrl: `file://${site.bare}`,
      defaultBranch: "main",
    });
    await api("PUT", "/api/settings/sandboxes/secrets", { gitToken: GIT_TOKEN });
    await api("POST", "/api/installations", {
      connectorId: "test-fake",
      name: "fake-host",
      credentials: { token: "fake-provider-token" },
      config: {},
    });
    await api("POST", "/api/deploy-targets", {
      name: "App",
      remoteKey: APP_KEY,
      method: "merge",
      checks: [{ url: `${site.url}/ok` }],
      versionUrl: `${site.url}/github-version`,
      settleSeconds: 0,
    });
    const created = await api<{ id: string; environment: string }>("POST", "/api/tasks", {
      repo: APP_KEY,
      title: "Fix the app",
      objective: "Fix the app.",
      deliver: "deploy",
      mode: "auto",
      environment: "sandbox",
    });
    expect(created.environment).toBe("sandbox");
    const waiting = await stepReaches(created.id, "merge", ["awaiting_approval"], 60_000);
    github.pulls.set(7, { head: waiting.branch, merged: false, sha: null });
    expect(step(waiting, "open_pr")?.url).toBe("https://github.com/acme/app/pull/7");
    // The sandbox goes now, not after the deploy.
    await until("sandbox destroyed", async () => {
      const t = await task(created.id);
      return t.environment.sandboxState === "destroyed" ? t : null;
    });
    expect(step(await task(created.id), "merge")?.state).toBe("awaiting_approval");

    await api("POST", `/api/tasks/${created.id}/approval`, { decision: "approve" });
    const done = await stepReaches(created.id, "verify", ["succeeded", "failed"], 60_000);
    expect(step(done, "merge")).toMatchObject({
      state: "succeeded",
      ranOn: "Sling",
      commitSha: "abcabc1234567890abcabc1234567890abcabc12",
      url: "https://github.com/acme/app/pull/7",
      message: "Merged on GitHub (squash).",
    });
    expect(step(done, "verify")).toMatchObject({ state: "succeeded" });
    expect(github.merges).toEqual([
      {
        path: "/repos/acme/app/pulls/7/merge",
        body: { merge_method: "squash", sha: "1111111111111111111111111111111111111111" },
        auth: `Bearer ${GIT_TOKEN}`,
      },
    ]);
  });
});

// ---------------------------------------------------------------- the alert

describe("the Site down alert", () => {
  it("installs, validates, and pushes when a target goes down and comes back", async () => {
    const wf = await api<{ id: string; activeVersion: number }>("POST", "/api/workflows", {
      templateKey: "site-down-alert",
    });
    expect(wf.activeVersion).toBe(1);
    expect(await api("POST", `/api/workflows/${wf.id}/validate`)).toEqual({ issues: [] });

    const notified: { payload: { title: string; body: string; url: string }; urgency?: string }[] =
      [];
    const notify = server.ctx.push.notify;
    server.ctx.push.notify = async (_w, _u, payload, opts = {}) => {
      notified.push({ payload, ...(opts.urgency ? { urgency: opts.urgency } : {}) });
      return 1;
    };
    // Only the Website's health matters here, and only whether the site is down.
    const website = await target("Website");
    await api("PATCH", `/api/deploy-targets/${website.id}`, {
      checks: [{ url: `${site.url}/status` }],
    });
    try {
      const [row] = await server.ctx.db
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.id, wf.id));
      const run = async () => {
        if (!row?.activeVersionId) throw new Error("no version");
        const r = await server.ctx.engine.startRun({
          workflowId: wf.id,
          workspaceId: row.workspaceId,
          ownerId: row.ownerId,
          versionId: row.activeVersionId,
          triggerNodeId: "everyMinute",
          outputs: { firedAt: new Date().toISOString() },
        });
        await until("run finished", async () => {
          const [x] = await server.ctx.db
            .select({ status: schema.workflowRuns.status })
            .from(schema.workflowRuns)
            .where(eq(schema.workflowRuns.id, r?.id ?? ""));
          if (x?.status === "failed") throw new Error("the run failed");
          return x?.status === "succeeded";
        });
      };
      await run();
      expect(notified).toEqual([]);

      site.statusDown = true;
      await run();
      expect(notified).toEqual([]);
      await run();
      expect(notified).toHaveLength(1);
      const down = notified[0];
      expect(down?.urgency).toBe("high");
      expect(down?.payload.title).toBe("Website is down: 503");
      const url = new URL(down?.payload.url ?? "", "http://x");
      expect(url.pathname).toBe("/");
      expect(url.searchParams.get("personality")).toBe("incident");
      expect(url.searchParams.get("draft")).toMatch(
        /^Website is down \(503 since \d\d:\d\d\)\. Find out why and fix it\.$/,
      );
      await run();
      expect(notified).toHaveLength(1);

      site.statusDown = false;
      await run();
      expect(notified).toHaveLength(2);
      expect(notified[1]?.payload).toMatchObject({ title: "Website is back up", url: "/deploys" });
      expect(notified[1]?.urgency).toBe("normal");
    } finally {
      site.statusDown = false;
      server.ctx.push.notify = notify;
      await api("PATCH", `/api/deploy-targets/${website.id}`, {
        checks: [{ url: `${site.url}/health` }],
      });
    }
  });
});

// ---------------------------------------------------------------- budgets

describe("budgets", () => {
  it("sends the RepoAction within 100 ms of the approval, at p95", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const conversationId = await newConversation("auto");
      const { id } = await api<{ id: string }>("POST", "/api/tasks", {
        repo: "bench",
        title: `Bench deploy ${i}`,
        objective: "Change something.",
        deliver: "deploy",
        conversationId,
        environment: "machine",
        machineId: laptop.runnerId,
      });
      await stepReaches(id, "merge", ["awaiting_approval"]);
      const before = laptop.repoActions.length;
      const started = performance.now();
      await api("POST", `/api/tasks/${id}/approval`, { decision: "approve" });
      const got = await until("RepoAction", async () => laptop.repoActions[before]);
      expect(got.action.taskId).toBe(id);
      samples.push(got.at - started);
      await stepReaches(id, "verify", ["succeeded"]);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
    console.log(
      `approval to RepoAction: p50 ${samples[9]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${samples.at(-1)?.toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(100);
  });

  it("calls a hook with under 50 ms of its own overhead", async () => {
    await useMethod(fakeMachine, "hook");
    const overheads: number[] = [];
    for (let i = 0; i < 5; i++) {
      const title = `Hook overhead ${i}`;
      site.expect = title;
      const { taskId } = await deployTask(fakeMachine, title, "full-access");
      const t = await stepReaches(taskId, "deploy", ["succeeded", "failed"]);
      const merge = step(t, "merge");
      const deploy = step(t, "deploy");
      const rows = await server.ctx.db
        .select()
        .from(schema.actions)
        .where(and(eq(schema.actions.taskId, taskId)));
      const mergeRow = rows.find((r) => r.id === merge?.id);
      const deployRow = rows.find((r) => r.id === deploy?.id);
      const hook = site.hookCalls.at(-1);
      if (!mergeRow?.finishedAt || !deployRow?.finishedAt || !hook) throw new Error("no timing");
      // From the merge's end to the deploy's end, less the hook's own time.
      overheads.push(
        deployRow.finishedAt.getTime() -
          mergeRow.finishedAt.getTime() -
          (hook.answeredAt - hook.receivedAt),
      );
      await stepReaches(taskId, "verify", ["succeeded", "failed"]);
    }
    overheads.sort((a, b) => a - b);
    console.log(`hook step overhead: ${overheads.map((o) => o.toFixed(1)).join(", ")} ms`);
    expect(overheads[Math.floor(overheads.length / 2)]).toBeLessThan(50);
  });

  it("notices a site that comes back within 12 s of it answering", async () => {
    await useMethod(fakeMachine, "hook", { timeoutSeconds: 120 });
    const title = "Comes back during verify";
    site.expect = title;
    site.down = true;
    const { taskId } = await deployTask(fakeMachine, title, "full-access");
    let upAt = 0;
    try {
      await until(
        "first failed round",
        async () => (step(await task(taskId), "verify")?.verify?.attempts ?? 0) >= 1,
      );
      site.down = false;
      upAt = Date.now();
    } finally {
      site.down = false;
    }
    const done = await stepReaches(taskId, "verify", ["succeeded", "failed"], 60_000);
    const verify = step(done, "verify");
    expect(verify?.state).toBe("succeeded");
    const noticed = Date.parse(verify?.verify?.finishedAt ?? "") - upAt;
    console.log(`verify noticed the site ${noticed} ms after it came back`);
    expect(noticed).toBeLessThan(12_000);
    await useMethod(fakeMachine, "hook", { timeoutSeconds: 60 });
  });
});
