# Bots — the bot recipe

A _bot_ is a role-specific agent inside one Tenjin install. Each bot has its own
personality (`SOUL.md`), optional model and budget, and **isolated** memory,
sessions and inbox — so `researcher` and `writer` never share facts, sessions or
messages. Bots can still talk to each other through their inboxes and delegate
with `ask_bot`.

## Why bots?

One install, many specialized agents. Instead of one generic assistant you get a
team: a researcher that digs into code, a writer that drafts, a reviewer that
checks — each with its own voice and its own data. Everything below is one bot,
done end to end; the example bots (`researcher`, `writer`) are one `tenjin bot
init-examples` away.

## 1. Create a bot

```sh
bun run src/index.ts bot new <name>
```

This creates `~/.tenjin/bots/<name>/` with a starter `SOUL.md`. The bot name is
sanitized (lowercase, dashes). A bot is just that directory plus its
`SOUL.md` — there is no registry to update.

To seed the built-in examples instead:

```sh
bun run src/index.ts bot init-examples   # creates "researcher" and "writer"
bun run src/index.ts bot list            # → researcher\nwriter
```

## 2. Give it a personality

Edit `~/.tenjin/bots/<name>/SOUL.md`. The starter template (in
[`src/bots/profile.ts`](../src/bots/profile.ts)) keeps the bot in character and
reminds it that its memory/facts/sessions are its own:

```md
# SOUL — researcher

You are **researcher**, the investigation specialist among the user's Tenjin bots.

- Dig deep before answering: read the actual code and files, never speculate.
- Cite file paths and line numbers as evidence.
- Summarize findings in tight, factual prose.
```

The `SOUL.md` is what shapes behavior — keep it short, concrete and in the voice
you want.

## 3. Configure model & budget (optional)

Per-bot `~/.tenjin/bots/<name>/config.yaml`:

```yaml
model: openai:gpt-4o-mini   # override the default model for this bot
budgetUSD: 2                # cap this bot's spend; falls back to global budgetUSD
security:
  policy: read-only         # cap tools: none | read-only | full (never upgrades the caller)
  blockedPatterns:          # extra globs, unioned with the global guard
    - secrets/*
  denyTools:                # drop these tools even under a full policy
    - bash
telegram:
  allowedUsers: [123456789] # if set, only these Telegram senders may reach this bot
```

If `model` is unset, the bot uses the global default. `budgetUSD` overrides the
global per-session cap for this bot.

`security.policy` and `security.denyTools` can only **restrict** the bot relative
to the caller (REPL, gateway `allowWrites`, or a read-only job) — a bot cannot
grant itself write tools the gateway has turned off. `blockedPatterns` are
**unioned** with the global `security.blockedPatterns` (or the built-in
defaults). See [docs/security.md](security.md#per-bot-policies).

## 4. Run it as a bot

```sh
bun run src/index.ts --bot <name>          # interactive session as this bot
bun run src/index.ts --bot <name> -p "…"   # one-shot as this bot
```

When run as a bot, Tenjin uses the bot's `SOUL.md`, model, budget, and its own
`sessions/`, `memory/` and `inbox/` directories — the bot sees only its own
history and facts.

## 5. Wire it to a channel / lifecycle

Bots talk to the outside world through the **gateway** (`tenjin gateway`), which
routes messages to a `defaultBot` and lets jobs and heartbeats target any bot by
name:

```yaml
gateway:
  telegram:
    enabled: true
    defaultBot: researcher    # inbound Telegram goes to researcher
    allowedUsers: [123456789] # channel door (still required when enabled)
    bindings:                 # optional per-bot sender allowlists
      researcher: [123456789]
      writer: [987654321]
  heartbeat:
    enabled: true
    bot: researcher
    every: 30m
  jobs:
    - name: weekly-writer
      bot: writer             # this job runs the writer bot
      prompt: "Draft the weekly changelog."
      cron: "0 9 * * 1"
      tz: Europe/Berlin       # optional; default is server local time
```

See [docs/architecture.md](architecture.md#gateway) for the full gateway config.

## Bots talking to bots

- **Inbox** — every bot has an inbox at `~/.tenjin/bots/<name>/inbox/`.
  Bots read it with the `check_inbox` tool and send messages with the
  `send_message` tool (`src/bots/inbox.ts`, `src/bots/tools.ts`). Incoming
  messages are treated as data, not instructions.
- **Delegation** — the `ask_bot` tool (`src/bots/delegate.ts`) lets one bot
  ask another and get its answer back, creating a delegation audit event.

You can tune inbox retention with the global `inbox` config:

```yaml
inbox:
  ttlDays: 30        # drop messages older than this (0 = never expire)
  maxMessages: 500   # keep newest N per inbox (0 = unlimited)
```

## Portable packages (export / import)

Bots can be moved between machines or shared without copying keys or runtime
state around by hand:

- `tenjin bot export <name>` writes `<name>.tar.gz` (in the current directory)
  containing the bot's portable content — `SOUL.md`, `config.yaml`, and any
  bundled folders such as `skills/`. Sessions, memory, inbox and the global
  `providers.yaml` (API keys) are **never** packaged.
- `tenjin bot import <file.tar.gz>` restores a bot from a package. If a bot with
  the same name already exists, the imported bot gets a numeric suffix
  (`name-2`) instead of overwriting. The imported configuration is validated
  like any other bot before the bot is left behind.

## Reference

| Need | Command / file |
| --- | --- |
| Create a bot | `tenjin bot new <name>` |
| List bots | `tenjin bot list` |
| Export a bot (portable package) | `tenjin bot export <name>` |
| Import a bot | `tenjin bot import <file.tar.gz>` |
| Seed examples | `tenjin bot init-examples` |
| Run as a bot | `tenjin --bot <name>` |
| Bot profile code | `src/bots/profile.ts` |
| Bot inbox | `src/bots/inbox.ts` |
| Bot tools | `src/bots/tools.ts` |
| Cross-bot delegation | `src/bots/delegate.ts` |
