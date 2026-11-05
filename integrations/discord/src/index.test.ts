import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, fakeRest, silentLog } from "./fakes.ts";
import {
  BAD_TOKEN,
  connector,
  createDiscordConnector,
  GATEWAY_MESSAGE_CONTENT,
  GATEWAY_MESSAGE_CONTENT_LIMITED,
  MESSAGE_CONTENT_OFF,
} from "./index.ts";

const me = { status: 200, body: { id: "900000000000000001", username: "sling-bot", bot: true } };

function runTest(routes: Parameters<typeof fakeRest>[0], allowedUserIds = [ALICE]) {
  const rest = fakeRest(routes);
  const result = createDiscordConnector({ rest: rest.factory }).test({
    credentials: { botToken: "token-abc" },
    config: { allowedUserIds, approverUserIds: [] },
    log: silentLog,
    signal: new AbortController().signal,
  });
  return { rest, result };
}

describe("Discord connection test", () => {
  it("passes with a valid token and the Message Content intent on", async () => {
    const { rest, result } = runTest({
      "GET /users/@me": me,
      "GET /applications/@me": { status: 200, body: { flags: GATEWAY_MESSAGE_CONTENT } },
    });
    expect(await result).toEqual({ ok: true, detail: "Connected as sling-bot." });
    expect(rest.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /users/@me",
      "GET /applications/@me",
    ]);
  });

  it("accepts the limited Message Content intent of unverified bots", async () => {
    const { result } = runTest({
      "GET /users/@me": me,
      "GET /applications/@me": {
        status: 200,
        body: { flags: GATEWAY_MESSAGE_CONTENT_LIMITED | (1 << 23) },
      },
    });
    expect(await result).toMatchObject({ ok: true });
  });

  it("fails with directions when the Message Content intent is off", async () => {
    const { result } = runTest({
      "GET /users/@me": me,
      "GET /applications/@me": { status: 200, body: { flags: (1 << 13) | (1 << 15) } },
    });
    const outcome = await result;
    expect(outcome).toEqual({ ok: false, error: MESSAGE_CONTENT_OFF });
    expect(MESSAGE_CONTENT_OFF).toMatch(/developer portal/);
  });

  it("fails on a bad token without asking for the application", async () => {
    const { rest, result } = runTest({
      "GET /users/@me": { status: 401, body: { message: "401: Unauthorized", code: 0 } },
    });
    expect(await result).toEqual({ ok: false, error: BAD_TOKEN });
    expect(rest.requests).toHaveLength(1);
  });

  it("notes when nobody is allowed to message the bot yet", async () => {
    const { result } = runTest(
      {
        "GET /users/@me": me,
        "GET /applications/@me": { status: 200, body: { flags: GATEWAY_MESSAGE_CONTENT } },
      },
      [],
    );
    expect(await result).toMatchObject({ ok: true, detail: expect.stringMatching(/No allowed/) });
  });

  it("reports a network failure", async () => {
    const result = await createDiscordConnector({
      rest: () => ({
        async request() {
          throw new Error("getaddrinfo ENOTFOUND discord.com");
        },
      }),
    }).test({
      credentials: { botToken: "t" },
      config: { allowedUserIds: [], approverUserIds: [] },
      log: silentLog,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: false,
      error: "Couldn't reach Discord: getaddrinfo ENOTFOUND discord.com",
    });
  });
});

describe("Discord connector definition", () => {
  it("declares its credentials, config, and nodes", () => {
    expect(connector.id).toBe("discord");
    expect(connector.secretFields).toEqual(["botToken"]);
    expect(connector.nodes.map((n) => n.type)).toEqual([
      "discord.message_received",
      "discord.send_message",
    ]);
    expect(connector.source).toBeDefined();
    expect(connector.configSchema.parse({})).toEqual({ allowedUserIds: [], approverUserIds: [] });
    expect(() => connector.configSchema.parse({ allowedUserIds: ["alice"] })).toThrow();
  });

  it("describes every config field, for the editor's form", () => {
    const schemas = [
      connector.credentialsSchema,
      connector.configSchema,
      ...connector.nodes.map((n) => n.configSchema),
    ];
    for (const schema of schemas) {
      const json = z.toJSONSchema(schema, { io: "input" }) as {
        properties: Record<string, { description?: string }>;
      };
      for (const [key, prop] of Object.entries(json.properties)) {
        expect(prop.description, key).toBeTruthy();
      }
    }
  });

  it("marks the content field as a textarea expression", () => {
    const send = connector.nodes.find((n) => n.type === "discord.send_message");
    const json = z.toJSONSchema(send?.configSchema ?? z.object({}), { io: "input" }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(json.properties.content?.widget).toBe("textarea");
    expect(send?.expressionFields).toContain("content");
    expect(send?.installationFields).toEqual(["installationId"]);
  });
});
