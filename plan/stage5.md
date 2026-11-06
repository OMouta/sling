# Stage 5 build plan

Deploys and everyday help, from your phone. This is spec section 15, Stage 5, with the choices in `decisions.md` applied (D72 to D81 are new for this stage).

## Status (2026-11-06)

W0 to W6 are built and on `main`. The contracts went in first: core views, the `RepoAction` messages, migration `0009_deploys`, SDK 1.1.0, the deploy and push service slots, and `app.notify`. Five parallel workstreams followed: Runner, server deploys, calendar and apps, push and the installed app, and the web UI. Each was cherry-picked onto `main`. Integration then ran against a preview server with its own database and Runner, a real GitHub repo, and a real CalDAV server.

| "Done when" item | Verified by |
|---|---|
| 1. Deploy targets | `deploys.e2e` (CRUD, checks, each method). In the browser: the Deploys page, and the dialog for each method, including a repo no machine has a deploy command for |
| 2. Incident to deploy, in Auto | `deploys.e2e` on the real `sling-runner` and `fake-codex`, once per method. **Live**, in the preview, in one chat: the assistant (Claude Code, Haiku 5.5) checked Website and saw the 500, then delegated to Codex (GPT-6-Luna, low) with `deploy`. The Runner pushed and opened real PR #1 on a private GitHub repo. "Approve deployment?" showed in the chat and on **Approvals**, and I approved it in the browser. The machine merged it with `gh`. Verify passed in 12 s, with the version URL showing `5699841`, and the assistant reported it. The push for the approval is covered by `push.e2e`, not checked on a device |
| 3. The other modes | `deploys.e2e`: Supervised asks twice, the deploy only after the PR; Read-only is refused; Full access doesn't ask |
| 4. A deploy that doesn't fix it | `deploys.e2e`: verify fails with each check's result, and the update says so |
| 5. The machine's own limits | Rust tests for every guard, against real repos with bare remotes, plus the refusals in `deploys.e2e` on the real Runner |
| 6. A real merge | Live, above: GitHub reports the PR `MERGED`, and `main` is `5699841 Fix wrong year in website footer (#1)` |
| 7. Deploy later | `deploys.e2e`, plus DOM tests for **Deploy** and its 409 |
| 8. Site down alert | The template and `deploys.check` in `deploys.e2e`. In the preview: with the template on, a target pointed at a dead URL went down after two checks, and its notify step ran with "Couldn't reach it". In the browser: the alert's link opened a new chat with Incident and the draft. Not checked on a device |
| 9. Calendar | `calendar.integration` against Radicale 3.8.3.0: discovery, recurring events across the October clock change, create, and an idempotent repeat. Also a local iCal server with ETag. In the preview: the connection test said "Found 2 calendars: Home, Work." |
| 10. Morning briefing | `apps.e2e`, on its schedule, with the mock model. Not run live |
| 11. The assistant uses your apps | `apps.e2e` in every mode, against GreenMail and the fake Discord: allow, deny, expire, `run_workflow`, the audit rows, and ntfy's publish as a tool, on both the in-process and the real extension runtime. **Live:** the assistant read tomorrow's calendar without asking, added an event after **Allow** (it's in Radicale), and added nothing after **Deny**. In the browser: the ntfy install dialog lists "Publish to ntfy", marked Sends |
| 12. Push | `push.e2e` against a local push endpoint: every category, each payload decrypted with the subscription's key, and a 410 removing the subscription. Unit tests check RFC 8291's worked example byte for byte. In the browser: a push delivered over DevTools became the right notification in the service worker. Headless Chromium denies notifications, so `showNotification` was stubbed. Not checked against a real push service or device |
| 13. Installable | DevTools, with a production build: no manifest or installability errors. The second start's navigation came from the service worker, and its caches held no `/api` entries |
| 14. Checked in a browser | Playwright against the preview at 1440×900 and 390×844, in dark and light. Pages: Deploys; the target dialog for all three methods; task steps and "Approve deployment?" in the chat and on Approvals; the task page; send approvals pending, allowed, and denied; Settings → General and Notifications; Connectors with the calendar; the personality form's tool groups; the ntfy install dialog; and the alert's link |

Test counts on `main`:
- **Unit:** 937 in TypeScript across 17 packages, and 205 in Rust (1 live test ignored).
- **Integration:** 8 against Radicale and 12 against GreenMail.
- **End to end:** 205 across 12 suites, with 67 in three new ones: deploys 39, push 14, apps 14. The extension and apps suites also pass on real extension processes, 29 and 14.
- **Live:**
  - 9 real CLI turns, none in fast mode: 8 chat turns on Claude Code with Haiku 5.5, and 1 Codex task on GPT-6-Luna at low effort. One chat turn was cut off when the Mac slept, and one ran on a session started before a prompt fix.
  - 1 real GitHub PR merged, on a private throwaway repo.

| Budget | Measured |
|---|---|
| Approval to `RepoAction` sent, p95 | 12.4 to 13.4 ms |
| Verify sees a site come back | 10.0 to 11.0 s after it answered |
| Hook step overhead | 9 to 15 ms, median about 10 |
| Push, event to request at the push service, p95 | 1.7 to 3.7 ms |
| Push encryption per message | 75 to 77 µs |
| Today's events from 1,000 CalDAV events, repeat read | 63 to 65 ms median |
| Same, first read of a day | **508 to 525 ms, over budget.** Radicale's own REPORT is 397 to 407 ms of it |
| Parse a 1 MB iCal feed and read a day | 24 to 34 ms median |
| Tool layer per connector action | 0.8 to 0.9 ms median |
| Second start from the cached shell, 4× CPU slowdown | 87 to 104 ms, median 95; the cold first load is 269 ms |
| Service worker and manifest | 5.2 KB |
| Web bundle growth, gzipped | 23.3 KB JS and 0.3 KB CSS (396.2 to 419.5 KB JS) |

Found and fixed during integration:
- **The Runner scanned the whole home folder before connecting.** On this Mac that took over 20 seconds, so three end-to-end suites hung. It now connects first and scans after.
- **Verify ran two rounds at once.** A round against a hanging site waits out its 10-second timeout, so two down sites could hold up a third deploy's check. It now runs eight.
- **Deploys showed "Down" after a verified deploy.** The page now shows the newer of the target's last check and the last verify. The alert still compares against its own checks.
- **The assistant asked in its reply instead of calling the send tool.** The prompt now says to call the tool and let Sling ask.
- **A send's approval didn't show an email's body.** It now lists every value that would go out. Its summary writes dates as "Sat 7 Nov, 18:00", and its wording ("Allow this?") fits events and messages as well as email.
- **Task summaries showed raw Markdown,** with links to files in the agent's worktree. They now render, with those links as code.
- **The server ignored each repo's deploy timeout.** The Runner reports it (`Repo.deploy_timeout_seconds`); the server stores it (migration `0010_deploy_timeout`) and waits that long.
- **Tasks didn't carry their repo's remote,** so the web app guessed a task's target. `TaskView.remoteKey` makes it exact.
- **The calendar card** had the plug icon and said "Not listening". `ConnectorView.hasSource` hides that for connectors that never listen, and the calendar gets its own icon.
- **A finished chat task sent two pushes,** "Done" and then the reply. Now it sends one, the reply, unless replies are off.
- **The Command method left an empty panel** before a repo was picked. It now shows the machine picker, disabled.
- **The apps suite passed only on the in-process stand-in.** Its loopback ntfy needs `localNetwork` on the real runtime.
- **The Mac slept twice during the checks.** Both Runners dropped at the same second, and the power log shows "Wake from Deep Idle". `caffeinate` kept it awake after that.
- **Found by the workstreams themselves:**
  - a step sent to the Runner before it was marked `sent`, so a fast Runner left it stuck
  - ical.js's event constructor scanning every sibling event, which made a feed quadratic (330 ms to 25 ms)
  - CLI tool call IDs taken from Fastify request IDs, which start over on restart and would have broken idempotency keys
  - presence sent on connect, which was lost before the socket's session check finished
  - the test Runner's close handler stopping a newer connection's heartbeat

Not done or not verified yet:
- **A real push service and a real phone.** No subscription went through Apple's or Google's push service. On an iPhone, the Home Screen install, the safe areas, and tapping a notification are unchecked. Needs the app on an HTTPS address (Tailscale or Cloudflare Tunnel) and a phone.
- **The first CalDAV read of a day is over budget.** About 400 ms of the 520 ms is Radicale answering the REPORT. iCloud and Fastmail may be faster or slower, and haven't been tried.
- **Real calendars and hosts.** No iCloud, Fastmail, Google, or Outlook calendar, and no live deploy hook or deploy command against a real host. Both methods ran against local stand-ins only.
- **Merging a sandbox's PR through GitHub's API** has run against a fake API only.
- **The Morning briefing at its time,** with a real model.
- **The revert flow live.** The assistant offering a revert after a failed verify is in the prompt, but no real turn has shown it.
- **A Runner restarted mid-deploy** loses the result it hadn't sent, and doesn't stop the command's process group.
- **Windows** kills a deploy's direct child only, after 5 seconds.
- **Linux and Windows end to end,** and CI, since the repo has no remote.
- **The throwaway repo** `OMouta/sling-deploy-check-11062152` still exists: `gh` lacks the `delete_repo` scope. Deleting it needs `gh auth refresh -h github.com -s delete_repo`, then `gh repo delete OMouta/sling-deploy-check-11062152 --yes`.
- **Smaller gaps:**
  - a target with one check says "Not checked yet" twice on its card
  - a chat's Claude Code session keeps the system prompt it started with, so prompt changes reach new chats only
  - PR checks before the deploy approval, and GitHub deployment statuses, are out of scope

## Goal

Two people use Sling from a phone. The first is away from their desk when their site goes down. Their phone buzzes, they tap the alert, and they tell Sling to fix it. Sling checks the site, hands the fix to a coding agent on their machine, and asks "Approve deployment?" once the PR is open. After they approve, Sling merges, deploys, checks that the site is back, and says so.

The second never touches a coding agent. Sling reads their calendar, writes them a briefing every morning, and sends messages or creates events from chat, asking first.

The phone app is the web app, installed to the home screen, with push notifications. There is no native app.

## Done when

1. **Deploy targets.** On the new **Deploys** page you add a target for a repo with each of the three methods: the host deploys on merge, a command on a machine, and a deploy hook. The command method offers only machines that report a deploy command for that repo, and shows the `sling-runner` line that sets one. **Check now** shows each health check's status and time.
2. **Incident to deploy, in Auto.** A local test site answers 500. In chat, "the site is down, fix it":
   - the assistant checks the target and sees the 500
   - it delegates the fix with `deliver: "deploy"`
   - the task pushes and opens its PR on its own
   - "Approve deployment?" shows in the chat, on **Approvals**, and as a push notification
   - after approval, Sling merges, deploys, and verifies: the site answers 200 and the version URL shows the merged commit
   - the assistant reports that the fix is live and verified

   This passes once for each method.
3. **The other modes.** In Supervised you approve push and PR first, and the deploy approval comes only after the PR exists. Read-only can't deliver a deploy. Full access deploys without asking.
4. **A deploy that doesn't fix it.** The deploy succeeds but the site still answers 500. The task shows verification failed with each check's result, the conversation's update says so, and the assistant offers a revert task.
5. **The machine's own limits.** The Runner refuses each of these, and the task shows the reason:
   - merging a branch that isn't a Sling task branch
   - deploying a commit that isn't on the remote's default branch
   - any merge or deploy on a machine set to `deploys off`
   - deploying a repo with no deploy command set on that machine
   - any merge or deploy on a machine whose `max-mode` is Read-only
6. **A real merge.** On a private throwaway GitHub repo, a task delivered with `deploy` opens a real PR, and Sling merges it through the machine's `gh` login. The merged commit is on `main`.
7. **Deploy later.** A delivered PR task whose repo has a target shows **Deploy**. It runs merge, deploy, and verify after approval. The assistant does the same with `deploy_task`.
8. **Site down alert.** With the **Site down alert** template on, a target that fails two checks in a row sends a push notification. Tapping it opens a new chat with the Incident personality and a draft that says what failed. Recovery sends "back up".
9. **Calendar.** A CalDAV installation (Radicale in a container) and an iCal-link installation both pass their connection test. `calendar.list_events` returns today's events in the workspace's time zone, recurring events included. `calendar.create_event` writes an event to CalDAV, and running it again with the same idempotency key doesn't add a second one.
10. **Morning briefing.** With the template on, at its time Sling starts that day's briefing chat, the assistant writes the briefing from the calendar, and a push notification opens the chat.
11. **The assistant uses your apps.** In chat:
    - reading the calendar never asks
    - sending email or a Discord message, creating an event, or running a workflow that has side effects asks inline in Supervised and Auto, runs at once in Full access, and is refused in Read-only
    - denying means nothing is sent
    - `run_workflow` runs a workflow with a manual trigger and returns its result
    - every call is audited

    An extension's node flagged for the assistant works the same way (ntfy's publish), and its install dialog lists it.
