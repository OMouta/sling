import type { NodeContext, SourceContext, SourceStatus } from "@sling/connector-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TgChat } from "./api.ts";
import { createBotApi, createTelegramConnector } from "./index.ts";
import type { TelegramConfig, TelegramCredentials, TelegramMessage } from "./schemas.ts";
import { OFFSET_KEY, toTelegramMessage } from "./source.ts";
import { type BotApiStandIn, startBotApi } from "./stand-in.ts";

let bot: BotApiStandIn;
let connector: ReturnType<typeof createTelegramConnector>;

const ANA: TgChat = { id: 5551234, type: "private", first_name: "Ana", username: "ana_s" };
const BOB: TgChat = { id: 5559999, type: "private", first_name: "Bob" };
const TEAM: TgChat = { id: -100777, type: "supergroup", title: "Team" };
const log = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  bot = await startBotApi();
  connector = createTelegramConnector({
    api: (token) => createBotApi(token, { baseUrl: bot.url }),
    backoff: { initialMs: 20, maxMs: 100 },
    pollSeconds: 1,
  });
});
afterAll(() => bot.close());

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the setup lookup", () => {
  const setup = (credentials: Partial<TelegramCredentials>, config: Partial<TelegramConfig> = {}) =>
    connector.setup?.({ credentials, config, log, signal: AbortSignal.timeout(5_000) });

  it("points at @BotFather until there's a token, and says when Telegram refuses one", async () => {
    expect((await setup({}))?.notes?.[0]).toMatchObject({
      tone: "info",
      link: { url: "https://t.me/BotFather" },
    });
    expect((await setup({ botToken: "123:wrong" }))?.notes?.[0]).toMatchObject({
      tone: "error",
      text: "Telegram doesn't accept this token.",
    });
  });

  it("asks you to message the bot, then finds your chat and picks it", async () => {
    const waiting = await setup({ botToken: bot.token });
    expect(waiting).toMatchObject({
      name: "@sling_test_bot",
      retryAfterMs: 3_000,
      notes: [
        { field: "botToken", tone: "ok", text: "Connected as @sling_test_bot" },
        {
          field: "allowedChatIds",
          text: "Send @sling_test_bot a private message in Telegram, and your chat shows up here.",
          link: { url: "https://t.me/sling_test_bot" },
        },
      ],
    });
    bot.message(ANA, "hi");
    const found = await setup({ botToken: bot.token });
    expect(found?.config).toEqual({ allowedChatIds: ["5551234"] });
    expect(found?.options?.allowedChatIds).toEqual([
      { value: "5551234", label: "Ana", detail: "@ana_s" },
    ]);
    expect(found?.notes).toContainEqual({
      field: "botToken",
      tone: "ok",
      text: "Found your chat with Ana",
    });
    expect(found?.retryAfterMs).toBeUndefined();
    // The lookup leaves the message for the bot's own polling.
    expect(bot.polls.at(-1)?.offset).toBeNull();
  });

  it("names chats allowed before, and leaves the choice alone", async () => {
    const editing = await setup({ botToken: bot.token }, { allowedChatIds: ["5551234", "777"] });
    expect(editing?.config).toBeUndefined();
    expect(editing?.options?.allowedChatIds).toEqual([
      { value: "5551234", label: "Ana", detail: "@ana_s" },
      { value: "777", label: "777", detail: "Not found" },
    ]);
  });
});

describe("the setup lookup with a group", () => {
  it("never picks a group by itself, and offers the people who wrote there", async () => {
    const other = await startBotApi();
    try {
      const c = createTelegramConnector({
        api: (token) => createBotApi(token, { baseUrl: other.url }),
      });
      const setup = (config: Partial<TelegramConfig> = {}) =>
        c.setup?.({
          credentials: { botToken: other.token },
          config,
          log,
          signal: AbortSignal.timeout(5_000),
        });
      other.message(TEAM, "hello bot");
      const grouped = await setup();
      expect(grouped?.config).toBeUndefined();
      expect(grouped?.retryAfterMs).toBe(3_000);
      expect(grouped?.options?.allowedChatIds).toEqual([
        { value: "-100777", label: "Team", detail: "Group" },
        { value: "42", label: "Someone", detail: "Person" },
      ]);
      expect((await setup({ allowedChatIds: ["-100777"] }))?.notes).toContainEqual({
        field: "allowedChatIds",
        tone: "info",
        text: "In a group, it answers only the people on this list. Add yourself too.",
      });
      other.message(ANA, "me");
      expect((await setup())?.config).toEqual({ allowedChatIds: ["5551234"] });
    } finally {
      await other.close();
    }
  });
});

