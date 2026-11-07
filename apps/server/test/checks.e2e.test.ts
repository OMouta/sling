/**
 * Checks end to end: real Postgres, the control plane in-process, a local
 * site, a real sling-runner for command checks, the TypeScript Runner for a
 * PR's CI, and a scripted mock model for actions from chat.
 *
 * Needs Docker, and the Runner built first: cargo build -p sling-runner
 * (without it, the command check is skipped).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { defineConnector } from "@sling/connector-sdk";
import type {
  CheckResultView,
  CheckView,
  PushPayload,
  RunnerView,
  ServerEvent,
  TaskView,
  ToolStep,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import type { VerifyResult } from "@sling/workflow";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Checks } from "../src/checks/service.ts";
import type { RunOutcome } from "../src/checks/state.ts";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");

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
const script: { tool: string; input: unknown }[] = [];
/** What each [Sling update] said, as the model saw it. */
const updates: string[] = [];

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const last = options.prompt.at(-1);
    if (last?.role === "tool") return text("Done.");
    const userText =
      last?.role === "user"
        ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
        : "";
    if (userText.startsWith("[Sling update]")) {
      updates.push(userText);
      return text("I told you about the check.");
    }
    const next = script.shift();
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

// ---------------------------------------------------------------- a connector whose sends check themselves

/** What the next verify calls answer, in order. The last one repeats. */
const verifyAnswers: VerifyResult[] = [];
const verifyCalls: { attempt: number; outputs: Record<string, unknown> }[] = [];

const poster = defineConnector({
  id: "test-post",
  name: "Poster",
  description: "Posts somewhere, and can say whether the post is there.",
  credentialsSchema: z.object({}),
  secretFields: [],
  configSchema: z.object({}),
  test: async () => ({ ok: true }),
  nodes: [
    {
      type: "testpost.send",
      version: 1,
      title: "Post a note",
      description: "Posts a note.",
      category: "action",
      connector: "test-post",
      configSchema: z.object({
        installationId: z.string().describe("Account."),
        text: z.string().describe("What to post."),
      }),
      installationFields: ["installationId"],
      inputs: [],
      outputs: [{ name: "postId", type: "string" }],
      execInput: true,
      execOutputs: [{ name: "next" }],
      idempotent: false,
      assistant: { sends: true, summary: "Post {text}" },
      run: async () => ({ exec: "next", outputs: { postId: "post_1" } }),
      verifyForSeconds: 120,
      verify: async (ctx, { outputs }) => {
        verifyCalls.push({ attempt: ctx.attempt, outputs });
        const answer = verifyAnswers.length > 1 ? verifyAnswers.shift() : verifyAnswers[0];
        return answer ?? { state: "unchecked", message: "No answer set" };
      },
    },
  ],
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let dir = "";
let cookie = "";
let origin = "";
let site: Server;
let siteUrl = "";
let siteDown = false;
let runner: ChildProcess | null = null;
let machine: RunnerView | null = null;
let ciBox: FakeRunner;
let ciAnswer: { checks: { name: string; bucket: string }[] } | { error: string } = { checks: [] };
const pushes: { payload: PushPayload; urgency?: string }[] = [];
const events: ServerEvent[] = [];

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

const check = (id: string) =>
  api<CheckView[]>("GET", "/api/checks").then((l) => l.find((c) => c.id === id));
const svc = () => server.ctx.checks as Checks;
/** Makes a check due now, as if its interval had passed. */
const due = (id: string) =>
  server.ctx.db
    .update(schema.checks)
    .set({ nextRunAt: new Date(Date.now() - 1000) })
    .where(eq(schema.checks.id, id));

async function workspace() {
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers);
  if (!m) throw new Error("no workspace");
  return { workspaceId: m.workspaceId, userId: m.userId };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sling-checks-"));
  site = createHttpServer((req, res) => {
    if (req.url === "/ok" && !siteDown) return res.writeHead(200).end("fine");
    res.writeHead(500).end("broken");
  });
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

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
  server = await startServer(config, { model, jobs: false, connectors: [poster] });
  server.ctx.push.notify = async (_w, _u, payload, opts = {}) => {
    pushes.push({ payload, ...(opts.urgency ? { urgency: opts.urgency } : {}) });
    return 1;
  };
  const publish = server.ctx.hub.publish.bind(server.ctx.hub);
  server.ctx.hub.publish = (workspaceId, event) => {
    events.push(event);
    publish(workspaceId, event);
  };
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });

  ciBox = new FakeRunner({
    url: server.url,
    name: "ci-box",
    repos: [{ name: "site", remoteUrl: "https://github.com/acme/site.git" }],
    prUrl: (taskId) =>
      `https://github.com/acme/site/pull/${taskId.slice(-4).replace(/\D/g, "") || "1"}`,
    ci: () => ciAnswer,
  });
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await ciBox.pair(code);
  await ciBox.connect();
  await until("ci-box online", async () =>
    (await api<RunnerView[]>("GET", "/api/runners")).some((r) => r.name === "ci-box" && r.online),
  );

  if (existsSync(RUNNER)) {
    const env = {
      ...process.env,
      SLING_RUNNER_HOME: join(dir, "runner"),
      SLING_RUNNER_LOG: "warn",
    };
    const cli = (...args: string[]) => promisify(execFile)(RUNNER, args, { env });
    const enrollment = await api<{ code: string }>("POST", "/api/runners/enrollments");
    await cli("config", "set", "codex-bin", join(dir, "no-codex-here"));
    await cli("config", "set", "claude-bin", join(dir, "no-claude-here"));
    await cli("config", "set", "scan-roots", dir);
    await cli("pair", server.url, enrollment.code, "--name", "laptop");
    runner = spawn(RUNNER, ["run"], { env, stdio: "ignore" });
    machine = await until("the machine", async () =>
      (await api<RunnerView[]>("GET", "/api/runners")).find(
        (r) => r.name === "laptop" && r.online && r.capabilities.some((c) => c.name === "shell"),
      ),
    );
  }
}, 120_000);

