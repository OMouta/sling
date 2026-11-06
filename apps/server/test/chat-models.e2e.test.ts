/**
 * Model choices in chat, provider keys and model lists, repos allowed from
 * the web app, the one-line install script, and turning two-factor on
 * without a password right after signing in.
 */
import { createServer } from "node:net";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import type { ModelCatalogView, ReplyTrace } from "@sling/core";
import { schema } from "@sling/db";
import { RepoChange_Op } from "@sling/runner-protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let cookie = "";
let origin = "";
let runner: FakeRunner | null = null;
const realFetch = globalThis.fetch;

/** The assistant answers every update with one word, so no model call leaves the test. */
const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "t" },
      { type: "text-delta" as const, id: "t", delta: "Noted." },
      { type: "text-end" as const, id: "t" },
      {
        type: "finish" as const,
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      },
    ]),
  }),
});

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function raw(method: string, path: string, body?: unknown) {
  const res = await realFetch(server.url + path, {
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
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, text };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.body as T;
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Provider model lists, without reaching the real APIs. */
function stubProviders() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.anthropic.com/v1/models")) {
      const key = new Headers(init?.headers).get("x-api-key");
      if (key !== "sk-ant-good") {
        return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
          status: 401,
        });
      }
      return Response.json({
        data: [
          {
            id: "claude-sonnet-5-5",
            display_name: "Claude Sonnet 5.5",
            created_at: "2026-09-01T00:00:00Z",
          },
          {
            id: "claude-opus-5-5",
            display_name: "Claude Opus 5.5",
            created_at: "2026-10-01T00:00:00Z",
          },
          {
            id: "claude-haiku-4-5",
            display_name: "Claude Haiku 4.5",
            created_at: "2025-10-01T00:00:00Z",
          },
        ],
      });
    }
    if (url.startsWith("https://api.openai.com/v1/models")) {
      return Response.json({
        data: [
          { id: "gpt-5.1", created: 1_760_000_000 },
          { id: "gpt-4o-mini-tts", created: 1_750_000_000 },
          { id: "text-embedding-3-large", created: 1_700_000_000 },
          { id: "gpt-5.1-2025-11-13", created: 1_760_000_001 },
        ],
      });
    }
    // Model calls from the assistant never leave the test.
    if (/^https:\/\/api\.(anthropic|openai)\.com\//.test(url)) {
      return new Response(JSON.stringify({ error: { message: "offline in tests" } }), {
        status: 503,
      });
    }
    return realFetch(input, init);
  });
}

beforeAll(async () => {
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
  stubProviders();
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  runner?.close();
  await server?.close();
  await pg?.stop();
});