12. **Push.** You turn notifications on for a device under **Settings → Notifications**. Approvals, finished tasks, replies to a chat you aren't looking at, and `app.notify` nodes reach it. Payloads are encrypted for the device, and an endpoint outside the known push services is refused. Removing a device stops its pushes, and a subscription the push service reports gone is removed.
13. **Installable.** Chromium's installability check passes. In standalone mode the layout keeps clear of the notch and the home indicator. The second start loads the app shell from cache. Nothing under `/api` is ever cached.
14. **Checked in a browser**, at desktop and phone width, in dark and light:
    - **Deploys** and the target dialog
    - the task's merge, deploy, and verify steps, and the deploy approval in chat and on **Approvals**
    - send approvals in chat
    - **Settings → Notifications** and the time zone
    - the calendar connector
    - the personality tool groups

## Out of scope

- Showing a PR's CI checks before the deploy approval. GitHub's branch protection still applies when Sling merges.
- Reading GitHub deployment statuses to learn when a host finished deploying. The version URL covers that.
- Automatic rollback. The way back is a revert task, which the assistant offers and you approve.
- Deploying from a branch other than the default, more than one target per repo, and deploys that run as Sling workflows.
- Google Calendar through OAuth, calendar triggers such as "event starting soon", and reading email from chat.
- A native app, and approving from a notification's own buttons.
- Offline use beyond the cached shell.
- Starting an investigation on its own when a site goes down.
- Pinning a personality in an `agent.assistant` node.

