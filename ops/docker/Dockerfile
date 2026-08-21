# Tenjin gateway — multi-stage server image.
#
# Build from the repository root (so the build context includes src/, package.json
# and bun.lock):
#   docker build -f ops/docker/Dockerfile -t tenjin-gateway .
# Or via compose (recommended): see ops/docker/docker-compose.yml.

# ---- build stage: resolve dependencies from the lockfile ----
FROM oven/bun:1 AS build
WORKDIR /app

# Install production dependencies. The project has zero runtime deps today, but
# freezing the lockfile keeps the runtime stage correct if that ever changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime stage: slim, non-root ----
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Copy installed deps and the application source.
COPY --from=build /app/node_modules ./node_modules
COPY . .

# Non-root user (uid 1000) for the container. `|| true` keeps the image buildable
# even on base images that ship without useradd; the numeric uid still works.
RUN useradd --create-home --uid 1000 tenjin 2>/dev/null || true; \
    mkdir -p /data && chown -R 1000:1000 /data && chmod 0750 /data

USER 1000:1000

# tenjin home lives on a persistent volume (see docker-compose.yml). API keys and
# channel tokens come only from the environment — never baked into the image.
ENV TENJIN_HOME=/data

COPY --chown=1000:1000 ops/docker/entrypoint.sh /app/entrypoint.sh
COPY --chown=1000:1000 ops/docker/check-token.sh /app/check-token.sh
RUN chmod +x /app/entrypoint.sh /app/check-token.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3000/api/health',{headers:{authorization:'Bearer '+process.env.GATEWAY_TOKEN}});if(!r.ok){console.error(await r.text());process.exit(1)}"]

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts", "gateway"]
