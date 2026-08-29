#!/bin/sh
# Tenjin one-command installer (B15-5, #442).
#
#   curl -fsSL https://raw.githubusercontent.com/SaltKing0/Stealth/main/install.sh | sh
#   sh install.sh [--platform=<os>] [--arch=<arch>] [--version=<tag>] [--dir=<dest>]
#
# Resolves the host platform/arch, downloads the matching release binary from
# the GitHub release, verifies its sha256 against the published SHA256SUMS
# manifest, and installs it into ~/.local/bin (or --dir). Fails GRACEFULLY with
# a clear message on any unsupported platform/arch — it never guesses.
set -eu

REPO="${TENJIN_REPO:-SaltKing0/Stealth}"
VERSION="${TENJIN_VERSION:-latest}"
RELEASES_URL="${TENJIN_RELEASES_URL:-https://github.com/${REPO}/releases}"

# --- parse args (platform/arch overridable for tests + unusual hosts) ---
PLATFORM=""
ARCH=""
INSTALL_DIR=""
for arg in "$@"; do
  case "$arg" in
    --platform=*) PLATFORM="${arg#--platform=}" ;;
    --arch=*) ARCH="${arg#--arch=}" ;;
    --version=*) VERSION="${arg#--version=}" ;;
    --dir=*) INSTALL_DIR="${arg#--dir=}" ;;
  esac
done

# --- auto-detect platform/arch from the host when not given ---
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Linux) PLATFORM=linux ;;
    Darwin) PLATFORM=darwin ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
    *) echo "tenjin: unsupported platform '$(uname -s)'" >&2; exit 1 ;;
  esac
fi
if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "tenjin: unsupported architecture '$(uname -m)'" >&2; exit 1 ;;
  esac
fi

# --- deny-by-default: only the six supported targets pass ---
case "$PLATFORM:$ARCH" in
  linux:x64|linux:arm64|darwin:x64|darwin:arm64|windows:x64|windows:arm64) ;;
  *)
    echo "tenjin: unsupported platform/architecture '$PLATFORM/$ARCH' (supported: linux, darwin, windows x x64, arm64)" >&2
    exit 1
    ;;
esac

EXT=""
[ "$PLATFORM" = "windows" ] && EXT=".exe"
NAME="tenjin-${PLATFORM}-${ARCH}${EXT}"
INSTALL_NAME="tenjin${EXT}"
DEST="${INSTALL_DIR:-${TENJIN_INSTALL_DIR:-$HOME/.local/bin}}"
mkdir -p "$DEST"

if [ "$VERSION" = "latest" ]; then
  DL_URL="${RELEASES_URL}/latest/download/${NAME}"
  SUM_URL="${RELEASES_URL}/latest/download/SHA256SUMS"
else
  DL_URL="${RELEASES_URL}/download/${VERSION}/${NAME}"
  SUM_URL="${RELEASES_URL}/download/${VERSION}/SHA256SUMS"
fi

# SKIP_DOWNLOAD=1 verifies the install logic (platform/arch/dest) without
# fetching — used by CI/tests, never by end users.
if [ -n "${SKIP_DOWNLOAD:-}" ]; then
  echo "tenjin: install logic OK for ${PLATFORM}/${ARCH} -> ${DEST}/${INSTALL_NAME} (SKIP_DOWNLOAD)" >&2
  exit 0
fi

TMP_ROOT="${TMPDIR:-/tmp}"
TMP="$(mktemp -d "${TMP_ROOT%/}/tenjin-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
DOWNLOADED="${TMP}/${NAME}"
SUMS="${TMP}/SHA256SUMS"

echo "tenjin: installing $PLATFORM/$ARCH ($VERSION) -> ${DEST}/${INSTALL_NAME}"
curl -fsSL "$DL_URL" -o "$DOWNLOADED"
curl -fsSL "$SUM_URL" -o "$SUMS"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else echo ""; fi
}

EXPECTED="$(awk -v name="$NAME" '$2 == name || $2 == "*" name { print $1; exit }' "$SUMS")"
ACTUAL="$(sha256_of "$DOWNLOADED")"
if [ -n "$EXPECTED" ] && [ -n "$ACTUAL" ] && [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "tenjin: checksum ok"
else
  echo "tenjin: checksum mismatch for ${NAME} (expected ${EXPECTED:-none}, got ${ACTUAL:-none})" >&2
  exit 1
fi

chmod +x "$DOWNLOADED"
mv "$DOWNLOADED" "${DEST}/${INSTALL_NAME}"
echo "tenjin: installed ${DEST}/${INSTALL_NAME}"
echo "tenjin: add to PATH: export PATH=\"${DEST}:\$PATH\""
