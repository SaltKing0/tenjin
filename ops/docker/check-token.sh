#!/bin/sh
# Refuse to boot the gateway with a missing or well-known GATEWAY_TOKEN.
#
# Issue #239: `docker compose up` with no `.env` used to fall back to a public
# host bind + the known example token `dev-local-token` — the exact pattern
# that has exposed thousands of AI gateways. This guard makes the container
# FAIL CLOSED: if GATEWAY_TOKEN is unset/empty or still the example value,
# we exit non-zero before the gateway (or even the bot seed) runs, forcing the
# operator to set a real secret and match it in config.yaml.
#
# Called from entrypoint.sh as:  sh check-token.sh
# Returns 0 only when GATEWAY_TOKEN is set to a non-example value.
set -u

if [ -z "${GATEWAY_TOKEN:-}" ]; then
  echo "[tenjin] refusing to start: GATEWAY_TOKEN is not set." >&2
  echo "  Copy ops/docker/.env.example to .env, set a strong, unique GATEWAY_TOKEN," >&2
  echo "  and match it as gateway.listen.token in config.yaml." >&2
  exit 1
fi

case "$GATEWAY_TOKEN" in
  dev-local-token)
    echo "[tenjin] refusing to start: GATEWAY_TOKEN is still the well-known example value 'dev-local-token'." >&2
    echo "  Generate a strong, unique token (e.g. \`openssl rand -hex 32\`) and set it in both" >&2
    echo "  .env (GATEWAY_TOKEN) and config.yaml (gateway.listen.token)." >&2
    exit 1
    ;;
esac

exit 0
