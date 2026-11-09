/**
 * The chat list end to end on real Postgres: pages without gaps or repeats,
 * filters applied before paging, search, archive and restore, and a message
 * sent again after its response was lost.
 */
import { createServer } from "node:net";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ConversationPage, ConversationView } from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type RunningServer, startServer } from "../src/server.ts";

vi.setConfig({ testTimeout: 60_000 });

const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hi." },
      { type: "text-end", id: "t" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      },
    ]),
  }),
});

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
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
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.body as T;
}

/** Every chat a filter lists, a few per page, following each cursor. */
async function everyPage(query: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const page: ConversationPage = await api(
      "GET",
      `/api/conversations?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(page.items.length).toBeLessThanOrEqual(limit);
    ids.push(...page.items.map((c) => c.id));
    cursor = page.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error("too many pages");
}

/** A chat with one user message, written straight to the database without a turn. */
async function chat(text: string): Promise<string> {
  const created = await api<ConversationView>("POST", "/api/conversations");
  const [conv] = await server.ctx.db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, created.id));
  if (!conv) throw new Error("no conversation");
  await server.ctx.agent.addMessage(conv, "user", { role: "user", content: text });
  return conv.id;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = await startServer(
    {
      databaseUrl: pg.getConnectionUri(),
      publicUrl: new URL(origin),
      secretKey: "e2e-secret-key-that-is-long-enough-1234",
      host: "127.0.0.1",
      port,
      logLevel: "warn",
      webDist: undefined,
      releaseRepo: "acme/sling",
    },
    { model, jobs: false },
  );
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

describe("the chat list", () => {
  it("pages through every chat newest first, with no gaps or repeats", async () => {
    const empty = await api<ConversationView>("POST", "/api/conversations");
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push(await chat(`page ${i}`));
    // Two chats with the same activity time still page apart by their IDs.
    const [a, b] = made.slice(2, 4);
    const at = new Date("2026-01-01T00:00:00.000Z");
    await server.ctx.db
      .update(schema.conversations)
      .set({ lastMessageAt: at })
      .where(eq(schema.conversations.id, a as string));
    await server.ctx.db
      .update(schema.conversations)
      .set({ lastMessageAt: at })
      .where(eq(schema.conversations.id, b as string));

    const listed = await everyPage("", 3);
    expect(listed).not.toContain(empty.id);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...made].sort());
    const newest = made.filter((id) => id !== a && id !== b).reverse();
    expect(listed).toEqual([...newest, b, a]);
  });

  it("keeps a renamed chat in place, and moves one with a new message to the top", async () => {
    const older = await chat("first");
    const newer = await chat("second");
    await api("PATCH", `/api/conversations/${older}`, { title: "Renamed" });
    let page = await api<ConversationPage>("GET", "/api/conversations?limit=2");
    expect(page.items.map((c) => c.id)).toEqual([newer, older]);

    await api("POST", `/api/conversations/${older}/messages`, { text: "back again" });
    page = await api<ConversationPage>("GET", "/api/conversations?limit=2");
    expect(page.items[0]?.id).toBe(older);
  });

  it("filters before paging, so an old chat with a task still shows, and counts it", async () => {
    const old = await chat("an old chat with a task");
    for (let i = 0; i < 4; i++) await chat(`newer ${i}`);
    const [conv] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, old));
    if (!conv) throw new Error("no conversation");
    await server.ctx.db.insert(schema.tasks).values({
      id: newId("tsk"),
      workspaceId: conv.workspaceId,
      ownerId: conv.ownerId,
      conversationId: old,
      repoName: "demo",
      title: "Queued work",
      objective: "Do it",
      mode: "auto",
      branch: "sling/demo",
      state: "queued",
    });

    const first = await api<ConversationPage>("GET", "/api/conversations?limit=2");
    expect(first.items.map((c) => c.id)).not.toContain(old);
    expect(first.counts?.working).toBe(1);
    expect(await everyPage("&filter=working", 2)).toEqual([old]);
    expect(await everyPage("&filter=tasks", 2)).toEqual([old]);
    expect(await everyPage("&filter=waiting", 2)).toEqual([]);
    const later = await api<ConversationPage>(
      "GET",
      `/api/conversations?limit=2&cursor=${first.nextCursor}`,
    );
    expect(later.counts).toBeNull();
  });

  it("searches titles and message text, with % and _ taken literally", async () => {
    const zebra = await chat("Look for the ZEBRA file");
    await chat("nothing here");
    const titled = await chat("plain");
    await api("PATCH", `/api/conversations/${titled}`, { title: "Quarterly 100% report" });

    expect(await everyPage("&q=zebra", 5)).toEqual([zebra]);
    expect(await everyPage(`&q=${encodeURIComponent("100%")}`, 5)).toEqual([titled]);
    expect(await everyPage(`&q=${encodeURIComponent("_")}`, 5)).toEqual([]);
  });

  it("archives a chat, keeps it readable, and brings it back with Restore or a message", async () => {
    const id = await chat("keep me");
    const archived = await api<ConversationView>("POST", `/api/conversations/${id}/archive`);
    expect(archived.archived).toBe(true);
    expect(await everyPage("", 100)).not.toContain(id);
    expect(await everyPage("&filter=archived", 100)).toContain(id);
    const detail = await api<{ conversation: ConversationView; messages: unknown[] }>(
      "GET",
      `/api/conversations/${id}`,
    );
    expect(detail.conversation.archived).toBe(true);
    expect(detail.messages).toHaveLength(1);

    const restored = await api<ConversationView>("POST", `/api/conversations/${id}/restore`);
    expect(restored.archived).toBe(false);
    expect(await everyPage("", 100)).toContain(id);
    expect(await everyPage("&filter=archived", 100)).not.toContain(id);

    await api("POST", `/api/conversations/${id}/archive`);
    await api("POST", `/api/conversations/${id}/messages`, { text: "I'm back" });
    expect(await everyPage("", 100)).toContain(id);

    const other = await raw("POST", "/api/conversations/cnv_missing/archive");
    expect(other.status).toBe(404);
  });

  it("saves a message sent again with the same client ID once, and queues one turn", async () => {
    const id = await chat("hello");
    const clientId = "c_0123456789abcdef";
    const first = await api<{ id: string }>("POST", `/api/conversations/${id}/messages`, {
      text: "do the thing",
      clientId,
    });
    const again = await api<{ id: string }>("POST", `/api/conversations/${id}/messages`, {
      text: "do the thing",
      clientId,
    });
    expect(again.id).toBe(first.id);
    // The same words on purpose, as a new message, still go out.
    const second = await api<{ id: string }>("POST", `/api/conversations/${id}/messages`, {
      text: "do the thing",
      clientId: "c_fedcba9876543210",
    });
    expect(second.id).not.toBe(first.id);

    const sent = await server.ctx.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, id), eq(schema.messages.role, "user")));
    // "hello", then one copy of the resent message, then the deliberate second one.
    expect(sent).toHaveLength(3);
    expect(sent.map((m) => m.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    const queued = await server.ctx.db
      .select({ id: schema.deliveries.id })
      .from(schema.deliveries)
      .where(eq(schema.deliveries.id, first.id));
    expect(queued).toHaveLength(1);
  });
});
