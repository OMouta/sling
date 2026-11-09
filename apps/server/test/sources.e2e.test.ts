/**
 * Sources and files in chat end to end: real Postgres, the control plane
 * in-process, and a scripted mock model. Files are uploaded, read, and
 * searched; a mock model gets a message's files as parts and calls
 * search_sources and read_source; and a real sling-runner with fake-claude
 * gets a document in its prompt and an image on stdin.
 *
 * Needs Docker, and the Runner and fake-claude built first:
 * cargo build -p sling-runner -p sling-harness-claude-code --bins
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, createServer as httpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  INLINE_DOCUMENT_CHARS,
  type MessageView,
  newId,
  PERSONALITY_MAX_SOURCES,
  type PersonalityView,
  type RunnerView,
  type SourceView,
  type StorageUsageView,
  type ToolStep,
} from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { addressRefusal } from "../src/sources/fetch-link.ts";
import type { Sources } from "../src/sources/service.ts";
import { makeDocx, makePdf, PNG_PIXEL } from "./fixtures/documents.ts";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(ROOT, "target/debug/sling-runner");
const FAKE_CLAUDE = join(ROOT, "target/debug/fake-claude");

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
const plan: { name: string; input: Record<string, unknown> | (() => Record<string, unknown>) }[] =
  [];
/** Every call's prompt and tools, latest last. */
const calls: { prompt: LanguageModelV4Prompt; tools: string[] }[] = [];

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    calls.push({
      prompt: options.prompt,
      tools: (options.tools ?? []).map((t) => ("name" in t ? t.name : "")),
    });
    const next = plan.shift();
    if (!next) return text("Done.");
    const input = typeof next.input === "function" ? next.input() : next.input;
    return respond(
      [
        {
          type: "tool-call",
          toolCallId: `call_${newId("c")}`,
          toolName: next.name,
          input: JSON.stringify(input),
        },
      ],
      "tool-calls",
    );
  },
});

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let site: Server;
let sitePort = 0;
let dir: string;
let cookie = "";
let origin = "";
let runner: ChildProcess | null = null;
let tutor: PersonalityView;
let writer: PersonalityView;

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function call(method: string, path: string, body?: unknown, raw = false) {
  return fetch(server.url + path, {
    method,
    redirect: "manual",
    headers: {
      origin,
      cookie,
      ...(body === undefined
        ? {}
        : { "content-type": raw ? "application/octet-stream" : "application/json" }),
    },
    body:
      body === undefined ? undefined : raw ? Buffer.from(body as Uint8Array) : JSON.stringify(body),
  });
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(method, path, body);
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const t = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

async function upload(path: string, name: string, bytes: Uint8Array) {
  const res = await call("POST", `${path}?name=${encodeURIComponent(name)}`, bytes, true);
  return { status: res.status, body: (await res.json()) as SourceView & { error?: string } };
}

/** An upload that says it's one byte over the limit, and sends only its start. */
function oversized(path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((ok, fail) => {
    const req = httpRequest(server.url + path, {
      method: "POST",
      headers: {
        origin,
        cookie,
        "content-type": "application/octet-stream",
        "content-length": String(25 * 1024 * 1024 + 1),
      },
    });
    req.on("response", (res) => {
      let text = "";
      res.on("data", (d) => {
        text += d;
      });
      res.on("end", () => {
        req.destroy();
        ok({ status: res.statusCode ?? 0, body: JSON.parse(text) });
      });
    });
    req.on("error", (err) => {
      if ((err as { code?: string }).code !== "EPIPE") fail(err);
    });
    req.write(Buffer.alloc(1024, 97));
  });
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

const sourcesOf = (p: PersonalityView) =>
  api<SourceView[]>("GET", `/api/personalities/${p.id}/sources`);

async function settled(p: PersonalityView, id: string) {
  return until(`source ${id}`, async () =>
    (await sourcesOf(p)).find((s) => s.id === id && s.state !== "processing"),
  );
}

const messages = async (id: string) =>
  (await api<{ messages: MessageView[] }>("GET", `/api/conversations/${id}`)).messages;

async function chat(personality: PersonalityView) {
  return (
    await api<{ id: string }>("POST", "/api/conversations", { personalityId: personality.id })
  ).id;
}

/** Sends a message with the calls the assistant makes for it, and returns the reply. */
async function ask(
  id: string,
  said: string,
  opts: { calls?: typeof plan; attachmentIds?: string[]; answer?: string } = {},
) {
  plan.push(...(opts.calls ?? []));
  const before = (await messages(id)).length;
  await api("POST", `/api/conversations/${id}/messages`, {
    text: said,
    ...(opts.attachmentIds ? { attachmentIds: opts.attachmentIds } : {}),
  });
  return until("the reply", async () =>
    (await messages(id))
      .slice(before)
      .find((m) => m.role === "assistant" && (!opts.answer || m.text.includes(opts.answer))),
  );
}

const toolSteps = (m: MessageView) =>
  (m.trace?.steps ?? []).filter((s): s is ToolStep => s.kind === "tool");
const out = <T = Record<string, unknown>>(step: ToolStep | undefined) =>
  JSON.parse(step?.output ?? "null") as T;

/** The latest model call's last user message, as parts. */
function lastUser() {
  const prompt = calls.at(-1)?.prompt ?? [];
  const m = prompt.findLast((p) => p.role === "user");
  return m?.role === "user" ? m.content : [];
}

const LEASE = makePdf([
  ["Lease agreement", "Tenant: Ana Silva", "Rent is due on the first of each month."],
  ["Pets", "Cats and small dogs are allowed with a deposit of 300 euros."],
  ["Signatures", "Signed in Lisbon."],
]);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sling-sources-"));
  site = httpServer((req, res) => {
    if (req.url === "/course") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Statistics 101</title></head><body><nav>Menu</nav><article><h1>Statistics 101</h1><p>${"A z-test needs the population variance, and a t-test estimates it from the sample. ".repeat(6)}</p></article></body></html>`,
      );
    } else if (req.url === "/syllabus.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from(makePdf([["Syllabus"], ["Week two covers confidence intervals."]])));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
  sitePort = (site.address() as AddressInfo).port;

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
  // Links to course.test reach the local site; everything else is checked as usual.
  (server.ctx.sources as Sources).linkOptions = {
    resolve: async (host) => {
      if (host === "course.test") return [{ address: "127.0.0.1", family: 4 }];
      if (host === "intranet.test") return [{ address: "10.0.0.8", family: 4 }];
      throw new Error("no such host");
    },
    refusal: (a) => (a === "127.0.0.1" ? null : addressRefusal(a)),
  };
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  tutor = await api<PersonalityView>("POST", "/api/personalities/templates/tutor");
  writer = await api<PersonalityView>("POST", "/api/personalities/templates/writer");
}, 120_000);

afterAll(async () => {
  runner?.kill("SIGTERM");
  await server?.close();
  await pg?.stop();
  await new Promise<void>((ok) => (site ? site.close(() => ok()) : ok()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a personality's sources", () => {
  let lease: SourceView;

  it("turns a PDF, a Word file, Markdown, and links into sources with their pages", async () => {
    const pdf = await upload(`/api/personalities/${tutor.id}/sources`, "lease.pdf", LEASE);
    expect(pdf.status).toBe(200);
    expect(pdf.body).toMatchObject({ state: "processing", kind: "file", name: "lease.pdf" });
    const docx = await upload(
      `/api/personalities/${tutor.id}/sources`,
      "notes.docx",
      makeDocx(["Lecture notes", "Hypothesis tests compare a sample with a claim."]),
    );
    const md = await upload(
      `/api/personalities/${tutor.id}/sources`,
      "glossary.md",
      new TextEncoder().encode("# Glossary\n\n**p-value**: how surprising the data is."),
    );
    const course = await api<SourceView>("POST", `/api/personalities/${tutor.id}/sources/link`, {
      url: `http://course.test:${sitePort}/course`,
    });
    const syllabus = await api<SourceView>("POST", `/api/personalities/${tutor.id}/sources/link`, {
      url: `http://course.test:${sitePort}/syllabus.pdf`,
      name: "Syllabus",
    });

    lease = await settled(tutor, pdf.body.id);
    expect(lease).toMatchObject({ state: "ready", pages: 3, mediaType: "application/pdf" });
    expect(await settled(tutor, docx.body.id)).toMatchObject({
      state: "ready",
      pages: null,
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(await settled(tutor, md.body.id)).toMatchObject({ state: "ready" });
    // A link nobody named takes its page's title; a PDF link is read as a PDF.
    expect(await settled(tutor, course.id)).toMatchObject({
      state: "ready",
      name: "Statistics 101",
      kind: "link",
    });
    expect(await settled(tutor, syllabus.id)).toMatchObject({
      state: "ready",
      name: "Syllabus",
      pages: 2,
      mediaType: "application/pdf",
    });
    const verbs = await server.ctx.db
      .select({ verb: schema.auditEvents.verb })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, lease.id));
    expect(verbs.map((v) => v.verb)).toEqual(["source.added"]);
  });

  it("fails a scanned PDF and a link into the local network, with reasons", async () => {
    const scan = await upload(
      `/api/personalities/${tutor.id}/sources`,
      "scan.pdf",
      makePdf([[], []]),
    );
    expect(await settled(tutor, scan.body.id)).toMatchObject({
      state: "failed",
      error: "No text found. It may be a scanned PDF.",
    });
    const inside = await api<SourceView>("POST", `/api/personalities/${tutor.id}/sources/link`, {
      url: "http://intranet.test/wiki",
    });
    expect((await settled(tutor, inside.id)).error).toMatch(/private address/);
  });

  it("answers from its sources with search_sources and read_source, citing the page", async () => {
    const id = await chat(tutor);
    const reply = await ask(id, "What does the lease say about pets?", {
      calls: [
        { name: "search_sources", input: { query: "pets deposit" } },
        { name: "read_source", input: () => ({ sourceId: lease.id, page: 2 }) },
      ],
    });
    const [search, read] = toolSteps(reply);
    const hits = out<{ results: { sourceId: string; page: number; link: string }[] }>(search);
    expect(hits.results[0]).toMatchObject({ sourceId: lease.id, page: 2 });
    expect(hits.results[0]?.link).toBe(`${origin}/api/sources/${lease.id}/view?page=2`);
    expect(out<{ text: string; truncated: boolean }>(read)).toMatchObject({
      text: expect.stringContaining("300 euros"),
      truncated: false,
      fromPage: 2,
      toPage: 2,
    });
    // The prompt lists the sources, and the tools came with them.
    const system = calls.at(-1)?.prompt.find((p) => p.role === "system");
    expect(system?.content).toContain("- lease.pdf (PDF, 3 pages)");
    expect(system?.content).toContain("- Statistics 101 (link)");
    expect(calls.at(-1)?.tools).toEqual(expect.arrayContaining(["search_sources", "read_source"]));

    // The citation opens the PDF at its page.
    const view = await call("GET", `/api/sources/${lease.id}/view?page=2`);
    expect(view.status).toBe(302);
    expect(view.headers.get("location")).toBe(`/api/sources/${lease.id}/file#page=2`);
    const file = await call("GET", `/api/sources/${lease.id}/file`);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(LEASE);
    // A link source's citation goes to its page.
    const course = (await sourcesOf(tutor)).find((s) => s.name === "Statistics 101");
    const link = await call("GET", `/api/sources/${course?.id}/view`);
    expect(link.headers.get("location")).toBe(`http://course.test:${sitePort}/course`);
  });

  it("can't be found by another personality, and is gone from search once removed", async () => {
    // Without sources, Writer isn't offered the tools at all.
    const other = await chat(writer);
    await ask(other, "Pets?");
    expect(calls.at(-1)?.tools).not.toContain("search_sources");
    const ws = (await workspaceOf()) ?? "";
    const writerScope = { workspaceId: ws, personalityId: writer.id, conversationId: other };
    expect(await server.ctx.sources.search(writerScope, "pets")).toEqual([]);
    expect(await server.ctx.sources.read(writerScope, lease.id, {})).toBeNull();

    const tutorScope = { workspaceId: ws, personalityId: tutor.id, conversationId: null };
    expect((await server.ctx.sources.search(tutorScope, "pets"))[0]?.sourceId).toBe(lease.id);
    expect((await call("DELETE", `/api/sources/${lease.id}`)).status).toBe(204);
    expect(await server.ctx.sources.search(tutorScope, "pets")).toEqual([]);
    expect((await call("GET", `/api/sources/${lease.id}/file`)).status).toBe(404);
  });
});

