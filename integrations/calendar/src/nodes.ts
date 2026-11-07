import { type NodeContext, NodeError, type NodeSpec } from "@sling/connector-sdk";
import { z } from "zod";
import { addEvent, readEvents } from "./calendar.ts";
import type { FeedCache } from "./feeds.ts";
import { CONNECTOR_ID } from "./schemas.ts";
import { addDays, dateIn, isZone } from "./zone.ts";

/**
 * What the server running a node may offer. The calendar runs in Sling's own
 * process, where the engine gives every node the workspace's time zone.
 */
interface CalendarServices {
  timeZone?: () => Promise<string>;
}

/** The workspace's time zone, or UTC when the server doesn't say. */
export async function zoneOf(ctx: NodeContext): Promise<string> {
  const services = ctx.services as CalendarServices | null | undefined;
  const zone = await services?.timeZone?.();
  return isZone(zone) ? zone : "UTC";
}

const FROM = /^(today|tomorrow|\d{4}-\d{2}-\d{2})$/;

/** The first day to read, as YYYY-MM-DD in `zone`. */
export function resolveFrom(from: string, zone: string, now = Date.now()): string {
  const v = from.trim().toLowerCase();
  const today = dateIn(now, zone);
  if (v === "" || v === "today") return today;
  if (v === "tomorrow") return addDays(today, 1);
  // addDays normalizes, so a date that doesn't exist, such as 2026-02-30, comes back changed.
  if (!FROM.test(v) || addDays(v, 0) !== v) {
    throw new NodeError(
      `${from} isn't a date. Use today, tomorrow, or a date such as 2026-11-06.`,
      {
        code: "invalid_config",
      },
    );
  }
  return v;
}

export const listConfigSchema = z.object({
  installationId: z.string().min(1).describe("Calendar installation to read"),
  from: z
    .string()
    .trim()
    .regex(FROM, "Use today, tomorrow, or a date such as 2026-11-06")
    .default("today")
    .describe(
      "The first day: today, tomorrow, or a date such as 2026-11-06, in the workspace's time zone",
    ),
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(31)
    .default(1)
    .describe("How many days to read, 1 to 31"),
  calendars: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Only these calendars, by name. Empty reads every calendar the installation includes",
    ),
});

export type ListConfig = z.infer<typeof listConfigSchema>;

export const createConfigSchema = z.object({
  installationId: z.string().min(1).describe("CalDAV installation to add the event to"),
  calendar: z
    .string()
    .default("")
    .describe("The calendar, by name. Empty uses the installation's default calendar"),
  title: z.string().min(1).max(500).describe("What the event is called"),
  start: z
    .string()
    .min(10)
    .describe(
      "When it starts, such as 2026-11-06T14:00 in the workspace's time zone, or with an offset like 2026-11-06T14:00:00+01:00. A date such as 2026-11-06 for an all-day event",
    ),
  end: z
    .string()
    .default("")
    .describe(
      "When it ends, in the same form. Empty uses durationMinutes. For an all-day event, its last day, or empty for one day",
    ),
  durationMinutes: z.coerce
    .number()
    .int()
    .min(1)
    .max(14 * 24 * 60)
    .default(60)
    .describe("How long it lasts, when end is empty"),
  allDay: z.boolean().default(false).describe("A whole-day event, such as a holiday or a trip"),
  location: z.string().max(500).default("").describe("Where it happens"),
  description: z.string().max(8_000).default("").meta({ widget: "textarea" }).describe("Notes"),
});

export type CreateConfig = z.infer<typeof createConfigSchema>;

export function createListEvents(feeds: FeedCache): NodeSpec<ListConfig> {
  return {
    type: "calendar.list_events",
    version: 1,
    title: "List calendar events",
    description:
      "Reads the events in a range of days, with recurring events expanded, in the workspace's time zone. Also gives an agenda as plain text for a prompt.",
    category: "action",
    connector: CONNECTOR_ID,
    configSchema: listConfigSchema,
    expressionFields: ["from"],
    installationFields: ["installationId"],
    inputs: [],
    outputs: [
      { name: "events", type: "list<json>", label: "Events" },
      { name: "agenda", type: "string", label: "Agenda" },
      { name: "date", type: "string", label: "First day (YYYY-MM-DD)" },
    ],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: true,
    retry: { maxAttempts: 3, backoffMs: 2_000 },
    assistant: { sends: false, summary: "Read calendar from {from}" },

    async run(ctx, { config: raw }) {
      const parsed = listConfigSchema.safeParse(raw);
      if (!parsed.success) {
        throw new NodeError(`Invalid settings: ${parsed.error.issues[0]?.message}`, {
          code: "invalid_config",
        });
      }
      const config = parsed.data;
      const installation = await ctx.installation(config.installationId);
      if (installation.connectorId !== CONNECTOR_ID) {
        throw new NodeError(`Installation ${installation.name} isn't a calendar`, {
          code: "wrong_installation",
        });
      }
      const timeZone = await zoneOf(ctx);
      const from = resolveFrom(config.from, timeZone);
      const result = await readEvents(installation, {
        from,
        days: config.days,
        timeZone,
        calendars: config.calendars,
        signal: ctx.signal,
        feeds,
      });
      return {
        exec: "next",
        outputs: { events: result.events, agenda: result.agenda, date: from },
      };
    },
  };
}

export const createEvent: NodeSpec<CreateConfig> = {
  type: "calendar.create_event",
  version: 1,
  title: "Add calendar event",
  description:
    "Adds an event to a CalDAV calendar. Running it again with the same run and node adds nothing, so a retry never duplicates the event.",
  category: "action",
  connector: CONNECTOR_ID,
  configSchema: createConfigSchema,
  expressionFields: ["calendar", "title", "start", "end", "location", "description"],
  installationFields: ["installationId"],
  inputs: [],
  outputs: [
    { name: "event", type: "json", label: "Event" },
    { name: "created", type: "boolean", label: "Created (false when it was already there)" },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  // The UID comes from the idempotency key and the PUT never overwrites, so a repeat is safe.
  idempotent: true,
  retry: { maxAttempts: 3, backoffMs: 2_000 },
  assistant: {
    sends: true,
    summary: 'Add "{title}" to your calendar, {start}',
    ruleFields: ["calendar"],
  },

  async run(ctx, { config: raw }) {
    const parsed = createConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new NodeError(`Invalid settings: ${parsed.error.issues[0]?.message}`, {
        code: "invalid_config",
      });
    }
    const config = parsed.data;
    const installation = await ctx.installation(config.installationId);
    if (installation.connectorId !== CONNECTOR_ID) {
      throw new NodeError(`Installation ${installation.name} isn't a calendar`, {
        code: "wrong_installation",
      });
    }
    const added = await addEvent(installation, config, {
      idempotencyKey: ctx.idempotencyKey,
      timeZone: await zoneOf(ctx),
      signal: ctx.signal,
    });
    ctx.log.info(added.created ? "Added an event" : "The event was already there", {
      uid: added.event.uid,
    });
    return { exec: "next", outputs: { event: added.event, created: added.created } };
  },
};
