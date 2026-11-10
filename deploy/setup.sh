#!/usr/bin/env bash
# Sets up self-hosted Sling with Docker Compose: asks how it should be
# reached, writes .env (and tunnel.env for a tunnel), and starts it.
# Run it again to change how Sling is reached. Secrets already in .env stay.
#
#   ./setup.sh
#   ./setup.sh --mode lan --address 192.168.1.20
#   TS_AUTHKEY=tskey-... ./setup.sh --mode tailscale
#   TUNNEL_TOKEN=... ./setup.sh --mode cloudflare --hostname sling.example.com
#
# Modes: local (this computer), lan (local network), tailscale, cloudflare.
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=.env
TUNNEL_FILE=tunnel.env

mode=""
address=""
hostname_arg=""
port_arg=""
start=1
assume_yes=0

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --mode local|lan|tailscale|cloudflare
  --address HOST      LAN address phones use (lan mode). Found for you when left out.
  --hostname NAME     Tailscale machine name (default sling), or the Cloudflare hostname.
  --port N            Port on this computer (default 8080).
  --no-start          Write the files, don't start anything.
  --yes               Don't ask; take the defaults.
Secrets come from the environment, never from flags: TS_AUTHKEY, TUNNEL_TOKEN.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --address) address="${2:-}"; shift 2 ;;
    --hostname) hostname_arg="${2:-}"; shift 2 ;;
    --port) port_arg="${2:-}"; shift 2 ;;
    --no-start) start=0; shift ;;
    --yes | -y) assume_yes=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Reads KEY from a file of KEY=value lines.
get_env() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Sets KEY=value in a file, replacing the first line for KEY (or a commented
# one), else adding it. The value goes through the environment, so any
# character is safe.
set_env() {
  local key="$1" value="$2" file="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  KEY="$key" VALUE="$value" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
    !done && ($0 ~ "^" key "=" || $0 ~ "^# *" key "=") { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

ask() {
  # ask VAR "Question" default
  local answer=""
  if [ "$assume_yes" = 1 ] || [ ! -t 0 ]; then
    printf -v "$1" '%s' "$3"
    return
  fi
  read -r -p "$2${3:+ [$3]}: " answer || true
  printf -v "$1" '%s' "${answer:-$3}"
}

ask_secret() {
  local answer=""
  [ -t 0 ] || fail "$2 is needed. Set it in the environment when running without a terminal."
  read -r -s -p "$2: " answer || true
  echo
  printf -v "$1" '%s' "$answer"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$1" | tr -d '\n'
  else
    head -c "$1" /dev/urandom | base64 | tr -d '\n'
  fi
}

lan_address() {
  local iface ip=""
  if [ "$(uname)" = Darwin ]; then
    iface="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
    [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  else
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
    [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
  fi
  printf '%s' "$ip"
}

port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

command -v docker >/dev/null 2>&1 || fail "Docker isn't installed. Get it from https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose isn't available. Install the Compose plugin."

# ---------------------------------------------------------------- .env

fresh=0
if [ ! -f "$ENV_FILE" ]; then
  fresh=1
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  bold "Created deploy/$ENV_FILE"
fi
# It holds the secrets, including in a copy made by hand.
chmod 600 "$ENV_FILE"
if [ -z "$(get_env SLING_SECRET_KEY "$ENV_FILE")" ]; then
  set_env SLING_SECRET_KEY "$(random_secret 48)" "$ENV_FILE"
  note "Generated SLING_SECRET_KEY. Keep a copy: stored API keys can't be read without it."
fi
if [ -z "$(get_env POSTGRES_PASSWORD "$ENV_FILE")" ]; then
  set_env POSTGRES_PASSWORD "$(random_secret 24 | tr -d '/+=')" "$ENV_FILE"
fi

old_url="$(get_env SLING_PUBLIC_URL "$ENV_FILE")"
profiles="$(get_env COMPOSE_PROFILES "$ENV_FILE")"
current=local
case "$profiles" in
  *tailscale*) current=tailscale ;;
  *cloudflare*) current=cloudflare ;;
  *) [ "$(get_env SLING_BIND "$ENV_FILE")" = 0.0.0.0 ] && current=lan ;;
esac

port="${port_arg:-$(get_env SLING_PORT "$ENV_FILE")}"
port="${port:-8080}"
running="$(docker compose ps -q sling 2>/dev/null || true)"
if [ -z "$running" ] && port_busy "$port"; then
  if [ -n "$port_arg" ] || [ "$assume_yes" = 1 ] || [ ! -t 0 ]; then
    fail "Port $port is in use. Pick another with --port."
  fi
  ask port "Port $port is already in use on this computer. Port for Sling" "8090"
  port_busy "$port" && fail "Port $port is in use too."
fi
set_env SLING_PORT "$port" "$ENV_FILE"

# ---------------------------------------------------------------- mode

if [ -z "$mode" ]; then
  bold "How should Sling be reached?"
  note "1) This computer only     http://localhost:$port"
  note "2) Local network          http://<this computer's address>:$port, from devices on your Wi-Fi"
  note "3) Tailscale              https://<name>.<tailnet>.ts.net, from your devices anywhere"
  note "4) Cloudflare Tunnel      https://<your hostname>, from anywhere, nothing to install on the phone"
  case "$current" in local) d=1 ;; lan) d=2 ;; tailscale) d=3 ;; cloudflare) d=4 ;; esac
  ask choice "Pick one" "$d"
  case "$choice" in
    1) mode=local ;; 2) mode=lan ;; 3) mode=tailscale ;; 4) mode=cloudflare ;;
    *) fail "Pick 1, 2, 3, or 4." ;;
  esac
