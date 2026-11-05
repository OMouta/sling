# Discord

The Discord connector runs a bot you create. Workflows can start when someone you allow messages the bot, post messages as the bot, and send approvals with Approve and Reject buttons.

The bot connects out to Discord's gateway, so Sling needs no public URL for it.

## Create the bot

1. Open the [Discord developer portal](https://discord.com/developers/applications) and click **New Application**. The name is what people see, for example "Sling".
2. Open **Bot**. Click **Reset Token**, then copy the token. Discord shows it once. You'll paste it into Sling.
3. On the same page, under **Privileged Gateway Intents**, turn on **Message Content Intent** and save. Without it the bot sees messages but not their text, and the connection test fails. The other two privileged intents aren't needed.
4. You can also turn off **Public Bot**, so nobody else can add it to their server.

## Invite it to a server

Discord only lets a bot DM people it shares a server with, so invite it to at least one server you're in, even if you only plan to use DMs.

1. In the developer portal, open **OAuth2**, then **URL Generator**.
2. Under scopes, tick `bot`.
3. Under bot permissions, tick **View Channels**, **Send Messages**, and **Read Message History**.
4. Open the generated URL and pick the server.

For DMs, that server's privacy settings must allow direct messages from server members. Right-click the server and open **Privacy Settings** to check.

## Find user and channel IDs

Sling identifies people and channels by Discord ID, not by name.

1. In Discord, open **User Settings**, **Advanced**, and turn on **Developer Mode**.
2. Right-click a user, yourself included, and choose **Copy User ID**.
3. Right-click a channel and choose **Copy Channel ID**.

IDs are long numbers such as `123456789012345678`.

## Add it to Sling

Under **Connectors**, add Discord:

| Field | What to put |
|---|---|
| Bot token | The token from step 2 above |
| Allowed users | User IDs whose messages reach your workflows. Messages from anyone else are dropped before any trigger sees them |
| Approvers | User IDs that may press Approve or Reject. Usually just you |
| Default channel | Optional. Where **Send Discord message** posts when the node names no channel or user |

**Test** checks that Discord accepts the token and that the Message Content intent is on.

## Nodes

**Discord message received** is the trigger. It fires for a message from an allowed user. Its output is a `discord.message` with the message ID, channel ID, author, text, whether it mentions the bot, and when it was sent. The server ID is null in DMs.

| Setting | Meaning |
|---|---|
| Scope | `dm` for direct messages to the bot, `channels` for server channels, `any` for both. `dm` is the default |
| Channel IDs | Only these server channels. Empty means every channel the bot can read |
| Require mention | Only channel messages that mention the bot. DMs always count as addressed to it |

Messages from one channel run one at a time, in order.

**Send Discord message** posts as the bot.

| Setting | Meaning |
|---|---|
| Channel ID | Channel to post in. To reply where a message came from, use `={{ trigger.message.channelId }}` |
| User ID | DM this user instead, when no channel is set |
| Content | Message text, up to 2,000 characters; longer text is cut. A connected `content` input replaces it |
| Approval buttons | Show the approval from the `approval` input with Approve and Reject buttons |

The message never pings `@everyone`, `@here`, or roles, even if the text contains them, since the text often comes from emails or other people. User mentions still work.

Sending isn't retried automatically after an unclear failure. Each send carries a key derived from the node run, so if the same node run does send twice within a few minutes, Discord keeps only the first message.

## Approvals

With approval buttons on, the message shows the approval's title, summary, a link to it in Sling, and when it expires.

- A click from a user on the approver list decides the approval, exactly as the web app would. The message then shows who approved or rejected it, and the buttons are disabled.
- A click from anyone else is refused. They get a reply only they can see, "You can't approve this.", and Sling logs the refused click.
- If the approval was already decided or has expired, the clicker is told so privately and nothing changes.

Anyone who controls an approver's Discord account can approve pushes. Turn on two-factor authentication for that account.

## When it doesn't work

- **"The Message Content intent is off."** Turn on Message Content Intent as described under "Create the bot", and save.
- **"Discord rejected the bot token."** Someone reset the token, or it was pasted wrong. Reset it again and paste the new one.
- **The bot doesn't answer DMs.** Check that your user ID is under allowed users, that the workflow's trigger scope includes DMs, and that you share a server with the bot.
- **"Cannot send messages to this user."** The user shares no server with the bot, or blocks DMs from server members.
- **"Missing Permissions."** The bot lacks View Channels or Send Messages in that channel.
