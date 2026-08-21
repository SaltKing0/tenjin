#!/usr/bin/env bash
# Build the Tenjin Console into a single minified, self-contained bundle.
# The console is served to the browser as ONE file (app.bundle.js) instead of
# 15 separate ES modules, so the real browser load is ~43 KB instead of ~94 KB
# (Epic #292 performance budget: <= 80 KB). This artifact is committed; re-run
# after any change under src/gateway/console/ so the served bundle stays current.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-$HOME/.local/bin/bun}"
"$BUN" build \
  "$ROOT/src/gateway/console/app.js" \
  --minify --target=browser \
  --outfile="$ROOT/src/gateway/console/app.bundle.js"
echo "console bundle built: $(wc -c < "$ROOT/src/gateway/console/app.bundle.js") bytes"