## Deploys (D72)

`deliver` gains `deploy`. A deploy delivery runs these steps, each a row in `actions`:

```text
push → open_pr → merge → deploy → verify
```

- **On merge.** A target whose host deploys on merge has no `deploy` step: merge, then verify.
- **Approval.** The mode decides what asks, as it does today. Supervised asks before push, PR, merge, and deploy. Auto asks before merge and deploy. Full access asks for nothing, and Read-only can't deliver a deploy.
- **When it asks.** Merge and deploy rows start as `queued`. When the steps reach merge, the server creates their approvals and the rows move to `awaiting_approval`. So in Supervised the first **Approve** covers push and PR. The second, "Approve deployment?", comes after the PR exists and links to it.
- **One answer.** Merge and deploy keep one approval each, so the audit shows both. **Approve** decides both at once, as it does for push and PR.
- **Only the default branch deploys.** A deploy always deploys the merged commit on the remote's default branch, never a task branch.
- **No target, no deploy.** `deliver: "deploy"` on a repo without a target is refused at create, with the reason.
- **Deploy later.** `POST /api/tasks/:id/deploy`, the **Deploy** button, and the assistant's `deploy_task` add merge, deploy, and verify to a task whose PR step succeeded. The steps start from merge, as above.

## Deploy targets (D73)

