# Telegram

The Telegram connector runs a bot you create. Workflows start when someone in a chat you allow messages the bot, and send messages as the bot. With the **Telegram assistant** template, you talk to Sling's assistant in Telegram.

Sling asks Telegram for new messages itself, with long polling, so it needs no public address for this.

## Create the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give it a name, such as "Sling", and a username that ends in `bot`.
3. BotFather answers with a token like `7000000001:AAH…`. Copy it.

Use a bot that nothing else reads. Telegram gives each message to one reader, so a bot that another app also polls, or one with a webhook set, doesn't work with Sling.

## Add it to Sling

Under **Connectors**, add Telegram and paste the token. The form takes it from there:

- It says which bot the token belongs to, or that Telegram doesn't accept it.
- It asks you to send the bot a private message, with a link that opens the chat. Send it anything. The form notices within a few seconds, and your chat shows up as the one it answers. It never picks a group by itself.
- **Chats and people it answers** starts with your chat. Messages from any other chat are dropped before a workflow sees them. To add another person or a group, have them message the bot while the form is open, or add the chat's ID.
- In a group, the bot answers only the people on the list, by their own Telegram ID, which is the same as their private chat's. Other members are ignored, and a group with nobody from the list answers no one. People who wrote in a group while the form is open show up to add.

**Add** checks the token before saving.

## Nodes

**Telegram message received** is the trigger. It fires for each text message from an allowed chat and an allowed person, or a photo's caption. Its output is a `telegram.message` with the message ID, the chat's ID, type and name, who sent it, the text, and when.

Messages from one chat run one at a time, in order.

**Send Telegram message** sends as the bot.

| Setting | Meaning |
|---|---|
| Chat ID | One of the chats the bot answers. Empty uses its first one. To reply where a message came from, use `={{ trigger.message.chatId }}` |
| Text | The message, in Markdown. A connected `text` input replaces it |

Markdown becomes Telegram's own formatting: bold, italics, strikethrough, code, code blocks, links, and quotes. Headings turn bold, list items get bullets, and tables show in a fixed-width font. A message over 4,096 characters, Telegram's limit, goes as several, split between paragraphs where it can. If Telegram can't read the formatting, the same text goes without it.

The node only sends to chats the bot answers. Sending isn't retried automatically after an unclear failure.

## The assistant

Install **Telegram assistant** under **Workflows**, pick the bot, and turn it on. Each chat gets its own conversation in Sling, called "Telegram: " and the person's name. The assistant answers there, and when a task it started finishes, the update comes back to the same chat.

From any chat, the assistant can also send Telegram messages with **Send Telegram message**. It asks you first in Supervised and Auto, sends at once in Full access, and is refused in Read-only. An **Always allow** rule can name the chat.

## How messages are picked up

- Sling keeps one long poll open per bot. A new message reaches the assistant within a moment.
- On the first start it skips messages already waiting, such as the one that found your chat.
- It remembers the next message it expects, so a restart picks up what arrived while it was down and never answers one twice.
- If the connection fails, it tries again, waiting longer after each failure. The Connectors page shows its status.

## Limits

- Telegram has no way to read a sent message back, so the chat shows Telegram's answer as the check.
- In a group, a bot sees only commands, replies to it, and messages that mention it, unless you turn off its privacy mode with BotFather's `/setprivacy`.
- Messages without text, such as stickers or voice notes, are skipped.