afterAll(async () => {
  runner?.kill("SIGTERM");
  ciBox?.close();
  await server?.close();
  await pg?.stop();
  site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- site checks

describe("a site check", () => {
  it("runs on its own, goes down after two failures, pushes, and keeps its history", async () => {
    const created = await api<CheckView>("POST", "/api/checks", {
      name: "Docs",
      config: { kind: "site", checks: [{ url: `${siteUrl}/ok` }], versionUrl: null },
    });
    expect(created).toMatchObject({
      kind: "site",
      state: "unknown",
      intervalSeconds: 60,
      notify: true,
      deploy: null,
      lastResult: null,
    });
    expect(created.nextRunAt).not.toBeNull();

    expect(await server.ctx.checks.tick()).toBeGreaterThanOrEqual(1);
    const up = await check(created.id);
    expect(up).toMatchObject({ state: "up", failures: 0 });
    expect(up?.lastResult?.message).toMatch(/^Answered 200 in \d+ ms$/);
    // It ran, so it isn't due again for a minute.
    expect(await server.ctx.checks.tick()).toBe(0);

    siteDown = true;
    try {
      await due(created.id);
      await server.ctx.checks.tick();
      expect(await check(created.id)).toMatchObject({ state: "up", failures: 1 });
      expect(pushes).toHaveLength(0);
      await due(created.id);
      await server.ctx.checks.tick();
      const down = await check(created.id);
      expect(down).toMatchObject({ state: "down", failures: 2 });
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        urgency: "high",
        payload: { title: "Docs is down: 500", tag: `check:${created.id}` },
      });
      const url = new URL(pushes[0]?.payload.url ?? "", "http://x");
      expect(url.searchParams.get("personality")).toBe("incident");
      expect(url.searchParams.get("draft")).toMatch(/^Docs is down \(500 since \d\d:\d\d\)\./);
    } finally {
      siteDown = false;
    }
    const back = await api<CheckView>("POST", `/api/checks/${created.id}/run`);
    expect(back.state).toBe("up");
    expect(pushes.at(-1)?.payload).toMatchObject({ title: "Docs is back up", url: "/checks" });

    const results = await api<CheckResultView[]>("GET", `/api/checks/${created.id}/results`);
    expect(results.map((r) => [r.passed, r.state])).toEqual([
      [true, "up"],
      [false, "down"],
      [false, "up"],
      [true, "up"],
    ]);
    const verbs = (
      await server.ctx.db
        .select({ verb: schema.auditEvents.verb })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.subjectId, created.id))
    ).map((a) => a.verb);
    expect(verbs).toEqual(["check.created", "check.down", "check.up"]);
    expect(events.some((e) => e.type === "check.changed" && e.check.id === created.id)).toBe(true);
  });

  it("keeps the newest 100 results", async () => {
    const c = await api<CheckView>("POST", "/api/checks", {
      name: "Busy",
      config: { kind: "site", checks: [{ url: `${siteUrl}/ok` }], versionUrl: null },
      notify: false,
    });
    const { workspaceId } = await workspace();
    for (let i = 0; i < 104; i++) await server.ctx.checks.run(workspaceId, c.id);
    const [{ n } = { n: 0 }] = await server.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.checkResults)
      .where(eq(schema.checkResults.checkId, c.id));
    expect(n).toBe(100);
    await api("DELETE", `/api/checks/${c.id}`);
  });

  it("refuses what can't be a check", async () => {
    const bad = async (body: unknown, status = 400) => {
      const r = await raw("POST", "/api/checks", body);
      expect(r.status, r.text).toBe(status);
      return r.text;
    };
    const siteConfig = { kind: "site", checks: [{ url: `${siteUrl}/ok` }], versionUrl: null };
    expect(await bad({ name: "docs", config: siteConfig }, 409)).toContain(
      "There's already a check called Docs.",
    );
    expect(await bad({ name: "Cmd", config: { kind: "command", command: "true" } })).toContain(
      "A command check needs the machine it runs on.",
    );
    // The TypeScript Runner reports no commands, so it can't run one.
    const box = (await api<RunnerView[]>("GET", "/api/runners")).find((r) => r.name === "ci-box");
    expect(
      await bad({ name: "Cmd", config: { kind: "command", command: "true" }, runnerId: box?.id }),
    ).toContain("can't run there");
    expect(
      await bad({
        name: "Reply",
        config: { kind: "reply", from: "jo@x" },
        deadline: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ).toContain("A reply check needs the email account it watches.");
    expect(
      await bad({
        name: "Deploys",
        config: { kind: "command", command: "true" },
        runnerId: box?.id,
        deploy: { remoteKey: "github.com/acme/site", method: "merge" },
      }),
    ).toContain("Only a site check can deploy.");
    const docs = (await api<CheckView[]>("GET", "/api/checks")).find((c) => c.name === "Docs");
    const r = await raw("PATCH", `/api/checks/${docs?.id}`, {
      config: { kind: "command", command: "true" },
    });
    expect(r.status).toBe(400);
    expect(r.text).toContain("A check's kind can't change.");
  });

  it("deploys through a site check, and stops when its deploy section goes", async () => {
    const c = await api<CheckView>("POST", "/api/checks", {
      name: "Shop",
      config: { kind: "site", checks: [{ url: `${siteUrl}/ok` }], versionUrl: null },
      deploy: { remoteKey: "https://github.com/acme/shop.git", method: "merge" },
    });
    expect(c.deploy).toMatchObject({
      remoteKey: "github.com/acme/shop",
      method: "merge",
      mergeMethod: "squash",
      settleSeconds: 60,
      lastDeploy: null,
    });
    const targets = await api<{ id: string; name: string; checks: unknown[] }[]>(
      "GET",
      "/api/deploy-targets",
    );
    expect(targets.find((t) => t.id === c.deploy?.id)).toMatchObject({
      name: "Shop",
      checks: [{ url: `${siteUrl}/ok`, status: null, contains: null }],
    });
    const renamed = await api<CheckView>("PATCH", `/api/checks/${c.id}`, { name: "Shop site" });
    expect(renamed.deploy?.id).toBe(c.deploy?.id);
    expect(
      (await api<{ id: string; name: string }[]>("GET", "/api/deploy-targets")).find(
        (t) => t.id === c.deploy?.id,
      )?.name,
    ).toBe("Shop site");
    const stopped = await api<CheckView>("PATCH", `/api/checks/${c.id}`, { deploy: null });
    expect(stopped.deploy).toBeNull();
    expect(
      (await api<{ id: string }[]>("GET", "/api/deploy-targets")).some(
        (t) => t.id === c.deploy?.id,
      ),
    ).toBe(false);
    await api("DELETE", `/api/checks/${c.id}`);
  });

  it("gives a deploy target with no check one, with its URLs and last check", async () => {
    const { workspaceId, userId } = await workspace();
    const id = newId("dpt");
    await server.ctx.db.insert(schema.deployTargets).values({
      id,
      workspaceId,
      ownerId: userId,
      name: "Docs",
      remoteKey: "github.com/acme/old",
      method: "merge",
      checks: [{ url: `${siteUrl}/ok`, status: null, contains: null }],
      versionUrl: null,
      lastCheck: { at: new Date().toISOString(), up: false, failures: 3, results: [] },
    });
    expect(await svc().adoptTargets()).toBe(1);
    const adopted = (await api<CheckView[]>("GET", "/api/checks")).find((c) => c.deploy?.id === id);
    // Docs is taken, so it gets the next free name.
    expect(adopted).toMatchObject({ name: "Docs 2", state: "down", failures: 3, kind: "site" });
    await api("DELETE", `/api/checks/${adopted?.id}`);
  });
});