A deploy target is one repo that Sling knows how to deploy and check. It lives in the control plane, one per repo per workspace, keyed by the normalized remote, like the sandbox list.

| Field | Holds |
|---|---|
| `name` | What you call it, for example "Website". Unique in the workspace |
| `remoteKey` | `host/owner/name` |
| `method` | `merge`, `command`, or `hook` |
| `mergeMethod` | `squash` (default), `merge`, or `rebase` |
| `runnerId` | The machine that runs the command, for `command` |
| `hook` | `{ url, httpMethod, headerName?, headerValue? }`, stored encrypted and never sent back to the browser, for `hook` |
| `checks` | 1 to 5 of `{ url, status?, contains? }` |
| `versionUrl` | Optional. A URL whose body shows the deployed commit |
| `settleSeconds` | Wait before the first check. Default 60 for `merge`, else 0 |
| `timeoutSeconds` | How long verify keeps trying. Default 600, at most 3,600 |
| `lastCheck` | `{ at, up, failures, results[] }` |

- **The command lives on the machine.** `sling-runner repo set site deploy-command "fly deploy"` sets it, and `deploy-timeout` sets its limit (default 15 minutes). The Runner reports the command in its inventory. The control plane picks which machine runs it and can't change what runs.
- **Hooks.** The control plane calls the hook with the chosen method, a 30-second timeout, and the optional header. Any 2xx counts as accepted. The first 1 KB of the answer goes in the step's message.
- **Checks.** A check is a GET with a 10-second timeout, up to 5 redirects, no cookies, and `User-Agent: Sling health check`.
  - It passes when the status matches. With no `status` set, anything from 200 to 399 matches.
  - With `contains` set, the first 1 MB of the body must also contain the text.
  - Checks may reach private addresses, because only you set their URLs. The assistant names a target, never a URL.

## Merging and deploying on a machine (D74)

**Where the merge runs:**
- **A task that ran on a machine.** That machine merges. When it's offline, another online machine with the same repo merges. With none online, the step waits and the task says which machines could take it.
- **A task that ran in a sandbox.** For a GitHub PR, the control plane merges through GitHub's REST API with the workspace's GitHub token, the one sandboxes use. Without a token, a machine with the repo merges.
- **A command deploy.** The target's machine runs it. When it's offline, the step waits.

The control plane sends `RepoAction` to the machine, which isn't tied to the task's spool, so any machine with the repo can take it.

**Merge on a machine:**
- **With a PR.** When the PR URL is a GitHub PR and `gh auth status` passes, the Runner checks the PR's head and base with `gh pr view <url>` from outside the repo, then runs `gh pr merge <url>` with the target's merge method. A PR that's already merged returns its merge commit, so asking twice is safe.
- **Without a PR or `gh`.** The Runner fetches, makes a temporary detached worktree at the default branch, and squash-merges (or merges) the task branch. The commit carries a `Sling-Task: <id>` trailer. It then pushes `HEAD` to the default branch, never forced, and retries once after a fetch if the push is refused because the branch moved.
  - **Rebase** falls back to squash here, and the step's message says so.
  - **Conflicts** abort the merge, and the step fails with the files that conflict.
  - **Before merging**, it looks for the trailer on the remote's default branch, so asking twice is safe here too.

**Deploy command on a machine:**
- The Runner fetches, checks that the commit is on the remote's default branch, and makes a temporary detached worktree at that commit.
- It runs the repo's deploy command there through the user's login shell, outside the sandbox, with the user's environment minus `SLING_*`, plus `SLING_DEPLOY_COMMIT` and `SLING_DEPLOY_REPO`.
- Output streams back redacted, capped at 256 KB. At the timeout the Runner kills the command's process group.
- It removes the worktree afterwards.

**What the Runner refuses, whatever the control plane says:**
- a merge or deploy with `sling-runner config set deploys off`
- a merge or deploy when `max-mode` is Read-only
- merging a branch that isn't a Sling task branch, or a PR whose head or base doesn't match
- deploying a commit that isn't on the remote's default branch
- deploying a repo with no deploy command
- force-pushing, ever

**Results.** The Runner keeps a result until the server acknowledges it, and sends it again after a reconnect. A server that restarts while a hook call is in flight marks the step "interrupted, outcome unknown" and never calls the hook again on its own. A machine step with no answer by its timeout plus a minute ends the same way.

