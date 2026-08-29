# Security model

Tenjin layers several independent security mechanisms. They are **separate
controls**: the **guard**, **approvals**, **redaction**, **workspace confinement**,
the **child-process boundary** and the **audit trail**. Note that
`security.disabled: true` turns off both the guard and redaction together;
approvals, native process isolation and the audit trail are governed separately.
Everything security-relevant is audited to
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

Approvals gate **write/edit/bash/browser** tools. Browser navigation and
interaction are write-grade because pages can submit forms or trigger external
side effects. The per-tool `approval` map sets the mode — `ask`, `allow` or
`deny`:

```yaml
approval:
  read: allow
  glob: allow
  grep: allow
  write: ask      # prompt before writing
  edit: ask
  bash: ask       # prompt before running shell
  browser: ask    # prompt before navigation or interaction
```

- **Interactive REPL** — `ask` prompts you before the tool runs, and records an
  `approval` audit event for approve/decline.
- **Gateway** — approvals are driven by the `allowWrites` switch. When it is
  on, read tools are auto-approved and write/edit/bash/browser tools create an
  out-of-band **approval request** (`~/.tenjin/approvals/<id>.json`). The
  request is announced (e.g. pushed to a Telegram admin chat) and resolved with
  `/approve <id>` / `/deny <id>` in Telegram or via the web console's
  `/api/approvals/:id`. When `allowWrites` is off, the gateway is read-only.
  Pending requests older than one hour are marked `expired` on the next approval
  scan (`GET /api/approvals`) so abandoned requests stop accumulating; resolving
  is atomic (rename-claimed), so a request is resolved exactly once even when
  Console and Telegram race to answer it.
  A bot's own `security.policy` can still tighten this further. Because the
  browser is write-grade, a `read-only` tool policy omits it entirely.

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
recognized credential formats and explicitly registered secrets — provider
keys, channel tokens, URL credentials, sensitive query parameters, `AKIA…`,
private-key material and similar — at the tool/model boundary and before session
or audit persistence. Matching credentials printed by a tool therefore do not
enter the next provider request or durable record. Redaction is defense in
depth, not proof that every opaque secret format can be inferred without its
key or context. It is **enabled by default**; turn it off explicitly if you want
raw input preserved:

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

or from the web console's `/api/audit`. Audit strings pass through the redactor,
so recognized credential formats and explicitly registered secrets are masked
before persistence. Heuristic redaction is defense in depth; it is not a proof
that an unknown opaque plaintext secret can always be inferred.

## 6. Secrets at rest & backups

API keys are encrypted under a machine-local secret stored in a 0600 keyfile,
`.tenjin-keyring` in the home (`src/security/keyring.ts`). This encryption is
opt-in via `tenjin keyring init`; without a keyfile `providers.yaml` stays
plaintext exactly as before.

Backups never carry key material: `providers.yaml`, `secrets/` and
`.tenjin-keyring` are excluded from `tenjin backup`, and `tenjin restore`
refuses to write any of them back even if a foreign archive happens to contain
them. Restoring the keyring therefore never happens through a backup — moving
a home to a new machine is an **out-of-band** step: run `tenjin keyring init`
on the new machine and re-save the encrypted keys (e.g. re-add each provider
with its key), never by copying `.tenjin-keyring` (a backup would also bypass
the 0600 protection and clobber a fresher machine-local secret).

## 7. Outbound egress allowlist (web_fetch)

`web_fetch` is deny-listed by default via `security.denyDomains`. For a stricter
deny-by-default posture, set an allowlist — only hosts on it may be fetched,
everything else is refused before any network I/O:

```yaml
security:
  denyDomains: ["example.com"]   # deny-list (default)
  egress:
    allowlist: ["docs.python.org"]  # deny-by-default: only these hosts
```

When `security.egress.allowlist` is non-empty, `web_fetch` refuses any host not
on it, re-checks every redirect target, and stops streaming a response at its
hard byte limit. Empty or absent keeps the deny-list-only behaviour. Every
outbound decision is recorded on the guard's egress log. This control currently
governs `web_fetch`; the real-browser transport does not yet share the same
DNS/redirect/subresource egress broker.

## 8. Agent-controlled child processes and plugins

