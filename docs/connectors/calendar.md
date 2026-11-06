# Calendar

The calendar connector reads your events, and adds new ones. It works two ways:

- **CalDAV** reads and adds events on a calendar account: iCloud, Fastmail, Nextcloud, Radicale, Baïkal, and most others. It logs in with an app password.
- **iCal links** read up to five calendars from their private iCal address, such as Google Calendar's or Outlook's. They're read-only.

It runs inside the Sling server, like the email connector. Google's own API needs a Google Cloud project and OAuth, so Sling reads Google through the iCal address instead.

## Settings

Set **Kind** first. The rest of the fields depend on it.

| Field | Kind | What to put |
|---|---|---|
| Kind | both | `caldav` or `ics` |
| Server URL | caldav | The server, such as `https://caldav.fastmail.com`. A calendar's own URL works too, and then that's the only calendar |
| Username | caldav | Your login, usually your email address |
| Password | caldav | An app password. Stored encrypted and never shown again |
| Calendars | caldav | The calendars to read, by name. Empty reads all of them |
| Default calendar | caldav | Where new events go when a node doesn't say. Empty uses the first one |
| iCal links | ics | One to five private iCal addresses. `webcal://` links work. Stored encrypted, like a password |
| Feed names | ics | A name for each link, in the same order, such as `Work` or `Family`. Without one a link is called Calendar 1, Calendar 2, and so on |

**Test** logs in to CalDAV and lists the calendars it finds ("Found 3 calendars: Home, Work, Family"), and checks that the calendars you named are there. For iCal links it fetches and parses each one ("142 events").

## iCloud

1. Sign in at [account.apple.com](https://account.apple.com), open **Sign-In and Security**, then **App-Specific Passwords**, and create one.
2. Use server URL `https://caldav.icloud.com`, your Apple ID email as the username, and the app-specific password.

## Fastmail

1. In Fastmail, open **Settings**, **Privacy & Security**, and create an app password with CalDAV access.
2. Use server URL `https://caldav.fastmail.com` and your Fastmail address.

## Nextcloud

1. In Nextcloud, open **Personal settings**, **Security**, and create an app password.
2. Use server URL `https://<your server>/remote.php/dav`.

## Google Calendar and Outlook

These are read-only, from the calendar's private address:

- **Google Calendar:** on the web, open **Settings**, pick the calendar under **Settings for my calendars**, then **Integrate calendar**, and copy **Secret address in iCal format**. Each calendar has its own address.
- **Outlook:** open **Settings**, **Calendar**, **Shared calendars**, and under **Publish a calendar** pick the calendar and **Can view all details**. Copy the ICS link.

Anyone who has the address can read the calendar, which is why Sling stores it with the credentials. If one leaks, reset it in Google or Outlook and paste the new one.

## Time zones

"Today" means today in the workspace's time zone, which you set under **Settings → General**. Times in events come out with that zone's offset, such as `2026-11-06T09:30:00+00:00` in Lisbon in winter.

Events keep the time zone they were made in. A meeting at 09:00 in New York shows at 14:00 in Lisbon, and a daily standup at 09:30 stays at 09:30 across a daylight saving change. Times with no zone at all, which some calendars use for things like "lunch at noon wherever I am", count as the workspace's zone.

## Nodes

**List calendar events** reads a range of days.

| Setting | Meaning |
|---|---|
| From | `today`, `tomorrow`, or a date such as `2026-11-06` |
| Days | How many days, 1 to 31 |
| Calendars | Only these calendars, by name. Empty reads every calendar the installation includes |

It outputs:

- `events`, sorted by start. Each has `title`, `start`, `end`, `allDay`, `location`, `description` (the first 500 characters), and `calendar`. A timed event's start and end are times with an offset. An all-day event's are dates, and `end` is its last day.
- `agenda`, the same events as plain text, one section per day, ready for a prompt.
- `date`, the first day it read, as `YYYY-MM-DD`.

Recurring events are expanded within the range. Skipped instances (EXDATE) are left out, moved or changed ones show as changed, and cancelled ones are dropped. A read returns at most 2,000 events; the agenda says when there were more.

**Add calendar event** adds an event to a CalDAV calendar.

| Setting | Meaning |
|---|---|
| Calendar | By name. Empty uses the default calendar |
| Title | What it's called |
| Start | `2026-11-06T14:00` in the workspace's time zone, or with an offset such as `2026-11-06T14:00:00+01:00`. A date for an all-day event |
| End | The same form. Empty uses Duration. For an all-day event, its last day, or empty for one day |
| Duration minutes | How long it lasts when End is empty. 60 by default |
| All day | A whole-day event, such as a holiday |
| Location, Description | Optional |

Its output is the `event`, with its `uid`, and `created`, which is false when the event was already there.

Each node run makes the same event UID every time, and Sling asks the server to store it only if nothing has that name yet (`If-None-Match: *`). So a retry, or a run repeated after a restart, never adds a second copy. Events are written in UTC, which every calendar app shows in its own zone.

## The assistant

Both nodes are tools for the assistant when the personality has **Apps and workflows**. Reading the calendar never asks. Adding an event asks you in the chat first in Supervised and Auto, runs at once in Full access, and is refused in Read-only.

## Limits

- Each request to a calendar server times out after 10 seconds, and a feed or CalDAV answer over 5 MB is refused.
- iCal links are fetched at most every five minutes. After that Sling asks again with the feed's ETag, and keeps what it parsed when the feed hasn't changed. Google refreshes its iCal feeds on its own schedule, which can lag by hours.
- CalDAV reads are always current. For a day it read before, Sling asks the calendar whether anything changed (its ctag), which costs one small request, and reads the events again only if something did.
- The list of an account's calendars is kept for five minutes. A calendar added since is found the first time a node asks for it by name.
