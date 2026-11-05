import { afterEach, describe, expect, it } from "vitest";
import { approvalCustomId } from "./approval.ts";
import {
  ALICE,
  BOB,
  BOT_ID,
  CHANNEL,
  FakeGateways,
  type FakeSourceContext,
  fakeClick,
  fakeSourceContext,
  GUILD,
  until,
} from "./fakes.ts";
import type { DiscordConfig } from "./schemas.ts";
import { createDiscordSource, REFUSED_REPLY } from "./source.ts";

const fast = { initialMs: 5, maxMs: 20 };
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
});

async function startSource(
  config: Partial<DiscordConfig> = {},
  decide?: Parameters<typeof fakeSourceContext>[1],
) {
  const gateways = new FakeGateways();
  const ctx = fakeSourceContext(config, decide);
  const source = await createDiscordSource({ gateway: gateways.factory, backoff: fast }).start(ctx);
  stops.push(() => source.stop());
  await until(() => gateways.instances[0]?.loggedIn === true);
  await until(() => ctx.statuses.some((s) => s.status === "connected"));
  return { gateways, ctx, source };
}

/** Lets queued emits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function payloads(ctx: FakeSourceContext) {
  return ctx.emitted.map((e) => e.payload as Record<string, unknown>);
}

describe("Discord source: messages", () => {
  it("emits a DM from an allowed user with the discord.message shape", async () => {
    const { gateways, ctx } = await startSource();
    expect(gateways.latest.token).toBe("token-abc");
    gateways.latest.send({ id: "600000000000000042", content: "fix the footer year in site" });
    await until(() => ctx.emitted.length === 1);
    expect(ctx.emitted[0]).toEqual({
      type: "discord.message_received",
      dedupeKey: "600000000000000042",
      payload: {
        id: "600000000000000042",
        channelId: CHANNEL,
        guildId: null,
        isDM: true,
        author: { id: ALICE, username: "alice" },
        content: "fix the footer year in site",
        mentionsBot: false,
        createdAt: "2026-11-05T10:00:00.000Z",
      },
    });
  });

  it("drops messages from users outside the allowed list", async () => {
    const { gateways, ctx } = await startSource();
    gateways.latest.send({ id: "600000000000000001", authorId: BOB });
    gateways.latest.send({ id: "600000000000000002", authorId: ALICE });
    await until(() => ctx.emitted.length === 1);
    await settle();
    expect(payloads(ctx).map((p) => p.id)).toEqual(["600000000000000002"]);
  });

  it("drops everything when no users are allowed", async () => {
    const { gateways, ctx } = await startSource({ allowedUserIds: [] });
    gateways.latest.send({ authorId: ALICE });
    await settle();
    expect(ctx.emitted).toEqual([]);
  });

  it("ignores bots, the bot itself, and system messages", async () => {
    const { gateways, ctx } = await startSource({ allowedUserIds: [ALICE, BOT_ID] });
    const g = gateways.latest;
    g.send({ id: "600000000000000001", author: { id: ALICE, username: "alice", bot: true } });
    g.send({ id: "600000000000000002", authorId: BOT_ID });
    g.send({ id: "600000000000000003", system: true });
    g.send({ id: "600000000000000004" });
    await until(() => ctx.emitted.length === 1);
    await settle();
    expect(payloads(ctx).map((p) => p.id)).toEqual(["600000000000000004"]);
  });

  it("marks channel messages and works out whether they mention the bot", async () => {
    const { gateways, ctx } = await startSource();
    const g = gateways.latest;
    const roleId = "700000000000000001";
    g.send({ id: "600000000000000001", guildId: GUILD, content: "no mention" });
    g.send({
      id: "600000000000000002",
      guildId: GUILD,
      content: `<@${BOT_ID}> hi`,
      mentionedUserIds: [BOT_ID],
    });
    g.send({
      id: "600000000000000003",
      guildId: GUILD,
      content: `<@&${roleId}> hi`,
      mentionedRoleIds: [roleId],
      botRoleId: roleId,
    });
    g.send({
      id: "600000000000000004",
      guildId: GUILD,
      content: `<@${BOB}> hi`,
      mentionedUserIds: [BOB],
      mentionedRoleIds: ["700000000000000002"],
      botRoleId: roleId,
    });
    await until(() => ctx.emitted.length === 4);
    expect(payloads(ctx).map((p) => [p.id, p.isDM, p.guildId, p.mentionsBot])).toEqual([
      ["600000000000000001", false, GUILD, false],
      ["600000000000000002", false, GUILD, true],
      ["600000000000000003", false, GUILD, true],
      ["600000000000000004", false, GUILD, false],
    ]);
  });

  it("emits in the order messages arrive, even when an emit is slow", async () => {
    const { gateways, ctx } = await startSource();
    const order: string[] = [];
    ctx.emit = async (event) => {
      const id = (event.payload as { id: string }).id;
      if (id.endsWith("1")) await new Promise((r) => setTimeout(r, 30));
      order.push(id);
    };
    gateways.latest.send({ id: "600000000000000001" });
    gateways.latest.send({ id: "600000000000000002" });
    await until(() => order.length === 2);
    expect(order).toEqual(["600000000000000001", "600000000000000002"]);
  });
});

describe("Discord source: approval buttons", () => {
  const approveId = approvalCustomId("appr_123", "approve");
  const rejectId = approvalCustomId("appr_123", "reject");

  it("decides for an approver, then shows the outcome and disables the buttons", async () => {
    const { gateways, ctx } = await startSource();
    const click = fakeClick(approveId, ALICE, "**Push branch**\n\nReview it in Sling: http://x");
    gateways.latest.handlers.button(click);
    await until(() => click.edits.length === 1);

    expect(ctx.decisions).toEqual([
      { approvalId: "appr_123", approve: true, actor: { via: "discord", externalUserId: ALICE } },
    ]);
    expect(ctx.refused).toEqual([]);
    expect(click.calls).toEqual(["acknowledge", "editMessage"]);
    const edit = click.edits[0];
    expect(edit?.content).toBe(
      `**Push branch**\n\nReview it in Sling: http://x\n\n✅ Approved by <@${ALICE}>`,
    );
    expect(edit?.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "Approve", custom_id: approveId, disabled: true },
          { type: 2, style: 4, label: "Reject", custom_id: rejectId, disabled: true },
        ],
      },
    ]);
  });

  it("passes a rejection through", async () => {
    const { gateways, ctx } = await startSource();
    const click = fakeClick(rejectId, ALICE, "Push?");
    gateways.latest.handlers.button(click);
    await until(() => click.edits.length === 1);
    expect(ctx.decisions[0]?.approve).toBe(false);
    expect(click.edits[0]?.content).toBe(`Push?\n\n❌ Rejected by <@${ALICE}>`);
  });

  it("refuses a click from someone who isn't an approver and reports it", async () => {
    // Bob may message the bot, but isn't an approver.
    const { gateways, ctx } = await startSource({ allowedUserIds: [ALICE, BOB] });
    const click = fakeClick(approveId, BOB);
    gateways.latest.handlers.button(click);
    await until(() => ctx.refused.length === 1);

    expect(ctx.decisions).toEqual([]);
    expect(ctx.refused[0]).toMatchObject({
      approvalId: "appr_123",
      approve: true,
      actor: { via: "discord", externalUserId: BOB },
    });
    expect(ctx.refused[0]?.reason).toMatch(/approver list/);
    expect(click.ephemeral).toEqual([REFUSED_REPLY]);
    expect(click.edits).toEqual([]);
  });

  it("says so privately when the approval was already decided", async () => {
    const { gateways, ctx } = await startSource({}, async () => ({
      ok: false,
      message: "This approval was already approved.",
    }));
    const click = fakeClick(approveId, ALICE);
    gateways.latest.handlers.button(click);
    await until(() => click.ephemeral.length === 1);

    expect(ctx.decisions).toHaveLength(1);
    expect(click.ephemeral).toEqual(["This approval was already approved."]);
    expect(click.edits).toEqual([]);
    expect(click.calls).toEqual(["acknowledge", "replyEphemeral"]);
  });

  it("tells the user when deciding throws", async () => {
    const { gateways } = await startSource({}, async () => {
      throw new Error("database down");
    });
    const click = fakeClick(approveId, ALICE);
    gateways.latest.handlers.button(click);
    await until(() => click.ephemeral.length === 1);
    expect(click.ephemeral[0]).toMatch(/couldn't record/);
    expect(click.edits).toEqual([]);
  });

  it("ignores buttons that aren't Sling approvals", async () => {
    const { gateways, ctx } = await startSource();
    const click = fakeClick("something:else", ALICE);
    gateways.latest.handlers.button(click);
    await settle();
    expect(click.calls).toEqual([]);
    expect(ctx.decisions).toEqual([]);
    expect(ctx.refused).toEqual([]);
  });
});

describe("Discord source: connection", () => {
  it("reports errors, retries with backoff, and connects", async () => {
    const gateways = new FakeGateways();
    gateways.loginErrors = [new Error("Discord rejected the bot token"), new Error("network")];
    const ctx = fakeSourceContext();
    const source = await createDiscordSource({ gateway: gateways.factory, backoff: fast }).start(
      ctx,
    );
    stops.push(() => source.stop());
    await until(() => ctx.statuses.some((s) => s.status === "connected"));

    expect(gateways.instances).toHaveLength(3);
    expect(gateways.instances.slice(0, 2).every((g) => g.destroyed)).toBe(true);
    expect(ctx.statuses.map((s) => s.status)).toEqual([
      "connecting",
      "error",
      "connecting",
      "error",
      "connecting",
      "connected",
    ]);
    expect(ctx.statuses[1]?.detail).toBe("Discord rejected the bot token");
  });

  it("reconnects after the gateway closes for good", async () => {
    const { gateways, ctx } = await startSource();
    const first = gateways.latest;
    first.handlers.closed("Discord closed the connection (code 4000)");
    await until(() => gateways.instances.length === 2 && gateways.latest.loggedIn);
    await until(() => ctx.statuses.filter((s) => s.status === "connected").length === 2);
    expect(first.destroyed).toBe(true);
    expect(ctx.statuses).toContainEqual({
      status: "error",
      detail: "Discord closed the connection (code 4000)",
    });

    // The new connection delivers messages; the old one's handlers are dead.
    first.send({ id: "600000000000000001" });
    gateways.latest.send({ id: "600000000000000002" });
    await until(() => ctx.emitted.length === 1);
    await settle();
    expect(payloads(ctx).map((p) => p.id)).toEqual(["600000000000000002"]);
  });

  it("maps the gateway's own reconnects to status updates", async () => {
    const { gateways, ctx } = await startSource();
    gateways.latest.handlers.status("reconnecting");
    gateways.latest.handlers.status("connected");
    expect(ctx.statuses.slice(-2)).toEqual([
      { status: "connecting", detail: "Reconnecting to Discord" },
      { status: "connected", detail: undefined },
    ]);
  });

  it("stops cleanly and doesn't reconnect", async () => {
    const { gateways, source } = await startSource();
    await source.stop();
    expect(gateways.latest.destroyed).toBe(true);
    await settle();
    expect(gateways.instances).toHaveLength(1);
  });

  it("stops when the server aborts the signal", async () => {
    const gateways = new FakeGateways();
    gateways.loginErrors = [new Error("down")];
    const ctx = fakeSourceContext();
    const source = await createDiscordSource({
      gateway: gateways.factory,
      backoff: { initialMs: 60_000, maxMs: 60_000 },
    }).start(ctx);
    await until(() => ctx.statuses.some((s) => s.status === "error"));
    ctx.controller.abort();
    // The long backoff sleep ends at once.
    await source.stop();
    expect(gateways.instances).toHaveLength(1);
  });
});
