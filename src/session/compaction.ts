import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, ContentBlock, ToolResultBlock } from "../provider/types";

/**
 * Adaptive staged compaction + non-lossy offload (Roadmap §5 B2-3/B2-4).
 *
 * Supersedes the simple auto-compact threshold in session/context.ts with a
 * staged, calibrated-pressure-driven pipeline:
 *
 *   stage 0 (none)          < warn threshold
 *   stage 1 (warn, ~70%)    log/audit a warning only, no mutation
 *   stage 2 (elide, ~80%)   pure text surgery: replace OLD tool-result outputs
 *                           with short reference pointers ("[tool result
 *                           archived → <id>]"), keep last-N verbatim — NO LLM
 *                           call. Originals are offloaded to the per-session
 *                           archive file first (non-lossy).
 *   stage 4 (summarize ~90% / critical ~99%)  keep last-N verbatim, offload the
 *                           older middle segment, optionally cheap-model
 *                           summarize it, and inject a labeled low-priority
 *                           section carrying the summary + archive path.
 *
 * CACHE LAW: compaction never fires on consecutive iterations — a re-compaction
 * is skipped within `minTurnsBetween` turns unless pressure escalated to a
 * strictly higher stage (protects the prefix cache).
 *
 * All content that leaves the context is first appended to the per-session
 * archive file (`memory/archives/<session>.md`), so nothing is lost.
 */

export type Stage = 0 | 1 | 2 | 4;

/** Config-driven pressure-ratio table (fractions of the context window). */
export interface StageTable {
  warn?: number; // ~0.70 — warn only
  elide?: number; // ~0.80 — pointer-replace old tool outputs
  elideDeep?: number; // ~0.85 — deeper elide (same stage-2 action, lower keep)
  summarize?: number; // ~0.90 — cheap-model summary of the middle
  critical?: number; // ~0.99 — forced
}

export const DEFAULT_STAGES: Required<StageTable> = {
  warn: 0.7,
  elide: 0.8,
  elideDeep: 0.85,
  summarize: 0.9,
  critical: 0.99,
};

export interface CompactionOptions {
  pressureTokens: number;
  windowTokens: number;
  /** Directory for per-session archive files (memory/archives). */
  archiveDir: string;
  /** Session id — becomes the archive filename `<session>.md`. */
  sessionKey: string;
  table?: StageTable;
  /** How many most-recent tool results stay verbatim (default 8). */
  keepLast?: number;
  /** Cheap-model summarizer for the middle segment (stage 4). Optional. */
  summarize?: (segment: string) => Promise<string>;
  warn?: (msg: string) => void;
}

export interface CompactionResult {
  /** Active stage (0 = none). */
  stage: Stage;
  /** Whether the message array was mutated. */
  mutated: boolean;
  /** Archive file written this pass, if any content was offloaded. */
  archivePath?: string;
  /** Number of tool-result outputs replaced/offloaded. */
  elidedCount?: number;
  /** Whether a summary section was injected (stage 4). */
  summaryInjected?: boolean;
  /** Human note (warning / skip reason). */
  message?: string;
}

/** Map a pressure ratio (0..1) to the active stage. */
export function resolveStage(ratio: number, table: StageTable = {}): Stage {
  const t = { ...DEFAULT_STAGES, ...table };
  if (ratio < t.warn) return 0;
  if (ratio < t.elide) return 1;
  if (ratio < t.summarize) return 2;
  return 4;
}

/** Tracker the caller keeps so compaction never fires on consecutive turns. */
export interface CompactionTracker {
  lastMutatedIteration: number;
  lastStage: Stage;
}

export function newTracker(): CompactionTracker {
  return { lastMutatedIteration: -1, lastStage: 0 };
}

/**
 * CACHE LAW: a re-compaction is allowed only when (a) it's been at least
 * `minTurnsBetween` iterations since the last mutation, or (b) pressure
 * escalated to a strictly higher stage (so we never elide twice at the same
 * pressure within the window).
 */
export function shouldMutate(
  tracker: CompactionTracker,
  iteration: number,
  stage: Stage,
  minTurnsBetween = 1,
): boolean {
  if (stage === 0) return false;
  if (tracker.lastMutatedIteration < 0) return true;
  const gap = iteration - tracker.lastMutatedIteration;
  // Within the window AND not a pressure escalation → skip (never compact on
  // consecutive turns / redundant re-compaction at the same pressure).
  if (gap <= minTurnsBetween && stage <= tracker.lastStage) return false;
  return true;
}