describe("provider keys and model lists", () => {
  it("lists nothing until a key is stored or a machine is paired", async () => {
    const catalog = await api<ModelCatalogView>("GET", "/api/models");
    // No machine yet, so the CLIs aren't ready either.
    expect(catalog.assistant.map((p) => [p.provider, p.connected])).toEqual([
      ["codex", false],
      ["claude-code", false],
      ["openai", false],
      ["anthropic", false],
      ["openai-compatible", false],
    ]);
    expect(catalog.defaults.assistant).toBeNull();
    expect(catalog.defaults.agent).toEqual({
      harness: "codex",
      model: null,
      effort: null,
      fast: false,
    });
  });

  it("lists a provider's models from its API, with effort levels and fast mode", async () => {
    const catalog = await api<ModelCatalogView>("PUT", "/api/settings/providers/anthropic", {
      apiKey: "sk-ant-good",
    });
    const anthropic = catalog.assistant.find((p) => p.provider === "anthropic");
    expect(anthropic?.connected).toBe(true);
    expect(anthropic?.error).toBeNull();
    expect(anthropic?.models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
    ]);
    const opus = anthropic?.models[0];
    expect(opus).toMatchObject({
      label: "Claude Opus 5.5",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      fast: true,
    });
    expect(anthropic?.models[2]).toMatchObject({ efforts: [], defaultEffort: null, fast: false });
    // The first provider stored becomes the default for new conversations.
    expect(catalog.defaults.assistant).toMatchObject({ provider: "anthropic" });
  });

  it("drops non-chat and dated OpenAI models", async () => {
    const catalog = await api<ModelCatalogView>("PUT", "/api/settings/providers/openai", {
      apiKey: "sk-openai",
    });
    const openai = catalog.assistant.find((p) => p.provider === "openai");
    expect(openai?.models.map((m) => [m.id, m.label, m.efforts.length > 0])).toEqual([
      ["gpt-5.1", "GPT-5.1", true],
    ]);
  });

  it("says why a list didn't load, and still offers the stored model", async () => {
    await api("PUT", "/api/settings/providers/anthropic", { apiKey: "sk-ant-bad" });
    const test = await api<{ ok: boolean; error?: string }>(
      "POST",
      "/api/settings/providers/anthropic/test",
    );
    expect(test.ok).toBe(false);
    expect(test.error).toContain("invalid x-api-key");
    const catalog = await api<ModelCatalogView>("GET", "/api/models");
    const anthropic = catalog.assistant.find((p) => p.provider === "anthropic");
    expect(anthropic?.connected).toBe(true);
    expect(anthropic?.models.map((m) => m.id)).toEqual(["claude-sonnet-5-5"]);
    await api("PUT", "/api/settings/providers/anthropic", { apiKey: "sk-ant-good" });
  });

  it("refuses a provider without a key, and removes one", async () => {
    const res = await raw("PUT", "/api/settings/providers/openai-compatible", {});
    expect(res.status).toBe(400);
    const catalog = await api<ModelCatalogView>("DELETE", "/api/settings/providers/openai");
    expect(catalog.assistant.find((p) => p.provider === "openai")?.connected).toBe(false);
  });
});

describe("choices in a conversation", () => {
  it("saves workspace defaults and per-conversation overrides", async () => {
    await api("PUT", "/api/settings/chat-defaults", {
      assistant: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", fast: false },
      agent: { harness: "claude-code", model: "opus", effort: "xhigh", fast: false },
    });
    const [ws] = await server.ctx.db.select().from(schema.workspaces);
    expect(ws?.defaultHarness).toBe("claude-code");

    const conv = await api<{ id: string; settings: unknown }>("POST", "/api/conversations");
    expect(conv.settings).toEqual({ assistant: null, agent: null });
    const updated = await api<{ settings: { assistant: unknown; agent: unknown } }>(
      "PATCH",
      `/api/conversations/${conv.id}`,
      {
        settings: { agent: { harness: "codex", model: "gpt-5.6-sol", effort: "high", fast: true } },
      },
    );
    expect(updated.settings).toEqual({
      assistant: null,
      agent: { harness: "codex", model: "gpt-5.6-sol", effort: "high", fast: true },
    });
  });

  it("rejects model names that could reach a command line", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    const res = await raw("PATCH", `/api/conversations/${conv.id}`, {
      settings: { agent: { harness: "codex", model: 'gpt"; rm -rf /', effort: null, fast: false } },
    });
    expect(res.status).toBe(400);
  });

  it("sends the conversation's agent, model, and effort with its tasks", async () => {
    const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
    runner = new FakeRunner({
      url: server.url,
      name: "devbox",
      repos: [{ name: "site", remoteUrl: "git@github.com:acme/site.git" }],
      harnesses: ["codex", "claude-code"],
      models: {
        codex: [
          { id: "gpt-5.6-sol", efforts: ["low", "medium", "high"], fast: true, isDefault: true },
          { id: "gpt-6-luna", efforts: ["medium", "high"] },
        ],
        "claude-code": [{ id: "opus", efforts: ["low", "high", "max"] }],
      },
      foundRepos: [
        { path: "/home/dev/code/api", name: "api", remoteUrl: "git@github.com:acme/api.git" },
      ],
    });
    await runner.pair(code);
    await runner.connect();

    const catalog = await api<ModelCatalogView>("GET", "/api/models");
    const codex = catalog.agents.find((a) => a.harness === "codex");
    expect(codex).toMatchObject({ readyMachines: 1, defaultModel: "gpt-5.6-sol" });
    expect(codex?.models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-6-luna"]);

    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, {
      settings: { agent: { harness: "codex", model: "gpt-6-luna", effort: "high", fast: true } },
    });
    const created = await api<{
      id: string;
      model: string | null;
      effort: string | null;
      harness: string;
    }>("POST", "/api/tasks", {
      repo: "site",
      title: "Bump deps",
      objective: "Bump them.",
      conversationId: conv.id,
      deliver: "local",
    });
    expect(created).toMatchObject({ harness: "codex", model: "gpt-6-luna", effort: "high" });
    const assigned = await until("assignment", async () =>
      runner?.assigned.find((a) => a.taskId === created.id),
    );
    expect(assigned).toMatchObject({
      harness: "codex",
      model: "gpt-6-luna",
      effort: "high",
      fast: true,
    });

    // A task without a conversation uses the workspace default agent and model.
    const plain = await api<{ id: string; harness: string; model: string | null }>(
      "POST",
      "/api/tasks",
      { repo: "site", title: "Docs", objective: "Write docs.", deliver: "local" },
    );
    expect(plain).toMatchObject({ harness: "claude-code", model: "opus" });
    // Naming another agent drops the default's model.
    const other = await api<{ harness: string; model: string | null; effort: string | null }>(
      "POST",
      "/api/tasks",
      { repo: "site", title: "Lint", objective: "Lint.", deliver: "local", harness: "codex" },
    );
    expect(other).toMatchObject({ harness: "codex", model: null, effort: null });
  });
});