## Verify (D75)

- **The job.** Verify is a pg-boss job, so it survives restarts. It waits `settleSeconds`, then checks every 10 seconds until every check passes and, when `versionUrl` is set, its body contains the merged commit (full or the first 7 characters). If that doesn't happen within `timeoutSeconds`, verify fails.
- **What it records.** Every check's last status, time, and error; whether the version URL showed the commit; how many attempts it took; and how long.
- **Saying what it knows.** Without a version URL, the step's message says that the site answered, but that Sling can't tell which version answered.
- **On failure.** The task's update tells the conversation that verification failed and what each check saw. The prompt has the assistant offer a revert task: a coding task that reverts the merged commit, delivered with `deploy`, which asks for approval like any other. Nothing rolls back on its own.
- **Spec scenario B.** A passing test isn't treated as success. The task counts as fixed only when verify passes.

## Watching a site (D76)

Watching runs as a workflow, like everything else that runs on a schedule.

- **The node.** `deploys.check` checks every target, or the one named in its config. It saves each target's `lastCheck` and outputs the targets whose state changed. A target goes down after two failed checks in a row and comes back up after one pass.
- **The template.** **Site down alert** checks every minute and sends an `app.notify` for each change:
  - **Down:** "Website is down: 502" opens a new chat with the Incident personality and a draft such as "Website is down (502 since 14:02). Find out why and fix it."
  - **Back up:** "Website is back up."
- **New chat links.** `/?draft=…&personality=incident` opens the new chat screen with that personality and the draft in the composer. `personality` takes an ID, a template key, or a name, and falls back to the default.
- **Nothing starts on its own.** The draft waits for you to send it. Sling never starts an investigation or a fix by itself.

## Calendar (D77)

A built-in connector in `integrations/calendar`, running in the server process like email.

| Kind | Credentials | Config |
|---|---|---|
| `caldav` | password (an app password) | server URL, username, calendars to include, default calendar for new events |
| `ics` | one to five iCal URLs (a private address is a secret) | names for each |

- **Test.** CalDAV finds the principal and the calendar home, and lists the calendars: "Found 3 calendars: Home, Work, Family". An iCal link fetches and parses: "142 events".
- **`calendar.list_events`.** Reads events. Config: `from` (a date, `today`, or `tomorrow`), `days` (1 to 31), and optional calendar names. Outputs `events`, each with title, start, end, all-day, location, description (first 500 characters), and calendar, sorted by start. It also outputs `agenda`, plain text for a prompt.
  - Recurring events are expanded within the range, with exceptions and cancelled instances.
  - It reads every calendar.
  - "Today" is in the workspace's time zone.
- **`calendar.create_event`.** CalDAV only. Config: calendar, title, start, end or duration, all-day, location, description. The event's UID comes from the idempotency key, and the PUT sends `If-None-Match: *`, so a second run creates nothing.
- **Libraries.** ical.js parses events and expands recurrences, and fast-xml-parser reads CalDAV's XML. There's no CalDAV client library.
- **Limits.** 5 MB per iCal feed, 2,000 events per query, 10 seconds per request. Feeds are cached for 5 minutes by ETag.

## The assistant uses your apps (D78)

- **Which nodes.** A node opts in with `assistant` in its spec (SDK 1.1.0, an addition):

  ```ts
  assistant?: { sends: boolean; summary?: string }
  ```

  `sends` says whether it reaches outside Sling. `summary` is a template such as `"Email {to}: {subject}"`, filled from the call's arguments for the approval and the audit. Only nodes with an exec input and no wait can opt in.
- **What's flagged.** Built in: `calendar.list_events` (doesn't send), and `calendar.create_event`, `email.send`, and `discord.send_message` (send). ntfy 1.1.0 flags `ntfy.publish`.
- **Extensions.** What an extension adds carries the flag. The install and update dialogs list the nodes the assistant may use, and which of them send.
- **Tools.** Each flagged node with at least one enabled installation becomes a tool named after its type, with dots as underscores: `calendar_list_events`, `email_send`. The arguments are the node's config fields and input ports, minus installation fields. An `installation` argument (an enum of names) appears when there's more than one.
  - **Values are literal.** Nothing from the model is evaluated as an expression.
  - **Context.** The node runs with an idempotency key of `chat:<toolCallId>`.
  - **Scrubbing.** Credentials are scrubbed from its output, as in workflow runs.
  - **Limit.** At most 30 such tools per turn.
- **`run_workflow`.** Takes `workflow`, an enum of enabled workflows with a manual trigger, and `input`. It starts a run, waits up to 60 seconds, and returns what the run's Return node gave. If the run is still going after that, it returns the run's state and a link. A workflow counts as sending when any node in its active version isn't idempotent.
- **Asking first.** Asked 2026-11-06.
  - **Reads** never ask.
  - **Sends** are refused in Read-only, ask inline in Supervised and Auto, and run at once in Full access.
  - **The approval** works the way command approvals do today: in the server's memory, tied to one conversation, and gone after 5 minutes. It shows the filled summary.
  - **Denied or expired** means nothing ran, and the tool tells the model not to look for another way.
