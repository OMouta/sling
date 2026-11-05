/**
 * The Discord gateway behind a narrow interface. The event source only sees
 * plain messages and button clicks, so tests can drive it with a fake.
 */
import {
  type ButtonInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  Partials,
} from "discord.js";
import type { ActionRow } from "./approval.ts";

export interface GatewayMessage {
  id: string;
  channelId: string;
  /** Null in direct messages. */
  guildId: string | null;
  author: { id: string; username: string; bot: boolean };
  /** Sent by Discord itself, for example a pin notice. */
  system: boolean;
  content: string;
  mentionedUserIds: string[];
  mentionedRoleIds: string[];
  /** The bot's own role in the message's server, which people sometimes mention instead. */
  botRoleId: string | null;
  createdAt: Date;
}

export interface ButtonClick {
  customId: string;
  user: { id: string; username: string };
  message: { id: string; channelId: string; content: string };
  /** Tells Discord the click arrived, so the rest can take longer than its 3-second limit. */
  acknowledge(): Promise<void>;
  /** A reply only the clicking user sees. */
  replyEphemeral(content: string): Promise<void>;
  /** Replaces the content and components of the message the button is on. */
  editMessage(edit: { content: string; components: ActionRow[] }): Promise<void>;
}

export interface GatewayHandlers {
  message(message: GatewayMessage): void;
  button(click: ButtonClick): void;
  /** The connection dropped and is reconnecting by itself, or it came back. */
  status(state: "connected" | "reconnecting"): void;
  /** The connection is gone and won't come back. Make a new gateway to continue. */
  closed(reason: string): void;
  error(error: Error): void;
}

export interface DiscordGateway {
  /** Connects, and resolves once Discord says the bot is ready. */
  login(token: string, signal: AbortSignal): Promise<{ botUserId: string; username: string }>;
  destroy(): Promise<void>;
}

export type GatewayFactory = (handlers: GatewayHandlers) => DiscordGateway;

const LOGIN_TIMEOUT_MS = 60_000;

/** Why Discord closed the gateway, for close codes it won't reconnect after. */
export function closeReason(code: number): string {
  switch (code) {
    case 4004:
      return "Discord rejected the bot token";
    case 4013:
      return "Discord rejected the requested gateway intents";
    case 4014:
      return "The Message Content intent is off. Turn it on under Bot > Privileged Gateway Intents in the Discord developer portal";
    default:
      return `Discord closed the connection (code ${code})`;
  }
}

export const createDiscordJsGateway: GatewayFactory = (handlers) => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Direct message channels aren't cached, so without this partial DMs never arrive.
    partials: [Partials.Channel],
    allowedMentions: { parse: ["users"] },
  });
  let ready = false;

  client.on(Events.MessageCreate, (message) => handlers.message(toGatewayMessage(message)));
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isButton()) handlers.button(toButtonClick(interaction));
  });
  client.on(Events.ShardReconnecting, () => {
    if (ready) handlers.status("reconnecting");
  });
  client.on(Events.ShardResume, () => handlers.status("connected"));
  client.on(Events.ShardReady, () => {
    if (ready) handlers.status("connected");
  });
  client.on(Events.ShardDisconnect, (event) => handlers.closed(closeReason(event.code)));
  client.on(Events.Invalidated, () => handlers.closed("Discord invalidated the session"));
  client.on(Events.Error, (error) => handlers.error(error));
  client.on(Events.ShardError, (error) => handlers.error(error));

  return {
    login(token, signal) {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          client.off(Events.ClientReady, onReady);
          client.off(Events.ShardDisconnect, onDisconnect);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onReady = (c: Client<true>) => {
          cleanup();
          ready = true;
          resolve({ botUserId: c.user.id, username: c.user.username });
        };
        // discord.js doesn't always reject login() for close codes it won't retry.
        const onDisconnect = (event: { code: number }) => fail(new Error(closeReason(event.code)));
        const onAbort = () => fail(new Error("Stopped"));
        const timer = setTimeout(
          () => fail(new Error("Timed out waiting for Discord to accept the connection")),
          LOGIN_TIMEOUT_MS,
        );
        signal.addEventListener("abort", onAbort, { once: true });
        client.once(Events.ClientReady, onReady);
        client.on(Events.ShardDisconnect, onDisconnect);
        client.login(token).catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
    async destroy() {
      await client.destroy();
    },
  };
};

function toGatewayMessage(message: Message): GatewayMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    author: {
      id: message.author.id,
      username: message.author.username,
      bot: message.author.bot,
    },
    system: message.system,
    content: message.content,
    mentionedUserIds: [...message.mentions.users.keys()],
    mentionedRoleIds: [...message.mentions.roles.keys()],
    botRoleId: message.guild?.members.me?.roles.botRole?.id ?? null,
    createdAt: message.createdAt,
  };
}

function toButtonClick(interaction: ButtonInteraction): ButtonClick {
  return {
    customId: interaction.customId,
    user: { id: interaction.user.id, username: interaction.user.username },
    message: {
      id: interaction.message.id,
      channelId: interaction.channelId,
      content: interaction.message.content,
    },
    async acknowledge() {
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    },
    async replyEphemeral(content) {
      const reply = { content, flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
      else await interaction.reply(reply);
    },
    async editMessage({ content, components }) {
      // After deferUpdate, the interaction's original message is the one the button is on.
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, components });
      } else {
        await interaction.update({ content, components });
      }
    },
  };
}
