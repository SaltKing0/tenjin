# Architecture

Tenjin is a small TypeScript harness that runs on Bun with **zero runtime
dependencies** (`package.json` lists none). This document maps the layers, how
a request flows through them, where data lives, and what every config knob does.

## Layer overview

```
                  ┌──────────────────────────────────────────────┐
                  │               Entry points (src/index.ts)       │
                  │  REPL (src/ui/repl.ts) · CLI · one-shot -p      │
                  │  bots (src/bots) · gateway (src/gateway)        │
                  └──────────────┬─────────────────────────────────┘
                                 │
        ┌────────────────────────▼─────────────────────────┐
        │                   Agent core                      │
        │  src/agent/loop.ts (turn loop)                    │
        │  src/agent/headless.ts (headless turn)            │
        │  src/agent/prompt.ts (system prompt build)        │
        │  src/agent/budget.ts (spend accounting)           │
        └───────────┬──────────────────┬────────────────────┘
                    │                  │
   ┌────────────────▼───────────┐  ┌──▼───────────────────────┐
   │  Tools (src/tools)          │  │  Skills (src/skills)      │
   │  read/glob/grep/write/edit  │  │  loader / activate        │
   │  bash · memory · skill-wtr  │  │  (project + global)       │
   └──────────────┬──────────────┘  └──────────┬────────────────┘
                  │                            │
        ┌─────────▼────────────────────────────▼───────────┐
        │             Security (src/security)               │
        │  guard.ts (blocked patterns + workspace)          │
        │  redact.ts (secret masking)                       │
        └────────────────────┬──────────────────────────────┘
                             │
   ┌──────────────┬──────────▼──────────┬───────────────────┐
   │ Session       │ Memory             │ Provider           │
   │ src/session/  │ src/memory/        │ src/provider/      │
   │ log.ts events │ summaries/vector   │ factory/registry   │
   │               │ inject/indexer     │ anthropic/openai   │
   └──────────────┴─────────────────────┴───────────────────┘

   Cross-cutting store:  src/audit/log.ts (audit.jsonl)
                         src/audit/spend.ts (spend aggregation)
```

## Entry points

Everything funnels through [`src/index.ts`](../src/index.ts), which parses the
CLI, loads config, builds an `AppContext`, and dispatches to one of:

- **Interactive / one-shot / resume / fork** — the agent turn loop.
- **`bot`** — bot lifecycle: `new`, `list`, `export`, `import`, `init-examples`.
- **`gateway`** — the always-on process (below).
- **`audit` / `spend`** — CLI views over the event trail and spend records.
- **`job`** — manage scheduled gateway jobs from the headless CLI: `list`,
  `add <bot> "<cron>" "<prompt>"`, `rm <id>`, `run <id>`. Edits
  `config.yaml` in block style and validates cron with the shared parser; a
  running gateway picks up the change via SIGHUP or restart.
- **`doctor` / `export` / `forget`** — diagnostics and data management.

`AppContext` carries the resolved config, provider registry, default model refs,
the built system prompt, the tool list, working directories and the (possibly
`null`) security guard — so downstream modules never re-read config.

## Agent core

[`src/agent/loop.ts`](../src/agent/loop.ts) (`runAgentTurn`) drives the
interactive conversation: it alternates model calls with tool execution until
the model signals it is done. [`src/agent/headless.ts`](../src/agent/headless.ts)
(`runHeadless`) is the one-shot variant used by `-p`, bots and gateway — it
returns a single answer after running as many tool steps as needed.

[`src/agent/prompt.ts`](../src/agent/prompt.ts) assembles the system prompt from
the configured `SOUL.md`, project `AGENTS.md`, facts and the memory section.
[`src/agent/budget.ts`](../src/agent/budget.ts) tracks spend per session against
`budgetUSD`.

## Bots

Bots (see [docs/bots.md](bots.md)) are role-specific agents, each with its own
`SOUL.md`, optional model/budget, and isolated `sessions/`, `memory/` and
`inbox/` directories under `~/.tenjin/bots/<name>/`. [`src/bots/profile.ts`](../src/bots/profile.ts)
defines profiles; [`src/bots/inbox.ts`](../src/bots/inbox.ts) implements the
async inbox and its TTL/size policy; [`src/bots/delegate.ts`](../src/bots/delegate.ts)
provides the `ask_bot` tool so one bot can delegate to another;
[`src/bots/tasks.ts`](../src/bots/tasks.ts) adds the async `ask_bot_async` /
`bot_task_status` task abstraction for fire-and-forget delegation;
[`src/bots/tools.ts`](../src/bots/tools.ts) exposes `send_message` /
`check_inbox` to bots.

