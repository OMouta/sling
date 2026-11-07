/**
 * A personality's own model, @mentions handing one turn to another
 * personality, and personalities saved to and added from a file, end to
 * end: real Postgres, the control plane in-process, a scripted mock model,
 * and a fake Runner for turns on a CLI.
 *
 * Needs Docker.
 */
import { request } from "node:http";
import { createServer } from "node:net";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  type MessageView,
  newId,
  type PersonalityExport,
  type PersonalityImportView,
  type PersonalityView,
  type ToolStep,
} from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { effectiveChat } from "../src/agent/chat-settings.ts";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import {
  type NewFile,
  type SourceActor,
  type SourceService,
  Sources,
  type SourceTarget,
} from "../src/sources/service.ts";
import type { SourceRow } from "../src/sources/views.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

vi.setConfig({ testTimeout: 60_000 });

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

/** The tool call the assistant makes for the next user message. */
const plan: { tool: string; input: Record<string, unknown> }[] = [];

interface Call {
  system: string;
  tools: string[];
  /** The other messages, as text. */
  history: string;
}
const calls: Call[] = [];

/** Answers as whoever its instructions say it is, so a test can tell who replied. */
const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const system = options.prompt
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    calls.push({
      system,
      tools: (options.tools ?? []).map((t) => t.name).sort(),
      history: JSON.stringify(options.prompt.filter((m) => m.role !== "system")),
    });
    if (options.prompt.at(-1)?.role === "tool") return text("Done.");
    const next = plan.shift();
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
    const who = /^You are ([\w ]+?)[.,]/m.exec(system)?.[1] ?? "someone";
    return text(`${who} here.`);
  },
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let runner: FakeRunner;
let cookie = "";
let origin = "";
let workspaceId = "";

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function raw(method: string, path: string, body?: unknown, type = "application/json") {
  const res = await fetch(server.url + path, {
    method,
    headers: { origin, cookie, ...(body === undefined ? {} : { "content-type": type }) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const t = await res.text();
  let json: unknown = null;
  try {
    json = t ? JSON.parse(t) : null;
  } catch {
    json = t;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  if (res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as T;
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

const messages = async (id: string) =>
  (await api<{ messages: MessageView[] }>("GET", `/api/conversations/${id}`)).messages;

/** Sends a message and waits for the reply to it. */
async function say(id: string, body: { text: string; personalityId?: string }) {
  const before = (await messages(id)).filter((m) => m.role === "assistant").length;
  await api("POST", `/api/conversations/${id}/messages`, body);
  return until("the reply", async () => {
    const replies = (await messages(id)).filter((m) => m.role === "assistant" && m.text);
    return replies.length > before ? replies.at(-1) : null;
  });
}

const personalities = () => api<PersonalityView[]>("GET", "/api/personalities");
const byName = async (name: string) =>
  (await personalities()).find((p) => p.name === name) as PersonalityView;

const HAIKU = { provider: "claude-code", model: "claude-haiku-5-5", effort: "low", fast: false };

async function addPersonality(fields: Partial<PersonalityView> & { name: string }) {
  return api<PersonalityView>("POST", "/api/personalities", {
    description: "",
    instructions: `You are ${fields.name}.`,
    tools: [],
    color: "teal",
    shape: "bloom",
    ...fields,
  });
}

async function chat(personalityId: string, settings?: object) {
  const conv = await api<{ id: string }>("POST", "/api/conversations", { personalityId });
  if (settings) await api("PATCH", `/api/conversations/${conv.id}`, { settings });
  return conv.id;
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
  const [ws] = await server.ctx.db.select().from(schema.workspaces);
  workspaceId = ws?.id ?? "";

  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  runner = new FakeRunner({
    url: server.url,
    name: "devbox",
    repos: [],
    harnesses: ["codex", "claude-code"],
    models: {
      codex: [{ id: "gpt-6-luna", efforts: ["low", "medium"], isDefault: true }],
      "claude-code": [
        { id: "claude-haiku-5-5", efforts: ["low", "high"], isDefault: true },
        { id: "claude-sonnet-5-5", efforts: ["low", "high"] },
      ],
    },
  });
  await runner.pair(code);
  await runner.connect();
  await until("the machine", async () =>
    (
      await api<{ assistant: { provider: string; connected: boolean }[] }>("GET", "/api/models")
    ).assistant.find((p) => p.provider === "claude-code" && p.connected),
  );
}, 120_000);

afterAll(async () => {
  runner?.close();
  await server?.close();
  await pg?.stop();
});

// ---------------------------------------------------------------- the model

describe("a personality's model", () => {
  it("is saved with it, and changing it isn't a new revision", async () => {
    const chef = await addPersonality({ name: "Chef", assistant: HAIKU as never });
    expect(chef.assistant).toEqual(HAIKU);
    const patched = await api<PersonalityView>("PATCH", `/api/personalities/${chef.id}`, {
      assistant: { ...HAIKU, model: "claude-sonnet-5-5" },
    });
    expect(patched.assistant?.model).toBe("claude-sonnet-5-5");
    expect(patched.revision).toBe(chef.revision);
    // Left out, it stays; null is the workspace default.
    const renamed = await api<PersonalityView>("PATCH", `/api/personalities/${chef.id}`, {
      description: "Recipes.",
    });
    expect(renamed.assistant?.model).toBe("claude-sonnet-5-5");
    const cleared = await api<PersonalityView>("PATCH", `/api/personalities/${chef.id}`, {
      assistant: null,
    });
    expect(cleared.assistant).toBeNull();
    const bad = await raw("PATCH", `/api/personalities/${chef.id}`, {
      assistant: { provider: "claude-code", model: 'x"; rm -rf /', effort: null, fast: false },
    });
    expect(bad.status).toBe(400);
  });

  it("comes after the chat's own choice and before the workspace default", async () => {
    const sling = await byName("Sling");
    const research = await addPersonality({ name: "Research", assistant: HAIKU as never });
    const plain = await chat(sling.id);
    const own = await chat(research.id);
    const picked = await chat(research.id, {
      assistant: { provider: "codex", model: "gpt-6-luna", effort: "low", fast: false },
    });
    const effective = async (id: string) =>
      (await effectiveChat(server.ctx, workspaceId, id)).assistant;
    expect(await effective(plain)).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
    expect(await effective(own)).toEqual(HAIKU);
    expect(await effective(picked)).toMatchObject({ provider: "codex" });

    // A chat a workflow starts has the default personality and no choice of its own.
    await api("PATCH", `/api/personalities/${sling.id}`, { assistant: HAIKU });
    const [started] = await server.ctx.db
      .insert(schema.conversations)
      .values({
        id: newId("cnv"),
        workspaceId,
        ownerId: (await server.ctx.db.select().from(schema.users))[0]?.id ?? "",
        mode: "auto",
        personalityId: null,
        externalKey: "discord:test",
        title: "From Discord",
      })
      .returning();
    expect(await effective(started?.id ?? "")).toEqual(HAIKU);
    await api("PATCH", `/api/personalities/${sling.id}`, { assistant: null });
  });

  it("runs a chat with no choice of its own on the personality's CLI", async () => {
    const research = await byName("Research");
    const id = await chat(research.id);
    const before = runner.chatTurns.length;
    expect((await say(id, { text: "What's new?" })).text).toBe("Fake reply to: What's new?");
    expect(runner.chatTurns[before]).toMatchObject({
      harness: "claude-code",
      model: "claude-haiku-5-5",
      effort: "low",
    });
  });
});

describe("save_personality", () => {
  it("sets a personality's model, by its label on the card", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, { mode: "full-access" });
    plan.push({
      tool: "save_personality",
      input: {
        personality: "chef",
        model: { provider: "claude-code", model: "claude-haiku-5-5", effort: "low" },
      },
    });
    const done = await say(conv.id, { text: "Put Chef on Haiku." });
    const step = done.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
    expect(step?.approval?.change?.rows).toEqual([
      {
        label: "Model",
        before: "Workspace default",
        // The fake machine names each model in capitals.
        after: "CLAUDE-HAIKU-5-5 on Claude Code, low effort",
      },
    ]);
    const chef = await byName("Chef");
    expect(chef.assistant).toEqual(HAIKU);

    plan.push({
      tool: "save_personality",
      input: { personality: "chef", model: { provider: "anthropic", model: "claude-opus-5-5" } },
    });
    const refused = await say(conv.id, { text: "Now Opus on a key." });
    const out = refused.trace?.steps.find((s): s is ToolStep => s.kind === "tool")?.output ?? "";
    expect(out).toContain("anthropic isn't set up");
    expect((await byName("Chef")).assistant).toEqual(HAIKU);
  });
});

// ---------------------------------------------------------------- mentions

describe("@mentions", () => {
  it("hands the turn to the mentioned personality, then back", async () => {
    const sling = await byName("Sling");
    const writer = await addPersonality({
      name: "Writer",
      instructions: "You are Writer. You draft emails.",
      tools: ["memory"],
    });
    const id = await chat(sling.id);
    await say(id, { text: "Plan my week." });

    const at = calls.length;
    const mention = await say(id, { text: "@Writer make it an email", personalityId: writer.id });
    expect(mention.text).toBe("Writer here.");
    const handed = calls[at];
    expect(handed?.system).toContain("You are Writer. You draft emails.");
    expect(handed?.system).not.toContain("You are Sling");
    expect(handed?.tools).toEqual(["forget", "recall", "remember"]);

    const back = await say(id, { text: "Thanks" });
    expect(back.text).toBe("Sling here.");
    const after = calls.at(-1);
    expect(after?.system).toContain("You are Sling");
    expect(after?.tools).toContain("delegate_coding_task");
    // The chat's own personality sees what Writer said.
    expect(after?.history).toContain("Writer here.");

    const list = await messages(id);
    const sent = list.find((m) => m.text === "@Writer make it an email");
    expect(sent?.personalityId).toBe(writer.id);
    const replies = list.filter((m) => m.role === "assistant" && m.text);
    expect(replies.map((m) => m.trace?.personality?.id)).toEqual([sling.id, writer.id, sling.id]);
  });

  it("runs on the mentioned personality's own model", async () => {
    const sling = await byName("Sling");
    const tutor = await addPersonality({ name: "Tutor", assistant: HAIKU as never });
    const id = await chat(sling.id);
    const before = runner.chatTurns.length;
    await say(id, { text: "@Tutor explain a t-test", personalityId: tutor.id });
    const turn = runner.chatTurns[before];
    expect(turn).toMatchObject({ harness: "claude-code", model: "claude-haiku-5-5" });
    expect(turn?.instructions).toContain("You are Tutor.");
    // The next message is the chat's own again, on its own model.
    const at = calls.length;
    expect((await say(id, { text: "Thanks" })).text).toBe("Sling here.");
    expect(calls.length).toBe(at + 1);
    expect(runner.chatTurns.length).toBe(before + 1);
  });

  it("refuses a personality from another workspace or one that's gone", async () => {
    const sling = await byName("Sling");
    const id = await chat(sling.id);
    const res = await raw("POST", `/api/conversations/${id}/messages`, {
      text: "@Ghost hi",
      personalityId: "prs_nope",
    });
    expect(res.status).toBe(400);
  });
});

describe("CLI sessions across personalities", () => {
  it("resumes only the session that answered as this turn's personality", async () => {
    const sling = await byName("Sling");
    const writer = await byName("Writer");
    const id = await chat(sling.id, {
      assistant: { provider: "claude-code", model: "", effort: null, fast: false },
    });
    const start = runner.chatTurns.length;
    const turn = (i: number) => runner.chatTurns[start + i];

    await say(id, { text: "One" });
    await say(id, { text: "Two" });
    expect(turn(0)?.sessionId).toBe("");
    expect(turn(1)?.sessionId).toBe(`fake-session-${start + 1}`);

    await say(id, { text: "@Writer three", personalityId: writer.id });
    expect(turn(2)?.sessionId).toBe("");
    expect(turn(2)?.instructions).toContain("You are Writer.");
    // A new session gets the history, with each reply under its personality's name.
    expect(turn(2)?.history).toContain("Sling: Fake reply to: One");
    expect(turn(2)?.history).not.toContain("Assistant:");

    await say(id, { text: "Four" });
    expect(turn(3)?.sessionId).toBe("");
    expect(turn(3)?.history).toContain("Writer: Fake reply to: @Writer three");
    expect(turn(3)?.history).toContain("Sling: Fake reply to: Two");

    await say(id, { text: "Five" });
    expect(turn(4)?.sessionId).toBe(`fake-session-${start + 4}`);
    const [conv] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id));
    expect(conv?.agentSession?.personalityId).toBe(sling.id);
  });

  it("keeps the plain history while one personality answers", async () => {
    const sling = await byName("Sling");
    const id = await chat(sling.id, {
      assistant: { provider: "claude-code", model: "", effort: null, fast: false },
    });
    await say(id, { text: "One" });
    // A session from before mentions, with no personality, is the chat's own.
    await server.ctx.db
      .update(schema.conversations)
      .set({ agentSession: { harness: "claude-code", runnerId: "run_gone", sessionId: "old" } })
      .where(eq(schema.conversations.id, id));
    const before = runner.chatTurns.length;
    await say(id, { text: "Two" });
    // That machine is gone, so it starts over with the history, unlabeled.
    expect(runner.chatTurns[before]?.history).toContain("Assistant: Fake reply to: One");
  });
});

// ---------------------------------------------------------------- files

/**
 * Stands in for source extraction: adds sources as ready and keeps their
 * files. Everything else is the server's own.
 */
class StandInSources implements SourceService {
  readonly added: { name: string; data?: Uint8Array; url?: string }[] = [];
  failing = false;
  readonly #base: SourceService = new Sources(server.ctx);

  start = (boss: Parameters<SourceService["start"]>[0]) => this.#base.start(boss);
  remove = (ws: string, id: string) => this.#base.remove(ws, id);
  forPersonality = (ws: string, id: string) => this.#base.forPersonality(ws, id);
  forMessages = (ws: string, ids: readonly string[]) => this.#base.forMessages(ws, ids);
  attach: SourceService["attach"] = (...args) => this.#base.attach(...args);
  search: SourceService["search"] = (...args) => this.#base.search(...args);
  read: SourceService["read"] = (...args) => this.#base.read(...args);
  file = (ws: string, id: string) => this.#base.file(ws, id);
  link = (id: string, page?: number | null) => this.#base.link(id, page);

  async #insert(actor: SourceActor, personalityId: string, values: Partial<SourceRow>) {
    const [row] = await server.ctx.db
      .insert(schema.sources)
      .values({
        id: newId("src"),
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        personalityId,
        kind: "file",
        name: "",
        mediaType: "application/octet-stream",
        state: "ready",
        ...values,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    return row;
  }

  async addFile(actor: SourceActor, target: SourceTarget, file: NewFile) {
    if (this.failing) throw new Error("Sources aren't available yet.");
    if (!("personalityId" in target)) throw new Error("not a personality");
    const row = await this.#insert(actor, target.personalityId, {
      name: file.name,
      mediaType: file.mediaType,
      size: file.data.length,
    });
    await server.ctx.db.insert(schema.sourceFiles).values({ sourceId: row.id, data: file.data });
    this.added.push({ name: file.name, data: file.data });
    return row;
  }

  async addLink(actor: SourceActor, personalityId: string, url: string, name?: string) {
    if (this.failing) throw new Error("Sources aren't available yet.");
    this.added.push({ name: name ?? url, url });
    return this.#insert(actor, personalityId, {
      kind: "link",
      name: name ?? url,
      mediaType: "text/html",
      url,
    });
  }
}

