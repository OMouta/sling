/**
 * Discord's setup lookup. From the bot token alone it finds the bot's name,
 * who owns it, the servers it's in and the channels it can post to, and
 * links straight to the invite or the setting that's still missing.
 */
import type { SetupNote, SetupOption, SetupResult } from "@sling/connector-sdk";
import { errorMessage } from "./backoff.ts";
import { describeError, field, isOk, type RestFactory } from "./rest.ts";
import type { DiscordConfig, DiscordCredentials } from "./schemas.ts";

export const PORTAL_URL = "https://discord.com/developers/applications";

/** View Channels, Send Messages and Read Message History: what posting and approvals need. */
export const INVITE_PERMISSIONS = String((1 << 10) | (1 << 11) | (1 << 16));

const GATEWAY_MESSAGE_CONTENT = 1 << 19;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 18;
/** Text and announcement channels. */
const POSTABLE = new Set([0, 5]);
/** More servers than this and the channel list stops being a list anyone reads. */
const MAX_GUILDS = 10;
/** How soon to look again while the bot waits on something done in Discord. */
const RECHECK_MS = 4_000;

export function inviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${INVITE_PERMISSIONS}`;
}

const tokenHelp: SetupNote = {
  field: "botToken",
  tone: "info",
  text: "Copy it from your app's Bot page.",
  link: { label: "Developer portal", url: PORTAL_URL },
};

interface Person {
  id: string;
  username: string;
}

function person(v: unknown): Person | null {
  const id = field(v, "id");
  const username = field(v, "global_name") ?? field(v, "username");
  return typeof id === "string" && typeof username === "string" ? { id, username } : null;
}

/** The app's owner, or its team's members when a team owns it. */
function ownersOf(app: unknown): Person[] {
  const team = field(app, "team");
  const members = field(team, "members");
  if (Array.isArray(members)) {
    return members.map((m) => person(field(m, "user"))).filter((p): p is Person => p !== null);
  }
  const owner = person(field(app, "owner"));
  return owner ? [owner] : [];
}

export async function discordSetup(
  rest: RestFactory,
  credentials: Partial<DiscordCredentials>,
  config: Partial<DiscordConfig>,
  signal: AbortSignal,
): Promise<SetupResult<DiscordCredentials, DiscordConfig>> {
  const token = (credentials.botToken ?? "").trim();
  if (!token) return { notes: [tokenHelp] };
  const client = rest(token);
  try {
    const me = await client.request("GET", "/users/@me", undefined, signal);
    if (me.status === 401) {
      return {
        notes: [{ ...tokenHelp, tone: "error", text: "Discord doesn't accept this token." }],
      };
    }
    if (!isOk(me))
      return { notes: [{ field: "botToken", tone: "error", text: describeError(me) }] };
    const app = await client.request("GET", "/applications/@me", undefined, signal);
    if (!isOk(app)) {
      return { notes: [{ field: "botToken", tone: "error", text: describeError(app) }] };
    }
    const appId = String(field(app.body, "id") ?? "");
    const botName = String(field(me.body, "username") ?? "the bot");
    const out: SetupResult<DiscordCredentials, DiscordConfig> = { name: botName, notes: [] };
    const notes = out.notes as SetupNote[];
    notes.push({ field: "botToken", tone: "ok", text: `Connected as ${botName}` });

    const flags = Number(field(app.body, "flags") ?? 0);
    if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) === 0) {
      notes.push({
        tone: "warn",
        text: "Turn on Message Content Intent so the bot can read messages.",
        link: { label: "Open bot settings", url: `${PORTAL_URL}/${appId}/bot` },
      });
      out.retryAfterMs = RECHECK_MS;
    }

    const owners = ownersOf(app.body);
    if (owners.length > 0) {
      const people: SetupOption[] = owners.map((p) => ({
        value: p.id,
        label: p.username,
        detail: owners.length === 1 ? "Owner" : "Team",
      }));
      out.options = { allowedUserIds: people, approverUserIds: people };
      const mine = owners.map((p) => p.id);
      out.config = {
        ...((config.allowedUserIds ?? []).length === 0 ? { allowedUserIds: mine } : {}),
        ...((config.approverUserIds ?? []).length === 0 ? { approverUserIds: mine } : {}),
      };
    }

    const guilds = await client.request("GET", "/users/@me/guilds", undefined, signal);
    const list = isOk(guilds) && Array.isArray(guilds.body) ? guilds.body : [];
    if (list.length === 0) {
      notes.push({
        tone: "warn",
        text: `Add ${botName} to a server so it can post and get messages.`,
        link: { label: "Invite it", url: inviteUrl(appId) },
      });
      out.retryAfterMs = RECHECK_MS;
      return out;
    }
    const channels: SetupOption[] = [];
    for (const g of list.slice(0, MAX_GUILDS)) {
      const id = String(field(g, "id") ?? "");
      const guildName = String(field(g, "name") ?? "");
      const res = await client.request("GET", `/guilds/${id}/channels`, undefined, signal);
      if (!isOk(res) || !Array.isArray(res.body)) continue;
      const postable = res.body
        .filter((c) => POSTABLE.has(Number(field(c, "type"))))
        .sort((a, b) => Number(field(a, "position") ?? 0) - Number(field(b, "position") ?? 0));
      for (const c of postable) {
        channels.push({
          value: String(field(c, "id")),
          label: `#${String(field(c, "name") ?? "")}`,
          ...(list.length > 1 ? { detail: guildName } : {}),
        });
      }
    }
    if (channels.length > 0) out.options = { ...out.options, defaultChannelId: channels };
    return out;
  } catch (error) {
    return {
      notes: [
        {
          field: "botToken",
          tone: "error",
          text: `Couldn't reach Discord: ${errorMessage(error)}`,
        },
      ],
    };
  }
}