- **Audit.** `assistant.action`, with the node type, installation, conversation, summary, decision, and whether it worked.
- **The group.** The personality tool group `apps` covers these tools and `run_workflow` (D81).

## Push and install (D79)

**The app:**
- **Manifest.** `manifest.webmanifest`, with `display: standalone`, theme colors for light and dark, and icons at 192, 512, and maskable 512, plus a 180 px `apple-touch-icon`.
- **Viewport.** `viewport-fit=cover`. The shell, the sidebar, and the composer pad by `env(safe-area-inset-*)`.
- **Service worker.** `sw.js`, registered in secure contexts only.
  - **Built assets.** Production builds cache `/assets/*` first, since their names are hashed.
  - **The shell** is served from cache, then refreshed in the background.
  - **Never cached:** `/api`, the socket, and Vite's dev paths. The registration says whether to cache at all, so a dev server never serves a stale shell.
  - **Cleanup.** On activate it keeps the assets of the last two builds.
- **iOS.** Push works there only from the home screen. **Settings → Notifications** says how to add Sling to it when the page runs in Safari.

**Push:**
- **Keys.** The VAPID key pair comes from `SLING_SECRET_KEY` through HKDF, so there's nothing new to store. Changing the secret key means each device turns notifications on again, as webhook URLs change today.
- **Encryption.** In-house, per RFC 8291 (`aes128gcm`) and RFC 8292 (VAPID), using `node:crypto`. Tests check it against the RFC's worked example. There's no `web-push` dependency.
- **Where pushes go.** Subscriptions are accepted only for HTTPS endpoints on known push services:
  - `fcm.googleapis.com`
  - `updates.push.services.mozilla.com`
  - `web.push.apple.com`
  - `*.notify.windows.com`
- **Headers.** `TTL` (24 hours for approvals, 1 hour for tasks, 10 minutes for replies, set per node for `app.notify`), `Urgency`, and `Topic`, so a newer push about the same approval or task replaces the old one.
- **Answers.** 201 is delivered. 404 or 410 removes the subscription. Anything else counts a failure, and ten in a row remove it.
- **What notifies:**

  | Category (per user, in Settings) | When |
  |---|---|
  | Approvals (on) | A task step, a sandbox fallback, or a workflow approval is pending, or a command or a send waits in a chat |
  | Tasks (on) | A task succeeds, fails, or is delivered |
  | Replies (on) | The assistant replies in a chat that no visible window shows |
  | `app.notify` | Always, when a workflow sends one |

- **Presence.** The web app's socket tells the server which conversation each visible window shows. Only replies use this.
- **Taps.** A tap focuses an open Sling window and navigates it, or opens one. Notifications have no buttons, so nothing is approved from a lock screen, and iOS shows no buttons anyway.
- **What a push holds.** `{ title, body, url, tag }`, at most 3 KB: the approval's or task's title, never command output or message bodies.

**`app.notify`.** A node that pushes to the devices of the workflow's owner. It takes a title, a body, and a path to open, which may be expressions, and an urgency. It outputs how many devices it reached.

## Time zone (D80)

- **Where it's stored.** `workspaces.time_zone`, an IANA name, null until set.
- **Setting it.** The web app sets it from the browser the first time it finds it null. **Settings → General** has a searchable picker.
- **Using it.** A null zone counts as UTC. "Today" in the calendar, a schedule trigger whose zone is empty, and the assistant's date line ("It's Friday, 6 November 2026, 07:30 in Europe/Lisbon") all use it.

## Personality tool groups (D81)

`PERSONALITY_TOOLS` becomes `commands`, `coding`, `apps`, and `deploys`.

- **`apps`, "Apps and workflows":** reads your calendar, runs your workflows, and sends through your connectors, asking first.
- **`deploys`, "Deploys":** `check_deploy_target`, `deploy_task`, and `deliver: "deploy"` on `delegate_coding_task`. A personality without it can't deploy, and the server enforces that.
- **Templates.** The migration gives the default personality the new groups when it has every old group. The Incident template gets `deploys`, and Planner gets `apps`. Other personalities keep exactly the groups they have.

The new assistant tools:

| Tool | Group | Does |
|---|---|---|
| `check_deploy_target` | deploys | Runs a target's checks now. Returns each result, the last deploy, and the target's method |
| `deploy_task` | deploys | Adds merge, deploy, and verify to a delivered PR task |
| `run_workflow` | apps | Above |
| `<node_type>` | apps | One per flagged node with an installation |

`list_machines` also lists each repo's deploy target name, when it has one.

## Data model additions

Migration `0009_deploys`:

