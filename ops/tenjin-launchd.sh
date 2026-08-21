#!/usr/bin/env bash
# launchd wrapper for `tenjin gateway` (macOS).
#
# launchd plists have no EnvironmentFile directive, so secrets are kept out of
# the (committed, world-readable) plist and loaded from a 0600 env file here,
# then we `exec` the real process so KeepAlive restarts the gateway itself.
#
# Secrets: ~/.tenjin/gateway.env   (chmod 600)  — see ops/gateway.env.example
set -euo pipefail

ENV_FILE="${TENJIN_ENV_FILE:-$HOME/.tenjin/gateway.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec /opt/homebrew/bin/bun run /path/to/stealth/src/index.ts gateway
