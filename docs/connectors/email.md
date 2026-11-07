# Email

The email connector works with any mailbox that offers IMAP and SMTP. Workflows can start on new mail in a folder and send plain text email from your address.

## Adding a mailbox

Type your address and password. Sling finds the IMAP and SMTP servers itself:

1. Gmail, Google Workspace, iCloud, Fastmail and Yahoo it knows already.
2. For other domains it asks Thunderbird's provider database (`autoconfig.thunderbird.net`), which knows most mail hosts.
3. Failing that, it looks up who handles the domain's mail (its MX records) and asks the database about them.

The form says which provider it found, and links to where that provider makes app passwords. Most providers want an app password here rather than your normal one. If nothing knows the domain, the server fields show up for you to fill in. Ports, TLS, the login and the folders to watch are under **More settings**.

**Add** logs in to IMAP, checks the folders, and logs in to SMTP before saving. If that fails, the form says why and offers **Add anyway**.

Outlook.com and Microsoft 365 mailboxes no longer accept passwords over IMAP and SMTP, so the form says they can't be added.

## Gmail

1. Turn on 2-Step Verification for the Google account. App passwords need it.
2. Make an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and paste its 16 characters; spaces don't matter.
3. If your Gmail settings still have **Forwarding and POP/IMAP**, make sure IMAP is on there.

Gmail labels appear as folders, for example `[Gmail]/Sent Mail`. Google Workspace admins can turn app passwords off; if you can't make one, ask your admin.

## Servers, by hand

Under **More settings**, prefer port 993 for IMAP and 465 for SMTP, both with TLS on. If the provider only offers 587 for SMTP, use it with SMTP over TLS off; the connection upgrades with STARTTLS. The address you type is also the From address; write `Sling <you@example.com>` to set a display name.

## How new mail is picked up

- Sling keeps one IMAP connection per watched folder. It uses IDLE, so new mail shows up within seconds. Servers without IDLE are checked every minute.
- On first start it begins with the newest message. Mail that was already there doesn't fire triggers.
- It remembers the last message it handed to workflows in each folder, so a restart picks up mail that arrived while it was down and never repeats mail. If the server renumbers a folder, which shows up as a new UIDVALIDITY, Sling starts again from the newest message.
- It only reads. Sling opens folders read-only, and messages stay unread.
- The connection reconnects by itself, waiting longer after each failure. The Connectors page shows its status.

## Nodes

**Email received** is the trigger. It fires once per new message. Its output is an `email`: sender, recipients, cc, subject, date, Message-ID, In-Reply-To, the text, and the HTML if there is one. For mail with only HTML, Sling converts the HTML to text. It cuts text and HTML at 200 KB each.

| Setting | Meaning |
|---|---|
| Folder | Which folder. It must be one of the installation's folders, since those are the only ones watched |
| From contains | Only mail whose sender name or address contains this. Not case-sensitive |
| Subject contains | Only mail whose subject contains this. Not case-sensitive |

**Send email** sends plain text from the installation's from address.

| Setting | Meaning |
|---|---|
| To | Recipients, separated by commas |
| Subject | Subject line |
| Text | The body. A connected `text` input replaces it |
| In reply to | Optional Message-ID of the mail you're answering, so mail apps thread the reply. For example `={{ trigger.email.messageId }}` |

Sending isn't retried automatically after an unclear failure. Each node run sends with its own fixed Message-ID, so a repeat is easy to spot. Gmail files a copy of sent mail in Sent Mail by itself; other providers may not.

Anyone can send you email, and anyone can write a convincing one. Workflows pass email to AI nodes as data, never as instructions, but filter on the sender with From contains or a condition before a workflow acts on what an email asks for.