describe("repos from the web app", () => {
  it("allows a found repo through the machine, then removes it", async () => {
    const machine = async () =>
      (
        await api<
          {
            id: string;
            repos: { name: string }[];
            foundRepos: { path: string }[];
            remoteRepos: boolean;
          }[]
        >("GET", "/api/runners")
      )[0];
    const m = await machine();
    expect(m?.remoteRepos).toBe(true);
    expect(m?.foundRepos.map((f) => f.path)).toEqual(["/home/dev/code/api"]);

    const res = await api<{ ok: boolean; message: string }>("POST", `/api/runners/${m?.id}/repos`, {
      path: "/home/dev/code/api",
    });
    expect(res).toEqual({ ok: true, message: "Allowed api." });
    expect(runner?.repoChanges.at(-1)).toMatchObject({
      op: RepoChange_Op.ADD,
      path: "/home/dev/code/api",
    });
    await until("repo listed", async () => (await machine())?.repos.some((r) => r.name === "api"));
    expect((await machine())?.foundRepos).toEqual([]);

    const removed = await api<{ ok: boolean }>("DELETE", `/api/runners/${m?.id}/repos/api`);
    expect(removed.ok).toBe(true);
    await until("repo gone", async () => !(await machine())?.repos.some((r) => r.name === "api"));
  });

  it("allows several found repos in one change", async () => {
    const [m] = await api<{ id: string }[]>("GET", "/api/runners");
    const found = [
      { path: "/home/dev/code/web", name: "web" },
      { path: "/home/dev/code/docs", name: "docs" },
    ];
    runner?.options.foundRepos?.push(...found);
    await api("POST", `/api/runners/${m?.id}/scan`);
    await until("both found", async () => {
      const [r] = await api<{ foundRepos: { path: string }[] }[]>("GET", "/api/runners");
      return (r?.foundRepos.length ?? 0) >= 2;
    });

    const res = await api<{ ok: boolean; message: string }>("POST", `/api/runners/${m?.id}/repos`, {
      // A path the machine never reported is dropped before anything is sent.
      paths: [...found.map((f) => f.path), "/etc"],
    });
    expect(res).toEqual({ ok: true, message: "Added 2 repos: web, docs." });
    expect(runner?.repoChanges.at(-1)).toMatchObject({
      op: RepoChange_Op.ADD,
      path: "",
      paths: found.map((f) => f.path),
    });
    await until("both allowed", async () => {
      const [r] = await api<{ repos: { name: string }[] }[]>("GET", "/api/runners");
      return ["web", "docs"].every((n) => r?.repos.some((p) => p.name === n));
    });
  });

  it("only sends paths the machine reported", async () => {
    const [m] = await api<{ id: string }[]>("GET", "/api/runners");
    const before = runner?.repoChanges.length;
    const res = await raw("POST", `/api/runners/${m?.id}/repos`, { path: "/etc" });
    expect(res.status).toBe(404);
    const many = await raw("POST", `/api/runners/${m?.id}/repos`, { paths: ["/etc", "/"] });
    expect(many.status).toBe(404);
    expect(runner?.repoChanges.length).toBe(before);
  });

  it("asks the machine to look again", async () => {
    const [m] = await api<{ id: string }[]>("GET", "/api/runners");
    await api("POST", `/api/runners/${m?.id}/scan`);
    await until("scan", async () => (runner?.scans ?? 0) > 0);
  });

  it("audits repo changes", async () => {
    const rows = await server.ctx.db
      .select({ verb: schema.auditEvents.verb })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectType, "runner"));
    expect(rows.map((r) => r.verb)).toEqual(
      expect.arrayContaining(["runner.repo_allowed", "runner.repo_removed"]),
    );
  });
});