function sanitizeFilename(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "session";
}

function toolResults(messages: ChatMessage[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result") out.push(b);
    }
  }
  return out;
}

/** Append evicted content to the archive and return the file path. */
async function offload(
  archiveDir: string,
  sessionKey: string,
  entries: Array<{ toolUseId: string; content: string }>,
): Promise<string> {
  await mkdir(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `${sanitizeFilename(sessionKey)}.md`);
  if (entries.length === 0) return archivePath;
  const body = entries
    .map((e) => `## tool_result ${e.toolUseId}\n${e.content}\n`)
    .join("\n");
  await appendFile(archivePath, body, "utf8");
  return archivePath;
}

/**
 * Stage 2 — replace OLD tool-result outputs with ~15-token reference pointers,
 * keeping the last `keepLast` verbatim. Non-lossy: originals are appended to
 * the archive first. Mutates `messages` in place.
 */
export async function elideOldToolResults(
  messages: ChatMessage[],
  opts: CompactionOptions,
): Promise<{ mutated: boolean; archivePath: string; elidedCount: number }> {
  const keepLast = Math.max(0, opts.keepLast ?? 8);
  const all = toolResults(messages);
  const total = all.length;
  const keepFrom = Math.max(0, total - keepLast);
  const evicted: Array<{ toolUseId: string; content: string }> = [];
  let seen = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      if (seen < keepFrom) {
        evicted.push({ toolUseId: b.toolUseId, content: b.content });
        b.content = `[tool result archived → ${b.toolUseId}]`;
      }
      seen++;
    }
  }
  const archivePath = await offload(opts.archiveDir, opts.sessionKey, evicted);
  return { mutated: evicted.length > 0, archivePath, elidedCount: evicted.length };
}

/**
 * Run the staged compaction pipeline against `messages` (mutating in place).
 * Returns the active stage and what it did.
 */
export async function runStagedCompaction(
  messages: ChatMessage[],
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const ratio = opts.windowTokens > 0 ? opts.pressureTokens / opts.windowTokens : 1;
  const stage = resolveStage(ratio, opts.table);

  if (stage === 0) {
    return { stage: 0, mutated: false };
  }
  if (stage === 1) {
    opts.warn?.(`context at ${Math.round(ratio * 100)}% — warn stage reached (no compaction yet)`);
    return { stage: 1, mutated: false, message: `context at ${Math.round(ratio * 100)}%` };
  }
  if (stage === 2) {
    const r = await elideOldToolResults(messages, opts);
    return {
      stage: 2,
      mutated: r.mutated,
      archivePath: r.archivePath,
      elidedCount: r.elidedCount,
      message: r.mutated
        ? `elided ${r.elidedCount} old tool result(s) → archive`
        : "elide stage reached but nothing to elide",
    };
  }

  // Stage 4 — summarize / critical.
  const keepLast = Math.max(0, opts.keepLast ?? 8);
  const all = toolResults(messages);
  const total = all.length;
  const keepFrom = Math.max(0, total - keepLast);
  const evicted: Array<{ toolUseId: string; content: string }> = [];
  let seen = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      if (seen < keepFrom) {
        evicted.push({ toolUseId: b.toolUseId, content: b.content });
        b.content = `[tool result archived → ${b.toolUseId}]`;
      }
      seen++;
    }
  }
  const archivePath = await offload(opts.archiveDir, opts.sessionKey, evicted);

  let summary: string | null = null;
  if (opts.summarize && evicted.length > 0) {
    const segment = evicted.map((e) => `[${e.toolUseId}]\n${e.content}`).join("\n\n");
    try {
      summary = (await opts.summarize(segment)).trim() || null;
    } catch {
      summary = null;
    }
  }

  const note: string[] = ["[archived context]"];
  if (summary) note.push(`Summary: ${summary}`);
  note.push(`Full history archived at ${archivePath} — use read_file to recover`);
  // Inject as a low-priority section at the front; recent messages stay at the
  // tail, verbatim.
  messages.unshift({ role: "assistant", content: note.join("\n") });

  return {
    stage: 4,
    mutated: true,
    archivePath,
    elidedCount: evicted.length,
    summaryInjected: true,
    message: summary ? "summarized + archived middle segment" : "archived middle segment",
  };
}

/** @internal — keep the ContentBlock import used by the type surface. */
export type { ChatMessage, ContentBlock };