// ---------------------------------------------------------------- command checks

describe("a command check", () => {
  it("passes in the machine's read-only sandbox, and goes down when the command fails", async (t) => {
    if (!machine?.capabilities.some((c) => c.name === "shell.sandbox" && c.ready)) t.skip();
    const marker = join(dir, "backup-done");
    writeFileSync(marker, "ok\n");
    const c = await api<CheckView>("POST", "/api/checks", {
      name: "Backup",
      config: { kind: "command", command: `cat '${marker}'`, contains: "ok" },
      runnerId: machine?.id,
    });
    expect(c).toMatchObject({ intervalSeconds: 300, runnerName: "laptop" });
    const ran = await api<CheckView>("POST", `/api/checks/${c.id}/run`);
    expect(ran.state).toBe("up");
    expect(ran.lastResult?.detail).toMatchObject({ kind: "command", exitCode: 0, output: "ok\n" });

    unlinkSync(marker);
    await api("POST", `/api/checks/${c.id}/run`);
    const down = await api<CheckView>("POST", `/api/checks/${c.id}/run`);
    expect(down).toMatchObject({ state: "down", failures: 2 });
    expect(down.lastResult?.message).toMatch(/^Exited 1/);
    expect(pushes.at(-1)?.payload.title).toMatch(/^Backup is failing: Exited 1/);

    // The sandbox can't write, so a command that does fails there.
    const writes = await api<CheckView>("PATCH", `/api/checks/${c.id}`, {
      config: { kind: "command", command: `touch '${marker}'`, contains: null },
    });
    expect(writes.state).toBe("unknown");
    const refused = await api<CheckView>("POST", `/api/checks/${c.id}/run`);
    expect(refused.lastResult?.passed).toBe(false);
    expect(existsSync(marker)).toBe(false);
    await api("DELETE", `/api/checks/${c.id}`);
  });
});