## Gateway

[`src/gateway/gateway.ts`](../src/gateway/gateway.ts) (`Gateway`) is the always-on
process. It runs **scheduled jobs**, **heartbeats** (recurring prompts to a
bot), and the **message handler** ([`src/gateway/handler.ts`](../src/gateway/handler.ts))
that fronts all incoming messages from channels. [`src/gateway/telegram.ts`](../src/gateway/telegram.ts)
is the Telegram channel integration; [`src/gateway/approvals.ts`](../src/gateway/approvals.ts)
implements out-of-band approval requests. [`src/gateway/schedule.ts`](../src/gateway/schedule.ts)
is the cron/every scheduler.

**Web console.** When `gateway.listen` is set, [`src/gateway/http.ts`](../src/gateway/http.ts)
serves the static console (`src/gateway/console/`) and
[`src/gateway/console-api.ts`](../src/gateway/console-api.ts) exposes a JSON API:

| Method & path | Purpose |
| --- | --- |
| `GET/POST /api/settings` | Read / apply settings |
| `POST /api/settings/detect` | Probe provider model lists |
| `GET /api/bots` | List bots |
| `POST /api/bots` | Create a bot (optionally with initial SOUL text) |
| `GET /api/bots/:name` | Bot detail incl. raw SOUL text |
| `PUT /api/bots/:name` | Edit SOUL text and/or rename the bot |
| `DELETE /api/bots/:name` | Delete a bot (removes its directory) |
| `GET /api/sessions` | List sessions |
| `GET /api/spend` | Aggregated spend (rows + `byBot` per-bot breakdown) |
| `GET /api/audit` | Security/audit events |
| `GET /api/approvals` | Pending approvals (scan expires stale ones) |
| `POST /api/approvals/:id` | Approve / deny a request |
| `GET /api/jobs` | Scheduled jobs (cron/every, policy, lastRun, nextDue) |
| `POST /api/jobs/:id/run` | Run a job now (does not advance nextDue) |
| `GET /api/chat/stream` | Streaming chat (SSE) |

The console is token-gated and per-IP rate-limited (see [`src/gateway/http.ts`](../src/gateway/http.ts)).

## Tools

[`src/tools/`](../src/tools/) defines the tools the agent can call:
`read_file`, `glob`, `grep`, `write_file`, `edit_file`, `bash`, plus the
memory tools (`remember`, `recall`) and skill tools (`use_skill`, `save_skill`).
[`src/tools/registry.ts`](../src/tools/registry.ts) maps tool names to their
implementations and threads the guard and approval callback through dispatch.

## Skills

[`src/skills/loader.ts`](../src/skills/loader.ts) discovers skills from two
sources — the global `~/.tenjin/skills/` and the project `.tenjin/skills/` (or
`.hermes`/repo conventions) — and provides `listSkills`, `getSkill`,
`saveSkill` and `sanitizeSkillName`. [`src/skills/activate.ts`](../src/skills/activate.ts)
wires the `use_skill` tool.

## Memory

[`src/memory/`](../src/memory/) gives the agent durable recall:

- `summaries.ts` — incremental session summaries (`generatePendingSummaries`).
- `indexer.ts` — index pending sessions into the vector store.
- `vector-store.ts` — in-memory vector index with buffered writes and
  compaction, persisted to disk.
- `inject.ts` — builds the memory section for the system prompt.

Memory is enabled by default (`memory.enabled`) and the vector layer is on when
`memory.vector.enabled` (it requires `OPENAI_API_KEY` at runtime).

## Providers

[`src/provider/`](../src/provider/) abstracts model access. The registry
([`src/provider/registry.ts`](../src/provider/registry.ts)) maps provider names
to clients; [`src/provider/factory.ts`](../src/provider/factory.ts) creates a
client from config; [`src/provider/anthropic.ts`](../src/provider/anthropic.ts)
and [`src/provider/openai.ts`](../src/provider/openai.ts) implement the two
backends. Any OpenAI-compatible endpoint (DeepSeek, Ollama, OpenRouter, …) works
through `providers.openai.baseUrl`.

## Session log

[`src/session/log.ts`](../src/session/log.ts) (`SessionLog`) persists each
conversation as an append-only event log; [`src/session/events.ts`](../src/session/events.ts)
rebuilds the message list from those events and sums usage. Sessions support
`resume` and `fork`. They live in the active profile's `sessions/` directory.