async function workspaceOf(): Promise<string | undefined> {
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
  return m?.workspaceId;
}

describe("limits and ownership", () => {
  it("refuses what isn't a document, too many sources, and files too large", async () => {
    const zip = await upload(
      `/api/personalities/${writer.id}/sources`,
      "a.bin",
      Uint8Array.from([1, 0, 2, 0]),
    );
    expect(zip.status).toBe(415);
    expect(zip.body.error).toMatch(/Sling reads PDFs/);
    const photo = await upload(`/api/personalities/${writer.id}/sources`, "a.png", PNG_PIXEL);
    expect(photo.status).toBe(415);
    // The server answers from the declared size, before the body arrives.
    const big = await oversized(`/api/personalities/${writer.id}/sources?name=big.txt`);
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: "Files are at most 25 MB." });

    const ws = (await workspaceOf()) ?? "";
    const [owner] = await server.ctx.db.select().from(schema.users).limit(1);
    await server.ctx.db.insert(schema.sources).values(
      Array.from({ length: PERSONALITY_MAX_SOURCES }, (_, i) => ({
        id: newId("src"),
        workspaceId: ws,
        ownerId: owner?.id ?? "",
        personalityId: writer.id,
        kind: "file" as const,
        name: `f${i}.md`,
        mediaType: "text/markdown",
        state: "ready" as const,
      })),
    );
    const full = await upload(
      `/api/personalities/${writer.id}/sources`,
      "one-more.md",
      new TextEncoder().encode("hi"),
    );
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/at most 50 sources/);
  });

  it("keeps another workspace's sources and someone else's uploads out of reach", async () => {
    const otherWs = newId("wsp");
    const otherUser = newId("usr");
    await server.ctx.db.insert(schema.workspaces).values({ id: otherWs, name: "Other" });
    await server.ctx.db
      .insert(schema.users)
      .values({ id: otherUser, name: "Bo", email: "bo@example.com" });
    const ws = (await workspaceOf()) ?? "";
    const theirs = newId("src");
    const theirUpload = newId("src");
    await server.ctx.db.insert(schema.sources).values([
      {
        id: theirs,
        workspaceId: otherWs,
        ownerId: otherUser,
        kind: "file",
        name: "theirs.md",
        mediaType: "text/markdown",
      },
      {
        id: theirUpload,
        workspaceId: ws,
        ownerId: otherUser,
        kind: "file",
        name: "bo.md",
        mediaType: "text/markdown",
      },
    ]);
    for (const id of [theirs, theirUpload]) {
      expect((await call("GET", `/api/sources/${id}/view`)).status).toBe(404);
      expect((await call("DELETE", `/api/sources/${id}`)).status).toBe(404);
    }
    const res = await call("POST", `/api/conversations/${await chat(writer)}/messages`, {
      text: "here",
      attachmentIds: [theirUpload],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/isn't there anymore/);
  });

  it("takes at most four images in a message, and 3 MB of them together", async () => {
    const id = await chat(writer);
    const pixels = [];
    for (let i = 0; i < 5; i++) {
      pixels.push((await upload("/api/attachments", `p${i}.png`, PNG_PIXEL)).body.id);
    }
    const five = await call("POST", `/api/conversations/${id}/messages`, {
      text: "look",
      attachmentIds: pixels,
    });
    expect(five.status).toBe(400);
    expect(((await five.json()) as { error: string }).error).toMatch(/at most 4 images/);
    const chunky = new Uint8Array(1.6 * 1024 * 1024);
    chunky.set(PNG_PIXEL);
    const a = (await upload("/api/attachments", "a.png", chunky)).body.id;
    const b = (await upload("/api/attachments", "b.png", chunky)).body.id;
    const heavy = await call("POST", `/api/conversations/${id}/messages`, {
      text: "look",
      attachmentIds: [a, b],
    });
    expect(((await heavy.json()) as { error: string }).error).toMatch(/3 MB together/);
    const tooBig = new Uint8Array(3.5 * 1024 * 1024);
    tooBig.set(PNG_PIXEL);
    expect((await upload("/api/attachments", "huge.png", tooBig)).status).toBe(413);
  });
});

