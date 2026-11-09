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

Everything lives in Postgres:

```sh
docker compose exec postgres pg_dump -U sling sling > sling-$(date +%F).sql
```

Back up `deploy/.env` too. Without `SLING_SECRET_KEY` the stored API keys can't be decrypted.

## Control-plane topology and health

Run one active Sling control-plane process per database. Runner connections, live
replies, and temporary chat approvals belong to that process. A shared Postgres
queue does not make multiple API replicas safe, and sticky browser sessions do
not route background work to the process that owns a runner. Stop the old process
before starting its replacement.

`/healthz` checks that the HTTP process answers. `/readyz` also checks startup,
shutdown state, and a bounded database probe. Use readiness for traffic routing;
do not restart the server solely because Postgres is temporarily unavailable.
The Compose service has a 75-second stop grace period for in-flight work.

Forwarded client addresses are trusted only from `SLING_TRUSTED_PROXIES`, a
comma-separated list of proxy IPs or CIDRs. Leave it empty for direct access.
For a tunnel or reverse proxy, list its actual source address or isolated proxy
network, and prevent direct public access to the application port. Avoid trusting
all addresses. Do not log full webhook URLs or OAuth callback query strings in
your proxy: those contain credentials, even though Sling redacts its own request
URLs.

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
