/**
 * What can be done with a reply: retry it, edit the message before it, rate
 * it, and the follow-ups it ends with; and the instructions its downvotes
 * suggest for its personality.
 */
import { createServer } from "node:net";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type {
  FeedbackSummaryView,
  InstructionsSuggestionView,
  MessageView,
  ServerEvent,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let cookie = "";
let origin = "";
let runner: FakeRunner | null = null;
const events: ServerEvent[] = [];

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textOf(m: LanguageModelV4CallOptions["prompt"][number] | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
}

/** What the model was asked each turn: the latest user message. */
const asked: string[] = [];
/** What each suggestion request sent. */
const suggestions: { system: string; prompt: string }[] = [];
/** A turn asked something "slow" waits for this before it answers. */
let gate: Promise<void> = Promise.resolve();
/** Each turn's prompt, as role and text, without the instructions. */
const prompts: string[][] = [];

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const user = textOf(options.prompt.findLast((m) => m.role === "user"));
    asked.push(user);
    prompts.push(
      options.prompt.filter((m) => m.role !== "system").map((m) => `${m.role}: ${textOf(m)}`),
    );
    if (user.includes("slow")) await gate;
    const answer = user.includes("recipe")
      ? "Pasta with tomatoes.\n\n<follow-ups>\nMake it vegan\nHow long does it keep?\n</follow-ups>"
      : `Reply ${asked.length} to: ${user}`;
    // In small pieces, so the tag arrives cut in half.
    const deltas = answer.match(/.{1,7}/gs) ?? [];
    return {
      stream: convertArrayToReadableStream([
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t" },
        ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
        { type: "text-end" as const, id: "t" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ]),
    };
  },
  doGenerate: async (options: LanguageModelV4CallOptions) => {
    suggestions.push({
      system: textOf(options.prompt.find((m) => m.role === "system")),
      prompt: textOf(options.prompt.findLast((m) => m.role === "user")),
    });
    return {
      content: [
        {
          type: "text" as const,
          text: "<summary>Answers in two sentences at most.</summary>\n<instructions>\nYou are Chef. Answer in two sentences at most.\n</instructions>",
        },
      ],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage,
      warnings: [],
    };
  },
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
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type Detail = {
  messages: MessageView[];
  agentStatus: string;
  personality: { id: string; revision: number };
};
const detail = (id: string) => api<Detail>("GET", `/api/conversations/${id}`);

/** Waits for the chat to settle with this many replies, and returns its messages. */
async function settled(id: string, replies: number) {
  return until(`${replies} replies`, async () => {
    const d = await detail(id);
    const n = d.messages.filter((m) => m.role === "assistant").length;
    return d.agentStatus === "idle" && n === replies ? d.messages : null;
  });
}

async function chat(text: string) {
  const conv = await api<{ id: string }>("POST", "/api/conversations");
  await api("POST", `/api/conversations/${conv.id}/messages`, { text });
  return { id: conv.id, messages: await settled(conv.id, 1) };
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
  server.ctx.hub.listen((_ws, ev) => events.push(ev));
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
}, 120_000);

afterAll(async () => {
  runner?.close();
  await server?.close();
  await pg?.stop();
});

