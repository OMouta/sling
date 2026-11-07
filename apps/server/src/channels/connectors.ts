/**
 * The iMessage and Signal connectors. Neither app has an API Sling can call,
 * so an installation names one of your machines and a channel it relays,
 * and the machine does the reading and sending. The setup offers the
 * machines that have the channel, so nothing is typed.
 */
import {
  type AnyConnector,
  defineConnector,
  NodeError,
  type NodeSpec,
  type SetupNote,
  type SetupOption,
  type SetupResult,
} from "@sling/connector-sdk";
import type { ChannelKind, ChannelView } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { hostOf } from "../workflows/connectors/setup.ts";
import {
  type ChannelInstallationConfig,
  type ChannelMessageView,
  MAX_CHANNEL_TEXT,
} from "./service.ts";
import { plainText } from "./text.ts";

interface Kind {
  id: ChannelKind;
  name: string;
  description: string;
  /** What the machine is called in the setup: a Mac, for iMessage. */
  machine: string;
  /** What to run on it to add the channel. */
  add: string;
  /** What the app is called when it took a message. */
  service: string;
  /** One message, as people say it: "iMessage", "Signal message". */
  message: string;
  /** With its article. */
  aMessage: string;
}

const KINDS: Record<ChannelKind, Kind> = {
  imessage: {
    id: "imessage",
    name: "iMessage",
    description: "Message Sling from iMessage, through your Mac.",
    machine: "Mac",
    add: "sling-runner channel add imessage",
    service: "Messages",
    message: "iMessage",
    aMessage: "an iMessage",
  },
  signal: {
    id: "signal",
    name: "Signal",
    description: "Message Sling on Signal, through signal-cli on one of your machines.",
    machine: "machine",
    add: "sling-runner channel add signal --account <number>",
    service: "Signal",
    message: "Signal message",
    aMessage: "a Signal message",
  },
};

/** How soon the form looks again while it waits on something done on the machine. */
const RECHECK_MS = 5_000;

const credentialsSchema = z.object({});

function configSchemaFor(k: Kind) {
  const step = `Which ${k.machine}?`;
  return z.object({
    runnerId: z
      .string()
      .min(1)
      .meta({ step, title: k.machine === "Mac" ? "Mac" : "Machine", picker: true, lookup: true }),
    channel: z
      .string()
      .min(1)
      .meta({ step, title: "Channel", picker: true, advanced: true, lookup: true }),
  });
}

interface Machine {
  id: string;
  name: string;
  online: boolean;
  channels: ChannelView[];
}

/** The workspace's paired machines that relay this kind of channel, by name. */
async function machinesWith(ctx: AppContext, workspaceId: string, kind: ChannelKind) {
  const rows = await ctx.db
    .select({
      id: schema.runners.id,
      name: schema.runners.name,
      online: schema.runners.online,
      channels: schema.runners.channels,
    })
    .from(schema.runners)
    .where(
      and(
        eq(schema.runners.workspaceId, workspaceId),
        isNull(schema.runners.revokedAt),
        eq(schema.runners.ephemeral, false),
      ),
    )
    .orderBy(asc(schema.runners.name));
  return rows
    .map((r) => ({ ...r, channels: r.channels.filter((c) => c.kind === kind) }))
    .filter((r): r is Machine => r.channels.length > 0);
}

const senders = (n: number) => (n === 1 ? "1 sender allowed" : `${n} senders allowed`);

function channelDetail(c: ChannelView): string {
  // The whole of what's missing shows as a note once it's picked.
  if (!c.ready) return "Not ready";
  return c.allowedSenders === 0 ? "No senders allowed yet" : senders(c.allowedSenders);
}

function machineDetail(m: Machine): string {
  if (!m.online) return "Offline";
  if (m.channels.length > 1) return `${m.channels.length} channels`;
  const [c] = m.channels;
  return c ? channelDetail(c) : "";
}

