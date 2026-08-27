import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ===========================================================================
// B9-9 USER/MEMORY/daily-notes layering (DR6-2, #426)
// ---------------------------------------------------------------------------
// Plain readable/editable/deletable files only — no PII dossier, no secrets,
// no hidden store. A four-layer precedence stack sits under a base directory:
//
//   managed  curated profile core (~2k chars imperative directives)
//   user     long-term MEMORY.md store (first 200 lines / 25 KiB injected)
//   project  per-repo auto-memory
//   local    local-only memory (gitignored by the host)
//
// Key resolution walks the stack managed -> user -> project -> local, so a key
// that exists in several layers is won by the highest-precedence one. Dated
// daily notes (YYYY-MM-DD.md) are a SEPARATE, retrieval-indexed store — they
// are never merged into the per-turn injection. Foreign imports (profiles /
// skills) land in an isolated quarantine scope and never touch the existing
// layers. Every write honours a per-call learning toggle; when it is off
// nothing is written anywhere.
//
// No PII dossier and no secrets are ever stored by design: values are kept as
// given, in plain per-key markdown files, deletable by removing the file.
// ===========================================================================

export type MemoryLayer = "managed" | "user" | "project" | "local";

/** Precedence order — index 0 wins resolution. */
export const LAYER_ORDER: MemoryLayer[] = ["managed", "user", "project", "local"];

/** Curated profile core cap (imperative directives), ~2k chars. */
export const PROFILE_MAX_CHARS = 2000;

/** Long-term MEMORY.md injection caps: 25 KiB and 200 lines. */
export const MEMORY_MAX_BYTES = 25 * 1024;
export const MEMORY_MAX_LINES = 200;

export interface LayerWriteOptions {
  /** When false, the write is a no-op and nothing is persisted anywhere. */
  learningEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function layerDir(base: string, layer: MemoryLayer): string {
  return join(base, layer);
}

function notesDir(base: string): string {
  return join(base, "notes");
}

function quarantineScopeDir(base: string, scope: string): string {
  return join(base, "quarantine", sanitizeScope(scope));
}

/** Path of a single per-key entry file within a layer. */
export function entryPath(base: string, layer: MemoryLayer, key: string): string {
  return join(layerDir(base, layer), `${sanitizeKey(key)}.md`);
}

/** Path of a dated daily note (YYYY-MM-DD.md). */
export function dailyNotePath(base: string, date: string): string {
  return join(notesDir(base), `${date}.md`);
}

/** Path of an isolated quarantine entry. */
export function quarantinePath(base: string, scope: string, key: string): string {
  return join(quarantineScopeDir(base, scope), `${sanitizeKey(key)}.md`);
}

// Keys and scopes become file names, so they must be safe on any filesystem:
// keep only [A-Za-z0-9._-] and collapse runs. This also keeps the precedence
// and quarantine lookups deterministic and collision-free.
function sanitizeKey(key: string): string {
  return key.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
}

function sanitizeScope(scope: string): string {
  const s = scope.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return s || "import";
}

function learningOff(opts?: LayerWriteOptions): boolean {
  return opts?.learningEnabled === false;
}

// ---------------------------------------------------------------------------
// Layer read / write
// ---------------------------------------------------------------------------

/** Read every entry of one layer as a key -> content map. Empty files are
 *  dropped so deleting a file (or emptying it) removes the key. */
export function readLayer(base: string, layer: MemoryLayer): Map<string, string> {
  const out = new Map<string, string>();
  const dir = layerDir(base, layer);
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue;
    const content = readFileSync(join(dir, file), "utf8");
    if (content === "") continue;
    out.set(file.slice(0, -3), content);
  }
  return out;
}

/** Write (or clear) a single entry in a layer. Returns true when a write
 *  happened, false when the learning toggle suppressed it. Passing an empty
 *  content deletes the entry file (deletable by design). */
