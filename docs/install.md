# Install the control plane

The control plane is one container plus Postgres, run with Docker Compose.

## Requirements

- Docker with the Compose plugin
- A hostname your browser and your Runners can reach. See [remote-access.md](remote-access.md) if the server lives at home.

## Set up

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
| `LOG_LEVEL` | `info` by default. |

Start it:

```sh
docker compose up -d
docker compose logs -f sling
```

Open `SLING_PUBLIC_URL`. The first visit creates the only account. Add a passkey or an authenticator app under **Settings** afterwards, since this account can start work on your machines.

## TLS

Put a reverse proxy with TLS in front. Caddy does it in two lines and passes WebSockets through on its own:

```text
sling.example.com {
  reverse_proxy localhost:8080
}
```

With Tailscale or Cloudflare Tunnel you get TLS from them instead. See [remote-access.md](remote-access.md).

## Models

Under **Settings**, pick a provider:

- **OpenAI** or **Anthropic** with an API key.
- **OpenAI-compatible** for Ollama, OpenRouter, LM Studio, and similar. For Ollama on the Docker host, use `http://host.docker.internal:11434/v1`.

The key is encrypted at rest with AES-256-GCM. **Test connection** makes one small call.

## Connectors

Discord and email are set up in the web app under **Connectors**. Their credentials are encrypted the same way as model keys. Setup guides: [Discord](connectors/discord.md), [Email](connectors/email.md).

The server reaches Discord and your mail server from inside the container, so it needs outbound access to `discord.com` and your IMAP and SMTP hosts.

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
