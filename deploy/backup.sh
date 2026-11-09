#!/usr/bin/env bash
# Backs up a Docker Compose install of Sling: a consistent dump of its Postgres
# database plus deploy/.env (and deploy/tunnel.env when present), which hold the
# secret every stored credential is encrypted with. Sling keeps running.
#
#   ./backup.sh
#   SLING_BACKUP_PASSPHRASE_FILE=/root/sling-backup.pass ./backup.sh --dir /srv/backups --keep 30
#
# Writes sling-<UTC time>.tar, or sling-<UTC time>.tar.enc when a passphrase is
# given, and then deletes all but the newest --keep backups in that directory.
# Restore with ./restore.sh.
set -euo pipefail

cd "$(dirname "$0")"

dir="${SLING_BACKUP_DIR:-backups}"
keep="${SLING_BACKUP_KEEP:-14}"

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --dir DIR     Where backups go. Default deploy/backups (SLING_BACKUP_DIR).
  --keep N      How many backups to keep in DIR, newest first. Default 14 (SLING_BACKUP_KEEP).
Encryption: set SLING_BACKUP_PASSPHRASE_FILE to a file holding the passphrase,
or SLING_BACKUP_PASSPHRASE. Without either the backup is not encrypted, and it
holds SLING_SECRET_KEY next to the data it protects.
The Compose project is the one docker compose picks here; set
COMPOSE_PROJECT_NAME to back up another.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:?--dir needs a directory}"; shift 2 ;;
    --keep) keep="${2:?--keep needs a number}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
case "$keep" in '' | *[!0-9]* | 0) fail "--keep must be a whole number of at least 1" ;; esac
[ -f .env ] || fail "deploy/.env is missing. It holds SLING_SECRET_KEY, without which stored credentials can't be decrypted."

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

passarg=""
if [ -n "${SLING_BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -r "$SLING_BACKUP_PASSPHRASE_FILE" ] || fail "Can't read $SLING_BACKUP_PASSPHRASE_FILE"
  passarg="file:$SLING_BACKUP_PASSPHRASE_FILE"
elif [ -n "${SLING_BACKUP_PASSPHRASE:-}" ]; then
  passarg="env:SLING_BACKUP_PASSPHRASE"
fi
if [ -n "$passarg" ]; then
  command -v openssl >/dev/null 2>&1 || fail "openssl is needed to encrypt the backup"
fi

umask 077
mkdir -p "$dir"
started=$(date +%s)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "${dir%/}/.sling-$stamp.XXXXXX")
trap 'rm -rf "$work"' EXIT

docker compose ps --status running --services 2>/dev/null | grep -qx postgres ||
  fail "The postgres service isn't running in this Compose project."

# pg_dump reads one snapshot, so the dump is consistent while Sling keeps writing.
docker compose exec -T postgres pg_dump -U sling -d sling --format=custom --compress=6 \
  >"$work/database.dump"
cp .env "$work/env"
files=(database.dump env)
if [ -f tunnel.env ]; then
  cp tunnel.env "$work/tunnel.env"
  files+=(tunnel.env)
fi

pg_version=$(docker compose exec -T postgres psql -U sling -d sling -Atc "show server_version")
migrations=$(docker compose exec -T postgres psql -U sling -d sling -Atc \
  "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo unknown)
{
  echo "format=sling-backup/v1"
  echo "created=$stamp"
  echo "postgres=$pg_version"
  echo "migrations=$migrations"
} >"$work/manifest"
(cd "$work" && sha256 "${files[@]}" >checksums)

name="sling-$stamp.tar"
tar -C "$work" -cf "$work/$name" manifest checksums "${files[@]}"
if [ -n "$passarg" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -md sha256 -pass "$passarg" \
    -in "$work/$name" -out "$work/$name.enc"
  name="$name.enc"
fi
# Same filesystem, so the backup appears whole or not at all.
out="${dir%/}/$name"
mv "$work/$name" "$out"
if [ -z "$passarg" ]; then
  echo "Warning: not encrypted. This file holds SLING_SECRET_KEY; store it somewhere only you can read." >&2
fi

# Retention: the newest $keep backups stay. Names carry the UTC time, so they sort by age.
# shellcheck disable=SC2012 # names are generated above, without spaces
ls -1 "${dir%/}"/sling-*.tar "${dir%/}"/sling-*.tar.enc 2>/dev/null | sort -r | tail -n +"$((keep + 1))" |
  while read -r old; do rm -f -- "$old"; echo "Removed old backup $old"; done || true

size=$(wc -c <"$out" | tr -d ' ')
echo "Backup written: $out ($size bytes, $(($(date +%s) - started))s, $migrations migrations, Postgres $pg_version)"
