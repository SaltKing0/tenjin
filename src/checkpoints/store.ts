// B13-6 checkpoints (#369): a shadow-git snapshot store, fully separate from
// the user's repo history. Each checkpoint is a commit in a dedicated shadow
// git repo (a mirror of the project working directory), so we get snapshots of
// TRACKED + UNTRACKED files without ever touching the user's git log.
//
// Group law: UNDO IS THE APPROVAL-SAVER — good checkpoints make accept/auto
// modes safe. Three-way restore lets a session roll back files, the
// conversation, or both.
//
// Honest LAW: bash-driven changes (rm/mv/cp) are NOT captured by these
// snapshots, because the snapshot is taken BEFORE the tool runs and the tool
// is opaque. `git reflog` in the user's repo is the documented fallback (see
// the checkpoint tool's help). We deliberately snapshot the file-edit tools
// (write/edit/apply_patch), not bash.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface Checkpoint {
  /** Monotonic sequence number (also the shadow ref `cp-<seq>`). */
  seq: number;
  /** Commit sha in the shadow store. */
  sha: string;
  /** Human-readable label, e.g. "prompt" / "edit:write". */
  label: string;
}

export interface CheckpointOptions {
  /** Shadow-git store directory (separate from the user's repo). */
  storeDir: string;
  /** Project working directory to snapshot. */
  sourceDir: string;
  /** Optional session/conversation log path captured into each checkpoint. */
  logPath?: string;
  /** Max checkpoints retained; oldest evicted beyond this (default 100). */
  keep?: number;
}

export const DEFAULT_KEEP = 100;

// Never snapshot regenerable or internal paths.
const IGNORE_NAMES = new Set([".git", "node_modules", ".checkpoint"]);

const GIT_ENV = [
  "-c",
  "user.name=stealth-checkpoints",
  "-c",
  "user.email=checkpoints@stealth.local",
  "-c",
  "commit.gpgsign=false",
];

function git(
  storeDir: string,
  args: string[],
): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", [...GIT_ENV, "-C", storeDir, ...args], {
    encoding: "utf8",
  });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

/** Initialize the shadow store as a git repo (idempotent). */
export function initStore(storeDir: string): void {
  mkdirSync(storeDir, { recursive: true });
  if (!existsSync(join(storeDir, ".git"))) {
    git(storeDir, ["init", "-q"]);
  }
}

function isStore(storeDir: string): boolean {
  return existsSync(join(storeDir, ".git"));
}

function copyTreeFiltered(srcDir: string, dstDir: string, ignore: Set<string>): void {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    if (ignore.has(entry)) continue;
    const s = join(srcDir, entry);
    const d = join(dstDir, entry);
    // cpSync recurses; filter applies per top-level entry (node_modules/.git are
    // top-level and skipped above).
    cpSync(s, d, { recursive: true, force: true });
  }
}

function wipeExcept(dir: string, keep: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (keep.has(entry)) continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

function nextSeq(storeDir: string): number {
  const tags = git(storeDir, ["tag", "--list", "cp-*"]).out
    .split("\n")
    .filter(Boolean);
  let max = 0;
  for (const t of tags) {
    const n = Number(t.replace(/^cp-/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Snapshot the current project state (files + optional conversation log) into
 * the shadow store. Always creates a commit (even when files are unchanged) so
 * prompt- and edit-boundary checkpoints have a reliable sequence. Never touches
 * the user's repo. Returns the new checkpoint, or null if sourceDir is missing.
 */
export function snapshot(opts: CheckpointOptions, label: string): Checkpoint | null {
  if (!existsSync(opts.sourceDir)) return null;
  initStore(opts.storeDir);
  const keep = opts.keep ?? DEFAULT_KEEP;

  // Refresh the mirror working tree from the project.
  wipeExcept(opts.storeDir, new Set([".git"]));
  copyTreeFiltered(opts.sourceDir, opts.storeDir, IGNORE_NAMES);

  // Capture the conversation log into a reserved metadata path.
  if (opts.logPath && existsSync(opts.logPath)) {
    const meta = join(opts.storeDir, ".checkpoint");
    mkdirSync(meta, { recursive: true });
    copyFileSync(opts.logPath, join(meta, "session.log"));
  }

  git(opts.storeDir, ["add", "-A"]);
  git(opts.storeDir, ["commit", "-q", "--allow-empty", "-m", label]);

  const seq = nextSeq(opts.storeDir);
  git(opts.storeDir, ["tag", `cp-${seq}`]);
  const sha = git(opts.storeDir, ["rev-parse", `cp-${seq}`]).out;

  // Evict oldest beyond keep.
  const tags = git(opts.storeDir, ["tag", "--list", "cp-*"]).out
    .split("\n")
    .filter(Boolean)
    .sort((a, b) => Number(a.replace(/^cp-/, "")) - Number(b.replace(/^cp-/, "")));
  for (let i = 0; i < tags.length - keep; i++) {
    git(opts.storeDir, ["tag", "-d", tags[i]!]);
  }

  return { seq, sha, label };
}

function resolveRef(storeDir: string, ref: number | string): string {
  if (typeof ref === "number") return `cp-${ref}`;
  // Raw 40-char sha passes through; otherwise treat as a tag name.
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return ref.startsWith("cp-") ? ref : `cp-${ref}`;
}

/**
 * Restore FILES only: put the project working directory back to the state in a
 * checkpoint. Conversation (session log) is untouched.
 */
export function restoreFiles(
  storeDir: string,
  sourceDir: string,
  ref: number | string,
): void {
  if (!isStore(storeDir)) return;
  const target = resolveRef(storeDir, ref);
  git(storeDir, ["checkout", "-q", target, "--", "."]);
  // Mirror the restored working tree back into the project.
  wipeExcept(sourceDir, IGNORE_NAMES);
  copyTreeFiltered(storeDir, sourceDir, IGNORE_NAMES);
}

/**
 * Restore CONVERSATION only: roll the session log back to the checkpoint's
 * captured copy. Files are untouched.
 */
export function restoreConversation(
  storeDir: string,
  logPath: string | undefined,
  ref: number | string,
): void {
  if (!isStore(storeDir) || !logPath) return;
  const target = resolveRef(storeDir, ref);
  const r = git(storeDir, ["show", `${target}:.checkpoint/session.log`]);
  if (r.ok && r.out) {
    writeFileSync(logPath, r.out);
  } else {
    // No captured log at that checkpoint → clear the current log.
    rmSync(logPath, { force: true });
  }
}

/** Restore BOTH files and conversation (full rewind). */
export function restoreBoth(
  storeDir: string,
  sourceDir: string,
  logPath: string | undefined,
  ref: number | string,
): void {
  restoreFiles(storeDir, sourceDir, ref);
  restoreConversation(storeDir, logPath, ref);
}

/** List checkpoints newest-first with sequence, sha, and label. */
export function listCheckpoints(storeDir: string): Checkpoint[] {
  if (!isStore(storeDir)) return [];
  const tags = git(storeDir, ["tag", "--list", "cp-*"]).out
    .split("\n")
    .filter(Boolean)
    .map((t) => Number(t.replace(/^cp-/, "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a); // newest first
  const out: Checkpoint[] = [];
  for (const seq of tags) {
    const ref = `cp-${seq}`;
    const sha = git(storeDir, ["rev-parse", ref]).out;
    const label = git(storeDir, ["log", "-1", "--format=%s", ref]).out;
    out.push({ seq, sha, label });
  }
  return out;
}

/** Path of the shadow store's stored manifest info (for tool help/docs). */
export function shadowStorePath(storeDir: string): string {
  return join(storeDir, ".git");
}
