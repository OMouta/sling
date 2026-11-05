#!/bin/sh
# Installs sling-runner from GitHub Releases.
#
#   curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | sh
#
# Options (environment variables):
#   SLING_REPO      GitHub repo to download from, as owner/name
#   SLING_VERSION   Release tag, for example v0.1.0. Defaults to the latest.
#   SLING_BIN_DIR   Install directory. Defaults to ~/.local/bin.
set -eu

REPO="${SLING_REPO:-}"
VERSION="${SLING_VERSION:-latest}"
BIN_DIR="${SLING_BIN_DIR:-$HOME/.local/bin}"

if [ -z "$REPO" ]; then
  echo "Set SLING_REPO to the GitHub repo that publishes Sling, for example SLING_REPO=owner/sling" >&2
  exit 1
fi

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

cat <<NEXT

Next:
  sling-runner repo add ~/code/your-repo
  sling-runner pair <sling-url> <code from the Machines page>
  sling-runner service install
NEXT
