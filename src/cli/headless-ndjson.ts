/**
 * Headless ndjson mode (Roadmap §16 B13-7, #416).
 *
 * Machine-consumable end to end (aider --message / cline --json pattern): a
 * non-interactive run emits one JSON object per line — turn events, usage,
 * compression, heartbeat — followed by a final stats block. No PTY/ANSI noise.
 *
 *   - Every emitted line is a single JSON object (newline-delimited); nothing
 *     else is ever written in this mode.
 *   - Stats block: tokens per model, cost, tool counts, files changed, duration.
 *   - Heartbeats during long waits keep consumers alive (fake-clock testable).
 *   - Exit codes: 0 on success (end_turn), nonzero on a failed/aborted turn.
 *
 * The conversion/accumulation functions are PURE and unit-testable without a
 * provider or network; {@link runHeadlessNdjson} wires them onto a real run.
 */

import type { TurnEvent } from "../agent/loop";
import type { HeadlessOptions, HeadlessResult } from "../agent/headless";
import { runHeadless } from "../agent/headless";

/** One newline-delimited JSON event. */
export type NdjsonEvent = Record<string, unknown> & { type: string };

/** Serialize one event to a single ndjson line (trailing newline). */
export function writeNdjson(write: (line: string) => void, e: NdjsonEvent): void {
  write(JSON.stringify(e) + "\n");
}

/** Map a turn event to its ndjson object (assistant msg, tool, usage, compression). */
export function turnEventToNdjson(e: TurnEvent): NdjsonEvent {
  switch (e.t) {
    case "assistant_message":
      return { type: "message", content: e.content };
    case "tool_call":
      return { type: "tool_call", id: e.id, name: e.name, input: e.input };
    case "tool_result":
      return { type: "tool_result", id: e.id, name: e.name, ok: e.ok, output: e.output };
    case "usage":
      return {
        type: "usage",
        inputTokens: e.usage.inputTokens,
        outputTokens: e.usage.outputTokens,
        cacheReadInputTokens: e.usage.cacheReadInputTokens ?? 0,
        costUSD: e.costUSD,
      };
    case "compression":
      return {
        type: "compression",
        beforeTokens: e.beforeTokens,
        afterTokens: e.afterTokens,
        elidedTokens: e.elidedTokens,
        ...(e.stage !== undefined ? { stage: e.stage } : {}),
        ...(e.archivePath ? { archivePath: e.archivePath } : {}),
        ...(e.skipped ? { skipped: e.skipped } : {}),
      };
  }
}

/** Heartbeat line emitted during long waits (injectable clock for tests). */
export function heartbeatEvent(now: number): NdjsonEvent {
  return { type: "heartbeat", at: now };
}

/** Error line emitted for a failed/aborted turn. */
export function errorEvent(message: string): NdjsonEvent {
  return { type: "error", message };
}

/** Accumulated run statistics derived purely from the turn events. */
export interface CollectedStats {
  toolCounts: Record<string, number>;
  filesChanged: string[];
  inputTokens: number;
  outputTokens: number;
}

/** Tools whose primary effect is writing a file (counted as "files changed"). */
const FILE_MUTATORS = new Set(["write", "edit", "apply_patch", "bash"]);

function filePathFor(name: string, input: unknown): string | undefined {
  if (!FILE_MUTATORS.has(name)) return undefined;
  const p = (input as { path?: unknown })?.path;
  return typeof p === "string" && p ? p : undefined;
}

/** Fold turn events into per-tool counts, files-changed set and token totals. */
export function collectStats(turnEvents: readonly TurnEvent[]): CollectedStats {
  const toolCounts: Record<string, number> = {};
  const filesChanged: string[] = [];
  const seen = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of turnEvents) {
    if (e.t === "tool_call") {
      toolCounts[e.name] = (toolCounts[e.name] ?? 0) + 1;
      const path = filePathFor(e.name, e.input);
      if (path && !seen.has(path)) {
        seen.add(path);
        filesChanged.push(path);
      }
    } else if (e.t === "usage") {
      inputTokens += e.usage.inputTokens;
      outputTokens += e.usage.outputTokens;
    }
  }
  return { toolCounts, filesChanged, inputTokens, outputTokens };
}

/** The final stats block: tokens per model, cost, tool counts, files, duration. */
export function statsBlock(opts: {
  model: string;
  costUSD: number;
  durationMs: number;
  stats: CollectedStats;
}): NdjsonEvent {
  return {
    type: "stats",
    model: opts.model,
    tokens: { input: opts.stats.inputTokens, output: opts.stats.outputTokens },
    costUSD: opts.costUSD,
    toolCounts: opts.stats.toolCounts,
    filesChanged: opts.stats.filesChanged,
    durationMs: opts.durationMs,
  };
}

/** Exit code: 0 on a successful turn, nonzero otherwise (CI-friendly). */
export function exitCodeFor(stopReason: string): number {
  return stopReason === "end_turn" ? 0 : 1;
}

export interface NdjsonRunOptions extends HeadlessOptions {
  /** Writer for ndjson lines (defaults to process.stdout.write). */
  write?: (line: string) => void;
  /** Heartbeat interval in ms during the run (default 5_000; 0 = off). */
  heartbeatMs?: number;
  /** Injectable wall clock for heartbeat timestamps (tests). */
  now?: () => number;
}

/**
 * Run a headless turn emitting pure ndjson (events + heartbeat + stats block).
 * Returns the process exit code. The ndjson conversion/accumulation is pure;
 * this only drives a real run through {@link runHeadless}.
 */
export async function runHeadlessNdjson(opts: NdjsonRunOptions): Promise<number> {
  const write = opts.write ?? ((l: string) => process.stdout.write(l));
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const turnEvents: TurnEvent[] = [];

  const stopHeartbeat =
    opts.heartbeatMs && opts.heartbeatMs > 0
      ? (() => {
          const id = setInterval(() => writeNdjson(write, heartbeatEvent(now())), opts.heartbeatMs!);
          return () => clearInterval(id);
        })()
      : () => {};

  try {
    const result: HeadlessResult = await runHeadless({
      ...opts,
      onEvent: (e: TurnEvent) => {
        turnEvents.push(e);
        writeNdjson(write, turnEventToNdjson(e));
      },
    });
    stopHeartbeat();
    writeNdjson(
      write,
      statsBlock({
        model: opts.model,
        costUSD: result.costUSD,
        durationMs: now() - startedAt,
        stats: collectStats(turnEvents),
      }),
    );
    return exitCodeFor(result.stopReason);
  } catch (e) {
    stopHeartbeat();
    writeNdjson(write, errorEvent((e as Error)?.message ?? String(e)));
    return 1;
  }
}
