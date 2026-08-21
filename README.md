# Tenjin

Tenjin is a **personal agent harness** — a single, self-hosted AI agent that runs
wherever you do: an interactive shell, a one-shot CLI, or an always-on gateway
that lives in your messaging apps and a web console. It is built to be read and
extended: plain TypeScript, zero runtime dependencies, and an architecture that
splits cleanly into small, focused modules.

It is the reference harness this repository documents. Repo codename: `stealth`.

## Highlights

- **No framework, no lock-in** — Bun + TypeScript only (`bun run src/index.ts`).
- **Bring your own model** — Anthropic or any OpenAI-compatible endpoint
  (OpenAI, DeepSeek, Ollama, OpenRouter) configured in one YAML file.
- **Sessions, memory and skills** — every conversation is a durable session log;
  optional embeddings-backed recall, summonable skills, and per-bot facts. A
  distilled **learnings** tier (`record_learning`) persists durable takeaways
  per bot+project, deduplicated and injected ahead of running summaries.
- **Bots** — run multiple role-specific agents from one install, each with its
  own `SOUL.md`, model, budget, memory and inbox.
- **Always-on gateway** — Telegram channel, scheduled jobs, heartbeats and a
  web console behind a single `gateway` process.
- **Security-first defaults** — a path/command guard, per-tool approval modes,
  workspace confinement and secret redaction, all audited to JSONL.

## Requirements

- [Bun](https://bun.sh) (tested on recent releases; the repo's CI pins `latest`).
- One API key: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (or any compatible base URL).

## Quickstart

```sh
# 1. Install dependencies
bun install

# 2. Run — the first run scaffolds your home config
bun run src/index.ts
```

The first launch creates `~/.tenjin/` with a starter `config.yaml` and a
`SOUL.md` personality file. It also shows a welcome banner:

```
Welcome to Tenjin. Created ~/.tenjin — set your model in ~/.tenjin/config.yaml
and add your SOUL.md to give it a personality.
```

### Set your model

Edit `~/.tenjin/config.yaml` and set at least `model` (and `provider`):

```yaml
provider: anthropic        # anthropic | openai (any OpenAI-compatible endpoint)
model: "claude-sonnet-4-5" # REQUIRED, e.g. claude-sonnet-4-5, gpt-4o, deepseek-chat
```

You can also pass a model on the command line for a single run:

```sh
bun run src/index.ts --model gpt-4o --provider openai
```

> Everything that can be configured is described in
> [docs/architecture.md](docs/architecture.md#configuration).

### Use it

```sh
bun run src/index.ts                # interactive REPL in the current directory
bun run src/index.ts -p "explain this repo"   # one-shot: answer and exit
bun run src/index.ts --resume <id>            # continue a previous session
bun run src/index.ts --fork <id> [n]          # branch a copy at event n
```

The CLI is also exposed as a `tenjin` binary via `package.json` (`bun link`
once to use it globally).

## Running the gateway

The gateway is the always-on process that connects Tenjin to channels, jobs and
heartbeats, and serves the web console:

```sh
bun run src/index.ts gateway          # start the gateway
bun run src/index.ts gateway --dry-run   # validate config + describe, then exit
```

It can be kept running under `launchd` (macOS) or `systemd` (Linux) using the
units in [`ops/`](ops/):

- `ops/com.tenjin.gateway.plist` — macOS LaunchAgent.
- `ops/tenjin.service` — Linux systemd user unit.

See [docs/architecture.md](docs/architecture.md#gateway) for what the gateway
runs and how to configure its channels, jobs, heartbeats, and the web console.

## Server deployment (Docker)

The gateway can run as a container — a repeatable path for a VPS with an
isolated runtime and a persistent volume for your Tenjin home. Everything lives
in [`ops/docker/`](ops/docker/): a multi-stage `Dockerfile` (slim, non-root), a
`docker-compose.yml`, and an example config. Secrets are passed via the
environment, never baked into the image.

```sh
cd ops/docker
cp .env.example .env        # fill in GATEWAY_TOKEN + any API keys / channel tokens
# set the same token as `gateway.listen.token` in config.yaml
docker compose up -d --build
docker compose ps           # wait for "healthy"
curl -H "Authorization: Bearer $GATEWAY_TOKEN" http://localhost:3000/api/health
```

That's it. On first boot the entrypoint seeds a `default` bot into the fresh
home volume so the gateway (which needs a bot for the web console) starts
cleanly. The gateway config (`config.yaml`) is mounted read-only, so jobs,
channels and the console token can be edited without rebuilding the image:

```sh
# edit ./config.yaml, then:
docker compose restart
```

State — sessions, memory, the audit log and any provider keys — persists in the
named `tenjin-home` volume. To connect Telegram, set `TELEGRAM_BOT_TOKEN` in
`.env`, enable `gateway.telegram` in `config.yaml`, and restart. For a hard reset
(wipe all state) run `docker compose down -v`.

## Command reference

| Command | Description |
| --- | --- |
| `tenjin` | Interactive REPL in the current directory |
| `tenjin -p "<prompt>"` | One-shot prompt; answer and exit |
| `tenjin --model <id>` | Override the configured model |
| `tenjin --provider <name>` | `anthropic` \| `openai` |
| `tenjin --budget <usd>` | Session spend cap (0 = unlimited) |
| `tenjin --resume <id>` | Continue a previous session |
| `tenjin --fork <id> [n]` | Branch a copy at event `n` (default: end) |
| `tenjin --bot <name>` | Run as a specific bot |
| `tenjin bot new\|list\|export\|import\|init-examples` | Manage & package bots |
| `tenjin gateway [--dry-run]` | Always-on gateway (channels, jobs, heartbeats, console) |
| `tenjin audit [--tail n] [--bot x] [--kind k]` | Security event trail |
| `tenjin spend [--days n] [--bot x]` | Spend across all sessions |
| `tenjin doctor` | Environment diagnostics |
| `tenjin export` / `tenjin forget` | Session export / data deletion |
| `tenjin backup [--out <file>]` | Archive the whole home (sans secrets) to a `.tar.gz` |
| `tenjin restore <backup.tar.gz>` | Restore a home backup (validates first; never restores keys) |

Run `tenjin --help` for the full reference.

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, data flow, config
  reference and the file map.
- [docs/bots.md](docs/bots.md) — the "bot recipe": create, personality, model,
  memory and wiring a bot to a channel.
- [docs/security.md](docs/security.md) — guard, approvals, workspace
  confinement and what `security.disabled: true` actually means.

## Development

```sh
bun test          # full test suite
bun run typecheck # tsc --noEmit
```

There is also a CI workflow (`.github/workflows/ci.yml`) that runs typecheck and
tests on every pull request.