fi

url=""
case "$mode" in
  local)
    url="http://localhost:$port"
    set_env SLING_BIND 127.0.0.1 "$ENV_FILE"
    set_env COMPOSE_PROFILES "" "$ENV_FILE"
    ;;
  lan)
    found="$(lan_address)"
    [ -n "$address" ] || ask address "Address your phone and other devices use" "$found"
    [ -n "$address" ] || fail "No address found. Pass one with --address."
    url="http://$address:$port"
    set_env SLING_BIND 0.0.0.0 "$ENV_FILE"
    set_env COMPOSE_PROFILES "" "$ENV_FILE"
    ;;
  tailscale)
    name="${hostname_arg:-$(get_env SLING_TAILSCALE_HOSTNAME "$ENV_FILE")}"
    ask name "Machine name on your tailnet" "${name:-sling}"
    set_env SLING_TAILSCALE_HOSTNAME "$name" "$ENV_FILE"
    key="${TS_AUTHKEY:-}"
    state="$(docker volume ls -q --filter name=sling_sling-tailscale 2>/dev/null || true)"
    if [ -z "$key" ] && [ -z "$state" ]; then
      bold "Tailscale needs an auth key, once."
      note "1. In the admin console, DNS: turn on MagicDNS and HTTPS Certificates."
      note "   https://login.tailscale.com/admin/dns"
      note "2. Generate an auth key (reusable off is fine):"
      note "   https://login.tailscale.com/admin/settings/keys"
      ask_secret key "Auth key (tskey-...)"
      [ -n "$key" ] || fail "An auth key is needed the first time."
    fi
    if [ -n "$key" ]; then
      (umask 077 && printf 'TS_AUTHKEY=%s\n' "$key" > "$TUNNEL_FILE")
    fi
    set_env SLING_BIND 127.0.0.1 "$ENV_FILE"
    set_env COMPOSE_PROFILES tailscale "$ENV_FILE"
    ;;
  cloudflare)
    host="${hostname_arg:-}"
    if [ -z "$host" ]; then
      case "$old_url" in https://*) host="${old_url#https://}" ;; esac
      bold "Cloudflare Tunnel"
      note "1. Zero Trust dashboard, Networks, Tunnels: create a Cloudflared tunnel."
      note "2. Add a public hostname for it, with service HTTP and URL sling:8080."
      ask host "Public hostname, like sling.example.com" "$host"
    fi
    host="${host#https://}"
    host="${host%%/*}"
    [ -n "$host" ] || fail "A hostname is needed."
    token="${TUNNEL_TOKEN:-}"
    if [ -z "$token" ] && [ -z "$(get_env TUNNEL_TOKEN "$TUNNEL_FILE")" ]; then
      note "3. Copy the tunnel's token: the long string after --token in its install command."
      ask_secret token "Tunnel token"
      [ -n "$token" ] || fail "A tunnel token is needed."
    fi
    if [ -n "$token" ]; then
      token="${token##* }"
      (umask 077 && printf 'TUNNEL_TOKEN=%s\n' "$token" > "$TUNNEL_FILE")
    fi
    url="https://$host"
    set_env SLING_BIND 127.0.0.1 "$ENV_FILE"
    set_env COMPOSE_PROFILES cloudflare "$ENV_FILE"
    ;;
  *) fail "Unknown mode $mode. Use local, lan, tailscale, or cloudflare." ;;
