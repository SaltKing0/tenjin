// ===========================================================================
// B13-8 Event-sourced web console transcript (#432)
// ---------------------------------------------------------------------------
// The console transcript is ONE codepath: a pure, deterministic reducer over
// an append-only event stream. Both the live SSE view and history replay feed
// the SAME TranscriptSession — live appends events as they happen, replay
// appends the recorded events — so for identical input they produce identical
// cards (byte-identical via serialize()).
//
// Structured event vocabulary separates the streams so reasoning, content and
// tool-call rendering never bleed into each other's panels. Tool calls are
// lifecycle cards: opened on START (with streaming JSON args), marked running
// on END, closed on RESULT (exit + inline diff for edit-type results).
// ===========================================================================

import type { SessionEvent } from "../session/events";

// ---------------------------------------------------------------------------
// Event vocabulary (the append-only transcript stream)
// ---------------------------------------------------------------------------

export type TranscriptEvent =
  | { kind: "TEXT_MESSAGE_CONTENT"; source: "agent" | "user"; text: string; ts: string }
  | { kind: "REASONING_CONTENT"; text: string; ts: string }
  | { kind: "TOOL_CALL_START"; id: string; name: string; ts: string }
  /** Streaming partial JSON — chunks accumulate into the open card. */
  | { kind: "TOOL_CALL_ARGS"; id: string; argsJson: string; ts: string }
  | { kind: "TOOL_CALL_END"; id: string; ts: string }
  | { kind: "TOOL_RESULT"; id: string; ok: boolean; output: string; ts: string }
  | { kind: "STATE_DELTA"; text: string; ts: string }
  | { kind: "AgentError"; message: string; ts: string };

// ---------------------------------------------------------------------------
// Renderable cards
// ---------------------------------------------------------------------------

export interface UnifiedDiff {
  old: string;
  new: string;
  unified: string;
  changed: boolean;
}

export type TranscriptCard =
  | { kind: "text"; source: "agent" | "user"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      state: "streaming" | "running" | "done" | "error";
      argsJson: string;
      parsedArgs?: unknown;
      argsParseError?: boolean;
      result?: { ok: boolean; output: string };
      diff?: UnifiedDiff;
    }
  | { kind: "state"; text: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Mapping from the persisted session event model to the transcript stream
// ---------------------------------------------------------------------------

/** Convert one persisted SessionEvent into zero or more transcript events. */
export function fromSessionEvent(e: SessionEvent): TranscriptEvent[] {
  const ts = e.ts;
  switch (e.t) {
    case "session_start":
      return [
        {
          kind: "STATE_DELTA",
          text: `session ${e.id} · ${e.provider || "?"}:${e.model || "?"}` +
            (e.parent ? ` · forked from ${e.parent.id}` : ""),
          ts,
        },
      ];
    case "message": {
      const out: TranscriptEvent[] = [];
      if (typeof e.content === "string") {
        out.push({
          kind: "TEXT_MESSAGE_CONTENT",
          source: e.role === "user" ? "user" : "agent",
          text: e.content,
          ts,
        });
        return out;
      }
      for (const block of e.content) {
        switch (block.type) {
          case "text":
            out.push({
              kind: "TEXT_MESSAGE_CONTENT",
              source: e.role === "user" ? "user" : "agent",
              text: block.text,
              ts,
            });
            break;
          case "tool_use":
            out.push(
              { kind: "TOOL_CALL_START", id: block.id, name: block.name, ts },
              { kind: "TOOL_CALL_ARGS", id: block.id, argsJson: JSON.stringify(block.input ?? {}), ts },
              { kind: "TOOL_CALL_END", id: block.id, ts },
            );
            break;
          case "tool_result":
            out.push({
              kind: "TOOL_RESULT",
              id: block.toolUseId,
              ok: !block.isError,
              output: block.content,
              ts,
            });
            break;
        }
      }
      return out;
    }
    case "tool_call":
      return [
        { kind: "TOOL_CALL_START", id: e.id, name: e.name, ts },
        { kind: "TOOL_CALL_ARGS", id: e.id, argsJson: JSON.stringify(e.input ?? {}), ts },
        { kind: "TOOL_CALL_END", id: e.id, ts },
      ];
    case "tool_result":
      return [{ kind: "TOOL_RESULT", id: e.id, ok: e.ok, output: e.output, ts }];
    case "usage":
      return [
        {
          kind: "STATE_DELTA",
          text: `$ in ${e.inputTokens} out ${e.outputTokens} · ${e.costUSD} turn · ${e.spentUSD} spent`,
          ts,
        },
      ];
    case "compression":
      return [
        {
          kind: "STATE_DELTA",
          text: `context ${e.beforeTokens} -> ${e.afterTokens} (elided ${e.elidedTokens})`,
          ts,
        },
      ];
    case "error":
      return [{ kind: "AgentError", message: e.message, ts }];
  }
}

// ---------------------------------------------------------------------------
// Inline unified diff for edit-type tool results
// ---------------------------------------------------------------------------

/** Common old/new field spellings across edit/write tools (mirrors #147). */
export function toolDiff(
  tool: string,
  args: unknown,
): UnifiedDiff | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const one = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string") return v;
    }
    return undefined;
  };
  const isEdit = tool === "edit_file" || tool === "edit";
  const isWrite = tool === "write_file" || tool === "write";
  const pathField = typeof obj.path === "string" ? obj.path : undefined;
  if (!isEdit && !isWrite && pathField === undefined) return undefined;
  const oldText = one("oldText", "old_string", "oldContent", "old", "oldString");
  const newText = one("newText", "new_string", "newContent", "new", "content", "newString");
  if (oldText === undefined && newText === undefined) return undefined;
  return computeUnifiedDiff(oldText ?? "", newText ?? "");
}

