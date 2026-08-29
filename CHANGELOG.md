# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `tenjin doctor --json` emits a stable, redacted diagnostics report for
  deployment gates; `--online` optionally verifies the configured default
  model with one minimal chat request. The installed-binary release blackbox
  now gates this path as well.

### Changed
- Guided onboarding now validates the selected provider/model with a real chat
  request before persisting credentials, closing false positives from public
  `/models` endpoints.
- GitHub workflows use the current Node 24-native official checkout and
  artifact actions. Releases are published with GitHub CLI instead of a
  deprecated third-party JavaScript action.
- Doctor now checks configured provider credentials, gateway binding/token,
  config permissions, routines and Bash isolation while preserving its
  offline, no-cost default.
- `workspace.mode` is no longer an inert isolation promise: unfinished
  `docker` and `remote` modes, plus docker-only settings under `local`, now fail
  during config loading instead of silently executing through the local tool
  path.
- Interactive and headless prompts now include the progressive-disclosure
  Level-1 index built from their final policy-filtered tool and skill surface;
  full skill bodies remain available only through explicit activation.

## [0.1.0-rc.2] - 2026-08-29

### Fixed
- The installer now downloads private GitHub release assets through an
  authenticated GitHub CLI, accepting existing `gh auth` credentials as well
  as `GH_TOKEN` or `GITHUB_TOKEN`. Public and custom release URLs keep the
  dependency-free `curl` path.

## [0.1.0-rc.1] - 2026-08-29

> Superseded by `v0.1.0-rc.2`; retained for release-history traceability.

### Added
- CLI `-v` / `--version` flag prints the version banner and exits (works with
  no config or API keys).
- A native release blackbox gate now verifies installer → binary → version →
  onboarding → MCP → gateway → embedded console → authenticated healthcheck →
  first agent run from a source-free temporary directory. It also executes the
  example routine and verifies the shared Activity data.
- Guided onboarding now configures provider, model, first bot, trust level,
  gateway token and an optional read-only daily repository watch in one flow.
- The Console has five primary areas: Chat, Activity, Approvals, Routines and
  Setup. Activity combines run outcomes, cost and audit information.

### Security
- Child processes receive a minimal allowlisted environment instead of all host
  secrets, and persisted/logged values pass through recursive redaction.
- Sandbox and tool execution fail closed when isolation cannot be established;
  MCP input, output and schema limits are enforced at the trust boundary.

### Changed
- `VERSION` is now derived from `package.json` (single source of truth) instead
  of being hardcoded in `src/version.ts`.
- CLI and MCP client/server handshakes report the same package version.
- Standalone builds embed that package version and all web-console assets; the
  installer exposes the stable `tenjin` command instead of an artifact name.
- RC tags are rejected unless they match `package.json`, and hyphenated versions
  are published explicitly as GitHub pre-releases.
- Repository hygiene: removed committed scratch files (`_d.txt`, `_f.txt`) and
  hardened `.gitignore` for `Start.md`, `LIN.txt`, `SEG.txt` and the scratch
  files so they cannot be re-added.

### Fixed
- Removed a duplicated gateway-boot paragraph from the README.
- Corrected release checksum paths and made `tenjin mcp-serve` reachable through
  top-level command dispatch.
- Bot selection now reaches the actual gateway request, legacy Console links
  resolve to canonical views, and mobile approval actions remain reachable.

### Included baseline

- Interactive REPL, one-shot CLI, resume/fork.
- Bots: role-specific agents with per-bot SOUL, model, budget, memory and inbox.
- Always-on gateway: Telegram, Slack, Discord, webhook channels; scheduled jobs,
  heartbeats; web console with REST/SSE API.
- Sessions, memory (summaries, vector recall, learnings), skills.
- Security: path/command guard, workspace confinement, approvals, redaction,
  audit trail, secrets-at-rest keyring.
- Backup/restore, Docker deployment, and CI (typecheck + tests).
