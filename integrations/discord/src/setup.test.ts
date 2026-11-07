import { describe, expect, it } from "vitest";
import { ALICE, BOB, CHANNEL, fakeRest, GUILD } from "./fakes.ts";
import { discordSetup, inviteUrl } from "./setup.ts";

const APP = "800000000000000001";
const me = { status: 200, body: { id: "900000000000000001", username: "sling-bot", bot: true } };
const app = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    id: APP,
    flags: 1 << 19,
    owner: { id: ALICE, username: "alice", global_name: "Alice" },
    ...extra,
  },
});

const signal = () => new AbortController().signal;
const setup = (routes: Parameters<typeof fakeRest>[0], config = {}, token = "tok") =>
  discordSetup(fakeRest(routes).factory, { botToken: token }, config, signal());

describe("Discord setup", () => {
  it("points at the developer portal until there's a token", async () => {
    const out = await discordSetup(fakeRest({}).factory, {}, {}, signal());
    expect(out.notes).toEqual([
      expect.objectContaining({ field: "botToken", tone: "info", link: expect.anything() }),
    ]);
  });

  it("says when Discord refuses the token", async () => {
    const out = await setup({ "GET /users/@me": { status: 401, body: {} } });
    expect(out.notes).toEqual([
      expect.objectContaining({
        field: "botToken",
        tone: "error",
        text: "Discord doesn't accept this token.",
      }),
    ]);
  });

  it("lets only the owner in by default, and lists the channels it can post to", async () => {
    const out = await setup({
      "GET /users/@me": me,
      "GET /applications/@me": app(),
      "GET /users/@me/guilds": { status: 200, body: [{ id: GUILD, name: "Home" }] },
      [`GET /guilds/${GUILD}/channels`]: {
        status: 200,
        body: [
          { id: "2", name: "voice", type: 2, position: 0 },
          { id: CHANNEL, name: "general", type: 0, position: 1 },
          { id: "3", name: "news", type: 5, position: 0 },
        ],
      },
    });
    expect(out.name).toBe("sling-bot");
    expect(out.config).toEqual({ allowedUserIds: [ALICE], approverUserIds: [ALICE] });
    expect(out.options?.allowedUserIds).toEqual([
      { value: ALICE, label: "Alice", detail: "Owner" },
    ]);
    expect(out.options?.defaultChannelId).toEqual([
      { value: "3", label: "#news" },
      { value: CHANNEL, label: "#general" },
    ]);
    expect(out.notes).toEqual([{ field: "botToken", tone: "ok", text: "Connected as sling-bot" }]);
    expect(out.retryAfterMs).toBeUndefined();
  });

  it("keeps the people already picked, and offers a team's members", async () => {
    const out = await setup(
      {
        "GET /users/@me": me,
        "GET /applications/@me": app({
          team: {
            members: [
              { user: { id: ALICE, username: "alice" } },
              { user: { id: BOB, username: "bob" } },
            ],
          },
        }),
        "GET /users/@me/guilds": { status: 200, body: [{ id: GUILD, name: "Home" }] },
      },
      { allowedUserIds: [BOB], approverUserIds: [BOB] },
    );
    expect(out.config).toEqual({});
    expect(out.options?.approverUserIds?.map((o) => o.label)).toEqual(["alice", "bob"]);
  });

  it("links the invite while the bot is in no server, and looks again", async () => {
    const out = await setup({
      "GET /users/@me": me,
      "GET /applications/@me": app(),
      "GET /users/@me/guilds": { status: 200, body: [] },
    });
    expect(out.notes).toContainEqual(
      expect.objectContaining({ tone: "warn", link: { label: "Invite it", url: inviteUrl(APP) } }),
    );
    expect(inviteUrl(APP)).toContain(`client_id=${APP}&scope=bot`);
    expect(out.retryAfterMs).toBeGreaterThan(0);
  });

  it("links the bot settings while Message Content is off", async () => {
    const out = await setup({
      "GET /users/@me": me,
      "GET /applications/@me": app({ flags: 0 }),
      "GET /users/@me/guilds": { status: 200, body: [{ id: GUILD, name: "Home" }] },
    });
    expect(out.notes).toContainEqual(
      expect.objectContaining({
        tone: "warn",
        link: expect.objectContaining({
          url: `https://discord.com/developers/applications/${APP}/bot`,
        }),
      }),
    );
    expect(out.retryAfterMs).toBeGreaterThan(0);
  });
});