esac

# Behind a tunnel, every request reaches Sling from the tunnel's container, so
# per-address limits need the client address it forwards. The app port is
# bound to 127.0.0.1 then, so only Docker's private addresses reach it. A list
# set by hand stays as it is.
TUNNEL_PROXIES="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
proxies="$(get_env SLING_TRUSTED_PROXIES "$ENV_FILE")"
case "$mode" in
  tailscale | cloudflare)
    if [ -z "$proxies" ]; then set_env SLING_TRUSTED_PROXIES "$TUNNEL_PROXIES" "$ENV_FILE"; fi ;;
  *)
    if [ "$proxies" = "$TUNNEL_PROXIES" ]; then set_env SLING_TRUSTED_PROXIES "" "$ENV_FILE"; fi ;;
esac

if [ "$start" = 0 ]; then
  [ -n "$url" ] && set_env SLING_PUBLIC_URL "$url" "$ENV_FILE"
  bold "Wrote deploy/$ENV_FILE${url:+ for $url}. Start it with: docker compose up -d --build"
  exit 0
fi

# ---------------------------------------------------------------- start

# A tunnel that's no longer picked stops.
for svc in tailscale cloudflared; do
  case "$mode:$svc" in tailscale:tailscale | cloudflare:cloudflared) continue ;; esac
  if [ -n "$(docker compose --profile tailscale --profile cloudflare ps -q "$svc" 2>/dev/null)" ]; then
    docker compose --profile tailscale --profile cloudflare rm -sf "$svc" >/dev/null
    note "Stopped the $svc tunnel."
  fi
done

if [ "$mode" = tailscale ]; then
  bold "Starting Tailscale"
  docker compose up -d tailscale
  dns=""
  for _ in $(seq 1 60); do
    json="$(docker compose exec -T tailscale tailscale status --json --peers=false 2>/dev/null || true)"
    case "$json" in *'"BackendState": "NeedsLogin"'*) fail "Tailscale didn't accept the auth key. Run this again with a new one." ;; esac
    dns="$(printf '%s' "$json" | sed -n 's/.*"DNSName": "\([^"]*\)".*/\1/p' | head -n 1)"
    dns="${dns%.}"
    [ -n "$dns" ] && break
    sleep 2
  done
  [ -n "$dns" ] || fail "Tailscale didn't come up. See: docker compose logs tailscale"
  case "$json" in *'"CertDomains": null'* | *'"CertDomains": []'*)
    note "HTTPS Certificates look off for your tailnet. Turn them on at https://login.tailscale.com/admin/dns" ;;
  esac
  url="https://$dns"
  # The key was only needed to join. Tailscale keeps its own state in a volume.
  rm -f "$TUNNEL_FILE"
fi

set_env SLING_PUBLIC_URL "$url" "$ENV_FILE"

bold "Building and starting Sling"
docker compose up -d --build

printf 'Waiting for Sling'
for _ in $(seq 1 90); do
  if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    ok=1
    break
  fi
  printf '.'
  sleep 2
done
echo
[ "${ok:-0}" = 1 ] || fail "Sling didn't answer on port $port. See: docker compose logs sling"

echo
bold "Sling is up at $url"
case "$mode" in
  local) note "Open it in this computer's browser." ;;
  lan)
    note "Open it on any device on the same network."
    note "It's plain HTTP there: your password crosses the network unencrypted, and passkeys"
    note "only work over HTTPS. Tailscale (option 3) gives you HTTPS at home and away."
    note "Give this computer a fixed address in your router, so the address doesn't change."
    ;;
  tailscale)
    note "On your phone and each machine: install Tailscale and sign in to the same tailnet."
    note "Then open the address. It works at home and away."
    ;;
  cloudflare)
    note "Open it from anywhere. The sign-in page is public, so turn on two-factor under Settings."
    ;;
esac
note "New machines: Machines, Add machine, in Sling. Its install command has this address."
if [ "$fresh" = 0 ] && [ -n "$old_url" ] && [ "$old_url" != "$url" ]; then
  echo
  bold "Sling moved from $old_url"
  note "Machines already paired: on each one run"
  note "  sling-runner config set server-url $url"
  note "then restart its Runner. Passkeys belong to the old address; add one again under Settings."
fi
