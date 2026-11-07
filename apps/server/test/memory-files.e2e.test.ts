/**
 * Memory and shared folders end to end: real Postgres, the control plane
 * in-process, and a real sling-runner sharing a temporary folder. A scripted
 * mock model plays the assistant and calls remember, recall, forget,
 * search_files, and read_file.
 *
 * Needs Docker, and the Runner built first: cargo build -p sling-runner
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { MemoryView, MessageView, PersonalityView, RunnerView, ToolStep } from "@sling/core";
import { MEMORY_PROMPT_BYTES, newId } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { BLOCK_HEADER } from "../src/memory/block.ts";
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

/** The tool calls the assistant makes, one per model step, before it answers. */
const plan: { name: string; input: Record<string, unknown> }[] = [];
/** The system prompt of the latest turn. */
let lastPrompt = "";

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const system = options.prompt.find((p) => p.role === "system");
    if (system && typeof system.content === "string") lastPrompt = system.content;
    const next = plan.shift();
    if (!next) return text("Done.");
    return respond(
      [
        {
          type: "tool-call",
          toolCallId: `call_${newId("c")}`,
          toolName: next.name,
          input: JSON.stringify(next.input),
        },
      ],
      "tool-calls",
    );
  },
});

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let dir: string;
let notes: string;
let cookie = "";
let origin = "";
let runner: ChildProcess | null = null;
let cli: (...args: string[]) => Promise<{ stdout: string }>;
let env: NodeJS.ProcessEnv;
let sling: PersonalityView;
let planner: PersonalityView;

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
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const messages = async (id: string) =>
  (await api<{ messages: MessageView[] }>("GET", `/api/conversations/${id}`)).messages;

async function chat(personality: PersonalityView) {
  const conv = await api<{ id: string }>("POST", "/api/conversations", {
    personalityId: personality.id,
  });
  return conv.id;
}

/** Sends a message with the calls the assistant makes for it, and returns the reply's tool steps. */
async function ask(
  id: string,
  said: string,
  calls: { name: string; input: Record<string, unknown> }[] = [],
): Promise<ToolStep[]> {
  plan.push(...calls);
  const before = (await messages(id)).length;
  await api("POST", `/api/conversations/${id}/messages`, { text: said });
  const reply = await until("the reply", async () =>
    (await messages(id)).slice(before).find((m) => m.role === "assistant" && m.text === "Done."),
  );
  return (reply.trace?.steps ?? []).filter((s): s is ToolStep => s.kind === "tool");
}

const out = <T = Record<string, unknown>>(step: ToolStep | undefined) =>
  JSON.parse(step?.output ?? "null") as T;

beforeAll(async () => {
  if (!existsSync(RUNNER)) throw new Error(`build the Runner first: ${RUNNER} is missing`);
  dir = mkdtempSync(join(tmpdir(), "sling-files-"));
  notes = join(dir, "Notes");
  mkdirSync(join(notes, "house"), { recursive: true });
  mkdirSync(join(dir, "Private"), { recursive: true });
  writeFileSync(
    join(notes, "house/boiler.md"),
    "# Boiler\n\nThe boiler was serviced in March by Vítor.\nPressure should sit at 1.5 bar.\n",
  );
  writeFileSync(join(notes, "todo.txt"), "call the bank\n");
  writeFileSync(join(dir, "Private/secret.md"), "boiler code 9911\n");
  symlinkSync(join(dir, "Private/secret.md"), join(notes, "link.md"));

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
  const list = await api<PersonalityView[]>("GET", "/api/personalities");
  const def = list.find((p) => p.isDefault);
  if (!def) throw new Error("no default personality");
  sling = def;
  planner = await api<PersonalityView>("POST", "/api/personalities/templates/planner");

  env = { ...process.env, SLING_RUNNER_HOME: join(dir, "runner"), SLING_RUNNER_LOG: "warn" };
  cli = (...args: string[]) => promisify(execFile)(RUNNER, args, { env });
  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  await cli("config", "set", "codex-bin", join(dir, "no-codex-here"));
  await cli("config", "set", "claude-bin", join(dir, "no-claude-here"));
  await cli("config", "set", "remote-repos", "off");
  await cli("pair", server.url, code, "--name", "laptop");
  await cli("folder", "add", notes);
  runner = spawn(RUNNER, ["run"], { env, stdio: "ignore" });
  await until("the machine with its folder", async () => {
    const machines = await api<RunnerView[]>("GET", "/api/runners");
    return machines.find((r) => r.online && r.folders.includes("Notes") && r.files);
  });
}, 120_000);

