# Reach Sling from outside your network

Runners always connect out to the control plane, so they never need open ports. The question is how your phone and your Runners reach a control plane that lives at home. Sling doesn't run a relay of its own. It runs Tailscale or Cloudflare Tunnel next to it instead, if you pick one.

`deploy/setup.sh` sets either one up for you. Pick it when the script asks how Sling should be reached. This page says what each one does, and how to set it up by hand.

Sling works at one address at a time, `SLING_PUBLIC_URL`. With a tunnel, that's the tunnel's HTTPS address, at home and away. Sign-in, passkeys, and paired machines all go with that address. Opened at another address, Sling points you to the right one.

| | Tailscale | Cloudflare Tunnel |
|---|---|---|
| Address | `https://<name>.<tailnet>.ts.net` | `https://<your hostname>` |
| Who can reach it | Only your devices on your tailnet | Anyone with the address |
| On the phone | The Tailscale app | Nothing |
| You need | A Tailscale account | A domain in a Cloudflare account |
| At home | Stays on your network | Goes out through Cloudflare and back |
| Push notifications | Yes. Opening Sling from one needs the tailnet | Yes |

With either one, Sling is published on `127.0.0.1` only, so the tunnel is the only way in from other devices.

Both give Sling an HTTPS address, which browsers need before they let you add Sling to a phone's home screen or turn on [push notifications](notifications.md). The push itself goes from your server to Apple's, Google's, or Mozilla's push service, encrypted for your device, and from there to the phone, so it arrives even when the phone is away from home.

## Tailscale

The `tailscale` service in `deploy/docker-compose.yml` joins your tailnet as its own machine and serves Sling over HTTPS with a real certificate. Nothing is exposed to the public internet.

Before you start, in the Tailscale admin console:

1. Under [DNS](https://login.tailscale.com/admin/dns), turn on MagicDNS and HTTPS Certificates.
2. Under [Keys](https://login.tailscale.com/admin/settings/keys), generate an auth key.

`setup.sh` asks for the key, starts the container, reads its address from Tailscale, and sets `SLING_PUBLIC_URL` to it. The key is only needed to join: Tailscale keeps its state in the `sling-tailscale` volume, and the script deletes the key afterwards.

By hand: put `TS_AUTHKEY=tskey-...` in `deploy/tunnel.env`, set `COMPOSE_PROFILES=tailscale` in `deploy/.env`, run `docker compose up -d tailscale`, and read the machine's name with `docker compose exec tailscale tailscale status`. Set `SLING_PUBLIC_URL=https://<that name>`, then `docker compose up -d`. `SLING_TAILSCALE_HOSTNAME` picks the machine name (default `sling`).

Install Tailscale on your phone and on each Runner machine, sign in to the same tailnet, and pair Runners with the `https://...ts.net` address.

If the server already runs Tailscale itself, you can skip the container: `tailscale serve --bg 8080` on the server serves the same thing.

## Cloudflare Tunnel

The `cloudflared` service connects a tunnel you create in Cloudflare. Cloudflare holds the public hostname and sends its traffic down the tunnel, so no port opens on your network.

In the Cloudflare Zero Trust dashboard, under **Networks → Tunnels**:

1. Create a Cloudflared tunnel.
2. Add a public hostname, for example `sling.example.com`, with service type **HTTP** and URL `sling:8080`.
3. Copy the tunnel's token: the long string after `--token` in its install command.

`setup.sh` asks for the hostname and the token. By hand: put `TUNNEL_TOKEN=...` in `deploy/tunnel.env`, set `COMPOSE_PROFILES=cloudflare` and `SLING_PUBLIC_URL=https://sling.example.com` in `deploy/.env`, then `docker compose up -d`. The token stays in `tunnel.env`, which only the `cloudflared` container reads. WebSockets pass through by default.

The sign-in page is public with a tunnel like this, so turn on two-factor under **Settings**.

If you put Cloudflare Access in front, the browser login works as usual, but Runners can't do a browser login. Add a bypass policy for `/runner/v1/ws` and `/api/runner/pair`, and for `/install.sh`, `/install.ps1`, and `/runner/download/` so the install command works. The first two are protected by the Runner's signed handshake and the one-time pairing code; the others only hand out the public install scripts and `sling-runner` builds.

## Moving to a new address

When `SLING_PUBLIC_URL` changes, for example from the local network to a tunnel, point each paired machine at the new address and restart its Runner:

```sh
sling-runner config set server-url https://sling.tail1234.ts.net
```

The machine keeps its pairing. Passkeys belong to the old address, so add one again under **Settings**.

## Plain reverse proxy

If the server has a public IP, use Caddy or nginx with TLS, and set `SLING_BIND=0.0.0.0` if the proxy runs on another machine. See [install.md](install.md#tls). The proxy has to pass WebSocket upgrades for `/api/ws` and `/runner/v1/ws`.