// ---------------------------------------------------------------- reply checks

describe("a reply check", () => {
  it("waits, is met by a matching reply, and is missed after its deadline", async () => {
    const { workspaceId, userId } = await workspace();
    const installationId = newId("ins");
    await server.ctx.db.insert(schema.connectorInstallations).values({
      id: installationId,
      workspaceId,
      ownerId: userId,
      connectorId: "email",
      name: "Mail",
      config: {},
      enabled: false,
    });
    let inbox: { id: string; from: string; subject: string; date: string; inReplyTo?: string }[] =
      [];
    const asked: unknown[] = [];
    const search = svc().mailSearch;
    svc().mailSearch = async (q) => {
      asked.push(q.config);
      return { messages: inbox };
    };
    try {
      const deadline = new Date(Date.now() + 3600_000).toISOString();
      const c = await api<CheckView>("POST", "/api/checks", {
        name: "Jo replied",
        config: { kind: "reply", from: "jo@silva.pt", subject: "invoice", inReplyTo: "<m1@sling>" },
        installationId,
        deadline,
      });
      expect(c).toMatchObject({ installationName: "Mail", intervalSeconds: 300 });
      expect((await api<CheckView>("POST", `/api/checks/${c.id}/run`)).state).toBe("waiting");
      expect(asked[0]).toMatchObject({ from: "jo@silva.pt", subject: "invoice" });

      // A mail from Jo that isn't in the thread doesn't count.
      inbox = [{ id: "1", from: "jo@silva.pt", subject: "Lunch?", date: "" }];
      expect((await api<CheckView>("POST", `/api/checks/${c.id}/run`)).state).toBe("waiting");
      inbox = [
        { id: "2", from: "jo@silva.pt", subject: "Re: invoice", date: "", inReplyTo: "<m1@sling>" },
      ];
      const met = await api<CheckView>("POST", `/api/checks/${c.id}/run`);
      expect(met).toMatchObject({ state: "met", nextRunAt: null });
      expect(pushes.at(-1)?.payload).toMatchObject({
        title: "Jo replied",
        body: "jo@silva.pt replied: Re: invoice",
      });

      inbox = [];
      const late = await api<CheckView>("POST", "/api/checks", {
        name: "Ana replied",
        config: { kind: "reply", from: "ana@x" },
        installationId,
        deadline: new Date(Date.now() + 1500).toISOString(),
      });
      await new Promise((r) => setTimeout(r, 1600));
      const missed = await api<CheckView>("POST", `/api/checks/${late.id}/run`);
      expect(missed).toMatchObject({ state: "missed", nextRunAt: null });
      expect(pushes.at(-1)?.payload.title).toMatch(/^Ana replied: no reply by /);
      expect(
        (await raw("PATCH", `/api/checks/${late.id}`, { deadline: new Date(0).toISOString() }))
          .text,
      ).toContain("The deadline has passed already.");
      await api("DELETE", `/api/checks/${c.id}`);
      await api("DELETE", `/api/checks/${late.id}`);
    } finally {
      svc().mailSearch = search;
    }
  });
});

