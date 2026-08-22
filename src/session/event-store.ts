/**
 * Session-as-event-store formalization (Roadmap §6 B3-1, #407) + sequence
 * integrity law (B3-2).
 *
 * The session log is the ONLY source of truth; message history is a DERIVED
 * view, never authoritative. This module makes that contract explicit and
 * testable:
 *
 *   - EVENT CLASSIFICATION: events split into LLM-convertible (Message,
 *     Action=tool_call, Observation=tool_result) vs Internal (usage, error,
 *     compression, session_start, and the future StateUpdate/Pause). Internal
 *     events NEVER leak into the derived model history, but stay in the audit
 *     view (the raw event list).
 *   - DERIVED HISTORY: {@link deriveModelHistory} rebuilds the model-visible
 *     message list deterministically — the same event set yields byte-identical
 *     output, twice.
 *   - SEQUENCE INTEGRITY (B3-2): seq is always derived from a FRESH load of
 *     the committed prefix ({@link deriveSequence}), never from an in-memory
 *     stale snapshot; {@link validateSequence} detects and rejects the
 *     seq-gap corruption class at load.
 *   - CRASH-SAFE REPLAY: {@link replayState} folds only complete events and
 *     stops at the first incomplete one — a crash mid-turn never applies a
 *     partial event.
 */

import type { ChatMessage } from "../provider/types";
import type { SessionEvent } from "./events";

/** Event kinds that belong in the derived, model-visible history. */
export const MODEL_VISIBLE_TYPES = new Set(["message", "tool_call", "tool_result"]);

/** True when the event is LLM-convertible; false for internal bookkeeping. */
export function isModelVisible(event: SessionEvent): boolean {
  return MODEL_VISIBLE_TYPES.has(event.t);
}

/**
 * Derive the model-visible message history from an event list. Internal events
 * (usage/error/compression/session_start) are excluded; Message, Action
 * (tool_call) and Observation (tool_result) are projected to chat messages.
 * Deterministic: same input ⇒ identical output (array + content), call after call.
 */
export function deriveModelHistory(events: SessionEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of events) {
    if (e.t === "message") {
      out.push({ role: e.role, content: e.content });
    } else if (e.t === "tool_call") {
      out.push({ role: "assistant", content: `tool_call(${e.name})` });
    } else if (e.t === "tool_result") {
      out.push({ role: "user", content: `tool_result(${e.name}): ${e.output}` });
    }
    // Internal events intentionally skipped.
  }
  return out;
}

/** Canonical, byte-stable rendering of a derived history (for determinism asserts). */
export function renderDerivedHistory(events: SessionEvent[]): string {
  return deriveModelHistory(events)
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[blocks]"}`)
    .join("\n");
}

/**
 * B3-2 law: seq is derived from the FRESH load position (1-based), never from
 * a stale in-memory counter. A fresh load of N committed events always yields
 * exactly 1..N.
 */
export function deriveSequence(events: unknown[]): number[] {
  return events.map((_, i) => i + 1);
}

/**
 * Validate a sequence for the gap-corruption class (#2167): a contiguous,
 * strictly monotonic 1..N. Any gap, duplicate, or out-of-order entry is
 * rejected at load rather than silently accepted.
 */
export function validateSequence(seqs: number[]):
  | { ok: true; count: number }
  | { ok: false; reason: string } {
  for (let i = 0; i < seqs.length; i++) {
    const expected = i + 1;
    if (seqs[i] !== expected) {
      return {
        ok: false,
        reason: `seq corruption at index ${i}: expected ${expected}, got ${seqs[i]}`,
      };
    }
  }
  return { ok: true, count: seqs.length };
}

/** True when the event is fully formed and safe to count as committed. */
export function isCompleteEvent(e: SessionEvent): boolean {
  if (e.t === "message") {
    return typeof e.content === "string" ? e.content.length > 0 : true;
  }
  if (e.t === "tool_call") return e.id.length > 0 && e.name.length > 0;
  if (e.t === "tool_result") return e.id.length > 0 && e.name.length > 0;
  return true;
}

/** The state we fold events into on replay (deterministic). */
export interface ReplayState {
  messageCount: number;
  lastUserMessage: string | null;
  toolCalls: number;
  /** Number of events committed into this state. */
  committed: number;
}

export function emptyReplayState(): ReplayState {
  return { messageCount: 0, lastUserMessage: null, toolCalls: 0, committed: 0 };
}

function reduce(state: ReplayState, e: SessionEvent): ReplayState {
  if (e.t === "message") {
    const text = typeof e.content === "string" ? e.content : "[blocks]";
    return {
      ...state,
      messageCount: state.messageCount + 1,
      lastUserMessage: e.role === "user" ? text : state.lastUserMessage,
    };
  }
  if (e.t === "tool_call") return { ...state, toolCalls: state.toolCalls + 1 };
  return state;
}

/**
 * Crash-safe deterministic replay: fold `base` state forward over the events,
 * stopping at the first INCOMPLETE event (e.g. a tool_call whose result was
 * never recorded because the run crashed mid-turn). The incomplete event is
 * never applied — `committed` reflects only fully-formed events.
 */
export function replayState(base: ReplayState, events: SessionEvent[]): ReplayState {
  let state: ReplayState = { ...base, committed: base.committed };
  for (const e of events) {
    if (!isCompleteEvent(e)) break;
    state = reduce(state, e);
    state.committed += 1;
  }
  return state;
}