describe("one-line install", () => {
  it("serves the install scripts with this server's URL and release repo filled in", async () => {
    const sh = await raw("GET", "/install.sh");
    expect(sh.status).toBe(200);
    expect(sh.text).toContain(`: "\${SLING_URL:=${origin}}"`);
    expect(sh.text).toContain(`: "\${SLING_REPO:=acme/sling}"`);
    const ps = await raw("GET", "/install.ps1");
    expect(ps.text).toContain(`$env:SLING_URL = '${origin}'`);
  });

  it("gives an install command with the pairing code", async () => {
    const e = await api<{ code: string; installCommand: string; command: string }>(
      "POST",
      "/api/runners/enrollments",
    );
    expect(e.installCommand).toBe(`curl -fsSL ${origin}/install.sh | SLING_CODE=${e.code} sh`);
    expect(e.command).toBe(`sling-runner pair ${origin} ${e.code}`);
  });
});

describe("two-factor without a password right after sign-in", () => {
  it("sets up an authenticator app that the normal verify step turns on", async () => {
    const setup = await api<{ totpURI: string; backupCodes: string[] }>(
      "POST",
      "/api/auth/two-factor/enable-fresh",
    );
    expect(setup.backupCodes).toHaveLength(10);
    expect(setup.backupCodes[0]).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
    // An authenticator app reads the base32 secret from the QR code.
    const encoded = new URL(setup.totpURI).searchParams.get("secret") ?? "";
    const secret = new TextDecoder().decode(base32.decode(encoded));
    expect(setup.totpURI).toContain("issuer=Sling");
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    await api("POST", "/api/auth/two-factor/verify-totp", { code });
    const [user] = await server.ctx.db.select().from(schema.users);
    expect(user?.twoFactorEnabled).toBe(true);
  });

  it("asks to confirm when the sign-in isn't recent", async () => {
    await server.ctx.db
      .update(schema.sessions)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) });
    const res = await raw("POST", "/api/auth/two-factor/disable-fresh");
    expect(res.status).toBe(403);
    expect(res.text).toContain("REAUTH_REQUIRED");
    const [user] = await server.ctx.db.select().from(schema.users);
    expect(user?.twoFactorEnabled).toBe(true);
  });

  it("turns it off again with a recent sign-in", async () => {
    await server.ctx.db.update(schema.sessions).set({ createdAt: new Date() });
    await api("POST", "/api/auth/two-factor/disable-fresh");
    const [user] = await server.ctx.db.select().from(schema.users);
    expect(user?.twoFactorEnabled).toBe(false);
    expect(await server.ctx.db.select().from(schema.twoFactors)).toEqual([]);
  });
});