export function writeEntry(
  base: string,
  layer: MemoryLayer,
  key: string,
  content: string,
  opts?: LayerWriteOptions,
): boolean {
  if (learningOff(opts)) return false;
  const path = entryPath(base, layer, key);
  if (content === "") {
    // Deletable: an empty value removes the key.
    rmSync(path, { force: true });
    // Prune an empty layer/quarantine dir so a cleared layer leaves no trace.
    const parent = layerDir(base, layer);
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true, force: true });
    }
    return true;
  }
  mkdirSync(layerDir(base, layer), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

/** Resolve a key across the layer stack by precedence
 *  (managed > user > project > local). Returns null when absent everywhere. */
export function resolveEntry(
  base: string,
  key: string,
): { layer: MemoryLayer; content: string } | null {
  for (const layer of LAYER_ORDER) {
    const content = readLayer(base, layer).get(key);
    if (content !== undefined) return { layer, content };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-turn injection (managed profile + user MEMORY.md; daily notes excluded)
// ---------------------------------------------------------------------------

export interface InjectionResult {
  /** The combined injected text (profile + memory), or "" when empty. */
  text: string;
  /** Managed profile core, capped at PROFILE_MAX_CHARS. */
  profile: string | null;
  /** User MEMORY.md store, capped at MEMORY_MAX_BYTES / MEMORY_MAX_LINES. */
  memory: string | null;
  /** Keys that contributed to the injection, profile keys first. */
  injectedKeys: string[];
}

function joinEntries(entries: Map<string, string>): string {
  return [...entries.entries()]
    .map(([key, content]) => `${key}: ${content}`)
    .join("\n");
}

/** Build the per-turn memory injection from the two injected tiers. Daily
 *  notes are deliberately NOT included — they are retrieval-indexed only. */
export function buildInjection(base: string): InjectionResult {
  return composeInjection(readLayer(base, "managed"), readLayer(base, "user"));
}

/** Shared composition: apply the profile/memory caps and render the labeled
 *  injection from two key→content maps. Used by both the native layered store
 *  and the workspace-convention adapter below. */
function composeInjection(
  profileEntries: Map<string, string>,
  memoryEntries: Map<string, string>,
): InjectionResult {
  // Profile core: cap the whole layer at ~2k chars.
  let profile = joinEntries(profileEntries);
  if (profile.length > PROFILE_MAX_CHARS) {
    profile = profile.slice(0, PROFILE_MAX_CHARS);
  }

  // Long-term MEMORY: first 200 lines, then cut at 25 KiB.
  let memory = joinEntries(memoryEntries);
  const lines = memory.split("\n");
  if (lines.length > MEMORY_MAX_LINES) {
    memory = lines.slice(0, MEMORY_MAX_LINES).join("\n");
  }
  if (memory.length > MEMORY_MAX_BYTES) {
    memory = memory.slice(0, MEMORY_MAX_BYTES);
  }

  const injectedKeys = [...profileEntries.keys(), ...memoryEntries.keys()];
  const parts: string[] = [];
  if (profile) parts.push(`# Profile (managed)\n${profile}`);
  if (memory) parts.push(`# Memory (user)\n${memory}`);
  return {
    text: parts.join("\n\n"),
    profile: profile || null,
    memory: memory || null,
    injectedKeys,
  };
}

/**
 * B9-9 → #460 adapter: read the workspace convention's two human-editable
 * aggregate files as the "user" tier. `USER.md` → key `user`, `MEMORY.md` →
 * key `memory`. Returns an empty map when neither file has content.
 */
export function readWorkspaceUserLayer(wsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const userPath = join(wsDir, "USER.md");
  const memPath = join(wsDir, "MEMORY.md");
  if (existsSync(userPath)) {
    const c = readFileSync(userPath, "utf8").trim();
    if (c) out.set("user", c);
  }
  if (existsSync(memPath)) {
    const c = readFileSync(memPath, "utf8").trim();
    if (c) out.set("memory", c);
  }
  return out;
}

/** Build the per-turn injection from the workspace convention: the managed
 *  layer reads `wsDir/managed/*.md`, the user tier reads `USER.md`+`MEMORY.md`. */
export function buildWorkspaceInjection(wsDir: string): InjectionResult {
  return composeInjection(readLayer(wsDir, "managed"), readWorkspaceUserLayer(wsDir));
}

/** Convenience gate used by prompt builders: returns the layered injection
 *  text when `memory.layers.enabled` is set and the workspace has content,
 *  otherwise null. */
export function buildLayeredMemory(
  wsDir: string,
  memoryConfig?: { layers?: { enabled?: boolean } },
): string | null {
  if (!memoryConfig?.layers?.enabled) return null;
  return buildWorkspaceInjection(wsDir).text || null;
}

// ---------------------------------------------------------------------------
// Daily notes — indexed for retrieval, never injected per turn
// ---------------------------------------------------------------------------

export interface DailyNote {
  date: string;
  path: string;
  content: string;
}

/** Write a dated daily note (YYYY-MM-DD.md). Returns its path, or null when
 *  the learning toggle suppressed the write. */
export function writeDailyNote(
  base: string,
  date: string,
  content: string,
  opts?: LayerWriteOptions,
): string | null {
  if (learningOff(opts)) return null;
  const path = dailyNotePath(base, date);
  mkdirSync(notesDir(base), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

/** Read one dated note, or null when absent. */
export function readDailyNote(base: string, date: string): string | null {
  const path = dailyNotePath(base, date);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** List all dated notes, oldest first. This is the retrieval index — callers
 *  query it on demand; it is not part of buildInjection(). */
export function listDailyNotes(base: string): DailyNote[] {
  const dir = notesDir(base);
  if (!existsSync(dir)) return [];
  const out: DailyNote[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(file)) continue;
    const date = file.slice(0, -3);
    out.push({ date, path: join(dir, file), content: readFileSync(join(dir, file), "utf8") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quarantine — isolated imports (foreign profiles / skills)
// ---------------------------------------------------------------------------

export interface QuarantineResult {
  written: string[];
  skipped: string[];
}

/** Land foreign profile/skill imports in an isolated quarantine scope, keyed
 *  by the import's scope name. Existing layers are NEVER touched — imports are
 *  never auto-merged into the live stack. Returns the paths written (and any
 *  skipped by the learning toggle). */
export function importToQuarantine(
  base: string,
  scope: string,
  entries: Record<string, string>,
  opts?: LayerWriteOptions,
): QuarantineResult {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [key, content] of Object.entries(entries)) {
    if (learningOff(opts)) {
      skipped.push(key);
      continue;
    }
    const path = quarantinePath(base, scope, key);
    mkdirSync(quarantineScopeDir(base, scope), { recursive: true });
    writeFileSync(path, content, "utf8");
    written.push(path);
  }
  return { written, skipped };
}
