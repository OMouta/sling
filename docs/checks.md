# Checks

**Checks** is what Sling watches on its own: your sites, a command on one of your machines, and an email you're waiting for. Each one runs on a schedule, keeps its last 100 runs, and sends a push notification when it changes. A site check can also deploy: Sling can take a fix past the pull request, merge it, deploy it, and check that the site works afterwards.

A typical run, from your phone:

> *A push says "Website is down: 502". You tap it, and a chat with the Incident personality opens with a draft that says what failed. You send it.*
>
> **Sling:** Website answers 502. I started a Codex task on your Mac to fix it, set to deploy.
>
> *The task pushes and opens its PR. A push notification says "Approve deployment of Website?" You tap it and approve.*
>
> **Sling:** Merged PR #12 and deployed it. Website answers 200, and its version URL shows the merged commit.

## Kinds of check

Add one under **Checks**, with **Add check**. It asks what to watch, then one thing at a time.

| Kind | Passes when | Runs |
|---|---|---|
| **A site** | Every page answers as set: 200 to 399 by default, or the status and text you give, for one to five URLs | Every minute |
| **A command on a machine** | The command exits 0, and its output has the text you give, if you give one | Every 5 minutes |
| **An email reply** | An email from the address, or with the words in its subject, arrives in your mailbox | Every 5 minutes, until it arrives or the deadline passes |

A site or command check is **Down** after two failures in a row, and **Up** again after one pass. A reply check is **Waiting**, then **Replied** or **No reply**, and then stops. **Pause** in a check's menu stops it until you **Resume** it, and **Check now** runs it at once. **History** under a check shows its recent runs.

A command check runs in the machine's read-only sandbox, so it can read files but can't change them or use the network, such as `test -n "$(find ~/Backups -mtime -1)"` to see that last night's backup is there. A machine with commands off, or one that can't sandbox them, can't take one. When the machine is offline, the run says so and doesn't count as a failure.

A reply check looks in one of your email accounts under **Connectors**.

## When a check changes

When a check goes down, comes back up, gets its reply, or misses it, Sling sends a push notification. Tapping one about something down opens a new chat with the Incident personality and a draft that says what failed, such as "Website is down (502 since 18:05). Find out why and fix it." Nothing starts until you send it, unless a start rule opened a chat about it already, in which case the push opens that chat. Turn a check's notifications off under **More settings** in its dialog.

Workflows hear about changes too, through the **Check changed** trigger. The **Site down alert** template uses it to push its own alert. While a workflow pushes about a change, Sling doesn't send a second one.

## Sites that deploy

A site check can also deploy a repo: that's where a repo's deploy target lives. In the check's dialog, **Does Sling deploy it?** picks the repo, from the ones your machines and your sandbox list know. One check deploys each repo. Then:

| Method | Use it when | After the merge, Sling |
|---|---|---|
| **On merge** | Your host deploys the default branch when it changes: Vercel, Netlify, Railway, Render, Fly, Cloudflare Pages | waits a minute, then checks |
| **Command** | A command on one of your machines deploys it, such as `fly deploy` or `docker compose up -d --build` | runs that command on the merged commit, then checks |
| **Deploy hook** | Your host gives you a deploy hook URL: Render, Netlify, Vercel, Coolify, and others | calls the hook, then checks |

Under **More settings**: how the PR is merged (squash by default, a merge commit, or rebase), and how long Sling waits after a deploy before it checks and how long it keeps checking. The site's own **More settings** has a **Version URL**: a page that shows the deployed commit, such as a `/version` route, so Sling waits until the site shows the merged commit, not just until it answers. **Edit** on a check opens a summary of all of it; each line opens its step.

### Command: set it on the machine

The deploy command lives in the Runner's own config, so Sling can pick which machine deploys but never what runs:

```sh
sling-runner repo set site deploy-command "fly deploy --remote-only"
sling-runner repo set site deploy-timeout 1200   # seconds, 900 by default
```

The machine then reports the command, and it shows up when you pick the machine in the check's dialog. To deploy, the Runner fetches, makes a fresh checkout of the merged commit, and runs the command there through your login shell, with your environment, outside any sandbox. `SLING_DEPLOY_COMMIT` and `SLING_DEPLOY_REPO` tell it what it's deploying. Its output shows on the task.

### Deploy hook