The `bash` tool does not inherit Tenjin's full environment. It receives a small
runtime allowlist (for example `PATH`, locale and terminal settings), an
isolated `HOME` inside the workspace, and no ambient provider keys, channel
tokens or credential-loader variables.

Shell execution also requires a usable native sandbox. The production backend
is Linux bubblewrap: the command runs as PID 1 in a private PID namespace,
`--die-with-parent` binds the established sandbox to its host monitor, and an
outer process group covers early setup revocation. Its mount/network namespaces
expose only the operating-system runtime plus the current workspace and keep
host runtime sockets out of view. If sandbox creation is unavailable or fails,
the command is refused instead of falling back to an unsandboxed process. macOS
Seatbelt can constrain file/network capabilities but cannot reliably revoke a
descendant that creates a detached session, so it is retained only as a policy
inspection utility and is not accepted as a Bash lifecycle boundary. `bash` is
therefore intentionally unavailable on macOS and Windows. A
separately constructed, trusted host integration may grant unsandboxed shell
execution for tests or an embedding application; tool input alone cannot do so.
Runtime and system-wide toolchain paths are an explicit compatibility allowlist;
Tenjin does not discover per-user toolchains or expose a user's home directory.
`tenjin doctor` reports whether a supported Bash isolation mechanism is
available, but deliberately does not execute an arbitrary end-to-end shell
probe; a tool outside that documented boundary can still fail closed at
execution time. Doctor output uses mandatory redaction even when
`security.disabled: true`, so diagnostics remain safe to attach to support
requests.

Configured MCP servers have a narrower **environment** boundary: they inherit
the same small ambient allowlist plus only values explicitly named in that
server's `env` map. They are nevertheless trusted host integrations, not OS-
sandboxed plugins: a configured MCP command can access files and networks with
Tenjin's operating-system permissions. Only configure MCP servers whose code
and update channel you trust.

The real-browser tool is write-grade and therefore approval-gated; click,
typing and even navigation can trigger remote side effects. Page text is
delimiter-framed as untrusted data and obvious delimiter injection is
neutralized, but that framing is guidance to the model rather than a security
sandbox.

`tenjin plugin install` and `tenjin plugin update` are file-only operations.
They validate and stage the package, but never import its module, call
`register()`, or run an install script. Installed marketplace plugins are
recorded as **inactive / experimental** until an isolated plugin runtime exists.
Tarball sources are local-file only and must match their pinned SHA-256 digest;
generic `git:` plugin sources are local-only, while the explicit `github:` form
is constrained to a literal `org/repo` slug on `github.com`. The installed tree
and its index record are committed through a durable recovery journal, so the
next state access rolls an interrupted pre-index commit back or finalizes a
durable post-index commit before exposing either view.

## Summary

| Control | Config key | Default | What it stops |
| --- | --- | --- | --- |
| Guard (patterns) | `security.blockedPatterns` | on | reads/writes/bash touching `.env`, keys, secrets |
| Per-bot guard/policy | bot `security.*` | off | extra globs, tighter tool policy, denyTools |
| Telegram bindings | bot `telegram.allowedUsers` / `gateway.telegram.bindings` | off | sender reaching a bot they are not bound to |
| Workspace confinement | `security.workspaceRoot` | on (tool cwd) | path escapes outside the workspace |
| Approvals | `approval` (per tool) | write/edit/bash/browser `ask` | writes, browser side effects & shell without consent |
| Redaction | `security.redaction` | on | tool secrets entering model context, logs or audit |
| Bash process boundary | host policy (not tool input) | required; Linux bwrap only | ambient credentials, host-file reads, shell network/socket egress and detached descendants |
| MCP environment boundary | server `env` map | minimal ambient env | accidental inheritance of unrelated host credentials |
| Marketplace plugin activation | — | inactive | plugin/install code executing during install or update |
| Audit trail | — (always) | on | hidden history of security events |
| Outbound egress | `security.egress.allowlist` | off | web_fetch to hosts not on the allowlist |

Turning `security.disabled: true` removes the guard (patterns + confinement) and
redaction; it does not grant the `bash` tool an unsandboxed process. Approvals
remain governed by the `approval` map, and the audit trail always runs.