| Change | Holds |
|---|---|
| `deploy_targets` (new) | The fields above, plus workspace, owner, and timestamps. Unique on (workspace, name) and (workspace, remote key) |
| `push_subscriptions` (new) | Workspace, user, endpoint (unique), `p256dh`, `auth`, device label, created, last delivered, last error, failures in a row |
| `actions` | Kinds `merge`, `deploy`, `verify`. State `queued`. New columns: `target_id`, `runner_id` (where a merge or deploy ran), `commit_sha` (the merged commit), `output` (text, at most 256 KB), `detail` (jsonb: verify results) |
| `repos` | `deploy_command` and, in `0010_deploy_timeout`, `deploy_timeout_seconds` |
| `workspaces` | `time_zone` |
| `workspace_members` | `notifications` (jsonb: approvals, tasks, replies) |
| `personalities` | The default gains `apps` and `deploys` (data only) |
| `audit_events` | New verbs: `deploy_target.created`, `.updated`, `.removed`, `action.merge.*`, `action.deploy.*`, `action.verify.*`, `assistant.action`, `push.subscribed`, `push.removed` |

## Protocol

- **`Repo`** gains `deploy_command`, empty when none is set, and `deploy_timeout_seconds`.
- **`Inventory`** gains `deploys`: false after `deploys off`.
- **Server to Runner:**
  - `RepoAction { request_id, kind (MERGE | DEPLOY), task_id, repo, branch, default_branch, pr_url, merge_method, title, body, commit_sha }`
  - `RepoActionAck { request_id }`
- **Runner to server:**
  - `RepoActionOutput { request_id, chunk }`
  - `RepoActionResult { request_id, outcome (SUCCEEDED | FAILED | REFUSED), message, commit_sha, url }`

## API

```text
GET    /api/deploy-targets                    with last check and last deploy
POST   /api/deploy-targets                    { name, remoteKey, method, … }
PATCH  /api/deploy-targets/:id
DELETE /api/deploy-targets/:id
POST   /api/deploy-targets/:id/check          runs the checks now
POST   /api/tasks/:id/deploy                  adds merge, deploy, verify to a delivered PR task
GET    /api/push/key                          the VAPID public key
GET    /api/push/subscriptions                this user's devices
POST   /api/push/subscriptions                { endpoint, keys, label }
DELETE /api/push/subscriptions/:id
POST   /api/push/test                         sends a test push to one device
PUT    /api/settings/notifications            { approvals, tasks, replies }, for the signed-in user
PUT    /api/settings/time-zone                { timeZone }
GET    /api/settings                          gains timeZone and notifications
POST   /api/conversations/:id/commands/:approvalId    now answers sends as well as commands
```

- **Realtime.** New event `deploy_target.updated`. The client sends `{ type: "presence", conversationId | null, visible }`.
- **Views.** `ToolStep.approval` gains `kind` (`command` or `send`) and `summary`. `TaskView` gains `remoteKey`, and `ConnectorView` gains `hasSource`.

## Workstreams

The contracts land on `main` first. Five workstreams then run in parallel, each in its own worktree, and integration comes last.

### W0. Contracts (on main, first)

- **`@sling/core`:**
  - `deploy` in `DELIVERY_KINDS`; `verify` and `queued` for actions
  - `DeployTargetView`, `DeployCheckResult`, and the action view's new fields
  - `PushSubscriptionView` and `NotificationSettings`
  - the `apps` and `deploys` groups, with their labels
  - `ToolStep.approval` with `kind` and `summary`
  - the new realtime events
- **Protocol:** the messages above, then `buf generate`.
- **`packages/db`:** migration `0009_deploys`.
- **`@sling/connector-sdk` 1.1.0:** `assistant` on node specs, carried through `describe()` and what an extension adds, with the API report updated.
- **Server:**
  - `TOOLS_BY_GROUP` for `deploys`, and a rule for `apps`
  - empty `deploys` and `push` slots on `AppContext`, with interfaces
  - the `workspaces.timeZone` field in views

### W1. Runner (Rust)

- **Config.** `config set deploys on|off`, `repo set <name> deploy-command …`, `repo unset <name> deploy-command`, and `repo set <name> deploy-timeout <secs>`, all reported in the inventory.
- **`RepoAction`:**
  - merge through `gh`, and the local merge with its trailer
  - deploy in a detached worktree, with output streaming, the timeout, and killing the process group
  - every guard above
  - results kept until acknowledged
- **Tests:**
  - against real repos with bare remotes: merge, idempotent re-merge, conflict, a moved default branch, deploy of a merged commit, and every refusal
  - the `gh` path against a stand-in `gh` on `PATH` that records its arguments

### W2. Server: deploys

- **`apps/server/src/deploys/`:**
  - `service.ts`: targets, checks, and `lastCheck`
  - `steps.ts`: merge, hook, and command steps, plus the GitHub REST merge for sandbox PRs
  - `verify.ts`: the pg-boss job
  - `routes.ts`
- **Task service:** the new delivery, queued steps, approvals made when the steps reach merge, `RepoAction` sends and results, restart handling, and deploy later.
- **Assistant:** `check_deploy_target`, `deploy_task`, `deliver: "deploy"`, the prompt's deploy rules (when to deliver a deploy, what to say after verify, offering a revert), and `list_machines` showing targets.
- **Nodes and templates:** `deploys.check`, **Site down alert**, and `deploy` delivery in `agent.delegate_coding_task`.
- **Tests:**
  - unit tests for check matching and the verify loop
  - an end-to-end suite with a local site, a bare remote, and the real Runner with `fake-codex`, which runs Done-when items 2 to 5 and 7 for each method
  - a test site that answers 200 once the default branch's `SLING_FAKE.md` holds the task title

