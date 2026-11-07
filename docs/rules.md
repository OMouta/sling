# Rules

A rule is a standing answer you gave once. There are two kinds:

- An **allow rule** answers a question for you, such as "Allow this email?", so the same kind of send goes out without asking.
- A **start rule** starts work on its own when a check changes, such as opening a chat with Incident when your site goes down.

Rules live on **Approvals**, under **Rules**. Each one says what it covers, how often it was used, and the chat it came from. **Revoke** stops it at once.

## Allow rules

Every question about a send from chat or a workflow run has **Always allow** next to **Allow**, and so does a task's push and pull request on **Approvals**. It first shows the rule it would make, such as "Email to anyone at acme.com". Confirm it, and Sling saves the rule and allows this send too.

After you've allowed the same kind of send five times in a row, from the same account, with no denial in 30 days, the question says "You've allowed this 5 times" above the same button.

A rule covers:

- **One action**: a send such as an email, a Discord message, or a new calendar event, `run_workflow` for one of your workflows, or a task's push or pull request.
- **One account**, when you have more than one of that kind. The rule's line names it.
- **The values it pins.** Each app says which ones a rule can pin: an email's recipients, a Discord message's channel or user, an event's calendar. A task's push and pull request pin the repo. Anything a rule doesn't pin is free, so a rule for email to acme.com doesn't care about the subject or the text.

How a pinned value matches:

| Pinned | Matches |
|---|---|
| `jo@silva.pt` | That value exactly. Case doesn't matter, and `Jo Silva <jo@silva.pt>` counts |
| `*@acme.com` | Anything ending in `@acme.com`, so anyone at acme.com, but not `acme.com.evil.io` |
| `jo@silva.pt, *@acme.com` | Either one |
| left empty | Only when the value is left out, such as a Discord message with no user |

A send to several people goes without asking only when every one of them is covered.

Always allow widens an address at a company domain to everyone there, `ana@acme.com` to `*@acme.com`. An address at a public mail provider, such as Gmail or Outlook, stays exact, so a rule never covers strangers who happen to share a provider.

A send a rule let through shows "allowed by rule" on its step in the chat, and a send you made a rule from shows "always allowed".

## Where allow rules apply

| Mode | A send a rule covers |
|---|---|
| Read-only | Still refused |
| Supervised | Goes without asking |
| Auto | Goes without asking |
| Full access | Goes without asking anyway |

The same holds in chats a workflow or a start rule opened. A task's push and pull request ask only in Supervised, so that's the only mode where their rules matter.

Nothing else ever matches a rule: merges, deploys, commands outside the sandbox, changes to Sling's setup, and saving a rule always ask as the mode says.

## Start rules

A start rule says which check, what it did, who answers, and in which mode:

> When Website goes down, Incident investigates.

When the check changes that way, Sling opens a new chat with that personality and runs its first turn at once. The chat starts with what the check saw, then the rule's message. In the message, `{check}` becomes the check's name and `{results}` what its last run saw.

| A check that | Can start on |
|---|---|
| Watches a site or runs a command | going down, or coming back up after being down |
| Waits for an email reply | the reply arriving, or the deadline passing |

A rule can name one check or cover every check.

- **One chat per check every 30 minutes.** A site that flaps doesn't open twenty chats.
- **At most Auto.** A start rule's chat runs in Read-only, Supervised, or Auto, never Full access. A deploy or merge it proposes asks you, as in any chat in that mode.
- **Its header says so.** The chat shows the rule that opened it, and tapping that opens **Approvals → Rules**.

## Rules from chat

Ask in a chat, with a personality that has **Change Sling's setup**:

> Stop asking me before adding calendar events.
>
> When Website goes down, have Incident look into it.

The assistant calls `save_rule`, and the chat shows a card with the rule and what it pins. The card shows in every mode, Full access included, because a rule outlives the chat that made it. Nothing is saved until you choose **Apply**.

## The audit log

Making a rule is recorded as `rule.created`, revoking it as `rule.revoked`, and every action it let through as `rule.used`. A send a rule allowed is in the audit log as `assistant.action` with the decision `rule` and the rule's ID.