## Audit & spend

[`src/audit/log.ts`](../src/audit/log.ts) appends every notable event — tool
blocks, approvals, write executions, budget halts, channel rejections,
settings changes — to `~/.tenjin/audit.jsonl`. [`src/audit/spend.ts`](../src/audit/spend.ts)
aggregates cost across sessions and feeds `/api/spend`, `tenjin spend`, and
budget enforcement.

Beyond the per-session `budgetUSD`, a **global budget**
([`src/audit/global-budget.ts`](../src/audit/global-budget.ts)) caps total spend
across solo sessions **and** every bot for a UTC day and/or month
(`globalBudget.dailyUSD` / `globalBudget.monthlyUSD`). It is consulted before
each provider call, so a runaway bot or cron loop can't burn past the cap; a hit
is recorded as a `budget_halt` audit event.

## Configuration

Config is loaded from up to three YAML sources and merged in this order (later
wins):

1. Built-in defaults (see `DEFAULTS` in [`src/config/loader.ts`](../src/config/loader.ts)).
2. Global — `~/.tenjin/config.yaml`.
3. Managed — `~/.tenjin/providers.yaml` (written by the web console).
4. Project — `<project>/.tenjin/config.yaml`.

A schema validator ([`src/config/loader.ts`](../src/config/loader.ts)) type-checks
every source at load: **wrong-typed known fields** raise a hard `ConfigError`
with a dotted path; **unknown fields** only warn and are ignored.

### Key reference