### W3. Server: everyday assistant

- **`integrations/calendar`:** CalDAV and iCal, both nodes, and the test, with unit tests on fixture feeds.
- **Tests:** an integration suite against Radicale in Testcontainers.
- **Assistant:**
  - `agent/app-tools.ts`, which builds tools from flagged nodes
  - `run_workflow`
  - chat approvals generalized from commands to sends, with summaries
  - audit
  - the date line in the workspace's time zone
  - schedules with an empty zone
- **Templates and examples:** **Morning briefing**, and ntfy 1.1.0 flagging `ntfy.publish`, rebuilt into the included catalog.
- **Tests:** mock-model tests for each mode, and send, deny, and expire with GreenMail and the fake Discord.

### W4. Push and the installed app

- **Server, in `apps/server/src/push/`:**
  - VAPID and RFC 8291
  - subscriptions and their routes
  - the dispatcher, which listens to the hub's events
  - presence
  - `app.notify`
- **Web:**
  - the manifest, icons, and `sw.js` with push, notification clicks, and caching
  - registration
  - **Settings → Notifications**: turn on for this device, the device list, categories, a test push, and the iOS steps
  - the time zone picker, and setting the zone on first load
  - safe areas
  - `?draft=` and `?personality=` links
- **Tests:**
  - RFC 8291 vectors, the JWT, the host allowlist, and dropping gone subscriptions
  - an end-to-end test against a local push endpoint, which decrypts the payload with the subscription's private key
  - DOM tests

### W5. Web: deploys and apps

- **Deploys page**, a sidebar item after Sandboxes: targets with status, last check, last deploy, and **Check now**.
- **The target dialog:**
  - a repo picker from known remotes
  - a method control
  - a machine picker limited to machines with a deploy command, with the `sling-runner` line to copy when there are none
  - the hook fields
  - checks, the version URL, and the merge method
  - timeouts, folded away
- **Tasks:**
  - merge, deploy, and verify steps on the task card and the task page, with output and check results
  - the "Approve deployment?" card in chat and on **Approvals**
  - **Deploy** on delivered PR tasks
- **Chat:** the send approval card, sharing the command approval's control, with the summary.
- **Personalities:** the new tool groups in the form.
- **Extensions:** nodes the assistant may use, in the install and update dialogs.
- **Tests:** DOM tests with fixtures. Screenshots come in integration.

### W6. Integration (after merge)

- **Wiring.** Wire everything in `main.ts`, and make sure the Dockerfile includes the calendar package.
- **Done when.** Run every item end to end, including the real GitHub merge, and one real chat turn on the cheapest model where the assistant reads the calendar.
- **Browser.** Playwright against a preview server with its own database, at desktop and phone width, in dark and light. Check push delivery to the service worker through CDP, and installability.
- **Budgets.** Measure them.
- **Docs.** README, `docs/deploys.md`, `docs/connectors/calendar.md`, `docs/notifications.md`, the personalities and runner docs, the threat model, and the plan's status.

## Testing

- **Unit:**
  - check matching, the verify loop, and the order of steps
  - the approval policy per mode for steps and sends
  - building tools from node specs, and filling summaries
  - iCal parsing and recurrence across a time zone change
  - CalDAV XML
  - RFC 8291 and VAPID
  - the push host allowlist
- **Rust:** merges and deploys against real git repos, every guard, and the stand-in `gh`.
- **End to end, Postgres plus server plus real Runner plus `fake-codex`:**
  - the incident flow for each method
  - each mode
  - a failed verify
  - refusals
  - deploy later
  - the site down alert
  - a push through a local endpoint
  - the assistant's sends with GreenMail and the fake Discord
  - the morning briefing with a mock model
- **Integration:** Radicale for CalDAV, and a local HTTP server for iCal.
- **Live:**
  - one PR merged for real on a private throwaway GitHub repo (asked 2026-11-06)
  - one real chat turn on Haiku 5.5 or GPT-6-Luna where the assistant reads the calendar
  - push delivery to a real browser's push service, if the preview browser can reach one

## Budgets

| Measure | Budget |
|---|---|
| Approval to `RepoAction` sent, p95 | under 100 ms |
| Verify sees a site come back | within 12 s of it answering |
| Hook step overhead over the hook's own time | under 50 ms |
| Push: event to request at the push service, p95 | under 30 ms |
| Push encryption per message | under 1 ms |
| Today's events from 1,000 CalDAV events, recurring included, local Radicale | under 300 ms |
| Parse a 1 MB iCal feed | under 150 ms |
| Tool layer overhead per connector action from chat | under 5 ms |
| Second start from the cached shell to an interactive chat, 4× CPU slowdown | under 1 s |
| Service worker and manifest, bytes | under 15 KB |
| Web bundle growth, gzipped | under 40 KB |