// ---------------------------------------------------------------- the scheduler

describe("the scheduler", () => {
  it("runs at most eight checks at once, with little overhead per check", async () => {
    const site = svc().kinds.site;
    let running = 0;
    let most = 0;
    const instant: RunOutcome = {
      passed: true,
      counted: true,
      message: "Answered 200 in 1 ms",
      ms: 1,
      detail: { kind: "site", checks: [], versionSeen: null },
    };
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const c = await api<CheckView>("POST", "/api/checks", {
        name: `Load ${i}`,
        config: { kind: "site", checks: [{ url: `${siteUrl}/ok` }], versionUrl: null },
        notify: false,
      });
      ids.push(c.id);
    }
    try {
      svc().kinds.site = async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 40));
        running--;
        return instant;
      };
      expect(await server.ctx.checks.tick()).toBeGreaterThanOrEqual(40);
      expect(most).toBe(8);

      svc().kinds.site = async () => instant;
      for (const id of ids) await due(id);
      const started = performance.now();
      const n = await server.ctx.checks.tick();
      const perCheck = (performance.now() - started) / n;
      console.log(`scheduler overhead: ${perCheck.toFixed(2)} ms per check over ${n}`);
      expect(n).toBeGreaterThanOrEqual(40);
      expect(perCheck).toBeLessThan(5);

      // A check that's off is never due.
      await api("PATCH", `/api/checks/${ids[0]}`, { enabled: false });
      await due(ids[0] ?? "");
      expect((await check(ids[0] ?? ""))?.nextRunAt).toBeNull();
      const before = (await check(ids[0] ?? ""))?.lastResult?.id;
      await server.ctx.checks.tick();
      expect((await check(ids[0] ?? ""))?.lastResult?.id).toBe(before);
    } finally {
      svc().kinds.site = site;
      for (const id of ids) await api("DELETE", `/api/checks/${id}`);
    }
  });
});

// ---------------------------------------------------------------- actions from chat

async function newConversation() {
  const conv = await api<{ id: string }>("POST", "/api/conversations");
  await api("PATCH", `/api/conversations/${conv.id}`, { mode: "full-access" });
  return conv.id;
}

async function postStep(conversationId: string): Promise<{ messageId: string; step: ToolStep }> {
  return until("the reply's step", async () => {
    const rows = await server.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.role, "assistant"),
        ),
      );
    for (const r of rows) {
      const step = r.trace?.steps.find(
        (s): s is ToolStep => s.kind === "tool" && s.name === "testpost_send",
      );
      if (step) return { messageId: r.id, step };
    }
    return null;
  });
}