afterAll(async () => {
  runner?.kill("SIGTERM");
  await server?.close();
  await pg?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("memory", () => {
  it("remembers in one chat, and another personality's new chat knows it", async () => {
    const first = await chat(sling);
    const [step] = await ask(first, "I'm vegetarian", [
      { name: "remember", input: { text: "Vegetarian" } },
    ]);
    expect(step?.name).toBe("remember");
    expect(step?.memory).toMatchObject({ text: "Vegetarian", undone: false });
    const id = step?.memory?.id ?? "";

    const [listed] = await api<MemoryView[]>("GET", "/api/memories");
    expect(listed).toMatchObject({
      id,
      text: "Vegetarian",
      personalityId: null,
      source: { kind: "chat", conversationId: first },
    });
    expect(listed?.source.messageId).toMatch(/^msg_/);

    const second = await chat(planner);
    await ask(second, "What should I cook tonight?");
    expect(lastPrompt).toContain(`${BLOCK_HEADER}\n- Vegetarian`);

    // An edit reaches the next chat.
    await api("PATCH", `/api/memories/${id}`, { text: "Vegetarian, and no fish either" });
    await ask(await chat(planner), "Any ideas?");
    expect(lastPrompt).toContain("- Vegetarian, and no fish either");

    // Undo deletes it everywhere, and the chat's line says so.
    await api("DELETE", `/api/memories/${id}`);
    expect(await api<MemoryView[]>("GET", "/api/memories")).toEqual([]);
    const reply = (await messages(first)).find((m) => m.role === "assistant");
    const saved = reply?.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
    expect(saved?.memory).toMatchObject({ id, undone: true });
    await ask(await chat(planner), "And now?");
    expect(lastPrompt).not.toContain("Vegetarian");
    await expect(api("DELETE", `/api/memories/${id}`)).rejects.toThrow(/404/);

    const verbs = await server.ctx.db
      .select({ verb: schema.auditEvents.verb, actorType: schema.auditEvents.actorType })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, id));
    expect(verbs).toEqual(
      expect.arrayContaining([
        { verb: "memory.created", actorType: "agent" },
        { verb: "memory.updated", actorType: "user" },
        { verb: "memory.deleted", actorType: "user" },
      ]),
    );
  });

  it("refuses a password or a card number, whatever the model asks", async () => {
    const id = await chat(sling);
    const [password, card] = await ask(id, "Remember my bank login", [
      { name: "remember", input: { text: "Bank password is Hunter2!" } },
      { name: "remember", input: { text: "Visa 4111 1111 1111 1111" } },
    ]);
    expect(out(password).error).toMatch(/Not saved.*password/);
    expect(out(card).error).toMatch(/Not saved.*card number/);
    expect(password?.memory).toBeUndefined();
    await expect(api("POST", "/api/memories", { text: "PIN is 4821" })).rejects.toThrow(/422/);
    await expect(
      api("POST", "/api/memories", { text: "key sk-proj-abcdefghijklmnopqrstuvwx1234" }),
    ).rejects.toThrow(/422/);
    expect(await api<MemoryView[]>("GET", "/api/memories")).toEqual([]);
  });

  it("keeps a memory to one personality when asked, and forgets on request", async () => {
    const id = await chat(planner);
    const [pinned, again] = await ask(id, "I'm planning a trip to Porto", [
      { name: "remember", input: { text: "Planning a trip to Porto", onlyThisPersonality: true } },
      { name: "remember", input: { text: "planning a trip to porto" } },
    ]);
    const memoryId = pinned?.memory?.id ?? "";
    expect(out(again)).toMatchObject({ id: memoryId, alreadyRemembered: true });
    expect(again?.memory).toBeUndefined();
    const [view] = await api<MemoryView[]>("GET", "/api/memories");
    expect(view?.personalityId).toBe(planner.id);

    await ask(await chat(sling), "Hi");
    expect(lastPrompt).not.toContain("Porto");
    await ask(await chat(planner), "Hi");
    expect(lastPrompt).toContain("- Planning a trip to Porto");

    // Sling can't see it, so it can't forget it either.
    const [hidden] = await ask(await chat(sling), "Forget Porto", [
      { name: "forget", input: { id: memoryId } },
    ]);
    expect(out(hidden).error).toContain("No memory has that id");

    const forgetting = await chat(planner);
    const [found, forgot] = await ask(forgetting, "Forget about Porto", [
      { name: "recall", input: { query: "porto trip" } },
      { name: "forget", input: { id: memoryId } },
    ]);
    expect(out<{ memories: { id: string }[] }>(found).memories.map((m) => m.id)).toEqual([
      memoryId,
    ]);
    expect(out(forgot)).toEqual({ forgotten: true });
    expect(await api<MemoryView[]>("GET", "/api/memories")).toEqual([]);
    const [deleted] = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.subjectId, memoryId),
          eq(schema.auditEvents.verb, "memory.deleted"),
        ),
      );
    expect(deleted).toMatchObject({ actorType: "agent", details: { conversationId: forgetting } });
  });

  it("adds, searches, and edits memories on the page, checking the personality", async () => {
    const added = await api<MemoryView>("POST", "/api/memories", {
      text: "  Jo Silva is their accountant,\n jo@silva.pt ",
    });
    expect(added).toMatchObject({
      text: "Jo Silva is their accountant, jo@silva.pt",
      source: { kind: "manual", conversationId: null, conversationTitle: null },
    });
    await api("POST", "/api/memories", { text: "Allergic to peanuts" });
    const found = await api<MemoryView[]>("GET", "/api/memories?q=acc");
    expect(found.map((m) => m.id)).toEqual([added.id]);
    expect((await api<MemoryView[]>("GET", "/api/memories?q=jo%20silva")).length).toBe(1);
    expect(await api<MemoryView[]>("GET", "/api/memories?q=accountants")).toHaveLength(1);
    await expect(
      api("PATCH", `/api/memories/${added.id}`, { personalityId: "prs_nope" }),
    ).rejects.toThrow(/400/);
    const pinned = await api<MemoryView>("PATCH", `/api/memories/${added.id}`, {
      personalityId: planner.id,
    });
    expect(pinned.personalityId).toBe(planner.id);
    await expect(api("PATCH", "/api/memories/mem_nope", { text: "x" })).rejects.toThrow(/404/);
    await server.ctx.db.delete(schema.memories);
  });

  it("holds the most recently used that fit, and recall finds an older one", async () => {
    const owner = await server.ctx.db.select().from(schema.memories).limit(1);
    expect(owner).toEqual([]);
    const [user] = await server.ctx.db.select({ id: schema.users.id }).from(schema.users);
    const [ws] = await server.ctx.db.select({ id: schema.workspaces.id }).from(schema.workspaces);
    if (!user || !ws) throw new Error("no user");
    const base = Date.parse("2026-01-01T00:00:00Z");
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      id: newId("mem"),
      workspaceId: ws.id,
      ownerId: user.id,
      text: i === 7 ? "The boiler engineer is Vítor, 912 000 111" : `Likes thing number ${i}`,
      source: "manual" as const,
      // Higher numbers were used more recently.
      lastUsedAt: new Date(base + i * 60_000),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await server.ctx.db.insert(schema.memories).values(rows.slice(i, i + 500));
    }

    const id = await chat(planner);
    await ask(id, "Hello");
    const block = lastPrompt.slice(lastPrompt.indexOf(BLOCK_HEADER)).split("\n\n")[0] ?? "";
    expect(new TextEncoder().encode(block).length).toBeLessThanOrEqual(MEMORY_PROMPT_BYTES);
    expect(block).toContain("- Likes thing number 1999");
    expect(block).not.toContain("boiler");
    const lines = block.split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.length).toBeLessThan(2000);
    // The newest first, with none left out between them.
    expect(lines[0]).toBe("- Likes thing number 1999");
    expect(lines.at(-1)).toBe(`- Likes thing number ${2000 - lines.length}`);

    const [recall] = await ask(id, "Who services my boiler?", [
      { name: "recall", input: { query: "boiler engineer" } },
    ]);
    expect(out<{ memories: { text: string }[] }>(recall).memories[0]?.text).toContain("Vítor");

    // Both the prompt and recall marked what they used.
    const [boiler] = await server.ctx.db
      .select({ lastUsedAt: schema.memories.lastUsedAt })
      .from(schema.memories)
      .where(sql`${schema.memories.text} like 'The boiler%'`);
    expect(boiler?.lastUsedAt.getTime()).toBeGreaterThan(base + 2000 * 60_000);
  });

  it("recalls over 10,000 memories in under 30 ms at the 95th percentile", async () => {
    const [user] = await server.ctx.db.select({ id: schema.users.id }).from(schema.users);
    const [ws] = await server.ctx.db.select({ id: schema.workspaces.id }).from(schema.workspaces);
    if (!user || !ws) throw new Error("no user");
    // Everyday notes: a few hundred different words, each in a hundred or so memories.
    const w = (k: number) => `topic${k % 400}`;
    const extra = Array.from({ length: 8000 }, (_, i) => ({
      id: newId("mem"),
      workspaceId: ws.id,
      ownerId: user.id,
      text:
        i % 1000 === 0
          ? `The dentist is Dr Lopes, every six months (${i})`
          : i % 1500 === 0
            ? `Likes the coffee from the machine at work (${i})`
            : `Note ${i}: the ${w(i)} and ${w(i * 7 + 3)} near ${w(i * 13 + 5)}, every ${w(i * 31 + 11)}`,
      source: "manual" as const,
    }));
    for (let i = 0; i < extra.length; i += 1000) {
      await server.ctx.db.insert(schema.memories).values(extra.slice(i, i + 1000));
    }
    await server.ctx.db.execute(sql`analyze memories`);
    const [{ n } = { n: 0 }] = await server.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.memories);
    expect(n).toBe(10_000);
    const owner = { workspaceId: ws.id, userId: user.id };
    const queries = [
      "boiler engineer",
      "who is my dentist",
      "topic17",
      "topic3 topic250",
      "the coffee machine",
      "Vítor",
    ];
    for (const q of queries) await server.ctx.memory.recall(owner, planner.id, q);
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      const found = await server.ctx.memory.recall(
        owner,
        planner.id,
        queries[i % queries.length] ?? "",
      );
      times.push(performance.now() - t);
      expect(found.length).toBeGreaterThan(0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[94] ?? Number.POSITIVE_INFINITY;
    // A word in every memory still answers: it ranks only the most recently used matches.
    const broad = performance.now();
    expect(await server.ctx.memory.recall(owner, planner.id, "note")).toHaveLength(20);
    const broadMs = performance.now() - broad;
    console.log(
      `recall over 10,000 memories: p50 ${times[49]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms; a word in 8,000 of them ${broadMs.toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(30);
    await server.ctx.db.delete(schema.memories);
  });
});

describe("files on a machine", () => {
  it("searches and reads a shared folder, and quotes the note", async () => {
    const id = await chat(sling);
    const [search, read] = await ask(id, "What did I write about the boiler?", [
      { name: "search_files", input: { query: "Boiler" } },
      { name: "read_file", input: { machine: "laptop", folder: "Notes", path: "house/boiler.md" } },
    ]);
    const found = out<{ hits: { machine: string; folder: string; path: string; line: number }[] }>(
      search,
    );
    expect(found.hits).toEqual([
      expect.objectContaining({
        machine: "laptop",
        folder: "Notes",
        path: "house/boiler.md",
        line: 1,
      }),
      expect.objectContaining({ path: "house/boiler.md", line: 3 }),
    ]);
    // Never what the symlink points at.
    expect(JSON.stringify(found)).not.toContain("9911");
    expect(out(read)).toMatchObject({
      machine: "laptop",
      folder: "Notes",
      path: "house/boiler.md",
      truncated: false,
    });
    expect(out<{ content: string }>(read).content).toContain("serviced in March by Vítor");
    const [audited] = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.verb, "files.read"));
    expect(audited?.details).toMatchObject({ conversationId: id, path: "house/boiler.md" });
  });

  it("works in Read-only, without asking", async () => {
    const id = await chat(sling);
    await api("PATCH", `/api/conversations/${id}`, { mode: "read-only" });
    const [read] = await ask(id, "Read my todo", [
      { name: "read_file", input: { machine: "laptop", folder: "Notes", path: "todo.txt" } },
    ]);
    expect(read?.approval).toBeUndefined();
    expect(out<{ content: string }>(read).content).toBe("call the bank\n");
  });

  it("refuses paths outside the folder, symlinks out, and folders that aren't shared", async () => {
    const id = await chat(sling);
    const [up, link, abs, other] = await ask(id, "Read these", [
      {
        name: "read_file",
        input: { machine: "laptop", folder: "Notes", path: "../Private/secret.md" },
      },
      { name: "read_file", input: { machine: "laptop", folder: "Notes", path: "link.md" } },
      {
        name: "read_file",
        input: { machine: "laptop", folder: "Notes", path: join(dir, "Private/secret.md") },
      },
      { name: "read_file", input: { machine: "laptop", folder: "Private", path: "secret.md" } },
    ]);
    expect(out(up).error).toContain("outside the shared folder Notes");
    expect(out(link).error).toContain("outside the shared folder Notes");
    expect(out(abs).error).toContain("relative to the folder");
    expect(out(other).error).toContain("doesn't share a folder named Private");
    for (const s of [up, link, abs, other]) expect(s?.output).not.toContain("9911");

    // A folder removed on the machine is refused there at once, before Sling hears of it.
    await cli("folder", "remove", "Notes");
    const [gone] = await ask(id, "Read my todo again", [
      { name: "read_file", input: { machine: "laptop", folder: "Notes", path: "todo.txt" } },
    ]);
    expect(out(gone).error).toContain("shares no folders");
    await cli("folder", "add", notes);

    // So is everything after `files off`.
    await cli("config", "set", "files", "off");
    const [off] = await ask(id, "Search", [{ name: "search_files", input: { query: "boiler" } }]);
    expect(out<{ errors: { error: string }[] }>(off).errors[0]?.error).toContain("Files are off");
    await cli("config", "set", "files", "on");
  });

  it("says when the machine is offline", async () => {
    runner?.kill("SIGTERM");
    runner = null;
    await until("the machine to go offline", async () => {
      const machines = await api<RunnerView[]>("GET", "/api/runners");
      return machines.find((r) => !r.online);
    });
    const id = await chat(sling);
    const [search, read] = await ask(id, "What did I write about the boiler?", [
      { name: "search_files", input: { query: "boiler" } },
      { name: "read_file", input: { machine: "laptop", folder: "Notes", path: "house/boiler.md" } },
    ]);
    expect(out(search)).toMatchObject({
      hits: [],
      errors: [{ machine: "laptop", error: expect.stringContaining("laptop is offline") }],
    });
    expect(out(read).error).toContain("laptop is offline");
  });
});
