# Memory

Sling remembers lasting facts about you, so you don't have to say them again in every chat. "I'm vegetarian" in one chat, and a week later a chat with another personality already knows.

## How a memory gets saved

The assistant saves one on its own when you tell it something that will still be true later: a preference, a person and how to reach them, a place, a routine, or anything you ask it to remember. The chat shows a line under the reply:

> Remembered: Vegetarian **Undo**

**Undo** deletes it. Once a memory is deleted, from the chat or anywhere else, the line reads "Forgotten".

It never saves secrets, one-off details of the task at hand, or anything you asked it to forget. Saying the same thing again keeps the memory it has.

You can also add one yourself on **Memory**, and ask the assistant to forget one ("forget that I'm vegetarian"). It finds the memory and deletes it.

## Secrets are refused

The server refuses a memory that looks like a secret, whether the assistant or you tried to save it:

- API keys and tokens, such as `sk-…`, `ghp_…`, AWS keys, JWTs, and private keys
- a card number that passes the Luhn check
- a password or PIN next to its value, such as "wifi password is …"

The assistant is told why, and the chat says "Not remembered" with the reason. Memories go into every chat's prompt, so a secret in one would reach every model you chat with.

## What a chat knows

Each chat's prompt starts with what its personality can see, most recently used first, up to 6 KB. A memory counts as used when a prompt includes it or the assistant finds it with `recall`. The rest are a `recall` away: the assistant searches every memory it can see by its words, with Postgres full-text search, and gets the 20 best matches.

An edit or a delete reaches the next turn of any chat. A chat on Claude Code keeps the prompt its session started with, so a change shows up there in new chats. Memories saved earlier in a chat are already in that chat's history.

A personality without the Memory tool group gets neither the tools nor the memories. Every personality has the group unless you take it away under **Personalities**.

## One personality or all

A memory is for every personality unless it's kept to one. The assistant keeps one to itself only when it matters to that personality alone, such as the level of a language you practice with it. On **Memory**, pick who knows it from the memory's menu.

## The Memory page

**Memory** is in the sidebar after Personalities. Each memory shows the chat it came from, with a link, or "Added by you", and the personality it's kept to, if any.

- **Search** filters as you type, by every word.
- **Add** takes the text. Enter saves and Escape cancels.
- Click a memory to edit it in place.
- The menu edits, picks who knows it, and deletes.

A memory is one line of at most 500 characters. Deleting one is for good. Memories live in your Sling's Postgres and nowhere else, and each change is in the audit log as `memory.created`, `memory.updated`, or `memory.deleted`.

## Tools

| Tool | Does |
|---|---|
| `remember` | Saves one fact, for every personality unless `onlyThisPersonality` is set |
| `recall` | Searches what the personality can see, at most 20 results |
| `forget` | Deletes one by its ID, from `recall` or `remember` |

They read and write only Sling's own data, so they work in every mode, Read-only included.