describe("who a message is answered for", () => {
  const update = (chat: TgChat, fromId: number) => ({
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat,
      from: { id: fromId, is_bot: false, first_name: "X" },
      text: "hi",
    },
  });

  it("answers a group only for the people on the list", () => {
    const ana = update(TEAM, 5551234);
    const someone = update(TEAM, 42);
    // A group on the list with no people on it answers nobody.
    expect(toTelegramMessage(ana, new Set(["-100777"]))).toBeNull();
    expect(toTelegramMessage(ana, new Set(["-100777", "5551234"]))?.from.id).toBe("5551234");
    expect(toTelegramMessage(someone, new Set(["-100777", "5551234"]))).toBeNull();
    // A person on the list isn't answered in a group that isn't.
    expect(toTelegramMessage(ana, new Set(["5551234"]))).toBeNull();
    // A private chat's ID is the person's, so a list from before keeps working.
    expect(toTelegramMessage(update(ANA, 5551234), new Set(["5551234"]))?.chatId).toBe("5551234");
  });
});

describe("the connection test", () => {
  const test = (config: TelegramConfig, botToken = bot.token) =>
    connector.test({ credentials: { botToken }, config, log, signal: AbortSignal.timeout(5_000) });

  it("names the bot and how many chats it answers", async () => {
    expect(await test({ allowedChatIds: ["1"] })).toEqual({
      ok: true,
      detail: "Connected as @sling_test_bot. It answers 1 chat.",
    });
    expect(await test({ allowedChatIds: [] })).toMatchObject({
      ok: true,
      detail: /answers no one/,
    });
    expect(await test({ allowedChatIds: [] }, "1:nope")).toMatchObject({
      ok: false,
      error: /doesn't accept/,
    });
  });

  it("fails while a webhook takes the bot's messages", async () => {
    bot.webhook = "https://elsewhere.example/hook";
    expect(await test({ allowedChatIds: ["1"] })).toMatchObject({ ok: false, error: /webhook/ });
    bot.webhook = "";
  });
});

// ---------------------------------------------------------------- source

interface Harness {
  ctx: SourceContext<TelegramCredentials, TelegramConfig>;
  emitted: { type: string; payload: TelegramMessage; dedupeKey?: string }[];
  statuses: { status: SourceStatus; detail?: string }[];
  state: Map<string, string>;
}

function harness(allowed: string[], shared?: Pick<Harness, "emitted" | "state">): Harness {
  const emitted = shared?.emitted ?? [];
  const state = shared?.state ?? new Map<string, string>();
  const statuses: Harness["statuses"] = [];
  return {
    emitted,
    state,
    statuses,
    ctx: {
      installationId: "ins_tg",
      workspaceId: "ws",
      credentials: { botToken: bot.token },
      config: { allowedChatIds: allowed },
      log,
      signal: new AbortController().signal,
      async emit(event) {
        emitted.push(event as Harness["emitted"][number]);
      },
      state: {
        get: async (k) => state.get(k) ?? null,
        set: async (k, v) => void state.set(k, v),
      },
      approvals: {
        decide: async () => ({ ok: false, message: "" }),
        reportRefused: async () => {},
      },
      setStatus(status, detail) {
        statuses.push({ status, ...(detail ? { detail } : {}) });
      },
    },
  };
}

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()?.stop();
});

async function start(h: Harness) {
  const source = await connector.source?.start(h.ctx);
  if (!source) throw new Error("no source");
  running.push(source);
  await until(() => h.statuses.at(-1)?.status === "connected");
  return source;
}

describe("the source", () => {
  it("skips what was waiting before it first listened, then hands on allowed chats only", async () => {
    bot.message(ANA, "sent during setup");
    const h = harness(["5551234"]);
    await start(h);
    expect(h.statuses.at(-1)).toEqual({
      status: "connected",
      detail: "Listening as @sling_test_bot",
    });
    bot.message(BOB, "let me in");
    const u = bot.message(ANA, "What's on **Monday**?");
    await until(() => h.emitted.length === 1);
    expect(h.emitted[0]).toEqual({
      type: "telegram.message_received",
      dedupeKey: String(u.update_id),
      payload: {
        id: String(u.message?.message_id),
        chatId: "5551234",
        chatType: "private",
        chatName: "Ana",
        from: { id: "5551234", username: "ana_s", name: "Ana" },
        text: "What's on **Monday**?",
        date: expect.stringMatching(/^\d{4}-/),
      },
    });
    await until(() => h.state.get(OFFSET_KEY) === String(u.update_id + 1));
    await new Promise((r) => setTimeout(r, 200));
    expect(h.emitted).toHaveLength(1);
  });

  it("answers nothing twice across a restart, and what came in while stopped once", async () => {
    const first = harness(["5551234"]);
    const source = await start(first);
    bot.message(ANA, "one");
    await until(() => first.emitted.length === 1);
    await source.stop();
    running.pop();
    bot.message(ANA, "while stopped");
    const second = harness(["5551234"], first);
    await start(second);
    await until(() => first.emitted.length === 2);
    bot.message(ANA, "after");
    await until(() => first.emitted.length === 3);
    expect(first.emitted.map((e) => e.payload.text)).toEqual(["one", "while stopped", "after"]);
  });

  it("keeps listening when the setup form polls at the same time", async () => {
    const h = harness(["5551234"]);
    await start(h);
    await connector.setup?.({
      credentials: { botToken: bot.token },
      config: { allowedChatIds: ["5551234"] },
      log,
      signal: AbortSignal.timeout(5_000),
    });
    bot.message(ANA, "still there?");
    await until(() => h.emitted.some((e) => e.payload.text === "still there?"));
    expect(h.statuses.some((s) => s.status === "error")).toBe(false);
  });

  it("reports a token Telegram refuses, and stops when asked", async () => {
    const h = harness(["5551234"]);
    h.ctx.credentials = { botToken: "1:revoked" };
    const source = await connector.source?.start(h.ctx);
    await until(() => h.statuses.some((s) => s.status === "error"));
    await source?.stop();
    expect(h.statuses.find((s) => s.status === "error")?.detail).toMatch(
      /doesn't accept the bot token/,
    );
  });
});

