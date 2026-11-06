# Deploys

Sling can take a fix past the pull request: merge it, deploy it, and check that the site works afterwards. It does this for repos that have a deploy target, and only when you approve, unless the conversation is in Full access.

A typical run, from your phone:

> **You:** The site is down. Find out why and fix it.
>
> **Sling:** Website answers 500. I started a Codex task on your Mac to fix it, set to deploy.
>
> *The task pushes and opens its PR. A push notification says "Approve deployment of Website?" You tap it and approve.*
>
> **Sling:** Merged PR #12 and deployed it. Website answers 200, and its version URL shows the merged commit.

## Deploy targets

A deploy target is a repo Sling knows how to deploy and how to check. Add one under **Deploys**, with **Add target**:

- **Name.** What you call it, such as Website or API. The assistant and the approvals use it.
- **Repo.** Picked from the repos your machines and your sandbox list know, by remote. One target per repo.
- **How it deploys.** One of the three below.
- **Health checks.** One to five URLs. Each passes when it answers 200 to 399, or the exact status you set, and contains the text you set, if any.
- **Version URL.** Optional. A page that shows the deployed commit, such as a `/version` route or a build-info file. With one, Sling waits until the site shows the merged commit, not just until it answers.
- **Merge with.** Squash (the default), merge commit, or rebase.

| Method | Use it when | After the merge, Sling |
|---|---|---|
| **On merge** | Your host deploys the default branch when it changes: Vercel, Netlify, Railway, Render, Fly, Cloudflare Pages | waits a minute, then checks |
| **Command** | A command on one of your machines deploys it, such as `fly deploy` or `docker compose up -d --build` | runs that command on the merged commit, then checks |
| **Deploy hook** | Your host gives you a deploy hook URL: Render, Netlify, Vercel, Coolify, and others | calls the hook, then checks |

**Check now** on a target runs its checks right away.

### Command: set it on the machine

The deploy command lives in the Runner's own config, so Sling can pick which machine deploys but never what runs:

```sh
sling-runner repo set site deploy-command "fly deploy --remote-only"
sling-runner repo set site deploy-timeout 1200   # seconds, 900 by default
```

The machine then reports the command, and it shows up when you pick the machine in the target's dialog. To deploy, the Runner fetches, makes a fresh checkout of the merged commit, and runs the command there through your login shell, with your environment, outside any sandbox. `SLING_DEPLOY_COMMIT` and `SLING_DEPLOY_REPO` tell it what it's deploying. Its output shows on the task.

### Deploy hook

Paste the hook URL, pick POST or GET, and add a header if the hook needs one, such as `Authorization`. Sling stores the URL and the header encrypted and never shows them again. Any 2xx answer counts as accepted.

## Asking for a deploy

In chat, say you want it live: "fix it and deploy", or "the site is down, fix it". The assistant delivers the task as a deploy when the repo has a target. A personality needs the **Deploys** tool group for this; Sling and the Incident template have it.

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

"Approve deployment?" shows in the chat, on **Approvals**, and as a [push notification](notifications.md). It names the target and says what will happen, such as "Merges PR #12 into main with squash, then runs `fly deploy` on Studio Mac, then checks example.com". It expires after 24 hours.

A task delivered as a plain PR can deploy later: **Deploy** on the task, or "deploy that" in chat.

## Where the merge happens

- **A task that ran on your machine.** That machine merges. With a GitHub PR and `gh` logged in, it uses `gh pr merge`, so your branch protection applies. Without them, it merges in a temporary checkout and pushes the default branch, never forced.
- **That machine is offline.** Another of your machines with the same repo merges. If none is online, the step waits.
- **A task that ran in a sandbox.** Sling merges the PR through GitHub's API with the GitHub token under **Settings → Sandboxes**.

Asking twice never merges twice. A merged PR, or a commit Sling already merged (it carries a `Sling-Task:` line), counts as done.

## Checking the site

After the deploy, Sling checks every 10 seconds until every check passes and, with a version URL, the page shows the merged commit. The task then says what it saw: "The site passed every check after 3 attempts (34 s), and the version URL shows 5699841."

Without a version URL, a passing check could still be the old version answering, and the task says so. If the checks don't pass within the time limit, the task says which ones failed and why, and the assistant offers a revert: a new task that reverts the merged commit, delivered as a deploy, which asks for approval like any other. Nothing rolls back on its own.

Change the wait before the first check and the time limit under **Timing** in the target's dialog.

## What the machine refuses

Whatever Sling asks, the Runner refuses, and the task shows why:

- any merge or deploy after `sling-runner config set deploys off`, or when `max-mode` is Read-only
- merging a branch that isn't a Sling task branch (`sling/…`), or a PR whose branches don't match the task's
- deploying a commit that isn't on the remote's default branch, so only merged code deploys
- deploying a repo with no deploy command set on that machine
- force-pushing, ever

## Watching a site

The **Site down alert** template, under **Workflows**, checks every deploy target every minute. A target that fails two checks in a row sends a push notification, such as "Website is down: 502", and one more when it's back up. Tapping the alert opens a new chat with the Incident personality and a draft that says what failed. Nothing starts until you send it.

The **Check deploy targets** step works in any workflow, so you can send the alert to Discord or email instead.