describe("retry", () => {
  it("replaces the latest reply, its feedback too, and runs the turn again", async () => {
    const { id, messages } = await chat("Hello");
    const [user, first] = messages;
    expect(user).toMatchObject({ role: "user", replaceable: true });
    expect(first).toMatchObject({ role: "assistant", replaceable: true });
    await api("PUT", `/api/messages/${first?.id}/feedback`, { rating: "down", reason: "dull" });

    await api("POST", `/api/conversations/${id}/retry`, { messageId: first?.id });
    const after = await until("a new reply", async () => {
      const m = await settled(id, 1);
      return m[1]?.id !== first?.id ? m : null;
    });
    expect(after.map((m) => m.text)).toEqual([
      "Hello",
      expect.stringMatching(/^Reply \d+ to: Hello$/),
    ]);
    expect(after[1]?.text).not.toBe(first?.text);
    expect(events).toContainEqual({
      type: "message.removed",
      conversationId: id,
      messageIds: [first?.id],
    });
    const left = await server.ctx.db
      .select()
      .from(schema.messageFeedback)
      .where(eq(schema.messageFeedback.messageId, first?.id ?? ""));
    expect(left).toEqual([]);
  });

  it("refuses a reply that's no longer the latest", async () => {
    const { id, messages } = await chat("One");
    await api("POST", `/api/conversations/${id}/messages`, { text: "Two" });
    await settled(id, 2);
    const res = await raw("POST", `/api/conversations/${id}/retry`, { messageId: messages[1]?.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no longer the latest");
    const latest = (await detail(id)).messages;
    expect(latest.map((m) => [m.role, m.replaceable])).toEqual([
      ["user", false],
      ["assistant", false],
      ["user", true],
      ["assistant", true],
    ]);
  });
});

describe("a message sent while a reply is being written", () => {
  it("gets its own reply once that reply is saved, and only one", async () => {
    let release = () => {};
    gate = new Promise((r) => {
      release = r;
    });
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Run the slow command" });
    await until(
      "the turn to start",
      async () => (await detail(conv.id)).agentStatus === "thinking",
    );
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "What is 2+2?" });
    const before = asked.length;
    release();
    const messages = await settled(conv.id, 2);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Run the slow command"],
      ["user", "What is 2+2?"],
      ["assistant", expect.stringMatching(/to: Run the slow command$/)],
      ["assistant", expect.stringMatching(/to: What is 2\+2\?$/)],
    ]);
    // The second turn reads the first reply before the message it answers.
    expect(prompts.at(-1)).toEqual([
      "user: Run the slow command",
      expect.stringMatching(/^assistant: .*to: Run the slow command$/),
      "user: What is 2+2?",
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(asked.length - before).toBe(1);
    expect((await detail(conv.id)).messages).toHaveLength(4);
  }, 30_000);
});

describe("edit", () => {
  it("changes the latest message in place and answers it again", async () => {
    const { id, messages } = await chat("Waht time is it?");
    const [user] = messages;
    await api("POST", `/api/conversations/${id}/messages/${user?.id}/edit`, {
      text: "What time is it?",
    });
    const after = await until("the edited reply", async () => {
      const m = await settled(id, 1);
      return m[1]?.id !== messages[1]?.id ? m : null;
    });
    expect(after[0]).toMatchObject({ id: user?.id, text: "What time is it?" });
    expect(after[1]?.text).toMatch(/to: What time is it\?$/);
    expect(asked.at(-1)).toBe("What time is it?");
    expect(events).toContainEqual({
      type: "message.updated",
      message: expect.objectContaining({ id: user?.id, text: "What time is it?" }),
    });
  });

  it("refuses an older message", async () => {
    const { id, messages } = await chat("First");
    await api("POST", `/api/conversations/${id}/messages`, { text: "Second" });
    await settled(id, 2);
    const res = await raw("POST", `/api/conversations/${id}/messages/${messages[0]?.id}/edit`, {
      text: "Changed",
    });
    expect(res.status).toBe(409);
  });
});

describe("after a reply that did something outside the chat", () => {
  it("offers neither, and the server refuses both", async () => {
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    const [c] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conv.id));
    if (!c) throw new Error("no conversation");
    const base = { workspaceId: c.workspaceId, ownerId: c.ownerId, conversationId: c.id };
    const userId = newId("msg");
    await server.ctx.db.insert(schema.messages).values([
      { ...base, id: userId, role: "user", content: { role: "user", content: "Fix the footer" } },
      {
        ...base,
        id: newId("msg"),
        role: "assistant",
        content: { role: "assistant", content: "Started a task." },
        trace: {
          ms: 5,
          steps: [
            {
              kind: "tool",
              id: "t1",
              name: "delegate_coding_task",
              input: { repo: "site" },
              status: "done",
              output: JSON.stringify({ taskId: "tsk_1", state: "queued" }),
            },
          ],
        },
      },
    ]);
    const { messages } = await detail(conv.id);
    expect(messages.map((m) => m.replaceable)).toEqual([false, false]);
    expect((await raw("POST", `/api/conversations/${conv.id}/retry`, {})).status).toBe(409);
    const edit = await raw("POST", `/api/conversations/${conv.id}/messages/${userId}/edit`, {
      text: "Fix the header",
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toContain("outside the chat");
  });
});