// ---------------------------------------------------------------- sending

function nodeContext(allowed: string[]): NodeContext {
  return {
    runId: "chat:conv",
    nodeId: "telegram_send_message",
    nodeRunId: "call_1",
    workflowId: "",
    workspaceId: "ws",
    ownerId: "usr",
    iteration: 0,
    attempt: 1,
    idempotencyKey: "chat:call_1",
    signal: AbortSignal.timeout(5_000),
    log,
    installation: async () =>
      ({
        id: "ins_tg",
        connectorId: "telegram",
        name: "Sling bot",
        credentials: { botToken: bot.token },
        config: { allowedChatIds: allowed },
      }) as never,
    services: undefined,
  };
}

describe("telegram.send_message", () => {
  const node = () => {
    const n = connector.nodes.find((x) => x.type === "telegram.send_message");
    if (!n?.run) throw new Error("no node");
    return n;
  };
  const send = (config: Record<string, unknown>, allowed = ["5551234"], inputs = {}) =>
    node().run?.(nodeContext(allowed), { inputs, config: { installationId: "ins_tg", ...config } });

  it("is flagged as sending, with the chat a rule may pin", () => {
    expect(node().assistant).toEqual({
      sends: true,
      summary: "Telegram message: {text}",
      ruleFields: ["chatId"],
    });
  });

  it("sends Markdown as Telegram HTML, to the first allowed chat by default", async () => {
    bot.sent.length = 0;
    const out = await send({ text: "**Mon** standup at 9" });
    expect(bot.sent).toEqual([
      { chat_id: "5551234", text: "<b>Mon</b> standup at 9", parse_mode: "HTML" },
    ]);
    expect(out).toEqual({
      exec: "next",
      outputs: {
        messageId: expect.any(String),
        messageIds: [expect.any(String)],
        chatId: "5551234",
      },
    });
    expect(
      await node().verify?.(nodeContext([]), {
        inputs: {},
        config: {},
        outputs: (out as { outputs: Record<string, unknown> }).outputs,
      }),
    ).toEqual({
      state: "passed",
      message: "Telegram took it",
    });
  });

  it("splits a long reply into messages of at most 4,096 characters", async () => {
    bot.sent.length = 0;
    const text = Array.from({ length: 5 }, (_, i) => `Part ${i} ${"word ".repeat(400)}`).join(
      "\n\n",
    );
    const out = (await send({}, ["5551234"], { text })) as unknown as {
      outputs: { messageIds: string[] };
    };
    expect(bot.sent.length).toBeGreaterThan(1);
    for (const m of bot.sent) expect(m.text.length).toBeLessThanOrEqual(4096);
    expect(out.outputs.messageIds).toHaveLength(bot.sent.length);
  });

  it("sends plain text when Telegram can't read the HTML", async () => {
    bot.sent.length = 0;
    await send({ text: "**UNPARSEABLE** & tag" });
    expect(bot.sent).toEqual([{ chat_id: "5551234", text: "UNPARSEABLE & tag" }]);
  });

  it("refuses a chat the bot doesn't answer, an empty message, and says when it's blocked", async () => {
    await expect(send({ chatId: "5559999", text: "hi" })).rejects.toThrow(
      "Sling bot doesn't answer chat 5559999. Add it to the bot's chats on the Connectors page.",
    );
    await expect(send({ text: "  " })).rejects.toThrow("The message is empty");
    await expect(send({ text: "hi" }, [])).rejects.toThrow(/has no chats yet/);
    bot.blocked.add("5551234");
    await expect(send({ text: "hi" })).rejects.toThrow(/bot was blocked by the user/);
    bot.blocked.clear();
  });
});