/**
 * Line-based unified diff (zero deps): common prefix/suffix around a single
 * hunk, context lines, `-` removed / `+` added. Deterministic and sufficient
 * for inline rendering. Returns changed:false when old and new are identical.
 */
export function computeUnifiedDiff(oldText: string, newText: string): UnifiedDiff {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (oldText === newText) {
    return { old: oldText, new: newText, unified: "", changed: false };
  }
  // trim a single trailing empty element from split("") so a trailing newline
  // does not produce a phantom empty line
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.slice(p, a.length - s);
  const added = b.slice(p, b.length - s);
  if (removed.length === 0 && added.length === 0) {
    return { old: oldText, new: newText, unified: "", changed: false };
  }
  const context = 3;
  const before = a.slice(Math.max(0, p - context), p);
  const after = a.slice(a.length - s, a.length - s + context);
  const start = p - before.length;
  const lines: string[] = [];
  lines.push(
    `@@ -${start},${before.length + removed.length + after.length} ` +
      `+${start},${before.length + added.length + after.length} @@`,
  );
  for (const l of before) lines.push(` ${l}`);
  for (const l of removed) lines.push(`-${l}`);
  for (const l of added) lines.push(`+${l}`);
  for (const l of after) lines.push(` ${l}`);
  return { old: oldText, new: newText, unified: lines.join("\n"), changed: true };
}

// ---------------------------------------------------------------------------
// The reducer / TranscriptSession — the single shared codepath
// ---------------------------------------------------------------------------

/** Tolerant JSON parse for streaming tool args — returns the parsed value or
 *  undefined (never throws) so partial chunks don't corrupt the card. */
function tryParseJson(raw: string): { value: unknown } | { error: true } {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { error: true };
  }
}

export class TranscriptSession {
  private cards: TranscriptCard[] = [];

  /** Append a raw transcript event through the reducer. */
  appendTranscript(ev: TranscriptEvent): void {
    switch (ev.kind) {
      case "TEXT_MESSAGE_CONTENT":
        this.cards.push({ kind: "text", source: ev.source, text: ev.text });
        return;
      case "REASONING_CONTENT":
        this.cards.push({ kind: "reasoning", text: ev.text });
        return;
      case "STATE_DELTA":
        this.cards.push({ kind: "state", text: ev.text });
        return;
      case "AgentError":
        this.cards.push({ kind: "error", message: ev.message });
        return;
      case "TOOL_CALL_START": {
        this.cards.push({
          kind: "tool",
          id: ev.id,
          name: ev.name,
          state: "streaming",
          argsJson: "",
        });
        return;
      }
      case "TOOL_CALL_ARGS": {
        const card = this.openTool(ev.id);
        if (!card) return; // orphan args chunk — ignore, keep stream intact
        card.argsJson += ev.argsJson;
        return;
      }
      case "TOOL_CALL_END": {
        const card = this.openTool(ev.id);
        if (!card) return;
        card.state = "running";
        const parsed = tryParseJson(card.argsJson);
        if ("value" in parsed) {
          card.parsedArgs = parsed.value;
          card.argsParseError = false;
        } else {
          card.argsParseError = true;
        }
        return;
      }
      case "TOOL_RESULT": {
        const card = this.openTool(ev.id);
        if (!card) return;
        card.state = ev.ok ? "done" : "error";
        card.result = { ok: ev.ok, output: ev.output };
        const diff = toolDiff(card.name, card.parsedArgs);
        if (diff && diff.changed) card.diff = diff;
        return;
      }
    }
  }

  /** Find an open (streaming/running) tool card by id — a tool lifecycle card
   *  is only mutated while open; a stray result for a closed card is ignored. */
  private openTool(id: string): TranscriptCard & { kind: "tool" } | undefined {
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const c = this.cards[i]!;
      if (c.kind === "tool" && c.id === id && c.state !== "done" && c.state !== "error") {
        return c;
      }
    }
    return undefined;
  }

  /** Append a persisted session event (live and replay share this path). */
  append(e: SessionEvent): void {
    for (const te of fromSessionEvent(e)) this.appendTranscript(te);
  }

  /** The current ordered cards. */
  snapshot(): TranscriptCard[] {
    return [...this.cards];
  }

  /** Canonical JSON — live and replay must serialize identically. */
  serialize(): string {
    return JSON.stringify(this.cards);
  }
}

/** Replay a recorded session through the SAME reducer the live view uses. */
export function renderTranscript(events: SessionEvent[]): TranscriptCard[] {
  const session = new TranscriptSession();
  for (const e of events) session.append(e);
  return session.snapshot();
}