describe("files in a chat", () => {
  it("sends images as image parts and short documents whole, and long ones by name", async () => {
    const id = await chat(writer);
    const photo = await upload("/api/attachments", "sign.png", PNG_PIXEL);
    expect(photo.body).toMatchObject({ kind: "image", state: "ready", messageId: null });
    const note = await upload(
      "/api/attachments",
      "lease.md",
      new TextEncoder().encode("No pets in the garden."),
    );
    const long = await upload(
      "/api/attachments",
      "book.txt",
      new TextEncoder().encode("Chapter. ".repeat(INLINE_DOCUMENT_CHARS / 8)),
    );
    // Files go on their own, with no text.
    await ask(id, "", { attachmentIds: [photo.body.id, note.body.id, long.body.id] });
    const parts = lastUser();
    expect(parts).toContainEqual(expect.objectContaining({ type: "file", mediaType: "image/png" }));
    const words = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    expect(words).toContain('<document name="lease.md">\nNo pets in the garden.\n</document>');
    expect(words).toMatch(
      /\[Attached: book\.txt\. It's too long to include here: use search_sources/,
    );
    expect(calls.at(-1)?.tools).toEqual(expect.arrayContaining(["search_sources", "read_source"]));

    const [sent] = (await messages(id)).filter((m) => m.role === "user");
    expect(sent?.text).toBe("");
    expect(sent?.attachments.map((a) => a.name)).toEqual(["sign.png", "lease.md", "book.txt"]);
    expect(sent?.attachments.every((a) => a.conversationId === id)).toBe(true);
    // The chat is named after its first file.
    const detail = await api<{ conversation: { title: string } }>(
      "GET",
      `/api/conversations/${id}`,
    );
    expect(detail.conversation.title).toBe("sign.png");

    // The next turn sends the earlier image again, and searches the long document.
    const reply = await ask(id, "What's in chapter one?", {
      calls: [{ name: "search_sources", input: { query: "chapter" } }],
    });
    expect(out<{ results: { name: string }[] }>(toolSteps(reply)[0]).results[0]?.name).toBe(
      "book.txt",
    );
    const earlier = calls.at(-1)?.prompt.filter((p) => p.role === "user") ?? [];
    expect(
      earlier.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "file")),
    ).toBe(true);
    // Another chat can't search this one's files.
    const ws = (await workspaceOf()) ?? "";
    expect(
      await server.ctx.sources.search(
        { workspaceId: ws, personalityId: writer.id, conversationId: await chat(writer) },
        "chapter",
      ),
    ).toEqual([]);
  });

  it("waits for a file still being read before the turn starts", async () => {
    const id = await chat(writer);
    const docx = await upload(
      "/api/attachments",
      "plan.docx",
      makeDocx(["The trip starts in Porto."]),
    );
    expect(docx.body.state).toBe("processing");
    await ask(id, "Where does it start?", { attachmentIds: [docx.body.id] });
    const words = lastUser()
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n");
    expect(words).toContain("The trip starts in Porto.");
  });
});

