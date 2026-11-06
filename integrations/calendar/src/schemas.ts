import { z } from "zod";

export const CONNECTOR_ID = "calendar";
export const MAX_FEEDS = 5;

/**
 * Stored encrypted and never sent back. A private iCal address works as a
 * password, so the links live here, not in the settings.
 */
export const credentialsSchema = z.object({
  password: z
    .string()
    .optional()
    .describe(
      "CalDAV only: an app password for the account. iCloud, Fastmail, and most providers don't accept your normal one",
    ),
  feedUrls: z
    .array(z.string().min(1))
    .max(MAX_FEEDS)
    .optional()
    .describe(
      "iCal links only: one to five private iCal addresses, such as Google Calendar's “Secret address in iCal format”",
    ),
});

export type CalendarCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z
  .object({
    kind: z
      .enum(["caldav", "ics"])
      .default("caldav")
      .describe(
        "caldav reads and adds events on a CalDAV account. ics reads iCal links, and can't add events",
      ),
    serverUrl: z
      .string()
      .default("")
      .describe(
        "CalDAV only: the server, for example https://caldav.icloud.com or https://caldav.fastmail.com",
      ),
    username: z
      .string()
      .default("")
      .describe("CalDAV only: the account's login, usually your email"),
    calendars: z
      .array(z.string().min(1))
      .default([])
      .describe("CalDAV only: the calendars to read, by name. Empty reads all of them"),
    defaultCalendar: z
      .string()
      .default("")
      .describe("CalDAV only: where new events go, by name. Empty uses the first calendar"),
    feedNames: z
      .array(z.string().min(1))
      .default([])
      .describe("iCal links only: a name for each link, in the same order, such as Work or Family"),
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
