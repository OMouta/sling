# Back up and restore

A Sling backup is the Postgres database plus `deploy/.env`. `deploy/backup.sh` takes
both while Sling keeps running, and `deploy/restore.sh` puts them back on a new or
rebuilt host with automation paused, so the restored copy can't repeat sends the
original already made.

## What a backup has to contain

| Item | Where it lives | Why it's needed |
|---|---|---|
| The `sling` database | Postgres volume | Everything Sling stores: accounts and passkeys, chats and their attachments, uploaded source files (kept as bytes in the database), workflows with every published version and their runs, connector installations, encrypted credentials, installed extension packages and trusted publisher keys, paired runners' public keys, push subscriptions, and the background job queue. |
| `SLING_SECRET_KEY` | `deploy/.env` | Required. Sling derives several keys from it, listed below. Without the same value, stored credentials can't be decrypted. |
| `SLING_PUBLIC_URL` | `deploy/.env` | Passkeys are bound to its hostname, and webhook URLs and runners use it. Restore at the same hostname or passkey sign-in stops working; password and authenticator-app sign-in still work. |
| `SLING_WEBHOOK_SECRET` | `deploy/.env`, if set | Webhook senders sign requests with it. |
| Other settings | `deploy/.env` | Port, proxies, metrics token, limits. `POSTGRES_PASSWORD` is only the bundled database's password. |
| Tunnel credentials | `deploy/tunnel.env`, if present | `TS_AUTHKEY` or `TUNNEL_TOKEN`. |

Keys derived from `SLING_SECRET_KEY`, and what a different key breaks:

