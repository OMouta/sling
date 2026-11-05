# Email

The email connector works with any mailbox that offers IMAP and SMTP. Workflows can start on new mail in a folder and send plain text email from your address.

It logs in with a password. Most providers want an app password for this rather than your normal one.

## Settings

| Field | What to put |
|---|---|
| IMAP host, port | Your provider's IMAP server. Port 993 with TLS on |
| IMAP TLS | On for port 993. Off only for port 143, which then upgrades with STARTTLS |
| SMTP host, port | Your provider's SMTP server. Port 465 with TLS on |
| SMTP TLS | On for port 465. Off for port 587, which then upgrades with STARTTLS |
| Username | Usually your full email address |
| Password | An app password. The provider sections below say where to get one |
| From address | The address mail is sent from, like `you@example.com`. Write `Sling <you@example.com>` to set a display name |
| Folders | Folders to watch. `INBOX` by default |

**Test** logs in to IMAP, checks that each folder exists, then logs in to SMTP.

## Gmail

1. Turn on 2-Step Verification for the Google account. App passwords need it.
2. Create an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Copy the 16 characters; spaces don't matter.
3. If your Gmail settings still have **Forwarding and POP/IMAP**, make sure IMAP is enabled there.

| Field | Value |
|---|---|
| IMAP | `imap.gmail.com`, port 993, TLS on |
| SMTP | `smtp.gmail.com`, port 465, TLS on |
| Username | Your Gmail address |

Gmail labels appear as folders, for example `[Gmail]/Sent Mail`. Google Workspace admins can turn app passwords off; if you can't create one, ask your admin.

## Fastmail

1. In Fastmail, open **Settings**, **Privacy & Security**, and create a new app password under app passwords.
2. Give it mail access over IMAP and SMTP, and copy it.

| Field | Value |
|---|---|
| IMAP | `imap.fastmail.com`, port 993, TLS on |
| SMTP | `smtp.fastmail.com`, port 465, TLS on |
| Username | Your Fastmail address |

## Other providers

Look for your provider's "IMAP and SMTP settings" page. Prefer port 993 for IMAP and 465 for SMTP, both with TLS on. If the provider only offers 587 for SMTP, use it with SMTP TLS off; the connection upgrades with STARTTLS.

Outlook.com and Microsoft 365 mailboxes no longer accept passwords over IMAP and SMTP, so they don't work with this connector.

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
