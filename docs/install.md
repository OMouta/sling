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
| `SLING_RELEASE_REPO` | Optional. The GitHub repo, as `owner/name`, whose releases the Runner install command downloads. Without it, the command works only on machines that already have `sling-runner`. |
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

- **OpenAI** or **Anthropic** with an API key.
- **OpenAI-compatible** for Ollama, OpenRouter, LM Studio, and similar. For Ollama on the Docker host, use `http://host.docker.internal:11434/v1`.

The key is encrypted at rest with AES-256-GCM. **Test** makes one small call.

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
