/**
 * The chat, task, and approval lists end to end on real Postgres: pages
 * without gaps or repeats, filters applied before paging, counts over
 * everything that matches, search, archive and restore, and a message sent
 * again after its response was lost.
 */
import { createServer } from "node:net";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ApprovalPage, ConversationPage, ConversationView, TaskPage } from "@sling/core";
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

/** The signed-in user's workspace and ID, for rows written straight to the database. */
async function me() {
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers);
  if (!m) throw new Error("no workspace");
  return { workspaceId: m.workspaceId, ownerId: m.userId };
}

/** Every item a list gives, following its cursors. */
async function everything<T extends { id: string }>(path: string, limit: number): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const sep = path.includes("?") ? "&" : "?";
    const page: { items: T[]; nextCursor: string | null } = await api(
      "GET",
      `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) return items;
  }
  throw new Error("too many pages");
}

describe("the task list", () => {
  it("pages newest first, filters before the limit, and totals every match", async () => {
    const owner = await me();
    // Its own chat keeps other tests' tasks out of the counts.
    const conversationId = await chat("tasks for the list");
    const q = `/api/tasks?conversationId=${conversationId}`;
    const made: string[] = [];
    const task = async (over: Partial<typeof schema.tasks.$inferInsert>) => {
      const id = newId("tsk");
      made.push(id);
      await server.ctx.db.insert(schema.tasks).values({
        id,
        ...owner,
        conversationId,
        repoName: "site",
        title: `Task ${made.length}`,
        objective: "Do it",
        mode: "auto",
        branch: `sling/t${made.length}`,
        state: "succeeded",
        ...over,
      });
      await new Promise((ok) => setTimeout(ok, 2));
      return id;
    };
    const oldFailure = await task({ state: "failed", harness: "claude-code" });
    for (let i = 0; i < 5; i++) {
      await task({ diffStats: { filesChanged: 1, insertions: 10, deletions: 2 } });
    }
    const running = await task({ state: "running", environment: "sandbox" });

    const all = await everything<{ id: string }>(q, 2);
    expect(all.map((t) => t.id)).toEqual([...made].reverse());

    const first = await api<TaskPage>("GET", `${q}&limit=2`);
    expect(first.counts).toEqual({ active: 1, attention: 1 });
    expect(first.stats).toEqual({
      total: 7,
      insertions: 50,
      deletions: 10,
      succeeded: 5,
      failed: 1,
    });
    expect((await everything<{ id: string }>(`${q}&view=attention`, 2)).map((t) => t.id)).toEqual([
      oldFailure,
    ]);
    expect((await everything<{ id: string }>(`${q}&view=active`, 2)).map((t) => t.id)).toEqual([
      running,
    ]);
    expect(
      (await everything<{ id: string }>(`${q}&harness=claude-code`, 2)).map((t) => t.id),
    ).toEqual([oldFailure]);
    expect(
      (await everything<{ id: string }>(`${q}&environment=sandbox`, 2)).map((t) => t.id),
    ).toEqual([running]);
    const done = await api<TaskPage>("GET", `${q}&view=done&limit=1`);
    expect(done.stats?.total).toBe(5);
    expect(done.counts).toEqual({ active: 1, attention: 1 });
  });
});

describe("the approval list", () => {
  it("lists soonest to expire first, keeps every one reachable, and counts decisions", async () => {
    const owner = await me();
    const taskIds = [newId("tsk"), newId("tsk")];
    for (const [i, id] of taskIds.entries()) {
      await server.ctx.db.insert(schema.tasks).values({
        id,
        ...owner,
        repoName: "site",
        title: `Needs a push ${i}`,
        objective: "Do it",
        mode: "auto",
        branch: `sling/a${i}`,
        state: "succeeded",
      });
    }
    const base = Date.now() + 3_600_000;
    const approval = async (
      minutes: number,
      over: Partial<typeof schema.approvals.$inferInsert>,
    ) => {
      const id = newId("apr");
      await server.ctx.db.insert(schema.approvals).values({
        id,
        ...owner,
        expiresAt: new Date(base + minutes * 60_000),
        ...over,
      });
      return id;
    };
    // The one that expires first was made last, so newest first would bury it.
    const ids = [
      await approval(30, { kind: "task_action", taskId: taskIds[0] }),
      await approval(31, { kind: "task_action", taskId: taskIds[0] }),
      await approval(20, { kind: "task_action", taskId: taskIds[1] }),
      await approval(40, { kind: "workflow", title: "Ship it?" }),
      await approval(10, { kind: "workflow", title: "Send it?" }),
      await approval(50, { kind: "sandbox_fallback", taskId: taskIds[1] }),
      await approval(5, { kind: "workflow", title: "Same time as the next" }),
      await approval(5, { kind: "workflow", title: "Same time as the last" }),
    ];
    await approval(1, { kind: "workflow", title: "Decided", state: "approved" });

    const listed = await everything<{ id: string; expiresAt: string }>("/api/approvals", 3);
    expect(listed).toHaveLength(ids.length);
    expect(new Set(listed.map((a) => a.id)).size).toBe(ids.length);
    const times = listed.map((a) => a.expiresAt);
    expect(times).toEqual([...times].sort());

    const newest = await everything<{ id: string }>("/api/approvals?order=newest", 3);
    expect(newest.map((a) => a.id)).toEqual([...ids].reverse());

    const first = await api<ApprovalPage>("GET", "/api/approvals?limit=2");
    expect(first.counts).toEqual({ tasks: 2, workflows: 4, sandboxes: 1 });
    expect(await everything("/api/approvals?kind=tasks", 2)).toHaveLength(3);
    expect(await everything("/api/approvals?kind=workflows", 2)).toHaveLength(4);
    expect(await everything("/api/approvals?kind=sandboxes", 2)).toHaveLength(1);
    expect(
      (await everything<{ id: string }>(`/api/approvals?taskId=${taskIds[1]}`, 5)).map((a) => a.id),
    ).toEqual([ids[2], ids[5]]);
    const decided = await api<ApprovalPage>("GET", "/api/approvals?state=approved");
    expect(decided.items).toHaveLength(1);
    expect(decided.counts).toBeNull();
  });
});

describe("chat and task history", () => {
  it("pages a long chat back without gaps, puts each task on one page, and refreshes from a message", async () => {
    const owner = await me();
    const created = await api<ConversationView>("POST", "/api/conversations");
    const id = created.id;
    const start = Date.parse("2026-03-01T10:00:00.000Z");
    const ids: string[] = [];
    const taskIds: string[] = [];
    for (let i = 0; i < 150; i++) {
      const at = start + i * 60_000;
      const msgId = newId("msg", at);
      ids.push(msgId);
      // One message far bigger than the rest makes its page stop early.
      const text = i === 120 ? "x".repeat(600 * 1024) : `message ${i}`;
      await server.ctx.db.insert(schema.messages).values({
        id: msgId,
        ...owner,
        conversationId: id,
        role: i % 2 ? "assistant" : "user",
        content: { role: i % 2 ? "assistant" : "user", content: text },
        createdAt: new Date(at),
      });
      if (i % 10 === 3) {
        const taskId = newId("tsk", at + 1_000);
        taskIds.push(taskId);
        await server.ctx.db.insert(schema.tasks).values({
          id: taskId,
          ...owner,
          conversationId: id,
          repoName: "site",
          title: `Task after message ${i}`,
          objective: "Do it",
          mode: "auto",
          branch: `sling/h${i}`,
          state: "succeeded",
          createdAt: new Date(at + 1_000),
        });
      }
    }

    type Page = {
      messages: { id: string }[];
      tasks: { id: string }[];
      olderCursor: string | null;
    };
    const latest = await api<Page>("GET", `/api/conversations/${id}`);
    // The first page stops before the big message, which then has a page to itself.
    expect(latest.messages.map((m) => m.id)).toEqual(ids.slice(121));
    expect(latest.olderCursor).toBe(ids[121]);
    const seen = [...latest.messages.map((m) => m.id)];
    const tasksSeen = [...latest.tasks.map((t) => t.id)];
    let cursor = latest.olderCursor;
    let pages = 1;
    while (cursor) {
      const page = await api<Page>("GET", `/api/conversations/${id}/messages?before=${cursor}`);
      expect(page.messages.length).toBeLessThanOrEqual(60);
      if (cursor === ids[121]) expect(page.messages.map((m) => m.id)).toEqual([ids[120]]);
      seen.unshift(...page.messages.map((m) => m.id));
      tasksSeen.push(...page.tasks.map((t) => t.id));
      cursor = page.olderCursor;
      pages++;
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(ids);
    expect([...tasksSeen].sort()).toEqual([...taskIds].sort());

    // A refresh from a message scrolled back to returns everything since.
    const refreshed = await api<Page>("GET", `/api/conversations/${id}?from=${ids[30]}`);
    expect(refreshed.messages.map((m) => m.id)).toEqual(ids.slice(30));
    expect(refreshed.olderCursor).toBe(ids[30]);
    expect(refreshed.tasks.map((t) => t.id).sort()).toEqual(taskIds.slice(3).sort());
  });

  it("pages a task's events back from the newest, and refreshes from an event", async () => {
    const owner = await me();
    const taskId = newId("tsk");
    await server.ctx.db.insert(schema.tasks).values({
      id: taskId,
      ...owner,
      repoName: "site",
      title: "Chatty task",
      objective: "Do it",
      mode: "auto",
      branch: "sling/events",
      state: "running",
    });
    const total = 1_200;
    const rows = Array.from({ length: total }, (_, seq) => ({
      taskId,
      workspaceId: owner.workspaceId,
      seq,
      type: "agent_message",
      payload: { text: `step ${seq}` },
      at: new Date(Date.parse("2026-03-01T10:00:00.000Z") + seq * 1_000),
    }));
    for (let i = 0; i < rows.length; i += 400) {
      await server.ctx.db.insert(schema.taskEvents).values(rows.slice(i, i + 400));
    }
    type Page = { events: { seq: number }[]; olderCursor: number | null };
    const latest = await api<Page>("GET", `/api/tasks/${taskId}`);
    expect(latest.events).toHaveLength(500);
    expect(latest.events.at(-1)?.seq).toBe(total - 1);
    const seen = latest.events.map((e) => e.seq);
    let cursor = latest.olderCursor;
    while (cursor !== null) {
      const page = await api<Page>("GET", `/api/tasks/${taskId}/events?before=${cursor}`);
      seen.unshift(...page.events.map((e) => e.seq));
      cursor = page.olderCursor;
    }
    expect(seen).toEqual(rows.map((r) => r.seq));

    const refreshed = await api<Page>("GET", `/api/tasks/${taskId}?from=100`);
    expect(refreshed.events).toHaveLength(total - 100);
    expect(refreshed.olderCursor).toBe(100);
  });
});
