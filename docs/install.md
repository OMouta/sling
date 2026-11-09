# Install the control plane

The control plane is one container plus Postgres, run with Docker Compose.

## Requirements

- Docker with the Compose plugin
- A hostname your browser and your Runners can reach. See [remote-access.md](remote-access.md) if the server lives at home.

## Set up

```sh
cd deploy
./setup.sh
```

The script asks how Sling should be reached, then writes `deploy/.env`, generates its secrets, and builds and starts the containers:

| Choice | Address | Who can reach it |
|---|---|---|
| This computer | `http://localhost:8080` | This computer only |
| Local network | `http://<this computer's LAN address>:8080` | Devices on the same network, over plain HTTP |
| Tailscale | `https://<name>.<tailnet>.ts.net` | Your devices on your tailnet, at home and away |
| Cloudflare Tunnel | `https://<your hostname>` | Anyone, from anywhere |

Sling works at one address at a time, so pick the one your phone will use. Only the two HTTPS choices let a phone add Sling to its home screen and get [push notifications](notifications.md). Run `./setup.sh` again to change it. It keeps the secrets already in `.env`. [remote-access.md](remote-access.md) covers the tunnels in more detail.

On a machine without bash, or to set it up by hand:

```sh
cd deploy
cp .env.example .env
```

Fill in `.env`:

