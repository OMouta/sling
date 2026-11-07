/**
 * Telegram end to end: real Postgres, the control plane in-process, the real
 * Telegram connector long-polling a local stand-in for the Bot API, and a
 * scripted model. The setup lookup finds the chat after it messages the
 * bot, and the Telegram assistant template answers there and nowhere else.
 */
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { InstallationView, SetupResultView } from "@sling/core";
import { schema } from "@sling/db";
import { createBotApi, createTelegramConnector } from "@sling/integration-telegram";
import { type BotApiStandIn, startBotApi } from "@sling/integration-telegram/stand-in";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

vi.setConfig({ testTimeout: 60_000 });

const ANA = { id: 5551234, type: "private" as const, first_name: "Ana", username: "ana_s" };
const BOB = { id: 5559999, type: "private" as const, first_name: "Bob" };

/** When each assistant turn reached the model, and what it was asked. */
const turns: { at: number; user: string }[] = [];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function lastUser(options: LanguageModelV4CallOptions): string {
  const m = options.prompt.findLast((p) => p.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
}

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const user = lastUser(options);
    turns.push({ at: Date.now(), user });
    const reply = user.includes("Monday")
      ? "**Nothing** on Monday. Enjoy it."
      : `You said: ${user.slice(0, 60)}`;
    return {
      stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: reply },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
      ]),
    };
  },
});

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let bot: BotApiStandIn;
let cookie = "";
let origin = "";
let installationId = "";

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
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const t = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false> | T,
  ms = 20_000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  bot = await startBotApi();
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "telegram-e2e-secret-key-that-is-long-enough",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
  };
  server = await startServer(config, {
    model,
    jobs: false,
    connectors: [
      createTelegramConnector({
        api: (token) => createBotApi(token, { baseUrl: bot.url }),
        backoff: { initialMs: 50, maxMs: 200 },
        pollSeconds: 2,
      }),
    ],
  });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
  await bot?.close();
});

describe("Telegram", () => {
  it("finds your chat once you message the bot", async () => {
    const before = await api<SetupResultView>("POST", "/api/connectors/telegram/setup", {
      credentials: { botToken: bot.token },
    });
    expect(before.retryAfterMs).toBe(3_000);
    bot.message(ANA, "hello bot");
    const after = await api<SetupResultView>("POST", "/api/connectors/telegram/setup", {
      credentials: { botToken: bot.token },
    });
    expect(after.config).toEqual({ allowedChatIds: [String(ANA.id)] });
    const inst = await api<InstallationView>("POST", "/api/installations", {
      connectorId: "telegram",
      ...(after.name ? { name: after.name } : {}),
      credentials: { botToken: bot.token },
      config: after.config,
      check: true,
    });
    installationId = inst.id;
    expect(inst.name).toBe("@sling_test_bot");
  });

  it("answers in the chat through the Telegram assistant, and ignores everyone else", async () => {
    const wf = await api<{ id: string }>("POST", "/api/workflows", {
      templateKey: "telegram-assistant",
      bindings: { $telegram: installationId },
    });
    await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
    await until("the bot listening", async () => {
      const list = await api<InstallationView[]>("GET", "/api/installations");
      return list.find((i) => i.id === installationId)?.status === "connected";
    });
    // What was sent while setting up isn't answered.
    await new Promise((r) => setTimeout(r, 300));
    expect(turns).toEqual([]);

    const sentAt = Date.now();
    bot.message(ANA, "What's on Monday?");
    await until("the reply", () => bot.sent.length === 1);
    const firstTurn = turns[0];
    expect(firstTurn?.user).toContain("What's on Monday?");
    const toTurn = (firstTurn?.at ?? 0) - sentAt;
    console.info(`Telegram message to the assistant's turn: ${toTurn} ms`);
    expect(toTurn).toBeLessThan(500);
    expect(bot.sent).toEqual([
      {
        chat_id: String(ANA.id),
        text: "<b>Nothing</b> on Monday. Enjoy it.",
        parse_mode: "HTML",
      },
    ]);

    bot.message(BOB, "let me in");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(turns).toHaveLength(1);
    expect(bot.sent).toHaveLength(1);

    const [conv] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.externalKey, `telegram:${installationId}:${ANA.id}`));
    expect(conv).toMatchObject({ title: "Telegram: Ana", workflowId: wf.id });
  });

  it("answers nothing twice after a restart, and what came in meanwhile once", async () => {
    await server.ctx.connectors.restart(installationId);
    bot.message(ANA, "after the restart");
    await until("the second reply", () => bot.sent.length === 2);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(bot.sent.map((s) => s.text)).toEqual([
      "<b>Nothing</b> on Monday. Enjoy it.",
      "You said: after the restart",
    ]);
    expect(turns).toHaveLength(2);
  });
});
