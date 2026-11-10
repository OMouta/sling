/**
 * Web search and Deep research on an API model, end to end: real Postgres
 * and the control plane in-process. A scripted mock model plays the
 * assistant and streams the parts a provider's own web search sends.
 *
 * Needs Docker.
 */
import { createServer } from "node:net";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4ProviderTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { AssistantChoice, MessageView, PersonalityView, ToolStep } from "@sling/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

vi.setConfig({ testTimeout: 60_000 });

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: t },
  { type: "text-end", id: "t" },
];

let calls = 0;
const recall = (): Step => ({
  reason: "tool-calls",
  parts: [
    {
      type: "tool-call",
      toolCallId: `call_${++calls}`,
      toolName: "recall",
      input: JSON.stringify({ query: "rust" }),
    },
  ],
});

interface Step {
  parts: LanguageModelV4StreamPart[];
  reason: "stop" | "tool-calls";
}

/** What the model does at each step, in order. Once it runs out, it answers "Done." */
const plan: Step[] = [];
/** Every call the model got. */
const seen: LanguageModelV4CallOptions[] = [];

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    seen.push(options);
    const step = plan.shift() ?? { parts: text("Done."), reason: "stop" as const };
    return {
      stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
        { type: "stream-start", warnings: [] },
        ...step.parts,
        { type: "finish", finishReason: { unified: step.reason, raw: undefined }, usage },
      ]),
    };
  },
});

const system = (o: LanguageModelV4CallOptions | undefined) => {
  const s = o?.prompt.find((p) => p.role === "system");
  return s && typeof s.content === "string" ? s.content : "";
};
const toolIds = (o: LanguageModelV4CallOptions | undefined) =>
  (o?.tools ?? []).map((t: LanguageModelV4FunctionTool | LanguageModelV4ProviderTool) =>
    t.type === "provider" ? t.id : t.name,
  );

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

async function chat(personality: PersonalityView, assistant: AssistantChoice) {
  const conv = await api<{ id: string }>("POST", "/api/conversations", {
    personalityId: personality.id,
  });
  await api("PATCH", `/api/conversations/${conv.id}`, { settings: { assistant } });
  return conv.id;
}

/** Sends a message and returns the reply. */
async function ask(id: string, said: string, extra: { research?: boolean } = {}) {
  const before = (await messages(id)).length;
  await api("POST", `/api/conversations/${id}/messages`, { text: said, ...extra });
  return until("the reply", async () =>
    (await messages(id)).slice(before).find((m) => m.role === "assistant"),
  );
}

const anthropic: AssistantChoice = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  effort: null,
  fast: false,
};
let research: PersonalityView;
let writer: PersonalityView;

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
  research = await api<PersonalityView>("POST", "/api/personalities/templates/research");
  writer = await api<PersonalityView>("POST", "/api/personalities/templates/writer");
}, 180_000);

afterEach(() => {
  plan.length = 0;
});

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

describe("web search on an API model", () => {
  it("searches with the provider's tools, shows the steps, and lists what the reply cites", async () => {
    const id = await chat(research, anthropic);
    plan.push({
      reason: "stop",
      parts: [
        {
          type: "tool-call",
          toolCallId: "srv_1",
          toolName: "web_search",
          input: JSON.stringify({ query: "rust stable release" }),
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "srv_1",
          toolName: "web_search",
          result: [
            {
              type: "web_search_result",
              url: "https://blog.rust-lang.org/releases/",
              title: "Rust Releases",
              pageAge: null,
              encryptedContent: "x",
            },
          ],
        },
        {
          type: "source",
          sourceType: "url",
          id: "s1",
          url: "https://blog.rust-lang.org/releases/",
          title: "Rust Releases",
        },
        {
          type: "tool-call",
          toolCallId: "srv_2",
          toolName: "web_fetch",
          input: JSON.stringify({ url: "https://releases.rs/" }),
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "srv_2",
          toolName: "web_fetch",
          result: {
            type: "web_fetch_result",
            url: "https://releases.rs/",
            retrievedAt: null,
            content: {
              type: "document",
              title: "Rust Versions",
              source: { type: "text", mediaType: "text/plain", data: "Stable: 1.99.1" },
            },
          },
        },
        ...text(
          "Rust 1.99.1 is stable [1](https://releases.rs/), out on 15 October [2](https://blog.rust-lang.org/releases/).",
        ),
      ],
    });
    const before = seen.length;
    const reply = await ask(id, "What's the latest Rust?");
    expect(toolIds(seen[before])).toEqual(
      expect.arrayContaining(["anthropic.web_search_20250305", "anthropic.web_fetch_20250910"]),
    );
    expect(system(seen[before])).toContain("Searching the web:");
    const steps = (reply.trace?.steps ?? []).filter((s): s is ToolStep => s.kind === "tool");
    expect(steps.map((s) => [s.name, s.input, s.status])).toEqual([
      ["web_search", { query: "rust stable release" }, "done"],
      ["web_fetch", { url: "https://releases.rs/" }, "done"],
    ]);
    expect(reply.trace?.sources).toEqual([
      { n: 1, url: "https://releases.rs/", title: "Rust Versions", kind: "web" },
      { n: 2, url: "https://blog.rust-lang.org/releases/", title: "Rust Releases", kind: "web" },
    ]);
    expect(reply.trace?.research).toBeUndefined();
  });

  it("gives Deep research 60 steps and its rules, and other turns 8", async () => {
    const id = await chat(research, anthropic);
    for (let i = 0; i < 10; i++) plan.push(recall());
    plan.push({ reason: "stop", parts: text("The report.") });
    let before = seen.length;
    const report = await ask(id, "Research Rust's release history.", { research: true });
    expect(report.text).toBe("The report.");
    expect(seen.length - before).toBe(11);
    expect(system(seen[before])).toContain("Deep research, for this message:");
    expect(report.trace?.research).toBe(true);
    const sent = (await messages(id)).find((m) => m.role === "user" && m.research);
    expect(sent?.text).toBe("Research Rust's release history.");

    // Still calling tools after seven steps, it has to answer on its eighth.
    for (let i = 0; i < 7; i++) plan.push(recall());
    plan.push({ reason: "stop", parts: text("What I found so far.") });
    before = seen.length;
    const short = await ask(id, "And the one before?");
    expect(short.text).toBe("What I found so far.");
    expect(seen.length - before).toBe(8);
    expect(seen[before + 6]?.toolChoice).not.toEqual({ type: "none" });
    expect(seen[before + 7]?.toolChoice).toEqual({ type: "none" });
    expect(system(seen[before])).not.toContain("Deep research");
  });

  it("gives no search to a personality without the web, or on a model that can't search", async () => {
    let before = seen.length;
    await ask(await chat(writer, anthropic), "Who won yesterday?", { research: true });
    expect(toolIds(seen[before])).not.toContain("anthropic.web_search_20250305");
    expect(system(seen[before])).toContain("You can't browse the web.");
    expect(system(seen[before])).not.toContain("Deep research");

    before = seen.length;
    const local: AssistantChoice = {
      provider: "openai-compatible",
      model: "llama3.3",
      effort: null,
      fast: false,
    };
    const reply = await ask(await chat(research, local), "Who won yesterday?", { research: true });
    expect(toolIds(seen[before]).filter((t) => t.includes("web"))).toEqual([]);
    expect(system(seen[before])).toContain("Web search isn't available on this model");
    expect(reply.trace?.research).toBeUndefined();
  });
});
