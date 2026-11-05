#!/bin/sh
# Installs sling-runner from GitHub Releases. Given a pairing code, it also
# pairs this machine with Sling and starts the Runner in the background.
#
#   curl -fsSL https://<your-sling>/install.sh | SLING_CODE=<code> sh
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | SLING_REPO=<owner>/<repo> sh
#
# Options (environment variables):
#   SLING_URL       Sling's public URL, to pair with.
#   SLING_CODE      Pairing code from Machines > Add machine. With SLING_URL,
#                   the script runs `sling-runner pair` and
#                   `sling-runner service install`.
#   SLING_REPO      GitHub repo to download from, as owner/name. When it's
#                   empty and sling-runner is already on PATH, the download is
#                   skipped.
#   SLING_VERSION   Release tag, for example v0.1.0. Defaults to the latest.
#   SLING_BIN_DIR   Install directory. Defaults to ~/.local/bin.
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

  if [ "$VERSION" = "latest" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
    [ -n "$VERSION" ] || { echo "Could not find the latest release of $REPO" >&2; exit 1; }
  fi

  name="sling-runner-$VERSION-$target"
  base="https://github.com/$REPO/releases/download/$VERSION"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading $name"
  curl -fsSL "$base/$name.tar.gz" -o "$tmp/$name.tar.gz"
  curl -fsSL "$base/$name.tar.gz.sha256" -o "$tmp/$name.tar.gz.sha256"
  (
    cd "$tmp"
    if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$name.tar.gz.sha256" >/dev/null
    else shasum -a 256 -c "$name.tar.gz.sha256" >/dev/null; fi
  ) || { echo "Checksum mismatch, not installing." >&2; exit 1; }

  tar xzf "$tmp/$name.tar.gz" -C "$tmp"
  mkdir -p "$BIN_DIR"
  install -m 0755 "$tmp/$name/sling-runner" "$BIN_DIR/sling-runner"
  echo "Installed $BIN_DIR/sling-runner ($VERSION)"

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "Add $BIN_DIR to your PATH to run sling-runner." ;;
  esac
}

if [ -z "$REPO" ] && command -v sling-runner >/dev/null 2>&1; then
  runner=$(command -v sling-runner)
  echo "Using $runner, which is already installed."
elif [ -z "$REPO" ]; then
  echo "Set SLING_REPO to the GitHub repo that publishes Sling, for example SLING_REPO=owner/sling" >&2
  exit 1
else
  download
  runner="$BIN_DIR/sling-runner"
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
