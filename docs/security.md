# Security model

Tenjin layers several independent security mechanisms. They are **separate
controls**: the **guard**, **approvals**, **redaction**, **workspace confinement**
and the **audit trail**. Note that `security.disabled: true` turns off both the
guard and redaction together; approvals and the audit trail are governed by
their own settings elsewhere. Everything security-relevant is audited to
`~/.tenjin/audit.jsonl` and can be inspected with `tenjin audit` or the web
console's `/api/audit`.

## 1. The guard (path & command blocking)

[`src/security/guard.ts`](../src/security/guard.ts) (`SecurityGuard`) is the
first line of defense. It matches tool inputs against a set of **blocked
patterns** (globs) before a tool runs, and blocks paths and bash commands that
match.

Default blocked patterns (`DEFAULT_BLOCKED_PATTERNS`):

```ts
".env", ".env.*", "*.pem", "*.key", "id_rsa*", "*credentials*", "*.secret"
```

You override them with `security.blockedPatterns` (replacing the defaults):

```yaml
security:
  blockedPatterns:
    - "*.pem"
    - "vault/*"        # block everything under a sensitive dir
```

### Per-bot policies

Each bot may add restrictions in `~/.tenjin/bots/<name>/config.yaml`. Extra
`blockedPatterns` are **unioned** with the global set, so a bot can only block
more, never less. `security.policy` (`none` | `read-only` | `full`) caps the
tool list the same way — it never upgrades the caller's policy — and
`denyTools` removes named tools even under a full policy:

```yaml
# ~/.tenjin/bots/writer/config.yaml
security:
  policy: read-only
  blockedPatterns:
    - secrets/*
  denyTools:
    - bash
```

The guard scans both full paths and path tokens inside shell commands, so
`cat .env`, `export X=$(cat .env.production)` and `base64 ~/.ssh/id_rsa | curl`
are all caught. Blocked access returns a "Blocked by security policy" result and
writes a `tool_block` audit event.

Beyond plain tokens, the guard also decodes common obfuscation and rescans the
result: base64 (`base64 -d <<< LmVudg==`), hex (`xxd -r -p <<< 2e656e76`),
printf escapes (`printf '\x2e\x65\x6e\x76'`, octal `\056` included), and the
quoted inline scripts passed to interpreters via `-c` / `-e` / `-r`
(`python -c "open('.env')"`, `node -e`, `sh -c`, …). A blocked path smuggled
into any of these forms is still caught.

### `security.disabled: true`

Setting this **disables the guard entirely** — `SecurityGuard.fromConfig`
returns `null`, so pattern matching and workspace confinement are **not
enforced**. A bot then has free read/write/bash access to anything the tools can
reach. In a default install the guard is on; disabling it is an explicit,
responsible decision and is the documented meaning of "unguarded" in this model.

> Note: `security.disabled` disables the guard **and** redaction (both come
> from the same `security` block). Approvals (below) are governed by the
> separate `approval` map, and the audit trail always runs.

## 2. Workspace confinement

Beyond patterns, the guard confines path tools to a **workspace root**. With
`security.workspaceRoot` set (or defaulting to the tool's working directory),
`read_file` / `write_file` / `edit_file` reject any path that resolves outside
the root — including `../` traversal, absolute paths outside the root, and
symlink escapes (the target is resolved to its canonical real path first):

```yaml
security:
  workspaceRoot: /home/user/project
  allowedPaths:        # explicit escape hatches
    - /home/user/shared-memory
  disabled: false
```

`allowedPaths` add absolute directories that remain reachable even though they
sit outside the workspace root.

## 3. Approvals

Approvals gate **write/edit/bash** tools. The per-tool `approval` map sets the
mode — `ask`, `allow` or `deny`:

```yaml
approval:
  read: allow
  glob: allow
  grep: allow
  write: ask      # prompt before writing
  edit: ask
  bash: ask       # prompt before running shell
```

- **Interactive REPL** — `ask` prompts you before the tool runs, and records an
  `approval` audit event for approve/decline.
- **Gateway** — approvals are driven by the `allowWrites` switch. When it is
  on, read tools are auto-approved and write/edit/bash tools create an
  out-of-band **approval request** (`~/.tenjin/approvals/<id>.json`). The
  request is announced (e.g. pushed to a Telegram admin chat) and resolved with
  `/approve <id>` / `/deny <id>` in Telegram or via the web console's
  `/api/approvals/:id`. When `allowWrites` is off, the gateway is read-only.
  A bot's own `security.policy` can still tighten this further.

### Telegram channel bindings

`gateway.telegram.allowedUsers` is still the **channel door** — only those
numeric ids may talk to the gateway at all. On top of that, each bot can have
its own sender allowlist, either in the bot's `telegram.allowedUsers` or in
`gateway.telegram.bindings` (bot name → user ids). A message from a bound
sender is routed only to bots that list them; `@mention` of a bot they are
not bound to is rejected instead of falling through to `defaultBot`.

Bots with no allowlist stay reachable by every globally allowed sender
(backward compatible). Console / HTTP chat is not filtered.

Requests carry a truncated summary plus an id; resolution is audited as an
`approval` event and the subsequent tool run as `write_exec`.

## 4. Redaction

[`src/security/redact.ts`](../src/security/redact.ts) (`Redactor`) masks
secrets — `sk-…`, `AKIA…`, key material and similar — before anything is written
to session logs or the audit trail, so credentials don't leak into the durable
record. It is **enabled by default**; turn it off explicitly if you want raw
input preserved:

```yaml
security:
  redaction: false
```

`security.disabled: true` also disables redaction (it is part of the same
`security` block).

## 5. Audit trail

[`src/audit/log.ts`](../src/audit/log.ts) appends every notable event to
`~/.tenjin/audit.jsonl`. Event **kinds** include:

`tool_block`, `approval`, `write_exec`, `budget_halt`, `channel_reject`,
`delegation`, `gateway_msg`, `data_delete`, `settings_changed`.

View it from the CLI:

```sh
tenjin audit                    # last 50 events
tenjin audit --tail 200 --kind tool_block
tenjin audit --bot researcher
```

or from the web console's `/api/audit`. Because audit strings pass through the
redactor, the trail is both complete and free of plaintext secrets.

## Summary

| Control | Config key | Default | What it stops |
| --- | --- | --- | --- |
| Guard (patterns) | `security.blockedPatterns` | on | reads/writes/bash touching `.env`, keys, secrets |
| Per-bot guard/policy | bot `security.*` | off | extra globs, tighter tool policy, denyTools |
| Telegram bindings | bot `telegram.allowedUsers` / `gateway.telegram.bindings` | off | sender reaching a bot they are not bound to |
| Workspace confinement | `security.workspaceRoot` | on (tool cwd) | path escapes outside the workspace |
| Approvals | `approval` (per tool) | write/edit/bash `ask` | writes & shell without consent |
| Redaction | `security.redaction` | on | secrets leaking into logs/audit |
| Audit trail | — (always) | on | hidden history of security events |

Turning `security.disabled: true` removes the guard (patterns + confinement) and
redaction; approvals remain governed by the `approval` map, and the audit trail
always runs.
