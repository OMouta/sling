#!/usr/bin/env bash
# Restores a backup made by ./backup.sh into this Compose project, with
# automation paused: workflow runs, chat replies, deliveries, connector sources,
# schedules, checks, webhooks, and push stay off until you resume them, so the
# restored copy can't repeat what the original already did.
#
#   ./restore.sh backups/sling-20261109T143000Z.tar
#   SLING_BACKUP_PASSPHRASE_FILE=/root/sling-backup.pass ./restore.sh sling-....tar.enc
#
# On a fresh host it installs the backup's deploy/.env. If deploy/.env already
# exists, its SLING_SECRET_KEY must match the backup's; everything else in it,
# such as the address and port, stays.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
force=0
file=""

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --force   Replace the database even if it already has data.
The Compose project is the one docker compose picks here; set
COMPOSE_PROJECT_NAME to restore into another.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$file" ] || { usage >&2; exit 2; }; file="$1"; shift ;;
  esac
done

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[ -n "$file" ] || { usage >&2; exit 2; }
[ -f "$file" ] || fail "No such file: $file"
file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
cd "$here"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
get_env() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
# Sets KEY=value in a file, replacing the first line for KEY (or a commented one).
set_env() {
  local key="$1" value="$2" target="$3" tmp
  tmp="$(mktemp "${target}.XXXXXX")"
  KEY="$key" VALUE="$value" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
    !done && ($0 ~ "^" key "=" || $0 ~ "^# *" key "=") { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$target" >"$tmp"
  cat "$tmp" >"$target"
  rm -f "$tmp"
}

umask 077
started=$(date +%s)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

case "$file" in
  *.enc)
    command -v openssl >/dev/null 2>&1 || fail "openssl is needed to decrypt the backup"
    if [ -n "${SLING_BACKUP_PASSPHRASE_FILE:-}" ]; then
      passarg="file:$SLING_BACKUP_PASSPHRASE_FILE"
    elif [ -n "${SLING_BACKUP_PASSPHRASE:-}" ]; then
      passarg="env:SLING_BACKUP_PASSPHRASE"
    else
      fail "The backup is encrypted. Set SLING_BACKUP_PASSPHRASE_FILE or SLING_BACKUP_PASSPHRASE."
    fi
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass "$passarg" \
      -in "$file" -out "$work/backup.tar" 2>/dev/null ||
      fail "Couldn't decrypt the backup. Check the passphrase."
    ;;
  *) cp "$file" "$work/backup.tar" ;;
esac
tar -C "$work" -xf "$work/backup.tar" || fail "The backup isn't a readable archive."
grep -qx "format=sling-backup/v1" "$work/manifest" 2>/dev/null || fail "Not a Sling backup."
(cd "$work" && sha256 -c checksums >/dev/null) || fail "The backup's checksums don't match; it's damaged."
echo "Backup verified: $(grep '^created=' "$work/manifest" | cut -d= -f2), $(grep '^migrations=' "$work/manifest" | cut -d= -f2) migrations."

backup_key=$(get_env SLING_SECRET_KEY "$work/env")
[ -n "$backup_key" ] || fail "The backup has no SLING_SECRET_KEY."
if [ -f .env ]; then
  [ "$(get_env SLING_SECRET_KEY .env)" = "$backup_key" ] ||
    fail "deploy/.env has a different SLING_SECRET_KEY than the backup, so stored credentials couldn't be decrypted. Move deploy/.env aside to use the backup's, or put the backup's key in it."
  if [ "$(get_env SLING_PUBLIC_URL .env)" != "$(get_env SLING_PUBLIC_URL "$work/env")" ]; then
    echo "Note: SLING_PUBLIC_URL differs from the backup's. Passkeys only work at the original hostname, and webhook senders and Runners need the new address."
  fi
  echo "Keeping deploy/.env; its secret matches the backup."
else
  cp "$work/env" .env
  echo "Installed deploy/.env from the backup."
fi
if [ -f "$work/tunnel.env" ] && [ ! -f tunnel.env ]; then cp "$work/tunnel.env" tunnel.env; fi

docker compose up -d --wait postgres
tables=$(docker compose exec -T postgres psql -U sling -d sling -Atc \
  "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")
[ "$tables" = "0" ] || [ "$force" = 1 ] ||
  fail "The database already has data ($tables tables). Restore into an empty project, or pass --force to replace it."
# Nothing may write while the database is replaced, and Sling starts paused from here on.
docker compose stop sling >/dev/null 2>&1 || true
set_env SLING_AUTOMATION_PAUSED 1 .env
if [ "$tables" != "0" ]; then
  echo "Replacing the existing database."
  docker compose exec -T postgres dropdb -U sling --force sling
  docker compose exec -T postgres createdb -U sling -O sling sling
fi
# One transaction: a failed restore leaves the database empty, not half-filled.
docker compose exec -T postgres pg_restore -U sling -d sling --no-owner --exit-on-error \
  --single-transaction <"$work/database.dump"
restored=$(date +%s)
echo "Database restored in $((restored - started))s. Starting Sling with automation paused."

docker compose up -d sling
ready=0
for _ in $(seq 1 120); do
  if docker compose exec -T sling node -e \
    "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = 1 ] || fail "Sling didn't become ready. See: docker compose logs sling"

cat <<EOF
Restored and ready in $(($(date +%s) - started))s.

Automation is paused (SLING_AUTOMATION_PAUSED=1 in deploy/.env). Sign in and check
your data. If the original server is still running, stop it or its connectors
first: both would answer the same bots and mailboxes. Then resume with:

  sed -i.bak '/^SLING_AUTOMATION_PAUSED=/d' .env && docker compose up -d
EOF
