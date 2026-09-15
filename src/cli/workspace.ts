import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tenjinHome } from "../config/loader";

/**
 * OpenClaw-style plain-file workspace convention. Like OpenClaw's
 * `~/.openclaw/workspace/` and Hermes' editable profile/memory files, Tenjin
 * exposes agent configuration + long-term memory as plain Markdown files the
 * user can read and edit directly — "no black boxes".
 *
 *   ~/.tenjin/workspace/
 *     SOUL.md        personality, tone, boundaries
 *     USER.md        about the user (preferences, people, projects)
 *     AGENTS.md      operating instructions / conventions
 *     MEMORY.md      long-term curated memory
 *     HEARTBEAT.md   proactive task checklist (what to check periodically)
 *     memory/        dated daily logs (YYYY-MM-DD.md)
 */

export function workspaceDir(home: string = tenjinHome()): string {
  return join(home, "workspace");
}

export function dailyMemoryDir(home: string = tenjinHome()): string {
  return join(workspaceDir(home), "memory");
}

export interface WorkspaceTemplate {
  /** File name, e.g. "SOUL.md". */
  name: string;
  /** One-line description shown in status. */
  desc: string;
  /** Body written on scaffold. */
  body: string;
}

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    name: "SOUL.md",
    desc: "personality, tone, boundaries",
    body: `# SOUL

You are **Tenjin**, the user's personal agent harness.

- Be direct, concrete, and honest; admit uncertainty plainly.
- Match the user's register and language.
- Prefer small, verified actions over plausible-sounding claims.
`,
  },
  {
    name: "USER.md",
    desc: "about the user",
    body: `# USER

Facts about the user that persist across sessions. Edit freely — this is the
long-term memory the agent reads about who you are.
`,
  },
  {
    name: "AGENTS.md",
    desc: "operating instructions",
    body: `# AGENTS

Operating instructions and conventions the agent follows by default.

- Verify before claiming: run tests, read the actual files, cite paths.
- Keep changes small and reviewable; follow the repo's conventions.
- Ask for acceptance criteria when a task is underspecified.
`,
  },
  {
    name: "MEMORY.md",
    desc: "long-term memory",
    body: `# MEMORY

Curated long-term facts and summaries the agent has learned. Append dated
entries; the agent consolidates and dedupes over time.
`,
  },
  {
    name: "HEARTBEAT.md",
    desc: "proactive task checklist",
    body: `# HEARTBEAT

Checklist the agent reviews on its proactive heartbeat. Mark items done with
"- [x]" or leave open with "- [ ]".

- [ ] Review the inbox and surface anything urgent.
- [ ] Check scheduled jobs that may have fallen due.
- [ ] Sweep for stale memory / contradictions.
`,
  },
];

export interface WorkspaceStatusEntry {
  name: string;
  desc: string;
  exists: boolean;
  bytes: number;
}

/** Status of each workspace file under `home`. */
export function workspaceStatus(home: string = tenjinHome()): WorkspaceStatusEntry[] {
  const dir = workspaceDir(home);
  return WORKSPACE_TEMPLATES.map((t) => {
    const p = join(dir, t.name);
    const exists = existsSync(p);
    const bytes = exists ? statSync(p).size : 0;
    return { name: t.name, desc: t.desc, exists, bytes };
  });
}

export interface InitWorkspaceResult {
  created: string[];
  skipped: string[];
  daily: string;
}

/**
 * Scaffold the workspace files + a daily memory log. Idempotent: existing files
 * are left untouched unless `force` is set. Returns what was created vs skipped
 * plus the path of today's daily log.
 */
export function initWorkspace(
  home: string = tenjinHome(),
  opts: { force?: boolean } = {},
): InitWorkspaceResult {
  const dir = workspaceDir(home);
  mkdirSync(dir, { recursive: true });
  const memDir = dailyMemoryDir(home);
  mkdirSync(memDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const daily = join(memDir, `${today}.md`);
  if (!existsSync(daily)) {
    writeFileSync(daily, `# ${today}\n\n`);
  }

  const created: string[] = [];
  const skipped: string[] = [];
  for (const t of WORKSPACE_TEMPLATES) {
    const p = join(dir, t.name);
    if (existsSync(p) && !opts.force) {
      skipped.push(t.name);
      continue;
    }
    writeFileSync(p, t.body);
    created.push(t.name);
  }
  return { created, skipped, daily };
}

/** Human-readable status block for the `tenjin workspace` command. */
export function renderWorkspaceStatus(home: string = tenjinHome()): string {
  const dir = workspaceDir(home);
  const memCount = existsSync(dailyMemoryDir(home))
    ? readdirSync(dailyMemoryDir(home)).filter((f) => f.endsWith(".md")).length
    : 0;
  const lines = [`workspace: ${dir}`, `daily memory: ${memCount} log(s)`];
  for (const e of workspaceStatus(home)) {
    lines.push(`  ${e.exists ? "●" : "·"} ${e.name.padEnd(12)} ${e.exists ? `${e.bytes} B` : "missing"}  ${e.desc}`);
  }
  return lines.join("\n");
}