| Purpose | Effect of a different key |
|---|---|
| Credentials at rest (AES-256-GCM) | Model API keys, connector credentials, deploy hooks, sandbox secrets, and OAuth tokens can't be decrypted and must be entered again. |
| Sign-in (Better Auth's secret) | Everyone is signed out, and authenticator-app codes can't be checked, because their secrets are encrypted with it. |
| Webhook URLs | The token in every `/hooks/...` URL changes, so senders need new URLs. |
| Web Push (VAPID) keys | Devices stop getting notifications until they turn them on again. |
| Approval links in notifications | Links in notifications already sent stop working. |

Not needed in a backup: the extension and runner-build caches, which are rebuilt, and
the image, which you build from the same Sling revision. Sling holds no private
signing keys. It checks extension signatures with publishers' public keys, which are
in the database; a publisher's own key from `sling-ext keygen` stays with the
publisher. Each runner keeps its own key pair on its machine. The Tailscale state
volume isn't backed up: give the new host a fresh `TS_AUTHKEY`.

## Taking backups

```sh
cd deploy
./backup.sh
```

This writes `deploy/backups/sling-<UTC time>.tar` with a `pg_dump` of the database
(one consistent snapshot, taken while Sling runs), `deploy/.env`, `deploy/tunnel.env`
if present, and a manifest with checksums. It then keeps the newest 14 backups in that
directory and deletes the rest.

Options and environment:

| Setting | Effect |
|---|---|
| `--dir DIR` or `SLING_BACKUP_DIR` | Where backups go. |
| `--keep N` or `SLING_BACKUP_KEEP` | How many to keep. Default 14. |
| `SLING_BACKUP_PASSPHRASE_FILE` | A file holding a passphrase. The archive is then encrypted with AES-256 (OpenSSL, PBKDF2 with 600,000 iterations) and named `.tar.enc`. |
| `SLING_BACKUP_PASSPHRASE` | The passphrase itself, if a file isn't convenient. |

Without a passphrase the archive holds `SLING_SECRET_KEY` next to the data it
protects, so anyone who can read the file can read every stored credential. Encrypt
backups, or keep them where only you can read them. Store the passphrase somewhere
other than the backups. Copy backups off the host as well: a backup on the same disk
doesn't survive losing that disk.

A daily backup at 03:30, from root's crontab:

```text
30 3 * * * cd /srv/sling/deploy && SLING_BACKUP_PASSPHRASE_FILE=/root/sling-backup.pass ./backup.sh --dir /srv/backups/sling --keep 30 >>/var/log/sling-backup.log 2>&1
```

You lose whatever changed after the last backup, so the schedule sets how much work
a restore can lose.

## Restoring

On a fresh host, check out the same Sling revision as the backup (or a newer one;
migrations run on start), then:

```sh
cd deploy
SLING_BACKUP_PASSPHRASE_FILE=/root/sling-backup.pass ./restore.sh /path/to/sling-20261109T143357Z.tar.enc
```

The script:

1. Decrypts the archive if needed and checks its checksums.
2. Installs the backup's `deploy/.env` when there's none. If `deploy/.env` already
   exists, its `SLING_SECRET_KEY` must match the backup's, and the rest of it, such
   as a new address or port, is kept.
3. Starts Postgres and refuses to continue if the database already has data. Pass
   `--force` to replace it.
4. Stops Sling, sets `SLING_AUTOMATION_PAUSED=1` in `deploy/.env`, and loads the dump
   in one transaction, so a failed restore leaves the database empty rather than half
   loaded.
5. Starts Sling and waits until it's ready.

Nothing changes until the archive is verified and the secret key matches, and a
refused restore leaves the running server and its `deploy/.env` alone.

### Automation stays paused

With `SLING_AUTOMATION_PAUSED=1`, the restored server answers sign-in and shows all
data, but holds back everything that acts on its own:

- Workflow runs: nothing executes, including runs that were in progress at backup
  time. New runs wait in the queue.
- Chat replies and task-settlement deliveries wait in the database.
- Connector sources, such as Discord, Telegram, or a mailbox, don't connect. Their
  installations show as idle.
- Schedules don't fire, and their ticks are dropped rather than saved up. Checks
  don't run.
- Webhooks answer 503 with `Retry-After`, so senders that retry deliver again later.
- Automatic push notifications aren't sent.

`/metrics` reports `sling_automation_paused 1`, and the log says so at startup.
Runners still connect if they're pointed at this server's address.

Before resuming:

- If the original server is still running, stop it, or at least its connectors and
  workflows. Two servers with the same bot tokens and mailboxes would both answer.
- Runs that were in progress at backup time continue when you resume. If the original
  finished some of them after the backup, cancel those runs first.
- If the address changed, update webhook senders and pair runners with the new address.

Then remove the setting and restart:

```sh
sed -i.bak '/^SLING_AUTOMATION_PAUSED=/d' .env && docker compose up -d
```

## Restore drill

Run a drill now and then, on a spare machine or under another Compose project name:

```sh
COMPOSE_PROJECT_NAME=sling-drill ./restore.sh /path/to/backup.tar.enc
```

Use a separate checkout so the drill installs its own `deploy/.env`, and give it a free
`SLING_PORT`. The image name is fixed in `docker-compose.yml`, so building in a drill
checkout replaces the `sling:local` image your real install uses; a drill from the
same revision is harmless, but a different one isn't. Remove the drill afterwards with
`docker compose -p sling-drill down -v`. To keep the drill's image separate, add an
override file that sets `services.sling.image` to another name and list it in
`COMPOSE_FILE`.

Measured on 2026-11-09 on an Apple-silicon laptop (Docker with OrbStack, Postgres
18.6), restoring into an empty Compose project on the same machine. Times include
starting Postgres and waiting until Sling is ready.

| Installation | Database | Archive | Backup | Restore | Resume |
|---|---|---|---|---|---|
| One account, one chat, a connector credential, a 91 KB source file, two workflows with three published versions, a few runs | 270 KB dump | 283 KB encrypted | 1.2 s | 8.6 s, of which loading the dump 4 s | 7 s |
| The same plus nine source files totalling 160 MB of text, with 11,006 search chunks | 257 MB on disk | 170 MB encrypted | 18.6 s (17.2 s unencrypted) | 16.3 s, of which loading the dump 13 s | |

Checked on the restored copy: sign-in with the original password; the chat message;
every uploaded file byte for byte; both workflow versions; the stored mail
password, decrypted inside the restored container with the restored key and
compared with the original; a webhook answering 503; the mail connector idle where
the original was connecting; no scheduled run in 75 seconds although the schedule
fires every minute. After resuming, the webhook accepted again, the schedule fired
within a minute, and the mail connector reconnected. A wrong passphrase, a
`deploy/.env` with a different secret key, and a database that already had data
were each refused before anything changed.

Not covered by this drill: passkey sign-in at a different hostname, runners
reconnecting to a restored server, and restoring across Sling versions.