describe("a turn on Claude Code", () => {
  beforeAll(async () => {
    if (!existsSync(RUNNER) || !existsSync(FAKE_CLAUDE)) {
      throw new Error(`build the Runner and fake-claude first: ${RUNNER}`);
    }
    const env = {
      ...process.env,
      SLING_RUNNER_HOME: join(dir, "runner"),
      SLING_RUNNER_LOG: "warn",
    };
    const cli = (...args: string[]) => promisify(execFile)(RUNNER, args, { env });
    const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
    await cli("config", "set", "claude-bin", FAKE_CLAUDE);
    await cli("config", "set", "codex-bin", join(dir, "no-codex-here"));
    await cli("config", "set", "remote-repos", "off");
    await cli("pair", server.url, code, "--name", "laptop");
    runner = spawn(RUNNER, ["run"], { env, stdio: "ignore" });
    await until("the machine with Claude Code", async () => {
      const list = await api<RunnerView[]>("GET", "/api/runners");
      return list.find(
        (r) => r.online && r.capabilities.some((c) => c.name === "coding.claude-code" && c.ready),
      );
    });
  }, 120_000);

  it("gets a document in its prompt, and an image on stdin", async () => {
    const id = await chat(writer);
    await api("PATCH", `/api/conversations/${id}`, {
      settings: { assistant: { provider: "claude-code", model: "", effort: null, fast: false } },
    });
    const doc = await upload(
      "/api/attachments",
      "recipe.md",
      new TextEncoder().encode("Bake at 180 degrees for 25 minutes."),
    );
    const reply = await ask(id, "How long does it bake?", {
      attachmentIds: [doc.body.id],
      answer: "fake-claude",
    });
    expect(reply.text).toContain('<document name="recipe.md">');
    expect(reply.text).toContain("Bake at 180 degrees for 25 minutes.");
    expect(reply.text).toContain("How long does it bake?");
    const photo = await upload("/api/attachments", "dish.png", PNG_PIXEL);
    const seen = await ask(id, "And this?", {
      attachmentIds: [photo.body.id],
      answer: "fake-claude",
    });
    // With an image, stdin is one stream-json user message with an image block.
    expect(seen.text).toContain('"type":"image"');
    expect(seen.text).toContain('"media_type":"image/png"');
    expect(seen.text).toContain("[image: dish.png]");
  });
});