| Variable | What it's for |
|---|---|
| `SLING_PUBLIC_URL` | The URL browsers and Runners use, for example `https://sling.example.com`. Login cookies, passkeys, and the origin check all depend on it matching exactly. |
| `SLING_SECRET_KEY` | Master secret, at least 32 characters. Generate it with `openssl rand -base64 48`. API keys are encrypted with a key derived from it, so losing it means re-entering them. |
| `POSTGRES_PASSWORD` | Password for the bundled Postgres. |
| `SLING_PORT` | Host port to publish. Default `8080`. |
| `SLING_BIND` | Where to publish it: `127.0.0.1` (default) for this computer and a tunnel only, `0.0.0.0` for the local network too. |
| `COMPOSE_PROFILES` | `tailscale` or `cloudflare` to run that tunnel next to Sling. Its secret goes in `deploy/tunnel.env`. |
| `LOG_LEVEL` | `info` by default. |
| `SLING_SHUTDOWN_TIMEOUT_SECONDS` | Optional. Longest a stop may take. Default `60`. See [below](#control-plane-topology-and-health). |
| `SLING_AUTOMATION_PAUSED` | Optional. `1` holds back workflow runs, chat replies, deliveries, connector sources, schedules, checks, webhooks, and push until a start without it. A restore sets it. See [backup.md](backup.md). |
| `SLING_METRICS_TOKEN` | Optional. Turns on Prometheus metrics at `/metrics` for requests that send it as a bearer token. See [Metrics](#metrics). |
| `SLING_STOP_GRACE_PERIOD` | Optional. How long Compose waits before killing the container. Default `75s`. Keep it at least 15 seconds above the shutdown timeout. |
| `SLING_RELEASE_REPO` | Optional. The GitHub repo, as `owner/name`, whose releases Sling gets `sling-runner` from for the install command. Default `OMouta/sling`. Set it when you publish your own builds. |
| `SLING_ALLOW_UNSIGNED_EXTENSIONS` | Optional, for developing extensions. `1` lets you install unsigned packages and add catalogs on loopback addresses. Leave it off otherwise: the web app can't turn it on, which is the point. |

Start it:

```sh
docker compose up -d
docker compose logs -f sling
```

Open `SLING_PUBLIC_URL`. The first visit creates the only account. Opened at any other address, Sling says where it lives instead of showing the sign-in form, since sign-in only works at that one address. Add a passkey or an authenticator app under **Settings** afterwards, since this account can start work on your machines.

## TLS

Put a reverse proxy with TLS in front. Caddy does it in two lines and passes WebSockets through on its own:

```text
sling.example.com {
  reverse_proxy localhost:8080
}
```

With Tailscale or Cloudflare Tunnel you get TLS from them instead. See [remote-access.md](remote-access.md).

## Models

The assistant chats through Codex or Claude Code on a paired machine, on the login that's already there, so a ChatGPT or Claude subscription covers it and you don't need an API key. Pick the model from the chat's model picker. See [runner.md](runner.md#chat).

API keys are optional, for chatting when no machine is on or through another provider. Under **Settings**, each provider has one row showing how it's connected, with **Add API key** next to it:

- **OpenAI** or **Anthropic** with an API key. The dialog links to where to make one.
- **Local or other** for Ollama, LM Studio, OpenRouter, and similar. Picking one fills in its address, such as `http://host.docker.internal:11434/v1` for Ollama on the Docker host.

Sling checks the key by listing the models it can see, and a key the provider refuses isn't kept. Then you pick the model new chats start with from that list, or keep the one they use now. The key is encrypted at rest with AES-256-GCM. On a connected provider, **Test** makes one small call.

## Connectors

Discord and email are set up in the web app under **Connectors**. Their credentials are encrypted the same way as model keys. Setup guides: [Discord](connectors/discord.md), [Email](connectors/email.md).

The server reaches Discord and your mail server from inside the container, so it needs outbound access to `discord.com` and your IMAP and SMTP hosts.

## Extensions

The image includes Sling's own catalog of extensions, under **Extensions → Discover**. Others come from catalogs you add by URL, which the server fetches over HTTPS. An installed extension reaches only the hosts it declared, through the server, so the container needs outbound access to those hosts as well. See [extensions](extensions/README.md).

Extension code needs Node 26, which the image has. If you run the server outside Docker on an older Node, it starts, but no extension code runs.

## Upgrades

```sh
git pull
docker compose up -d --build
```

Migrations run on startup.

## Backups

Everything Sling stores lives in Postgres, and `deploy/.env` holds the key its
credentials are encrypted with. Back up both:

```sh
cd deploy
SLING_BACKUP_PASSPHRASE_FILE=/root/sling-backup.pass ./backup.sh
```

`./restore.sh` puts a backup back with automation paused. [backup.md](backup.md)
covers what a backup needs, scheduling, encryption, restoring, and measured times.

## Control-plane topology and health

Run one active Sling control-plane process per database. Runner connections, live
replies, and temporary chat approvals belong to that process. A shared Postgres
queue does not make multiple API replicas safe, and sticky browser sessions do
not route background work to the process that owns a runner. Stop the old process
before starting its replacement.

`/healthz` checks that the HTTP process answers. `/readyz` also checks startup,
shutdown state, and a bounded database probe. Use readiness for traffic routing;
do not restart the server solely because Postgres is temporarily unavailable.

On SIGTERM or SIGINT the server stops reporting ready, refuses new requests, stops
taking new jobs and connector events, waits for work in progress, and closes
connections last. The whole stop shares one deadline,
`SLING_SHUTDOWN_TIMEOUT_SECONDS` (default 60). Work still running at the deadline
is cut off and picked up again on the next start, and the process exits non-zero.
A second signal doesn't start cleanup again. Compose waits
`SLING_STOP_GRACE_PERIOD` (default `75s`) before killing the container; keep it at
least 15 seconds above the shutdown timeout. If startup fails partway, for example
during a migration, the server closes its database connections and releases its
control-plane lock before exiting non-zero, so the restarted container can take
over.

Forwarded client addresses are trusted only from `SLING_TRUSTED_PROXIES`, a
comma-separated list of proxy IPs or CIDRs. Leave it empty for direct access.
For a tunnel or reverse proxy, list its actual source address or isolated proxy
network, and prevent direct public access to the application port. Avoid trusting
all addresses. Do not log full webhook URLs or OAuth callback query strings in
your proxy: those contain credentials, even though Sling redacts its own request
URLs.

## Metrics

`/metrics` is off by default and answers 404. To turn it on, set
`SLING_METRICS_TOKEN` in `deploy/.env` to a random string of at least 32
characters (`openssl rand -hex 32`) and restart. The endpoint then answers in the
Prometheus text format to requests with `Authorization: Bearer <token>`, and 401 to
anything else. It's served on the same port as the app, so it's reachable wherever
Sling is. Keep the token secret, or block `/metrics` at your proxy and scrape over
a private network.

```yaml
scrape_configs:
  - job_name: sling
    scheme: https
    authorization:
      credentials: <SLING_METRICS_TOKEN>
    static_configs:
      - targets: [sling.example.com]
```

| Metric | What it shows |
|---|---|
| `sling_http_request_duration_seconds` | Histogram of request time by method, route pattern (`/api/tasks/:id`, never the raw URL), and status. |
| `sling_job_queue_jobs{queue,state}` | Background jobs per queue: `waiting` (due), `deferred` (scheduled for later), `active`. |
| `sling_job_queue_lag_seconds{queue}` | How long the oldest due job has waited for a worker. A stalled worker shows up here. |
| `sling_job_queue_age_seconds{queue}` | Age of the oldest waiting job, including time spent between retries. |
| `sling_deliveries_pending{kind}`, `sling_deliveries_failing{kind}` | Chat dispatches and task-settlement deliveries not yet done, and those that failed at least once and are retrying. |
| `sling_delivery_lag_seconds{kind}` | How long the oldest due delivery has waited. |
| `sling_delivery_failures_total{kind}` | Failed delivery attempts since the process started. |
| `sling_runners_connected`, `sling_runners_registered` | Runners connected to this process, and paired runners that aren't revoked. |
| `sling_event_loop_delay_p50_seconds`, `_p99_seconds`, `_max_seconds` | Event loop delay since the previous scrape. |
| `sling_process_resident_memory_bytes`, `sling_process_heap_used_bytes` | Process memory. |
| `sling_scrape_collector_success{collector="database"}` | 0 when the scrape couldn't read the database. The queue and delivery series are missing from that scrape. |

Counters and the request histogram start from zero when the process restarts. The
queue and delivery numbers come from Postgres on each scrape, bounded to two
seconds. The event loop numbers cover the time since the last scrape by anyone,
so scrape from one Prometheus.

Runner connectivity is reported here only. An offline runner never makes `/readyz`
fail, since the API, chats through API keys, and workflows keep working without it.

Starting points for alerts:

| Condition | Meaning |
|---|---|
| `sling_job_queue_lag_seconds{queue="workflow-run"} > 60` for 5 minutes | Workflow runs aren't being picked up. |
| `sling_deliveries_failing > 0` for 15 minutes | A consumer keeps failing. The log has the delivery ID and attempt count. |
| `sling_scrape_collector_success{collector="database"} == 0` | Sling can't reach Postgres. `/readyz` fails too; don't restart Sling for it. |
| `sling_runners_connected` below the number of machines you expect | A machine is offline. |
| `sling_event_loop_delay_p99_seconds > 0.2` | The server is CPU-bound or blocked; requests and live updates slow down. |

## Automation admission and storage limits

Workflow HTTP requests now accept public destinations by default. Before upgrading
an installation whose workflows call internal services, set
`SLING_HTTP_ALLOWED_ORIGINS` to a comma-separated list of exact origins, including
ports, such as `http://internal-service:8080`. Redirect destinations are checked
again. Source-link fetching remains public-only.

Set `SLING_WEBHOOK_SECRET` to require HMAC-SHA256 authentication on webhook requests.
The sender supplies `x-sling-timestamp` as Unix seconds and `x-sling-signature` as
hexadecimal HMAC over the timestamp, a period, and the exact request bytes.
Signatures expire after five minutes. Rotate this secret through the server's
environment and coordinate the change with senders. Without this setting, webhook
URLs remain bearer credentials. `x-sling-event-id` deduplicates repeated deliveries
within a workflow trigger. Signed requests without an event ID deduplicate by
timestamp and body. Duplicate events return 409.

`SLING_WEBHOOK_REQUESTS_PER_MINUTE` defaults to 60 per workspace, with an additional
per-IP limit of twice that value. Excess requests return 429 and Retry-After.
These admission counters reset on process restart; they are not billing quotas.

`SLING_SOURCE_STORAGE_BYTES` defaults to 1073741824 bytes per workspace. Uploads
serialize their quota check with insertion, so simultaneous uploads cannot both
spend the same free space. Set zero to disable the quota. Existing files remain
available when usage exceeds a newly lowered limit; remove unused sources before
uploading more. There is no new storage-management screen in this change.

Chat messages and attachments commit with a durable dispatch record. Failed
workflow dispatches retry with exponential backoff capped at five minutes.
Task settlement consumers have independent delivery receipts. Delivery failures
are logged with the delivery ID and attempt count. Temporary command approvals
still fail closed on restart; they are not resumable executions.