describe("chat on a coding agent's CLI", () => {
  async function reply(convId: string, after: number) {
    return until("assistant reply", async () => {
      const d = await api<{ messages: { role: string; text: string }[] }>(
        "GET",
        `/api/conversations/${convId}`,
      );
      const replies = d.messages.filter((m) => m.role === "assistant");
      return replies.length > after ? replies.at(-1) : null;
    });
  }

  it("runs the turn on the machine's CLI, then resumes its session", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, {
      settings: {
        assistant: { provider: "codex", model: "gpt-5.6-sol", effort: "high", fast: false },
      },
    });
    const before = runner?.chatTurns.length ?? 0;
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "What can you do?" });
    expect((await reply(conv.id, 0)).text).toBe("Fake reply to: What can you do?");
    const first = runner?.chatTurns[before];
    expect(first).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: "What can you do?",
      sessionId: "",
      history: "",
    });
    expect(first?.instructions).toContain("Coding agents you can delegate to");
    expect(first?.instructions).toContain("gpt-6-luna");
    expect(first?.toolsUrl).toBe(`${origin}/api/agent/tools`);

    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "And then?" });
    await reply(conv.id, 1);
    const second = runner?.chatTurns[before + 1];
    // Same machine, same agent: the CLI resumes, so only the new message goes over.
    expect(second?.sessionId).toBe(first ? `fake-session-${before + 1}` : "");
    expect(second?.prompt).toBe("And then?");
    expect(second?.history).toBe("");
  });

  it("serves Sling's tools to the CLI for that turn only", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, {
      settings: { assistant: { provider: "claude-code", model: "", effort: null, fast: false } },
    });
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "[fake:tool] machines?" });
    const r = await reply(conv.id, 0);
    expect(r.text).toBe(
      "Tools: list_machines, delegate_coding_task, get_task, run_command, check_deploy_target, deploy_task, cancel_task. Machines: devbox.",
    );
    // The reply keeps its thinking and the tool call Sling served, in order.
    const { messages } = await api<{ messages: { role: string; trace: ReplyTrace | null }[] }>(
      "GET",
      `/api/conversations/${conv.id}`,
    );
    const trace = messages.filter((m) => m.role === "assistant").at(-1)?.trace;
    expect(trace?.steps).toEqual([
      { kind: "thinking", text: "The user wants their machines." },
      { kind: "text", text: "Checking." },
      {
        kind: "tool",
        id: expect.any(String),
        name: "list_machines",
        input: {},
        status: "done",
        output: expect.stringContaining("devbox"),
      },
    ]);
    expect(trace?.ms).toBeGreaterThanOrEqual(0);
    const res = await realFetch(`${origin}/api/agent/tools`, {
      headers: { authorization: "Bearer not-a-turn-token" },
    });
    expect(res.status).toBe(401);
  });

  it("lists the CLIs first as models to chat with", async () => {
    const catalog = await api<ModelCatalogView>("GET", "/api/models");
    expect(catalog.assistant.slice(0, 2).map((p) => [p.provider, p.kind, p.connected])).toEqual([
      ["codex", "cli", true],
      ["claude-code", "cli", true],
    ]);
    // Named, so the web app can say which machine a chat runs on.
    expect(catalog.assistant[0]).toMatchObject({ machines: ["devbox"], error: null });
  });
});

