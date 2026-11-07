import { z } from "zod";

export const CONNECTOR_ID = "calendar";
export const MAX_FEEDS = 5;

const ACCOUNT = { showWhen: { kind: "caldav" }, step: "Sign in" } as const;
const PICKED = { showWhen: { kind: "caldav" }, step: "Your calendars" } as const;
const LINKS = { showWhen: { kind: "ics" }, step: "Your iCal links" } as const;

/**
 * Stored encrypted and never sent back. A private iCal address works as a
 * password, so the links live here, not in the settings.
 */
export const credentialsSchema = z.object({
  password: z
    .string()
    .optional()
    .meta({ ...ACCOUNT, title: "Password", lookup: true, order: 2 }),
  feedUrls: z
    .array(z.string().min(1))
    .max(MAX_FEEDS)
    .optional()
    .meta({ ...LINKS, title: "iCal links", placeholder: "Paste a link", lookup: true, order: 1 }),
});

export type CalendarCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z
  .object({
    kind: z
      .union([
        z.literal("caldav").meta({
          title: "Calendar account",
          description: "Reads and adds events. iCloud, Fastmail, Nextcloud and most others.",
        }),
        z.literal("ics").meta({
          title: "iCal link",
          description: "Reads only. Google Calendar and Outlook.",
        }),
      ])
      .default("caldav")
      .meta({
        step: "How do you want to connect?",
        title: "Connect with",
        widget: "cards",
        lookup: true,
        order: 0,
      }),
    username: z
      .string()
      .default("")
      .meta({ ...ACCOUNT, title: "Email", placeholder: "you@icloud.com", lookup: true, order: 1 }),
    serverUrl: z
      .string()
      .default("")
      .meta({
        ...ACCOUNT,
        title: "Server",
        placeholder: "https://caldav.example.com",
        advanced: true,
        lookup: true,
        order: 3,
      }),
    calendars: z
      .array(z.string().min(1))
      .default([])
      .meta({ ...PICKED, title: "Calendars", picker: true, emptyMeansAll: true, order: 4 }),
    defaultCalendar: z
      .string()
      .default("")
      .meta({ ...PICKED, title: "New events go to", picker: true, order: 5 }),
    feedNames: z
      .array(z.string().min(1))
      .default([])
      .meta({ title: "Names, in the same order", hidden: true }),
  })
  .superRefine((c, ctx) => {
    if (c.kind !== "caldav") return;
    if (!c.serverUrl.trim()) {
      ctx.addIssue({ code: "custom", path: ["serverUrl"], message: "CalDAV needs the server URL" });
    } else if (!/^https?:\/\//i.test(c.serverUrl.trim())) {
      ctx.addIssue({
        code: "custom",
        path: ["serverUrl"],
        message: "Start the server URL with https://",
      });
    }
    if (!c.username.trim()) {
      ctx.addIssue({ code: "custom", path: ["username"], message: "CalDAV needs the username" });
    }
  });

export type CalendarConfig = z.infer<typeof configSchema>;
