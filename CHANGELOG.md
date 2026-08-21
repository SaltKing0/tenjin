# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CLI `-v` / `--version` flag prints the version banner and exits (works with
  no config or API keys).

### Changed
- `VERSION` is now derived from `package.json` (single source of truth) instead
  of being hardcoded in `src/version.ts`.
- Repository hygiene: removed committed scratch files (`_d.txt`, `_f.txt`) and
  hardened `.gitignore` for `Start.md`, `LIN.txt`, `SEG.txt` and the scratch
  files so they cannot be re-added.

### Fixed
- Removed a duplicated gateway-boot paragraph from the README.

## [0.1.0]

First tagged release candidate.

- Interactive REPL, one-shot CLI, resume/fork.
- Bots: role-specific agents with per-bot SOUL, model, budget, memory and inbox.
- Always-on gateway: Telegram, Slack, Discord, webhook channels; scheduled jobs,
  heartbeats; web console with REST/SSE API.
- Sessions, memory (summaries, vector recall, learnings), skills.
- Security: path/command guard, workspace confinement, approvals, redaction,
  audit trail, secrets-at-rest keyring.
- Backup/restore, Docker deployment, and CI (typecheck + tests).
