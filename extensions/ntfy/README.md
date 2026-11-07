# ntfy

Push notifications through [ntfy](https://ntfy.sh), on ntfy.sh or your own ntfy server. Workflows can publish a notification to your phone or desktop, and a message published to a topic you watch can start a workflow.

ntfy.sh needs no account. Install the ntfy app on your phone (Android or iOS), or open https://ntfy.sh/app in a browser, and subscribe to a topic.

## Topics are public on ntfy.sh

Anyone who knows a topic's name can read and write it. Pick long names nobody will guess, such as `sling-7f3k29xq-alerts`, and don't publish anything secret. For private topics, reserve them with an ntfy.sh account, or run your own server with access control, and give Sling an access token.

## Add it to Sling

Installing ntfy opens its setup. The form suggests a long, random **Topic** and links to it, so you can subscribe in the ntfy app on your phone; it's the topic **Publish to ntfy** uses when a node doesn't name one. Under **More settings**:

| Field | What to put |
|---|---|
| Access token | Optional. An ntfy access token (`tk_...`) for reserved topics or a server that requires login |
| Server | `https://ntfy.sh`, or your own server's URL |
| Topics that start workflows | Topics whose messages can start workflows |

**Add** calls `/v1/health` on the server, and `/v1/account` with the token when there is one, before saving.

## Nodes

**Publish to ntfy** sends a notification. Its settings take expressions.

| Setting | Meaning |
|---|---|
| Topic | Where to publish. Empty uses the installation's default topic |
| Message | The text. The message input replaces it when connected |
| Title | Shown above the message |
| Priority | 1 (min) to 5 (max). 4 and 5 make a sound and vibrate on phones. 3 is the default |
| Tags | Comma-separated. Emoji short codes such as `white_check_mark` show as emoji |
| Click | A URL to open when the notification is tapped |
| Markdown | Show the message as Markdown in ntfy's web app |

Its outputs are the message `id` and the `topic`. It isn't retried on its own after a failure, since a second try sends a second notification.

**ntfy message received** is the trigger. It fires for each message on a watched topic. Narrow it with **Topics** (each one must also be in the installation's topics) and **Contains** (text in the title or message, not case-sensitive). Outputs: `message` (id, time, topic, title, message, priority, tags, click, attachment), `text`, `title`, and `topic`. Messages on one topic run one at a time, in order.

## How it connects

One WebSocket per installation, to `wss://<server>/<topic1>,<topic2>/ws`. ntfy sends a keepalive every 45 seconds, and the extension treats two minutes of silence as a dropped connection.

When a connection that was open drops, the extension reconnects after about 2 seconds, and the installation shows **Connecting** meanwhile. When it can't connect at all, the installation shows the reason, and Sling starts it again after 1 second, then 2, 4, and so on up to 5 minutes.

Each time it reconnects, it asks ntfy for messages since the last one it handed on, so a short outage or a Sling restart loses nothing ntfy still has cached. ntfy.sh keeps messages for 12 hours. Each message reaches workflows once, by its ID.

## Permissions

| Permission | Why |
|---|---|
| Connect to ntfy.sh | The default server |
| Connect to the address in its "server" setting | Your own server |

A server on your local network, such as `http://ntfy.lan`, needs the local network permission, which this package doesn't ask for. Give your server a public HTTPS name, or build your own copy of this extension with `localNetwork: true`.

## Develop

```sh
pnpm --filter @sling/extension-ntfy test       # unit tests against a local server and a fake socket
SLING_LIVE_NTFY=1 pnpm --filter @sling/extension-ntfy test:live   # publishes to a random topic on ntfy.sh
pnpm sling-ext build && pnpm sling-ext check   # from this folder
```
