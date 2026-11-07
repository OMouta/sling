import { NodeError, type TriggerEvent } from "@sling/connector-sdk";
import { describe, expect, it } from "vitest";
import { approvalCustomId } from "./approval.ts";
import { ALICE, CHANNEL, fakeNodeContext, fakeRest, GUILD } from "./fakes.ts";
import {
  createSendMessage,
  type MessageReceivedConfig,
  messageReceived,
  nonceFor,
  type SendMessageConfig,
} from "./nodes.ts";
import type { DiscordMessage } from "./schemas.ts";

const trigger = messageReceived.trigger;
if (!trigger) throw new Error("trigger missing");
/** Takes settings as the editor saves them: the trigger fills in defaults itself. */
const match = (e: TriggerEvent, config: Record<string, unknown>) =>
  trigger.match(e, config as MessageReceivedConfig);

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "600000000000000001",
    channelId: CHANNEL,
    guildId: null,
    isDM: true,
    author: { id: ALICE, username: "alice" },
    content: "hi",
    mentionsBot: false,
    createdAt: "2026-11-05T10:00:00.000Z",
    ...overrides,
  };
}

const inChannel = (overrides: Partial<DiscordMessage> = {}) =>
  message({ isDM: false, guildId: GUILD, ...overrides });

function event(payload: DiscordMessage, installationId = "inst_discord"): TriggerEvent {
  return {
    type: "discord.message_received",
    workspaceId: "ws_1",
    installationId,
    payload,
    at: new Date(),
  };
}

const base = { installationId: "inst_discord" };

describe("discord.message_received match", () => {
  it("defaults to DMs only", () => {
    const m = message();
    expect(match(event(m), base)).toEqual({
      outputs: { message: m },
      concurrencyKey: `discord:inst_discord:${CHANNEL}`,
    });
    expect(match(event(inChannel()), base)).toBeNull();
  });

  it("channel scope takes channel messages only, optionally from listed channels", () => {
    const channels = { ...base, scope: "channels" };
    expect(match(event(message()), channels)).toBeNull();
    expect(match(event(inChannel()), channels)).not.toBeNull();

    const listed = { ...channels, channelIds: ["300000000000000009"] };
    expect(match(event(inChannel()), listed)).toBeNull();
    expect(match(event(inChannel({ channelId: "300000000000000009" })), listed)).toMatchObject({
      concurrencyKey: "discord:inst_discord:300000000000000009",
    });
  });

  it("any scope takes both, and channel IDs don't filter DMs", () => {
    const any = { ...base, scope: "any", channelIds: ["300000000000000009"] };
    expect(match(event(message()), any)).not.toBeNull();
    expect(match(event(inChannel()), any)).toBeNull();
    expect(match(event(inChannel({ channelId: "300000000000000009" })), any)).not.toBeNull();
  });

  it("requireMention filters channel messages but not DMs", () => {
    const config = { ...base, scope: "any", requireMention: true };
    expect(match(event(inChannel()), config)).toBeNull();
    expect(match(event(inChannel({ mentionsBot: true })), config)).not.toBeNull();
    expect(match(event(message()), config)).not.toBeNull();
  });

  it("ignores other installations, other events, and broken config", () => {
    expect(match(event(message(), "inst_other"), base)).toBeNull();
    expect(match({ ...event(message()), type: "email.received" }, base)).toBeNull();
    expect(match(event(message()), { installationId: "" })).toBeNull();
    expect(match(event(message()), { ...base, scope: "everywhere" })).toBeNull();
  });
});

/** Settings as the editor saves them: defaults are filled in by the node. */
const cfg = (config: Record<string, unknown>) => config as SendMessageConfig;

const sent = (channelId: string) => ({
  status: 200,
  body: { id: "800000000000000001", channel_id: channelId },
});

