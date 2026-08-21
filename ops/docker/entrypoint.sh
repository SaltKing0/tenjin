#!/bin/sh
# Tenjin gateway container entrypoint.
#
#  1. Makes sure the home volume is ready.
#  2. On first boot the gateway refuses to start without at least one bot (the
#     web console needs a `defaultBot`), so we seed one if none exist.
#  3. Then execs the gateway so signals and pid 1 behave normally.
set -e

cd /app
export TENJIN_HOME="${TENJIN_HOME:-/data}"
mkdir -p "$TENJIN_HOME"

if [ -z "$(ls -A "$TENJIN_HOME/bots" 2>/dev/null)" ]; then
  echo "[tenjin] no bots yet — seeding a 'default' bot on a fresh home volume"
  bun run src/index.ts bot new default
fi

echo "[tenjin] starting gateway (TENJIN_HOME=$TENJIN_HOME)"
exec "$@"