describe("follow-ups", () => {
  it("come off the reply, live and stored, and onto its trace", async () => {
    const from = events.length;
    const { messages } = await chat("A recipe for tonight?");
    const reply = messages[1];
    expect(reply?.text).toBe("Pasta with tomatoes.");
    expect(reply?.trace?.followUps).toEqual(["Make it vegan", "How long does it keep?"]);
    const live = events
      .slice(from)
      .flatMap((e) => (e.type === "agent.delta" ? [e.text] : []))
      .join("");
    expect(live).toBe("Pasta with tomatoes.\n\n");
    const [row] = await server.ctx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, reply?.id ?? ""));
    expect(JSON.stringify(row?.content)).not.toContain("follow-ups");
  });
});

describe("feedback", () => {
  it("sticks, changes, and clears, for the chat's owner only", async () => {
    const { id, messages } = await chat("Rate me");
    const replyId = messages[1]?.id ?? "";
    await api("PUT", `/api/messages/${replyId}/feedback`, { rating: "up" });
    expect((await detail(id)).messages[1]?.feedback).toBe("up");
    await api("PUT", `/api/messages/${replyId}/feedback`, { rating: "down", reason: "too long" });
    expect((await detail(id)).messages[1]?.feedback).toBe("down");
    await api("DELETE", `/api/messages/${replyId}/feedback`);
    expect((await detail(id)).messages[1]?.feedback).toBeNull();
    // A user message can't be rated.
    expect(
      (await raw("PUT", `/api/messages/${messages[0]?.id}/feedback`, { rating: "up" })).status,
    ).toBe(404);

    const [other] = await server.ctx.db
      .insert(schema.users)
      .values({ id: newId("usr"), name: "Other", email: "other@example.com" })
      .returning();
    await server.ctx.db
      .update(schema.conversations)
      .set({ ownerId: other?.id ?? "" })
      .where(eq(schema.conversations.id, id));
    const res = await raw("PUT", `/api/messages/${replyId}/feedback`, { rating: "up" });
    expect(res.status).toBe(403);
  });

  it("counts for the personality's revision, and lists downvotes with their chats", async () => {
    const { id, messages } = await chat("Too much text please");
    const replyId = messages[1]?.id ?? "";
    // A reply with no steps shows no trace, but its chat says who wrote it.
    const { personality } = await detail(id);
    await api("PUT", `/api/messages/${replyId}/feedback`, { rating: "down", reason: "too long" });
    const summary = await api<FeedbackSummaryView>(
      "GET",
      `/api/personalities/${personality?.id}/feedback`,
    );
    expect(summary).toMatchObject({ revision: personality?.revision, down: 1 });
    expect(summary.recent[0]).toMatchObject({
      messageId: replyId,
      conversationId: id,
      conversationTitle: "Too much text please",
      reason: "too long",
      excerpt: expect.stringContaining("to: Too much text please"),
    });

    const list = await api<{ id: string; instructions: string }[]>("GET", "/api/personalities");
    const p = list.find((x) => x.id === personality?.id);
    await api("PATCH", `/api/personalities/${personality?.id}`, {
      instructions: `${p?.instructions}\nBe brief.`,
    });
    const next = await api<FeedbackSummaryView>(
      "GET",
      `/api/personalities/${personality?.id}/feedback`,
    );
    expect(next).toMatchObject({ revision: (personality?.revision ?? 0) + 1, up: 0, down: 0 });
    // Older downvotes stay listed, with the revision they were for.
    expect(next.recent[0]).toMatchObject({ messageId: replyId, revision: personality?.revision });
  });
});