const PDF = new Uint8Array(Buffer.from("%PDF-1.4\nlecture two\n%%EOF"));

describe("export and import", () => {
  let sources: StandInSources;
  let file: PersonalityExport;

  it("exports a personality with its model and its sources' files", async () => {
    sources = new StandInSources();
    server.ctx.sources = sources;
    const tutor = await byName("Tutor");
    const actor = {
      workspaceId,
      userId: (await server.ctx.db.select().from(schema.users))[0]?.id ?? "",
    };
    await sources.addFile(
      actor,
      { personalityId: tutor.id },
      {
        name: "lecture-2.pdf",
        mediaType: "application/pdf",
        data: PDF,
      },
    );
    await sources.addLink(actor, tutor.id, "https://example.edu/stats", "Course page");

    const res = await raw("GET", `/api/personalities/${tutor.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Tutor.sling-personality.json"; filename*=UTF-8''Tutor.sling-personality.json`,
    );
    file = res.body as PersonalityExport;
    expect(file).toEqual({
      format: "sling.personality/v1",
      name: "Tutor",
      description: "",
      instructions: "You are Tutor.",
      tools: [],
      color: "teal",
      shape: "bloom",
      assistant: HAIKU,
      sources: [
        {
          kind: "file",
          name: "lecture-2.pdf",
          mediaType: "application/pdf",
          data: Buffer.from(PDF).toString("base64"),
        },
        { kind: "link", name: "Course page", url: "https://example.edu/stats" },
      ],
    });
    const [audited] = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.verb, "personality.exported"));
    expect(audited).toMatchObject({ subjectId: tutor.id, details: { name: "Tutor", sources: 2 } });
  });

  it("imports it back as a new personality, last, with its sources", async () => {
    sources.added.length = 0;
    const count = (await personalities()).length;
    const res = await raw(
      "POST",
      "/api/personalities/import",
      new Uint8Array(Buffer.from(JSON.stringify({ ...file, tools: ["memory", "teleport"] }))),
      "application/octet-stream",
    );
    expect(res.status).toBe(200);
    const imported = res.body as PersonalityImportView;
    expect(imported.sourcesFailed).toBe(0);
    expect(imported.personality).toMatchObject({
      name: "Tutor",
      instructions: "You are Tutor.",
      tools: ["memory"],
      assistant: HAIKU,
      isDefault: false,
      templateKey: null,
    });
    const list = await personalities();
    expect(list).toHaveLength(count + 1);
    expect(list.at(-1)?.id).toBe(imported.personality.id);
    expect(sources.added.map((s) => s.name)).toEqual(["lecture-2.pdf", "Course page"]);
    expect(Buffer.from(sources.added[0]?.data ?? []).equals(Buffer.from(PDF))).toBe(true);
    const rows = await server.ctx.db
      .select()
      .from(schema.sources)
      .where(eq(schema.sources.personalityId, imported.personality.id));
    expect(rows.map((r) => r.name).sort()).toEqual(["Course page", "lecture-2.pdf"]);

    // Exporting the copy gives the same file back.
    const again = await api<PersonalityExport>(
      "GET",
      `/api/personalities/${imported.personality.id}/export`,
    );
    expect({ ...again, tools: file.tools }).toEqual(file);
    const [audited] = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.verb, "personality.imported"),
          eq(schema.auditEvents.subjectId, imported.personality.id),
        ),
      );
    expect(audited?.details).toEqual({ name: "Tutor", tools: ["memory"], sources: 2 });
  });

  it("takes a JSON body too, and says how many sources couldn't be added", async () => {
    sources.failing = true;
    const res = await api<PersonalityImportView>("POST", "/api/personalities/import", {
      ...file,
      name: "Tutor two",
    });
    expect(res.sourcesFailed).toBe(2);
    expect(res.personality.name).toBe("Tutor two");
    sources.failing = false;
  });

  it("leaves out a model this workspace can't run", async () => {
    const res = await api<PersonalityImportView>("POST", "/api/personalities/import", {
      ...file,
      name: "Tutor three",
      sources: [],
      assistant: { provider: "anthropic", model: "claude-opus-5-5", effort: null, fast: false },
    });
    expect(res.personality.assistant).toBeNull();
  });

  it("refuses a file that isn't a personality, with a reason", async () => {
    const count = (await personalities()).length;
    const bytes = (s: string) => new Uint8Array(Buffer.from(s));
    const cases: [Uint8Array | object, string][] = [
      [bytes("PK\u0003\u0004 a zip"), "This file isn't a Sling personality."],
      [{ name: "Tutor" }, "This file isn't a Sling personality."],
      [{ ...file, color: "plaid" }, "This personality file has a problem: color: "],
    ];
    for (const [body, error] of cases) {
      const res = await raw(
        "POST",
        "/api/personalities/import",
        body,
        body instanceof Uint8Array ? "application/octet-stream" : "application/json",
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain(error);
    }
    // Refused from its length alone, before any of it is read.
    const tooBig = await new Promise<{ status: number; body: string }>((ok, fail) => {
      const req = request(
        `${server.url}/api/personalities/import`,
        {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/octet-stream",
            "content-length": String(100 * 1024 * 1024 + 1),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => {
            ok({ status: res.statusCode ?? 0, body });
            req.destroy();
          });
        },
      );
      req.on("error", fail);
      req.flushHeaders();
    });
    expect(tooBig.status).toBe(413);
    expect(JSON.parse(tooBig.body)).toEqual({ error: "This file is bigger than 100 MB." });
    expect(await personalities()).toHaveLength(count);
  });
});