Paste the hook URL, pick POST or GET, and add a header if the hook needs one, such as `Authorization`. Sling stores the URL and the header encrypted and never shows them again. Any 2xx answer counts as accepted.

## Asking for a deploy

In chat, say you want it live: "fix it and deploy", or "the site is down, fix it". The assistant delivers the task as a deploy when the repo has a site check that deploys it. A personality needs the **Deploys** tool group for this; Sling and the Incident template have it.

A task delivered as a deploy runs these steps:

1. **Push** the task's branch.
2. **Open the pull request.**
3. **Merge** it into the default branch.
4. **Deploy**, for the command and hook methods.
5. **Check the site** until it passes, or for up to 10 minutes.

What asks first depends on the conversation's [mode](modes.md):

| Mode | Asks before |
|---|---|
| Read-only | Can't deploy |
| Supervised | Push and PR, then the deployment once the PR exists |
| Auto | The deployment, once the PR exists |
| Full access | Nothing |

"Approve deployment?" shows in the chat, on **Approvals**, and as a [push notification](notifications.md). It names the site and says what will happen, such as "Merges PR #12 into main with squash, then runs `fly deploy` on Studio Mac, then checks example.com". It expires after 24 hours.

A task delivered as a plain PR can deploy later: **Deploy** on the task, or "deploy that" in chat.

## Where the merge happens

- **A task that ran on your machine.** That machine merges. With a GitHub PR and `gh` logged in, it uses `gh pr merge`, so your branch protection applies. Without them, it merges in a temporary checkout and pushes the default branch, never forced.
- **That machine is offline.** Another of your machines with the same repo merges. If none is online, the step waits.
- **A task that ran in a sandbox.** Sling merges the PR through GitHub's API with the GitHub token under **Settings → Sandboxes**.

Asking twice never merges twice. A merged PR, or a commit Sling already merged (it carries a `Sling-Task:` line), counts as done.

## The PR's CI

Once a task's pull request is open on GitHub, Sling waits up to 30 minutes for its CI and shows the result on the PR's step and on "Approve deployment?", such as "CI passed: 4 checks" or "CI failed: lint (1 of 4)". The machine that has the repo reads it with `gh pr checks`, which needs `gh` logged in there. A sandbox's PR, or one no machine can read, is read through GitHub's API with the token under **Settings → Sandboxes**. When CI fails, the chat hears about it, the assistant tells you, and a push goes out. CI doesn't block the deploy: you decide.

## Checking the site after a deploy

After the deploy, Sling runs the site's check every 10 seconds until every check passes and, with a version URL, the page shows the merged commit. The task then says what it saw: "The site passed every check after 3 attempts (34 s), and the version URL shows 5699841."

Without a version URL, a passing check could still be the old version answering, and the task says so. If the checks don't pass within the time limit, the task says which ones failed and why, and the assistant offers a revert: a new task that reverts the merged commit, delivered as a deploy, which asks for approval like any other. Nothing rolls back on its own.

Its last round is the check's latest run, so **Checks** shows what the deploy left behind. Change the wait before the first round and the time limit under **More settings** on the **How does it go live?** step.

## What the machine refuses

Whatever Sling asks, the Runner refuses, and the task shows why:

- any merge or deploy after `sling-runner config set deploys off`, or when `max-mode` is Read-only
- merging a branch that isn't a Sling task branch (`sling/…`), or a PR whose branches don't match the task's
- deploying a commit that isn't on the remote's default branch, so only merged code deploys
- deploying a repo with no deploy command set on that machine
- force-pushing, ever

## From chat

The assistant can run any check by name with `run_check`, such as "is the site up?" or "did the backup run?", and add or change one with `save_check`, which shows the change on a card first, as other setup changes do. A personality needs the **Deploys** tool group for `run_check` and the setup group for `save_check`.

## Checks of what the assistant does

When the assistant does something outside Sling from a chat, Sling checks that it happened where it can, and shows the result under the step:

- an event added to a CalDAV calendar is read back, and the step says which calendar it's in, such as "In Work, Mon 9 Nov 10:00"
- a Discord message is fetched back by its ID

Sling checks once right after, and keeps checking for a while when the service hasn't caught up yet. When a check fails, the chat hears about it, the assistant tells you, and a push goes out. A step with nothing to check shows nothing.