describe("an action from chat", () => {
  let installationReady = false;
  const install = async () => {
    if (installationReady) return;
    await api("POST", "/api/installations", {
      connectorId: "test-post",
      name: "Board",
      credentials: {},
      config: {},
    });
    installationReady = true;
  };

  it("is checked right away, and the check shows on its step and in the tool's result", async () => {
    await install();
    verifyAnswers.splice(0, verifyAnswers.length, { state: "passed", message: "On the board" });
    const conv = await newConversation();
    script.push({ tool: "testpost_send", input: { text: "hello" } });
    await api("POST", `/api/conversations/${conv}/messages`, { text: "Post hello." });
    const { step } = await postStep(conv);
    expect(step.check).toMatchObject({ state: "passed", message: "On the board" });
    expect(JSON.parse(step.output ?? "{}")).toMatchObject({
      check: { state: "passed", message: "On the board" },
    });
    expect(verifyCalls.at(-1)).toEqual({ attempt: 1, outputs: { postId: "post_1" } });
  });

  it("checks again while it waits, and a failure lands on the step, tells the conversation, and pushes", async () => {
    await install();
    verifyAnswers.splice(
      0,
      verifyAnswers.length,
      { state: "waiting", message: "Not there yet", retryAfterSeconds: 5 },
      { state: "failed", message: "The post was taken down" },
    );
    const before = pushes.length;
    const conv = await newConversation();
    script.push({ tool: "testpost_send", input: { text: "second" } });
    const started = Date.now();
    await api("POST", `/api/conversations/${conv}/messages`, { text: "Post it." });
    const first = await postStep(conv);
    expect(first.step.check?.state).toBe("waiting");

    const landed = await until(
      "the failed check",
      async () =>
        events.find(
          (e): e is Extract<ServerEvent, { type: "tool_step.check" }> =>
            e.type === "tool_step.check" && e.conversationId === conv && e.check.state === "failed",
        ),
      20_000,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    expect(landed).toMatchObject({
      messageId: first.messageId,
      stepId: first.step.id,
      check: { state: "failed", message: "The post was taken down" },
    });
    expect((await postStep(conv)).step.check?.state).toBe("failed");
    expect(pushes.slice(before).map((p) => p.payload)).toContainEqual(
      expect.objectContaining({
        title: "Check failed: Post second",
        body: "The post was taken down",
        url: `/c/${conv}`,
      }),
    );
    // The note goes to the conversation, and the assistant answers it.
    await until("the assistant hears", async () =>
      updates.find((u) => u.includes("The post was taken down")),
    );
  });
});

// ---------------------------------------------------------------- a PR's CI

describe("a delivered PR", () => {
  async function prTask(title: string) {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, { mode: "auto" });
    const box = (await api<RunnerView[]>("GET", "/api/runners")).find((r) => r.name === "ci-box");
    const created = await api<{ id: string }>("POST", "/api/tasks", {
      repo: "site",
      title,
      objective: "Change something.",
      deliver: "pr",
      conversationId: conv.id,
      environment: "machine",
      machineId: box?.id,
    });
    return { taskId: created.id, conversationId: conv.id };
  }
  const prStep = async (taskId: string) =>
    (await api<{ task: TaskView }>("GET", `/api/tasks/${taskId}`)).task.actions.find(
      (a) => a.kind === "open_pr",
    );

  it("waits for its CI, read on the machine, and the PR's step shows it", async () => {
    ciAnswer = {
      checks: [
        { name: "test", bucket: "pass" },
        { name: "lint", bucket: "pass" },
        { name: "docs", bucket: "skipping" },
      ],
    };
    const { taskId } = await prTask("Passing CI");
    const pr = await until("CI checked", async () => {
      const a = await prStep(taskId);
      return a?.check?.state === "passed" ? a : null;
    });
    expect(pr.check?.message).toBe("CI passed: 2 checks");
    const asked = ciBox.repoActions.filter((r) => r.action.prUrl === pr.url);
    expect(asked.length).toBeGreaterThanOrEqual(1);
  });

  it("tells the conversation when CI fails", async () => {
    ciAnswer = {
      checks: [
        { name: "test", bucket: "fail" },
        { name: "lint", bucket: "pass" },
      ],
    };
    const before = pushes.length;
    const { taskId, conversationId } = await prTask("Failing CI");
    const pr = await until("CI checked", async () => {
      const a = await prStep(taskId);
      return a?.check?.state === "failed" ? a : null;
    });
    expect(pr.check?.message).toBe("CI failed: test (1 of 2)");
    expect(pushes.slice(before).map((p) => p.payload.title)).toContainEqual(
      expect.stringMatching(/^Check failed: PR #\d+ for "Failing CI"$/),
    );
    const notes = await server.ctx.db
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.role, "system")),
      );
    expect(JSON.stringify(notes)).toContain("CI failed: test (1 of 2)");
  });
});
