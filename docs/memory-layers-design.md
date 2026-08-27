# Design — Memory-layering wiring (B9-9 → live prompt)

> Status: **proposed**. Owner decision pending. Nothing here is implemented yet.
> Serves Vision §7 (memory that compounds) and closes the #460 gap where the
> workspace convention scaffolds `USER.md`/`MEMORY.md` but nothing consumes them.

## 1. Problem

Two related gaps, both grounded in the current code:

1. **The workspace convention (#460) is half-wired.** `tenjin workspace init`
   scaffolds `~/.tenjin/workspace/` with `SOUL.md`, `USER.md`, `AGENTS.md`,
   `MEMORY.md`, `HEARTBEAT.md` + daily `memory/YYYY-MM-DD.md`. Only `SOUL.md`
   (`loadSoul`) and `AGENTS.md` (`loadAgentsMd`) are read into the prompt.
   **`USER.md` and `MEMORY.md` are scaffolded but never consumed** — the
   "no black boxes" promise is half-empty.

2. **The B9-9 layering module is orphaned.** `src/memory/layers.ts` ships a
   complete, tested four-layer store (`managed`/`user`/`project`/`local`) with
   `buildInjection(base)` that renders a capped, labeled per-turn injection —
   but nothing in the runtime calls it (verified: no import anywhere in `src`).

## 2. Structural mismatch

- **Workspace convention:** single aggregate files at the root
  (`USER.md`, `MEMORY.md`).
- **Layers module:** per-key `.md` files in subdirectories
  (`base/managed/<key>.md`, `base/user/<key>.md`).
- `buildInjection(base)` reads `base/managed/*.md` + `base/user/*.md` via
  `readLayer`. It does **not** read `base/USER.md` / `base/MEMORY.md` as-is.

So "just point `buildInjection` at the workspace dir" does not work without an
adapter.

## 3. Decision — Option 1 (recommended): dock layers to the workspace files

Wire the layers module so it consumes the workspace convention's files, making
`USER.md`/`MEMORY.md` live and reusing the tested `buildInjection` logic —
**without** creating a second overlapping memory-file convention.

### 3.1 Tier mapping

| Tier | Source | Notes |
| --- | --- | --- |
| `managed` | `~/.tenjin/workspace/managed/<key>.md` | Agent-managed profile directives. Distinct from the user's hand-edited files. |
| `user` | `~/.tenjin/workspace/USER.md` **and** `~/.tenjin/workspace/MEMORY.md` | The two human-editable aggregate files. Read directly. |
| `project` / `local` | (future) | Not injected per-turn today; reserved. |
| daily notes | `~/.tenjin/workspace/memory/YYYY-MM-DD.md` | Already exists from #460; retrieval-indexed, never per-turn. |

### 3.2 Adapter

Add a thin adapter in `src/memory/layers.ts` (or a sibling `workspace-layers.ts`):

- `readWorkspaceUserLayer(workspaceDir)`: reads `USER.md` + `MEMORY.md`, treats
  them as the "user" tier entries (`USER.md` → key `user`, `MEMORY.md` → key
  `memory`).
- `buildWorkspaceInjection(workspaceDir)`: calls `buildInjection` with the
  managed layer read from `workspace/managed/` and the user layer from the
  adapter above, applying the same caps (`PROFILE_MAX_CHARS`,
  `MEMORY_MAX_BYTES`/`MEMORY_MAX_LINES`) and label rendering.

### 3.3 Prompt wiring (additive, opt-in)

- New config `memory.layers.enabled` (default **false** → non-breaking).
- When enabled, the prompt builder renders the layered injection as an
  additional **stable** section (like `coreMemory` / `facts` — it is reference
  data, so it belongs in the stable cache prefix, not the volatile tail).
- Existing `facts`/`summaries`/`learnings` injection is untouched. The
  human-curated `MEMORY.md` and the agent-distilled learnings store are
  complementary; both stay.

### 3.4 Why not the alternatives

- **Option 2 (native per-bot layers store)** would keep `layers.ts` native but
  introduce a *second* memory-file convention alongside the just-shipped
  workspace `USER.md`/`MEMORY.md` — exactly the overlap/confusion the pass is
  trying to remove.
- **Option 3 (direct inject, ignore layers)** fixes the #460 gap fastest but
  leaves the B9-9 module (managed tier, caps, quarantine) orphaned — it does
  not advance the integration pass.

## 4. Implementation plan (when approved)

1. `src/memory/layers.ts` — add `readWorkspaceUserLayer` + `buildWorkspaceInjection`.
2. `src/config/types.ts` — `memory.layers.enabled?: boolean`.
3. `src/agent/prompt.ts` — add `layeredMemory?: string | null` input, render as a
   stable section.
4. `src/agent/headless.ts` — when `memory.layers.enabled`, call
   `buildWorkspaceInjection(workspaceDir(home))` and pass the result.
5. Tests: layers adapter (workspace files → injection), prompt rendering, and a
   headless wiring test asserting the section appears only when enabled.
6. Docs: note in `docs/security.md`/`docs/architecture.md`.

## 5. Open questions for the owner

- Confirm **Option 1** and the **additive + opt-in** posture.
- Should `managed/` be scaffolded by `tenjin workspace init`, or left to the
  agent to create on first write? (Recommend: scaffold an empty example.)
- Should `USER.md` + `MEMORY.md` map to two distinct keys, or be concatenated
  under one `memory` key? (Recommend: two keys, `user` + `memory`.)