async function setup(
  ctx: AppContext,
  k: Kind,
  lookup: { config: Partial<ChannelInstallationConfig> },
): Promise<SetupResult<Record<string, never>, ChannelInstallationConfig>> {
  const host = hostOf(lookup);
  if (!host) return {};
  const machines = await machinesWith(ctx, host.workspaceId, k.id);
  if (machines.length === 0) {
    return {
      notes: [{ tone: "info", text: `On your ${k.machine}, run \`${k.add}\`` }],
      retryAfterMs: RECHECK_MS,
    };
  }
  const options: Record<string, SetupOption[]> = {
    runnerId: machines.map((m) => ({ value: m.id, label: m.name, detail: machineDetail(m) })),
  };
  const out: SetupResult<Record<string, never>, ChannelInstallationConfig> = { options };
  const picked =
    machines.find((m) => m.id === lookup.config.runnerId) ??
    (machines.length === 1 ? machines[0] : undefined);
  if (!picked) return out;
  const config: Partial<ChannelInstallationConfig> = {};
  if (lookup.config.runnerId !== picked.id) config.runnerId = picked.id;
  // With one channel there's nothing to pick, so no picker shows.
  if (picked.channels.length > 1) {
    options.channel = picked.channels.map((c) => ({
      value: c.name,
      label: c.name,
      detail: channelDetail(c),
    }));
  }
  const channel =
    picked.channels.find((c) => c.name === lookup.config.channel) ??
    (picked.channels.length === 1 ? picked.channels[0] : undefined);
  if (channel && lookup.config.channel !== channel.name) config.channel = channel.name;
  out.config = config;
  out.name = `${k.name} on ${picked.name}`;
  if (!channel) {
    out.reveal = ["channel"];
    return out;
  }
  const notes: SetupNote[] = [];
  // Under the channel when there's a choice of them, else under the machine.
  const about = options.channel ? "channel" : "runnerId";
  if (!picked.online) {
    notes.push({
      field: "runnerId",
      tone: "info",
      text: `${picked.name} is offline. Messages wait there until it's back.`,
    });
  } else if (!channel.ready) {
    notes.push({ field: about, tone: "warn", text: channel.missing || "Not ready yet." });
    out.retryAfterMs = RECHECK_MS;
  }
  if (channel.allowedSenders === 0) {
    notes.push({
      field: about,
      tone: "warn",
      text: `It answers no one yet. On ${picked.name}, run \`sling-runner channel allow ${channel.name} <your number>\``,
    });
    out.retryAfterMs = RECHECK_MS;
  }
  out.notes = notes;
  return out;
}

async function test(ctx: AppContext, k: Kind, run: { config: unknown }) {
  const host = hostOf(run);
  const config = configSchemaFor(k).safeParse(run.config);
  if (!config.success)
    return { ok: false as const, error: `Pick the ${k.machine} that relays ${k.name}.` };
  if (!host) return { ok: true as const };
  const [machine] = await ctx.db
    .select()
    .from(schema.runners)
    .where(
      and(
        eq(schema.runners.id, config.data.runnerId),
        eq(schema.runners.workspaceId, host.workspaceId),
        isNull(schema.runners.revokedAt),
      ),
    );
  if (!machine) return { ok: false as const, error: "That machine isn't paired with Sling." };
  const channel = machine.channels.find((c) => c.kind === k.id && c.name === config.data.channel);
  if (!channel) {
    return {
      ok: false as const,
      error: `${machine.name} has no ${k.name} channel named ${config.data.channel}. Run \`${k.add}\` there.`,
    };
  }
  if (machine.online && !channel.ready) {
    return {
      ok: false as const,
      error: channel.missing || `${k.name} isn't ready on ${machine.name}.`,
    };
  }
  const notes = [`Relayed by ${machine.name}.`];
  if (!machine.online) notes.push("It's offline right now.");
  if (channel.allowedSenders === 0) {
    notes.push(
      `No senders allowed yet: run \`sling-runner channel allow ${channel.name} <number>\` there.`,
    );
  }
  return { ok: true as const, detail: notes.join(" ") };
}

// ---------------------------------------------------------------- nodes

function messageReceived(k: Kind): NodeSpec<{ installationId: string; senders: string[] }> {
  const event = `${k.id}.message_received`;
  const configSchema = z.object({
    installationId: z
      .string()
      .min(1)
      .describe(`${k.name} account whose messages start the workflow`),
    senders: z
      .array(z.string())
      .default([])
      .describe("Only messages from these senders. Leave empty for everyone the machine allows."),
  });
  return {
    type: event,
    version: 1,
    title: `${k.message} received`,
    description: `Fires when someone the machine allows sends ${k.aMessage}, one to one or in a group.`,
    category: "trigger",
    connector: k.id,
    configSchema,
    installationFields: ["installationId"],
    inputs: [],
    outputs: [{ name: "message", type: "channel.message", label: "Message" }],
    execInput: false,
    execOutputs: [{ name: "next" }],
    idempotent: true,
    trigger: {
      event,
      match(e, raw) {
        if (e.type !== event) return null;
        const config = configSchema.safeParse(raw);
        if (!config.success) return null;
        if (e.installationId && e.installationId !== config.data.installationId) return null;
        const message = e.payload as ChannelMessageView;
        if (!message || typeof message.conversation !== "string") return null;
        const only = config.data.senders.map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (only.length > 0 && !only.includes(message.sender.toLowerCase())) return null;
        return {
          outputs: { message },
          concurrencyKey: `${k.id}:${config.data.installationId}:${message.conversation}`,
        };
      },
    },
  };
}