describe("personalities", () => {
  type P = { id: string; name: string; tools: string[]; isDefault: boolean; revision: number };
  async function reply(convId: string, after: number) {
    return until("assistant reply", async () => {
      const d = await api<{ messages: { role: string; text: string }[] }>(
        "GET",
        `/api/conversations/${convId}`,
      );
      const replies = d.messages.filter((m) => m.role === "assistant");
      return replies.length > after ? replies.at(-1) : null;
    });
  }
  const byName = async (name: string) =>
    (await api<P[]>("GET", "/api/personalities")).find((p) => p.name === name) as P;

  it("starts a workspace with Sling only, and adds the rest from templates", async () => {
    const list = await api<P[]>("GET", "/api/personalities");
    expect(list.map((p) => [p.name, p.tools, p.isDefault])).toEqual([
      ["Sling", ["commands", "coding", "apps", "deploys"], true],
    ]);
    // Chats from before personalities get the default, so they keep who answers them.
    const convs = await server.ctx.db.select().from(schema.conversations);
    expect(convs.length).toBeGreaterThan(0);
    expect(new Set(convs.map((c) => c.personalityId))).toEqual(new Set([list[0]?.id]));

    const templates = await api<{ key: string; name: string; tools: string[] }[]>(
      "GET",
      "/api/personalities/templates",
    );
    expect(templates.map((t) => t.key)).toEqual([
      "sling",
      "ops",
      "incident",
      "research",
      "planner",
      "writer",
      "tutor",
      "finance",
      "travel",
      "chef",
      "language-coach",
    ]);
    expect(templates.find((t) => t.key === "ops")?.tools).toEqual(["commands"]);
    const finance = await api<P & { templateKey: string }>(
      "POST",
      "/api/personalities/templates/finance",
    );
    expect(finance).toMatchObject({
      name: "Finance",
      tools: [],
      isDefault: false,
      templateKey: "finance",
    });
    // Adding it again gives back the one that's there.
    expect((await api<P>("POST", "/api/personalities/templates/finance")).id).toBe(finance.id);
    expect((await raw("POST", "/api/personalities/templates/nope")).status).toBe(404);
    // The installed one counts as added from its template.
    expect((await api<P>("POST", "/api/personalities/templates/sling")).id).toBe(list[0]?.id);
  });

  it("gives a Finance chat on a CLI no tools, and refuses them if it asks anyway", async () => {
    const finance = await byName("Finance");
    const conv = await api<{ id: string; personalityId: string }>("POST", "/api/conversations", {
      personalityId: finance.id,
    });
    expect(conv.personalityId).toBe(finance.id);
    await api("PATCH", `/api/conversations/${conv.id}`, {
      settings: { assistant: { provider: "codex", model: "", effort: null, fast: false } },
    });
    const before = runner?.chatTurns.length ?? 0;
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Rent or buy?" });
    await reply(conv.id, 0);
    const turn = runner?.chatTurns[before];
    expect(turn?.instructions).toContain("You are Finance");
    expect(turn?.instructions).toContain("You have no tools in this chat");
    expect(turn?.instructions).not.toContain("delegate_coding_task");
    expect(turn?.instructions).not.toContain("Coding agents you can delegate to");
    expect(turn?.instructions).not.toContain("mode:");

    // The turn's token still works for a moment after the turn, and serves nothing.
    const auth = { authorization: `Bearer ${turn?.toolsToken}` };
    const listed = await realFetch(`${origin}/api/agent/tools`, { headers: auth });
    expect(await listed.json()).toEqual({ tools: [] });
    const called = await realFetch(`${origin}/api/agent/tools/list_machines`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(called.status).toBe(404);
  });

  it("gives the scripted model only the personality's tools", async () => {
    const created = await api<P>("POST", "/api/personalities", {
      name: "Ops",
      description: "Looks around the machines.",
      instructions: "You are Ops. Be terse.",
      tools: ["commands"],
      color: "amber",
      shape: "orbit",
    });
    const conv = await api<{ id: string }>("POST", "/api/conversations", {
      personalityId: created.id,
    });
    const calls = model.doStreamCalls.length;
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Disk space?" });
    await reply(conv.id, 0);
    const call = model.doStreamCalls[calls];
    expect((call?.tools ?? []).map((t) => t.name).sort()).toEqual(["list_machines", "run_command"]);
    const system = call?.prompt.find((m) => m.role === "system");
    expect(JSON.stringify(system)).toContain("You are Ops. Be terse.");
    expect(JSON.stringify(system)).not.toContain("delegate_coding_task");
  });

  it("keeps a chat's personality, and records the revision that wrote each reply", async () => {
    const ops = await byName("Ops");
    const conv = await api<{ id: string }>("POST", "/api/conversations", { personalityId: ops.id });
    // Not something a chat can change once it exists.
    const patched = await api<{ personalityId: string }>("PATCH", `/api/conversations/${conv.id}`, {
      personalityId: (await byName("Sling")).id,
      title: "Ops chat",
    });
    expect(patched.personalityId).toBe(ops.id);

    const edited = await api<P>("PATCH", `/api/personalities/${ops.id}`, {
      instructions: "You are Ops. Be very terse.",
    });
    expect(edited.revision).toBe(ops.revision + 1);
    // A new look isn't a new revision.
    expect(
      (await api<P>("PATCH", `/api/personalities/${ops.id}`, { color: "rose" })).revision,
    ).toBe(edited.revision);
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Uptime?" });
    await reply(conv.id, 0);
    const rows = await server.ctx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conv.id));
    const answer = rows.filter((m) => m.role === "assistant" && m.trace).at(-1);
    expect(answer?.trace?.personality).toEqual({ id: ops.id, revision: edited.revision });
  });

  it("archives a deleted personality, and its chats keep it", async () => {
    const ops = await byName("Ops");
    const sling = await byName("Sling");
    const old = await api<{ id: string }>("POST", "/api/conversations", { personalityId: ops.id });
    const refused = await raw("DELETE", `/api/personalities/${sling.id}`);
    expect(refused.status).toBe(409);
    expect(refused.text).toContain("Make another one the default first");

    await api("DELETE", `/api/personalities/${ops.id}`);
    expect((await api<P[]>("GET", "/api/personalities")).map((p) => p.name)).toEqual([
      "Sling",
      "Finance",
    ]);
    const fresh = await raw("POST", "/api/conversations", { personalityId: ops.id });
    expect(fresh.status).toBe(400);

    const calls = model.doStreamCalls.length;
    await api("POST", `/api/conversations/${old.id}/messages`, { text: "Still there?" });
    await reply(old.id, 0);
    const system = model.doStreamCalls[calls]?.prompt.find((m) => m.role === "system");
    expect(JSON.stringify(system)).toContain("You are Ops. Be very terse.");
  });

  it("moves the default, and new chats without a choice get it", async () => {
    const finance = await byName("Finance");
    await api("POST", `/api/personalities/${finance.id}/default`);
    const list = await api<P[]>("GET", "/api/personalities");
    expect(list.filter((p) => p.isDefault).map((p) => p.name)).toEqual(["Finance"]);
    const conv = await api<{ personalityId: string }>("POST", "/api/conversations");
    expect(conv.personalityId).toBe(finance.id);

    const order = await api<P[]>("PUT", "/api/personalities/order", {
      ids: [finance.id, (await byName("Sling")).id],
    });
    expect(order.map((p) => p.name)).toEqual(["Finance", "Sling"]);
    const bad = await raw("PUT", "/api/personalities/order", { ids: [finance.id] });
    expect(bad.status).toBe(400);
    await api("POST", `/api/personalities/${(await byName("Sling")).id}/default`);
  });
});