describe("discord.send_message", () => {
  it("posts to a channel with a nonce derived from the idempotency key", async () => {
    const rest = fakeRest({ [`POST /channels/${CHANNEL}/messages`]: sent(CHANNEL) });
    const node = createSendMessage(rest.factory);
    const result = await node.run?.(fakeNodeContext(), {
      inputs: {},
      config: cfg({
        installationId: "inst_discord",
        channelId: CHANNEL,
        content: "Deploy finished",
      }),
    });

    expect(result).toEqual({
      exec: "next",
      outputs: { messageId: "800000000000000001", channelId: CHANNEL },
    });
    expect(rest.requests).toEqual([
      {
        token: "token-abc",
        method: "POST",
        path: `/channels/${CHANNEL}/messages`,
        body: {
          content: "Deploy finished",
          nonce: nonceFor("run_1:n_send:0"),
          enforce_nonce: true,
          allowed_mentions: { parse: ["users"] },
        },
      },
    ]);
  });

  it("keeps the nonce within Discord's 25 characters, stable per key", () => {
    const a = nonceFor("run_0193f0a1-aaaa-bbbb-cccc-1234567890ab:n_send_reply:12");
    expect(a).toHaveLength(25);
    expect(a).toBe(nonceFor("run_0193f0a1-aaaa-bbbb-cccc-1234567890ab:n_send_reply:12"));
    expect(a).not.toBe(nonceFor("run_0193f0a1-aaaa-bbbb-cccc-1234567890ab:n_send_reply:13"));
  });

  it("opens a DM channel for a user ID", async () => {
    const dmChannel = "300000000000000077";
    const rest = fakeRest({
      "POST /users/@me/channels": { status: 200, body: { id: dmChannel, type: 1 } },
      [`POST /channels/${dmChannel}/messages`]: sent(dmChannel),
    });
    const result = await createSendMessage(rest.factory).run?.(fakeNodeContext(), {
      inputs: {},
      config: cfg({ installationId: "inst_discord", userId: ALICE, content: "hi" }),
    });
    expect(rest.requests.map((r) => [r.path, r.body])).toEqual([
      ["/users/@me/channels", { recipient_id: ALICE }],
      [`/channels/${dmChannel}/messages`, expect.objectContaining({ content: "hi" })],
    ]);
    expect(result).toMatchObject({ outputs: { channelId: dmChannel } });
  });

  it("falls back to the installation's default channel, and lets the content input win", async () => {
    const fallback = "300000000000000055";
    const rest = fakeRest({ [`POST /channels/${fallback}/messages`]: sent(fallback) });
    const ctx = fakeNodeContext({
      config: { allowedUserIds: [], approverUserIds: [], defaultChannelId: fallback },
    });
    await createSendMessage(rest.factory).run?.(ctx, {
      inputs: { content: "from the input" },
      config: cfg({ installationId: "inst_discord", channelId: "", content: "from config" }),
    });
    expect(rest.requests[0]?.path).toBe(`/channels/${fallback}/messages`);
    expect(rest.requests[0]?.body).toMatchObject({ content: "from the input" });
  });

  it("adds approval buttons and the approval's title, summary, and link", async () => {
    const rest = fakeRest({ [`POST /channels/${CHANNEL}/messages`]: sent(CHANNEL) });
    await createSendMessage(rest.factory).run?.(fakeNodeContext(), {
      inputs: {
        approval: {
          id: "appr_123",
          kind: "task_action",
          title: "Push fix/footer to origin",
          summary: "1 file changed: footer year.",
          expiresAt: "2026-11-06T10:00:00.000Z",
          url: "https://sling.example/approvals/appr_123",
        },
      },
      config: cfg({ installationId: "inst_discord", channelId: CHANNEL, approvalButtons: true }),
    });
    const body = rest.requests[0]?.body as Record<string, unknown>;
    expect(body.content).toBe(
      [
        "**Push fix/footer to origin**",
        "1 file changed: footer year.",
        `Review it in Sling: https://sling.example/approvals/appr_123\nExpires <t:${Date.parse("2026-11-06T10:00:00.000Z") / 1000}:R>`,
      ].join("\n\n"),
    );
    expect(body.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Approve",
            custom_id: approvalCustomId("appr_123", "approve"),
          },
          { type: 2, style: 4, label: "Reject", custom_id: approvalCustomId("appr_123", "reject") },
        ],
      },
    ]);
    expect(body.nonce).toBe(nonceFor("run_1:n_send:0"));
    expect(body.enforce_nonce).toBe(true);
  });

  it("requires an approval when approval buttons are on", async () => {
    const rest = fakeRest({});
    await expect(
      createSendMessage(rest.factory).run?.(fakeNodeContext(), {
        inputs: { approval: null },
        config: cfg({ installationId: "inst_discord", channelId: CHANNEL, approvalButtons: true }),
      }),
    ).rejects.toMatchObject({ code: "missing_approval" });
    expect(rest.requests).toEqual([]);
  });

  it("cuts content down to Discord's limit", async () => {
    const rest = fakeRest({ [`POST /channels/${CHANNEL}/messages`]: sent(CHANNEL) });
    await createSendMessage(rest.factory).run?.(fakeNodeContext(), {
      inputs: { content: "x".repeat(5000) },
      config: cfg({ installationId: "inst_discord", channelId: CHANNEL }),
    });
    const body = rest.requests[0]?.body as { content: string } | undefined;
    expect(body?.content).toHaveLength(2000);
  });

  it.each([
    [429, "discord_rate_limited", true],
    [502, "discord_unavailable", true],
    [403, "discord_forbidden", false],
    [401, "discord_unauthorized", false],
    [400, "discord_error", false],
  ])("turns HTTP %i into %s (retryable: %s)", async (status, code, retryable) => {
    const rest = fakeRest({
      [`POST /channels/${CHANNEL}/messages`]: {
        status,
        body: { code: 50013, message: "Missing Permissions" },
        retryAfterMs: status === 429 ? 1500 : undefined,
      },
    });
    const error = await createSendMessage(rest.factory)
      .run?.(fakeNodeContext(), {
        inputs: {},
        config: cfg({ installationId: "inst_discord", channelId: CHANNEL, content: "hi" }),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NodeError);
    expect(error).toMatchObject({ code, retryable });
  });

  it("fails without a target, with a bad ID, or with an empty message", async () => {
    const rest = fakeRest({});
    const node = createSendMessage(rest.factory);
    const run = (config: Record<string, unknown>, inputs: Record<string, unknown> = {}) =>
      node.run?.(fakeNodeContext(), {
        inputs,
        config: cfg({ installationId: "inst_discord", ...config }),
      });
    await expect(run({ content: "hi" })).rejects.toMatchObject({ code: "no_target" });
    await expect(run({ channelId: "general", content: "hi" })).rejects.toMatchObject({
      code: "invalid_target",
    });
    await expect(run({ channelId: CHANNEL, content: "  " })).rejects.toMatchObject({
      code: "empty_message",
    });
    expect(rest.requests).toEqual([]);
  });

  it("refuses an installation of another connector", async () => {
    const rest = fakeRest({});
    await expect(
      createSendMessage(rest.factory).run?.(fakeNodeContext({ connectorId: "email" }), {
        inputs: {},
        config: cfg({ installationId: "inst_discord", channelId: CHANNEL, content: "hi" }),
      }),
    ).rejects.toMatchObject({ code: "wrong_installation" });
  });

  it("fetches the message back by its ID to check it was posted", async () => {
    const path = `/channels/${CHANNEL}/messages/800000000000000001`;
    const outputs = { messageId: "800000000000000001", channelId: CHANNEL };
    const config = cfg({ installationId: "inst_discord", channelId: CHANNEL, content: "hi" });
    const check = (routes: Parameters<typeof fakeRest>[0]) =>
      createSendMessage(fakeRest(routes).factory).verify?.(fakeNodeContext(), {
        inputs: {},
        config,
        outputs,
      });
    expect(await check({ [`GET ${path}`]: sent(CHANNEL) })).toEqual({
      state: "passed",
      message: "Discord has the message",
    });
    expect(await check({})).toMatchObject({ state: "failed" });
    expect(
      await check({
        [`GET ${path}`]: { status: 403, body: { code: 50001, message: "Missing Access" } },
      }),
    ).toEqual({
      state: "unchecked",
      message: "Discord won't let the bot read it back: Missing Access (Discord code 50001)",
    });
    expect(
      await check({ [`GET ${path}`]: { status: 503, body: "", retryAfterMs: 2000 } }),
    ).toMatchObject({ state: "waiting", retryAfterSeconds: 5 });
    const nothing = await createSendMessage(fakeRest({}).factory).verify?.(fakeNodeContext(), {
      inputs: {},
      config,
      outputs: {},
    });
    expect(nothing).toMatchObject({ state: "unchecked" });
  });

  it("isn't retried automatically", () => {
    const node = createSendMessage(fakeRest({}).factory);
    expect(node.idempotent).toBe(false);
    expect(node.retry).toBeUndefined();
  });
});