interface SendConfig {
  installationId: string;
  conversation: string;
  text: string;
}

function sendMessage(ctx: AppContext, k: Kind): NodeSpec<SendConfig> {
  const configSchema = z.object({
    installationId: z.string().min(1).describe(`${k.name} account that sends it`),
    conversation: z
      .string()
      .default("")
      .describe(
        "Who to send to: a phone number with its country code, an email address, or a group's ID from a received message. Leave empty to send to the one sender the machine allows.",
      ),
    text: z
      .string()
      .default("")
      .meta({ widget: "textarea" })
      .describe(
        "Message text. A value on the text input replaces it. Markdown is sent as plain text.",
      ),
  });
  return {
    type: `${k.id}.send_message`,
    version: 1,
    title: `Send ${k.message}`,
    description: `Sends ${k.aMessage} from your ${k.machine}, to someone it allows or a group they wrote in.`,
    category: "action",
    connector: k.id,
    configSchema,
    expressionFields: ["conversation", "text"],
    installationFields: ["installationId"],
    inputs: [
      {
        name: "text",
        type: "string",
        label: "Text",
        description: "Message text. Replaces the text setting when connected.",
        required: false,
      },
    ],
    outputs: [{ name: "machine", type: "string", label: "Machine" }],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: false,
    assistant: {
      sends: true,
      summary: `${k.name} to {conversation}: {text}`,
      ruleFields: ["conversation"],
    },
    async run(node, { inputs, config: raw }) {
      const config = configSchema.safeParse(raw);
      if (!config.success) {
        throw new NodeError(`Invalid settings: ${config.error.message}`, {
          code: "invalid_config",
        });
      }
      const inst = await node.installation<Record<string, never>, ChannelInstallationConfig>(
        config.data.installationId,
      );
      if (inst.connectorId !== k.id) {
        throw new NodeError(`Installation ${inst.name} isn't a ${k.name} account`, {
          code: "wrong_installation",
        });
      }
      const where = configSchemaFor(k).safeParse(inst.config);
      if (!where.success) {
        throw new NodeError(`${inst.name} names no machine. Edit it on the Connectors page.`, {
          code: "invalid_installation",
        });
      }
      const typed = typeof inputs.text === "string" ? inputs.text : config.data.text;
      const text = plainText(typed);
      if (!text) throw new NodeError("The message is empty", { code: "empty_message" });
      const cut = text.length > MAX_CHANNEL_TEXT ? `${text.slice(0, MAX_CHANNEL_TEXT - 1)}…` : text;
      const answer = await ctx.channels.send(node.workspaceId, {
        runnerId: where.data.runnerId,
        channel: where.data.channel,
        conversation: config.data.conversation.trim(),
        text: cut,
        signal: node.signal,
      });
      if (!answer.ok) throw new NodeError(answer.message, { code: "channel_send_failed" });
      node.log.info(`Sent ${k.aMessage}`, { machine: answer.machine });
      return { exec: "next", outputs: { machine: answer.machine ?? "" } };
    },
    // Neither app says more than that it took the message.
    async verify(_node, { outputs }) {
      const machine =
        typeof outputs.machine === "string" && outputs.machine ? ` on ${outputs.machine}` : "";
      return { state: "passed", message: `${k.service}${machine} took it` };
    },
  };
}

function channelConnector(ctx: AppContext, k: Kind): AnyConnector {
  const configSchema = configSchemaFor(k);
  return defineConnector<Record<string, never>, ChannelInstallationConfig>({
    id: k.id,
    name: k.name,
    description: k.description,
    credentialsSchema: credentialsSchema as z.ZodType<Record<string, never>>,
    secretFields: [],
    configSchema,
    test: (run) => test(ctx, k, run),
    setup: (lookup) => setup(ctx, k, lookup),
    nodes: [messageReceived(k), sendMessage(ctx, k)],
  });
}

/** The connectors for the channels machines relay, bound to this server. */
export function channelConnectors(ctx: AppContext): AnyConnector[] {
  return [channelConnector(ctx, KINDS.imessage), channelConnector(ctx, KINDS.signal)];
}
