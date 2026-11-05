# Reach Sling from outside your network

Runners always connect out to the control plane, so they never need open ports. The question is how your phone and your Runners reach a control plane that lives at home. Sling doesn't ship a relay (D9). Use one of these.

Whatever you pick, set `SLING_PUBLIC_URL` in `deploy/.env` to the exact URL you'll open in the browser, then `docker compose up -d` again.

## Tailscale

Good when every device that talks to Sling can join your tailnet.

On the server:

```sh
tailscale serve --bg 8080
```

That serves `https://<server>.<tailnet>.ts.net` with a valid certificate and forwards to Sling on port 8080. Set:

```text
SLING_PUBLIC_URL=https://<server>.<tailnet>.ts.net
```

Install Tailscale on your phone and on each Runner machine, then pair Runners with that URL. Nothing is exposed to the public internet.

## Cloudflare Tunnel

Good when you want a public hostname without opening ports.

```sh
cloudflared tunnel login
cloudflared tunnel create sling
cloudflared tunnel route dns sling sling.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: sling
credentials-file: /home/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: sling.example.com
    service: http://localhost:8080
  - service: http_status:404
```

Run `cloudflared tunnel run sling` and set `SLING_PUBLIC_URL=https://sling.example.com`. WebSockets pass through by default.

If you put Cloudflare Access in front, the browser login works as usual, but Runners can't do a browser login. Add a bypass policy for `/runner/v1/ws` and `/api/runner/pair`. Those paths are protected by the Runner's signed handshake and the one-time pairing code.

## Plain reverse proxy

If the server has a public IP, use Caddy or nginx with TLS. See [install.md](install.md#tls). The proxy has to pass WebSocket upgrades for `/api/ws` and `/runner/v1/ws`.
