# Calendar

The calendar connector reads your events, and adds new ones. It works three ways:

- **CalDAV** reads and adds events on a calendar account: iCloud, Fastmail, Nextcloud, Radicale, Baïkal, and most others. It logs in with an app password.
- **Google Calendar** reads and adds events through Google's API. You make the OAuth client in your own Google Cloud project, and connect through Google's consent screen.
- **iCal links** read up to five calendars from their private iCal address, such as Outlook's or Google Calendar's. They're read-only.

It runs inside the Sling server, like the email connector.

## Adding a calendar

The first step asks how to connect: **Calendar account** for CalDAV, **Google Calendar**, or **iCal link** for read-only links.

**Calendar account** asks you to sign in with your email and an app password:

- iCloud, Fastmail and Yahoo servers are known already, and the form links to where each makes app passwords.
- For other domains, Sling looks up the domain's CalDAV server in DNS (`_caldavs._tcp`), the way calendar apps do. If there's none, a **Server** field shows up, such as `https://<your server>/remote.php/dav` for Nextcloud. A calendar's own URL works too, and then that's the only calendar.
- Once the password works, your calendars show up as checkboxes, all ticked, and **New events go to** picks where nodes add events. A login that fails says so under the password.

**iCal link** takes one to five private addresses; `webcal://` links work. Each is named after the calendar it serves, and the form says if one can't be read.

**Add** checks it all again before saving, and offers **Add anyway** if that fails.

## Google Calendar

Google needs an OAuth client of your own. Sling doesn't have one, so your calendar data goes from Google to your Sling server and nowhere else.

1. In [Google Cloud](https://console.cloud.google.com/), make a project, or pick one.
2. Turn on the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) for it.
3. Under **Google Auth Platform**, set up the consent screen. Pick **External**, and add your own Google account as a test user.
4. Under **Clients**, make a client of type **Web application**. Add the redirect URI the setup form shows, `<your Sling address>/api/oauth/google/callback`. It works on `http://localhost` too.
5. Copy the client ID and secret into the form, and pick **Connect**.

Google shows its consent screen and asks to let Sling see and edit your events. After you allow it, you're back on **Connectors**, and Sling runs the connection test. Edit the calendar to pick which calendars it reads and where new events go. Without a choice, it reads all of them and adds to your own.

Sling keeps the refresh token encrypted, like other credentials, and gets a new access token when the one it has expires within a minute. If Google stops accepting the sign-in, such as after you remove Sling's access in your Google account, the calendar shows **Connect** again.

While the consent screen is in testing, Google ends the sign-in after 7 days. Publish the app on the consent screen's page to keep it, or connect again when it stops.

## Nextcloud

In Nextcloud, open **Personal settings**, **Security**, and make an app password. If the form can't find the server, use `https://<your server>/remote.php/dav`.

## iCal links

These are read-only, from the calendar's private address:

- **Google Calendar:** on the web, open **Settings**, pick the calendar under **Settings for my calendars**, then **Integrate calendar**, and copy **Secret address in iCal format**. Each calendar has its own address.
- **Outlook:** open **Settings**, **Calendar**, **Shared calendars**, and under **Publish a calendar** pick the calendar and **Can view all details**. Copy the ICS link.

Typing a Google or Outlook address under **Calendar account** points you to the other choices. Anyone who has the address can read the calendar, which is why Sling stores it with the credentials. If one leaks, reset it in Google or Outlook and paste the new one.

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

**Add calendar event** adds an event to a CalDAV or Google calendar.

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

Each node run makes the same event UID every time, and Sling asks the server to store it only if nothing has that name yet (`If-None-Match: *`). On Google, the event's ID comes from the run the same way, and Google refuses a second event with it. So a retry, or a run repeated after a restart, never adds a second copy. Events are written in UTC, which every calendar app shows in its own zone. On Google they also carry the workspace's time zone.

When the assistant adds an event to Google from a chat, Sling reads it back by its ID, and the chat says which calendar it's in and when, such as "In Work, Thu 12 Nov 15:00".

## The assistant

Both nodes are tools for the assistant when the personality has **Apps and workflows**. Reading the calendar never asks. Adding an event asks you in the chat first in Supervised and Auto, runs at once in Full access, and is refused in Read-only.

## Limits

- Each request to a calendar server times out after 10 seconds, and a feed or CalDAV answer over 5 MB is refused.
- iCal links are fetched at most every five minutes. After that Sling asks again with the feed's ETag, and keeps what it parsed when the feed hasn't changed. Google refreshes its iCal feeds on its own schedule, which can lag by hours.
- CalDAV reads are always current. For a day it read before, Sling asks the calendar whether anything changed (its ctag), which costs one small request, and reads the events again only if something did.
- The list of an account's calendars is kept for five minutes. A calendar added since is found the first time a node asks for it by name.
- Google's recurring events come expanded from Google. Sling asks for the calendar list each time, so a Google calendar added since shows up at once.
