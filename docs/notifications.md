# Notifications and the phone app

Sling's phone app is the web app, added to your home screen. There's nothing to download from an app store. Once it's installed, Sling can send push notifications to it, and to any desktop browser you turn them on in, even with Sling closed.

## Turning notifications on

Open **Settings → Notifications** on the device you want notified, and turn on **This device**. The browser asks once whether Sling may show notifications. Say yes, and the device shows up in the list under it, named after its browser, such as "Safari on iPhone" or "Chrome on Windows".

Each device in the list has two buttons:

- **Test** sends a notification to that device right away. If it doesn't arrive, the row says what the push service answered.
- **Remove** stops notifications to that device. Removing the device you're on also turns the switch off.

Do this on every device you want notified. Notifications go to all of them at once.

A device drops out of the list by itself when its push service says the subscription is gone, for example after you clear the browser's site data or uninstall the app, or after ten failed deliveries in a row. Turn it on again from that device to bring it back.

Changing `SLING_SECRET_KEY` changes the key Sling signs pushes with, so every device has to turn notifications on again, the same way webhook URLs change.

## iPhone and iPad

iOS only allows push notifications in web apps on the Home Screen, not in a Safari tab. In Safari, **Settings → Notifications** shows the steps instead of the switch:

1. Tap the Share button in Safari's toolbar.
2. Choose **Add to Home Screen**.
3. Open Sling from the Home Screen, go to **Settings → Notifications**, and turn on **This device**.

This needs iOS 16.4 or later. Android and desktop browsers can turn notifications on in a normal tab. Installing there is optional: Chrome and Edge offer **Install** in the address bar.

## HTTPS

Browsers only allow push and installing on HTTPS pages, or on `localhost` while you develop. Opened over plain HTTP at any other address, **Settings → Notifications** says so instead of showing the switch.

The [Tailscale and Cloudflare Tunnel setups](remote-access.md) both give Sling an HTTPS address, which is also what lets your phone reach it away from home.

## What notifies you

Under **Notify me about**, each person picks from three categories. All three start on.

| Category | When |
|---|---|
| Approvals | A task's push, pull request, merge, or deploy waits for your answer, or a task waits to run in a sandbox, or a workflow's approval step, or a command or a message the assistant wants to send in a chat |
| Finished tasks | A task succeeds, fails, or is delivered. A task you started from a chat in the app tells you through the assistant's reply instead, unless replies are off |
| Replies | The assistant replies in a chat that no open window of yours is showing |

A reply doesn't notify you when the chat is on screen in any of your windows. A chat in a background tab, a minimized window, or a phone with the app in the background still notifies.

Workflows can notify you with the **Notify my devices** step (`app.notify`). It always sends, whatever the categories say, and it sets its own urgency and how long the push service keeps trying a device that's off. The **Site down alert** template uses it.

## What a notification carries

A push holds a title, a line of text, and the page to open, at most 3 KB. That's the approval's or task's title, a chat's name, or what a workflow's step says. Sling never puts command output, task summaries, diffs, or what a message says in a push, because pushes pass through your browser maker's push service and show on your lock screen. Each push is encrypted for the one device it goes to (RFC 8291), so the push service can't read it.

Tapping a notification opens the page it's about in an open Sling window, or opens a new one:

- an approval opens **Approvals**
- a finished task opens the task
- a reply, or a command waiting in a chat, opens the chat
- a workflow's step opens whatever page it names, such as a new chat with a draft

Notifications have no buttons. You approve in the app, never from the lock screen.

A newer notification about the same task, approval, or chat replaces the older one, on the device and while it waits at the push service. You see "Delivered: Fix the footer" instead of a stale "Approve pull request?" above it.

## Where pushes go

Sling only accepts devices that use the browsers' own push services:

- `fcm.googleapis.com` (Chrome, and Chromium browsers on Android)
- `updates.push.services.mozilla.com` (Firefox)
- `web.push.apple.com` (Safari)
- `*.notify.windows.com` (Edge on Windows)

Anything else is refused, so a device subscription can't make Sling send requests to an address of someone's choosing. Sling sends to these services directly. There's no relay of Sling's own in between.

## Offline

The app keeps its built files and the last page shell it loaded, so the second start doesn't wait for the network. Everything it shows still comes from your server. Sling never caches anything from its API, so without a connection to your server the app opens but can't show your chats or tasks.
