/**
 * Checking that an added event is there: the calendar is asked for it again,
 * by the UID it was stored under, and the check says which calendar it's in.
 */
import type { NodeContext, NodeVerifyArgs, VerifyResult } from "@sling/connector-sdk";
import { calendarsOf, type DavCalendar, getEvent } from "./caldav.ts";
import { accountOf, type Parsed, parseInstallation } from "./calendar.ts";
import { CONNECTOR_ID } from "./schemas.ts";

interface AddedEvent {
  uid?: unknown;
  calendar?: unknown;
  start?: unknown;
  allDay?: unknown;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 9 Nov 10:00" from the event's start as the node gave it, in its own zone. */
export function whenText(start: unknown, allDay: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(start ?? ""));
  if (!m) return "";
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const date = `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
  return allDay || !m[4] ? date : `${date} ${m[4]}:${m[5]}`;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function onCalDav(
  p: Parsed,
  event: AddedEvent & { uid: string },
  signal: AbortSignal,
): Promise<VerifyResult> {
  const account = accountOf(p);
  const all = await calendarsOf(account, signal);
  const wanted = String(event.calendar ?? "");
  const calendar: DavCalendar | undefined = wanted
    ? all.find((c) => sameName(c.name, wanted))
    : all[0];
  if (!calendar) {
    return { state: "failed", message: `${p.name} has no calendar called ${wanted} any more` };
  }
  const ics = await getEvent(account, calendar, `${event.uid}.ics`, signal);
  if (!ics?.includes(event.uid)) {
    return { state: "failed", message: `The event isn't in ${calendar.name}` };
  }
  const when = whenText(event.start, event.allDay === true);
  return { state: "passed", message: `In ${calendar.name}${when ? `, ${when}` : ""}` };
}

/** Reads an added event back from the calendar it went to. */
export async function verifyEvent(
  ctx: NodeContext,
  args: NodeVerifyArgs<{ installationId: string }>,
): Promise<VerifyResult> {
  const event = args.outputs.event as AddedEvent | undefined;
  const uid = typeof event?.uid === "string" ? event.uid : "";
  if (!event || !uid) {
    return { state: "unchecked", message: "The calendar didn't say which event it added" };
  }
  const installation = await ctx.installation(args.config.installationId);
  if (installation.connectorId !== CONNECTOR_ID) {
    return { state: "unchecked", message: `${installation.name} isn't a calendar` };
  }
  const p = parseInstallation(installation);
  if (p.config.kind === "caldav") return onCalDav(p, { ...event, uid }, ctx.signal);
  return { state: "unchecked", message: `${p.name} can't be read back` };
}