describe("suggest changes", () => {
  it("refuses with no downvotes on the current revision", async () => {
    const list = await api<{ id: string; isDefault: boolean }[]>("GET", "/api/personalities");
    const sling = list.find((p) => p.isDefault);
    const res = await raw("POST", `/api/personalities/${sling?.id}/suggest`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no downvotes");
  });

  it("sends the instructions and the downvotes to the model, with no tools", async () => {
    const { id: convId, messages } = await chat("How do I boil an egg?");
    const reply = messages[1];
    await api("PUT", `/api/messages/${reply?.id}/feedback`, { rating: "down", reason: "rambles" });
    const id = (await detail(convId)).personality.id;
    const suggestion = await api<InstructionsSuggestionView>(
      "POST",
      `/api/personalities/${id}/suggest`,
    );
    expect(suggestion).toEqual({
      instructions: "You are Chef. Answer in two sentences at most.",
      summary: "Answers in two sentences at most.",
      basedOn: 1,
    });
    const sent = suggestions.at(-1);
    expect(sent?.system).toContain("thumbs down");
    expect(sent?.prompt).toContain("<message>How do I boil an egg?</message>");
    expect(sent?.prompt).toContain(`<reply>${reply?.text}</reply>`);
    expect(sent?.prompt).toContain("<reason>rambles</reason>");
    expect(model.doGenerateCalls.at(-1)?.tools ?? []).toEqual([]);
  });
});

describe("on a coding agent's CLI", () => {
  it("starts a new session when a reply is retried", async () => {
    const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
    runner = new FakeRunner({
      url: server.url,
      name: "devbox",
      repos: [],
      harnesses: ["codex"],
      models: { codex: [{ id: "gpt-6-luna", efforts: ["low"], isDefault: true }] },
    });
    await runner.pair(code);
    await runner.connect();
    const conv = await api<{ id: string }>("POST", "/api/conversations");
    await api("PATCH", `/api/conversations/${conv.id}`, {
      settings: {
        assistant: { provider: "codex", model: "gpt-6-luna", effort: "low", fast: false },
      },
    });
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Hi" });
    await settled(conv.id, 1);
    await api("POST", `/api/conversations/${conv.id}/messages`, { text: "Again" });
    const before = await settled(conv.id, 2);
    expect(runner.chatTurns.at(-1)?.sessionId).not.toBe("");

    await api("POST", `/api/conversations/${conv.id}/retry`, { messageId: before[3]?.id });
    await until("the retried turn", async () => (runner?.chatTurns.length ?? 0) === 3);
    const turn = runner.chatTurns.at(-1);
    expect(turn).toMatchObject({ sessionId: "", prompt: "Again" });
    // The fresh session gets the history without the replaced reply.
    expect(turn?.history).toContain("Assistant: Fake reply to: Hi");
    expect(turn?.history).not.toContain("Fake reply to: Again");
    const after = await settled(conv.id, 2);
    expect(after.map((m) => m.text)).toEqual([
      "Hi",
      "Fake reply to: Hi",
      "Again",
      "Fake reply to: Again",
    ]);
    expect(after[3]?.id).not.toBe(before[3]?.id);
  });

  it("asks for a suggestion as a one-off turn with no tools", async () => {
    const list = await api<{ id: string; isDefault: boolean }[]>("GET", "/api/personalities");
    const id = list.find((p) => p.isDefault)?.id ?? "";
    await server.ctx.db
      .update(schema.personalities)
      .set({ assistant: { provider: "codex", model: "gpt-6-luna", effort: "low", fast: false } })
      .where(eq(schema.personalities.id, id));
    const before = runner?.chatTurns.length ?? 0;
    // The fake CLI answers with an echo, not new instructions, so this says so.
    const res = await raw("POST", `/api/personalities/${id}/suggest`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("didn't send back new instructions");
    expect(runner?.chatTurns.length).toBe(before + 1);
    const turn = runner?.chatTurns.at(-1);
    expect(turn).toMatchObject({
      harness: "codex",
      model: "gpt-6-luna",
      sessionId: "",
      history: "",
    });
    expect(turn?.instructions).toContain("thumbs down");
    expect(turn?.prompt).toMatch(/^The current instructions:/);
    expect(turn?.prompt).toContain("<reason>rambles</reason>");
    const tools = await fetch(turn?.toolsUrl ?? "", {
      headers: { authorization: `Bearer ${turn?.toolsToken}` },
    }).then((r) => r.json());
    expect(tools).toEqual({ tools: [] });
    await server.ctx.db
      .update(schema.personalities)
      .set({ assistant: null })
      .where(eq(schema.personalities.id, id));
  });
});
