#!/usr/bin/env bash
# launchd wrapper for `tenjin gateway` (macOS).
#
# launchd plists have no EnvironmentFile directive, so secrets are kept out of
# the (committed, world-readable) plist and loaded from a 0600 env file here,
# then we `exec` the real process so KeepAlive restarts the gateway itself.
#
# Secrets: ~/.tenjin/gateway.env   (chmod 600)  — see ops/gateway.env.example
#
# No hardcoded binaries/paths here — resolve them so this works on Apple Silicon
# and Intel, Homebrew and non-Homebrew installs alike (#242):
#   TENJIN_BUN   path to the bun binary (default: `command -v bun`; must exist)
#   TENJIN_REPO  path to the Tenjin checkout (default: parent dir of this script)
#   TENJIN_ENV_FILE  secrets file to source before exec
#                    (default: $HOME/.tenjin/gateway.env)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${TENJIN_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${TENJIN_ENV_FILE:-$HOME/.tenjin/gateway.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BUN="${TENJIN_BUN:-}"
if [[ -z "$BUN" ]]; then
  BUN="$(command -v bun || true)"
fi
if [[ -z "$BUN" ]]; then
  echo "error: bun not found on PATH — set TENJIN_BUN to the bun binary path" >&2
  exit 1
fi

exec "$BUN" run "$REPO/src/index.ts" gateway