| Key | Type | Meaning |
| --- | --- | --- |
| `provider` | `anthropic` \| `openai` | Default provider |
| `model` | string | Default model id (or use `models.default`) |
| `maxTokens` | number | Response token budget (>= 256) |
| `budgetUSD` | number | Session spend cap; `0` = unlimited |
| `approval` | map | Per-tool mode: `ask` \| `allow` \| `deny` |
| `pricing` | map | Optional per-1M-token pricing overrides |
| `providers.openai` | map | `baseUrl`/`apiKey` for OpenAI-compatible endpoints |
| `providers.anthropic` | map | `apiKey` for Anthropic |
| `models.default` / `models.cheap` | string | Provider-prefixed model tiers |
| `memory.enabled` / `memory.vector` | bool / map | Memory + vector recall |
| `security` | map | Blocked patterns, disabled flag, workspace, redaction — see [docs/security.md](security.md) |
| `inbox` | map | `ttlDays` / `maxMessages` for bot inboxes |
| `globalBudget` | map | Global spend caps (USD) across solo + all bots: `dailyUSD` / `monthlyUSD`; `0` = unlimited — see [Audit & spend](#audit--spend) |
| `context` | map | Context-window guard: `enabled`, `thresholdRatio`, `defaultWindow`, `windows` — see below |

| `gateway` | map | Jobs, Telegram, heartbeat, listen — see below |

The generated template lives in `CONFIG_TEMPLATE` in
[`src/config/loader.ts`](../src/config/loader.ts); a fresh `~/.tenjin/config.yaml`
is the fastest way to see every option with inline comments.

### Context-window guard (`context`)

To stop long sessions from silently growing a trajectory past a model's context
window (and dying on a 413 / `context_length` error instead of answering), the
agent estimates the trajectory size (chars ÷ 4) before every provider call and,
once it exceeds `thresholdRatio` of the model's context window, elides the
OLDEST tool-result outputs into `[elided N tokens]` placeholders. Recent tool
outputs and the conversation text are kept, so the run survives and compression
boundaries are recorded as `compression` events in the session log.

```yaml
context:
  enabled: true           # on by default; false disables the guard
  thresholdRatio: 0.8     # compress once estimate > 80% of the window
  # defaultWindow: 128000 # context window (tokens) for unknown models
  # windows:              # per-model context-window override (tokens)
  #   my-model: 32000
```

Known models (Anthropic Claude, OpenAI GPT-4o, DeepSeek) have built-in window
sizes; anything unrecognized uses `defaultWindow` (or 128k).

### Gateway config

The `gateway:` block is validated separately in
[`src/gateway/config.ts`](../src/gateway/config.ts):

```yaml
gateway:
  allowWrites: false          # gate write/edit/bash behind approvals
  catchUp:                    # re-run jobs missed while the gateway was down
    enabled: true             # default true
    max: 50                   # max runs caught up per boot
  channels: [telegram]        # active channel kinds; defaults to each channel whose *.enabled is true
  telegram:
    enabled: true
    defaultBot: researcher
    allowedUsers: [123456789] # REQUIRED allowlist (security)
    bindings:                 # optional per-bot sender allowlists
      researcher: [123456789]
    adminChatId: 123456789
    allowWrites: true
    approvalTimeoutMs: 120000
  slack:
    enabled: true
    defaultBot: researcher
    allowedChannels: [C1234567890]  # REQUIRED allowlist (security)
    botToken: xoxb-your-token       # required
    signingSecret: your-secret      # required
    adminChannel: C1234567890
  heartbeat:
    enabled: true
    bot: researcher
    every: 30m
  jobs:
    - name: daily-digest
      bot: researcher
      prompt: "Summarize today's changes."
      cron: "0 9 * * *"       # or every: "4h"
      tz: Europe/Berlin       # optional IANA zone; default is server local time
      postTo: telegram
      timeoutMs: 300000       # optional hard cap (ms); release a hung run
      policy: full            # optional per-job tool policy (read-only | full)
  listen:
    port: 8787
    host: 127.0.0.1
    token: "some-secret"      # REQUIRED; gates the web console
    rateLimitMax: 60
    rateLimitWindowMs: 60000
```

- **`allowWrites`** — when false, the gateway runs bots read-only; when true it
  is the master switch, with Telegram's own `allowWrites` able to override per
  channel. Scheduled jobs honor it too: a job without an explicit `policy`
  defaults to `full` when `allowWrites` is true, and `read-only` otherwise.
- **`catchUp`** — on boot the gateway re-runs scheduled jobs whose slot came due
  while it was down (default `enabled: true`, `max: 50` runs per boot). A job is
  caught up when the next scheduled run after its last run is already in the
  past; the last run of each job is persisted in `~/.tenjin/gateway-state.json`.
- **`channels`** — the list of channel kinds the gateway starts. Each name must
  be a registered channel (an unknown name is a config error). Defaults to the
  set of channels with `enabled: true` (e.g. `[telegram]`, `[slack]`, or both);
  empty when none are enabled.
- **`telegram`** — requires a non-empty `allowedUsers` allowlist and a
  `TELEGRAM_BOT_TOKEN` env var.
- **`slack`** — requires a non-empty `allowedChannels` allowlist, a `botToken`,
  and a `signingSecret`. Receives Events API webhook POSTs (signed; the
  `url_verification` challenge is answered automatically) and sends replies via
  `chat.postMessage`. `adminChannel` is the destination for channel-level
  `send(text)` (e.g. `postTo: slack`). Optional `rateLimitMax`,
  `rateLimitWindowMs`, `maxMessageLength` mirror Telegram's #69 limits. By
  default the webhook listens on an ephemeral port on `127.0.0.1`; set the
  `SLACK_WEBHOOK_PORT` env var to pin a port.
- **`jobs`** — scheduled prompts to a bot on a cron or `every` schedule
  (`postTo` routes the result to a channel). Optional `tz` (IANA name) interprets
  cron fields in that zone, including across DST; omitted `tz` keeps server local time.
  Optional per-job `timeoutMs` (ms) sets a hard cap on a single run — a hung
  provider call is released after this so it can't pin the job slot forever.
  Optional per-job `policy` (`read-only` | `full`) sets the job's tool policy;
  the default is `read-only` (or `full` when the gateway `allowWrites` is set).
  A job's effective policy is still capped by the bot's `security.policy`, so a
  read-only bot can never be upgraded to write via a job — the upgrade is
  explicit and remains bounded by the bot's own security.
- **`heartbeat`** — a recurring prompt to a bot at a fixed interval.
- **`listen`** — enables the web console; `token` is mandatory.

## Data layout

```
~/.tenjin/                      # TENJIN_HOME (env-overridable)
├── config.yaml                 # global config
├── SOUL.md                     # global personality
├── providers.yaml              # managed by the web console
├── sessions/                   # session logs (global / non-bot)
├── memory/                     # summaries, facts, vector store
├── approvals/                  # out-of-band approval requests (*.json)
├── audit.jsonl                 # audit event trail
├── gateway-state.json          # last run per scheduled job (catch-up bookkeeping)
└── bots/<name>/
    ├── SOUL.md                 # bot personality
    ├── config.yaml             # per-bot model / budget / security / telegram allowlist (optional)
    ├── sessions/ · memory/ · inbox/
```

Project-local config can live at `<project>/.tenjin/config.yaml`.
