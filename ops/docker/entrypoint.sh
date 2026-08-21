#!/bin/sh
# Tenjin gateway container entrypoint.
#
#  0. Refuses to start with a missing or well-known GATEWAY_TOKEN (#239).
#  1. Makes sure the home volume is ready.
#  2. On first boot the gateway refuses to start without at least one bot (the
#     web console needs a `defaultBot`), so we seed one if none exist. The name
#     honours the operator's intent instead of hard-coding "default" (#244):
#       - $TENJIN_DEFAULT_BOT (env override, highest precedence), else
#       - a top-level `defaultBot:` in the mounted config.yaml, else
#       - "default".
#  3. A boot consistency check: if the resolved defaultBot name does not exist
#     as a bot, it prints a clear message so the mismatch isn't silent.
#  4. Then execs the gateway so signals and pid 1 behave normally.
set -e

cd "${TENJIN_APP_DIR:-/app}"
export TENJIN_HOME="${TENJIN_HOME:-/data}"
mkdir -p "$TENJIN_HOME"

# #239 fail closed: no gateway with a missing/example REST token. Resolve the
# guard relative to this script (not the cwd) so it works regardless of
# TENJIN_APP_DIR / the mount layout.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sh "$SCRIPT_DIR/check-token.sh"

# Resolve the seed bot name. ENV override wins; otherwise read the first
# top-level `defaultBot:` from the mounted config.yaml (ignoring comments);
# fall back to "default".
resolve_default_bot() {
  if [ -n "$TENJIN_DEFAULT_BOT" ]; then
    printf '%s\n' "$TENJIN_DEFAULT_BOT"
    return 0
  fi
  if [ -f "$TENJIN_HOME/config.yaml" ]; then
    awk -F: '/^[[:space:]]*defaultBot[[:space:]]*:/ {
      sub(/^[[:space:]]*defaultBot[[:space:]]*:[[:space:]]*/, "")
      sub(/[[:space:]]*#.*$/, "")
      gsub(/^["'\''"]|["'\''"]$/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      print
      exit
    }' "$TENJIN_HOME/config.yaml"
    return 0
  fi
  return 0
}

DEFAULT_BOT="$(resolve_default_bot)"
DEFAULT_BOT="${DEFAULT_BOT:-default}"

if [ -z "$(ls -A "$TENJIN_HOME/bots" 2>/dev/null)" ]; then
  echo "[tenjin] no bots yet — seeding a '$DEFAULT_BOT' bot on a fresh home volume"
  bun run src/index.ts bot new "$DEFAULT_BOT"
fi

# #244: surface a configured defaultBot that doesn't exist instead of booting
# silently with a bot the channels/jobs won't match.
if [ ! -d "$TENJIN_HOME/bots/$DEFAULT_BOT" ]; then
  existing="$(ls "$TENJIN_HOME/bots" 2>/dev/null | tr '\n' ' ')"
  echo "[tenjin] WARNING: configured defaultBot '$DEFAULT_BOT' does not exist (existing bots: ${existing:-none})" >&2
  echo "[tenjin] channels/jobs referencing '$DEFAULT_BOT' will fail until it is created (tenjin bot new $DEFAULT_BOT)" >&2
fi

echo "[tenjin] starting gateway (TENJIN_HOME=$TENJIN_HOME, defaultBot=$DEFAULT_BOT)"
exec "$@"
