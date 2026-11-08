#!/bin/sh
# Installs sling-runner. Given a pairing code, it also pairs this machine with
# Sling and starts the Runner in the background.
#
#   curl -fsSL https://<your-sling>/install.sh | SLING_CODE=<code> sh
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | SLING_REPO=<owner>/<repo> sh
#
# Options (environment variables):
#   SLING_URL       Sling's public URL. The script downloads sling-runner from
#                   there, the version that Sling runs, and pairs with it.
#   SLING_CODE      Pairing code from Machines > Add machine. With SLING_URL,
#                   the script runs `sling-runner pair` and
#                   `sling-runner service install`.
#   SLING_REPO      GitHub repo to download from instead, as owner/name.
#   SLING_VERSION   Release tag to download from SLING_REPO, for example
#                   v0.1.0. Defaults to the latest.
#   SLING_BIN_DIR   Install directory. Defaults to ~/.local/bin.
#
# With neither SLING_URL nor SLING_REPO, it uses the sling-runner on PATH.
set -eu
# sling:defaults

URL="${SLING_URL:-}"
CODE="${SLING_CODE:-}"
REPO="${SLING_REPO:-}"
VERSION="${SLING_VERSION:-latest}"
BIN_DIR="${SLING_BIN_DIR:-$HOME/.local/bin}"

if [ -n "$CODE" ] && [ -z "$URL" ]; then
  echo "Set SLING_URL to Sling's public URL to pair with SLING_CODE." >&2
  exit 1
fi

# Downloads $1 to $2. When the server says no, shows what it said.
fetch() {
  status=$(curl -sSL -o "$2" -w '%{http_code}' "$1") || {
    echo "Couldn't download $1" >&2
    exit 1
  }
  if [ "$status" != 200 ]; then
    echo "Couldn't download $1 (HTTP $status)" >&2
    if [ -s "$2" ]; then printf '%s\n' "$(head -c 1000 "$2")" >&2; fi
    exit 1
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'
  else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}

download() {
  case "$(uname -s)" in
    Darwin) os="apple-darwin" ;;
    Linux) os="unknown-linux-musl" ;;
    *) echo "Unsupported OS: $(uname -s). On Windows, use install.ps1." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch="x86_64" ;;
    arm64 | aarch64) arch="aarch64" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  target="$arch-$os"

  if [ -n "$REPO" ]; then
    if [ "$VERSION" = "latest" ]; then
      VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
      [ -n "$VERSION" ] || { echo "Could not find the latest release of $REPO" >&2; exit 1; }
    fi
    file="sling-runner-$VERSION-$target.tar.gz"
    base="https://github.com/$REPO/releases/download/$VERSION"
  else
    file="sling-runner-$target.tar.gz"
    base="${URL%/}/runner/download"
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading sling-runner for $target from ${REPO:-$URL}"
  fetch "$base/$file" "$tmp/$file"
  fetch "$base/$file.sha256" "$tmp/$file.sha256"
  expected=$(awk '{ print $1; exit }' "$tmp/$file.sha256")
  if [ -z "$expected" ] || [ "$expected" != "$(sha256 "$tmp/$file")" ]; then
    echo "Checksum mismatch, not installing." >&2
    exit 1
  fi

  mkdir "$tmp/unpacked"
  tar xzf "$tmp/$file" -C "$tmp/unpacked"
  mkdir -p "$BIN_DIR"
  install -m 0755 "$tmp"/unpacked/*/sling-runner "$BIN_DIR/sling-runner"
  installed=$("$BIN_DIR/sling-runner" --version 2>/dev/null || echo sling-runner)
  echo "Installed $installed in $BIN_DIR"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "Add $BIN_DIR to your PATH to run sling-runner." ;;
  esac
}

if [ -n "$REPO" ] || [ -n "$URL" ]; then
  download
  runner="$BIN_DIR/sling-runner"
elif command -v sling-runner >/dev/null 2>&1; then
  runner=$(command -v sling-runner)
  echo "Using $runner, which is already installed."
else
  echo "Set SLING_URL to Sling's address, or SLING_REPO to the GitHub repo that publishes Sling, for example SLING_REPO=owner/sling" >&2
  exit 1
fi

if [ -n "$CODE" ]; then
  "$runner" pair "$URL" "$CODE"
  "$runner" service install
  echo
  echo "Choose the repos Sling may use under Machines in Sling."
  exit 0
fi

cat <<NEXT

Next:
  sling-runner pair ${URL:-<sling-url>} <code from Machines > Add machine>
  sling-runner service install
Then choose the repos Sling may use under Machines in Sling.
NEXT