describe("storage", () => {
  it("lets uploads at once fill the space but never pass it, and frees space when a file goes", async () => {
    const usage = async () =>
      (await (await call("GET", "/api/storage")).json()) as StorageUsageView;
    const before = await usage();
    const file = new Uint8Array(2048);
    file.set(PNG_PIXEL);
    const limit = server.ctx.config.sourceStorageBytes;
    server.ctx.config.sourceStorageBytes = before.used + 3 * file.byteLength;
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => upload("/api/attachments", `c${i}.png`, file)),
      );
      const stored = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 413);
      expect(stored).toHaveLength(3);
      expect(refused).toHaveLength(5);
      expect(refused[0]?.body.error).toMatch(
        /^Storage is full: files use .+ of .+\. Remove sources from a personality to make room\.$/,
      );
      const full = await usage();
      expect(full.used).toBe(before.used + 3 * file.byteLength);
      expect(full.limit).toBe(full.used);

      // Removing a file frees its space for the next one.
      expect((await call("DELETE", `/api/sources/${stored[0]?.body.id}`)).status).toBe(204);
      expect((await usage()).used).toBe(before.used + 2 * file.byteLength);
      expect((await upload("/api/attachments", "again.png", file)).status).toBe(200);
    } finally {
      server.ctx.config.sourceStorageBytes = limit;
    }
  });
});
