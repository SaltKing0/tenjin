import { describe, test, expect } from "bun:test";
import {
  TranscriptSession,
  renderTranscript,
  fromSessionEvent,
  toolDiff,
  computeUnifiedDiff,
  type TranscriptCard,
} from "../src/gateway/transcript";

/**
 * B13-8 (#432): event-sourced web console transcript. ONE codepath — a pure
 * reducer over an append-only event stream — drives BOTH live SSE and history
 * replay, so replay reproduces any past session exactly. All headless.
 */

// A representative recorded session (persisted SessionEvent shape).
function sampleSession() {
  return [
    { t: "session_start", id: "s1", ts: "1", provider: "anthropic", model: "claude" },
    { t: "message", ts: "2", role: "user", content: "hello" },
    { t: "message", ts: "3", role: "assistant", content: "I will fix it" },
    { t: "tool_call", ts: "4", id: "t1", name: "edit_file", input: { path: "a.txt", oldText: "old line", newText: "new line" } },
    { t: "tool_result", ts: "5", id: "t1", ok: true, output: "edited" },
    { t: "error", ts: "6", message: "retry limit hit" },
  ];
}

function kinds(cards: TranscriptCard[]): string[] {
  return cards.map((c) => c.kind);
}

describe("B13-8 transcript — replay == live, one codepath", () => {
  test("history replay reproduces the transcript byte-identically to live rendering", () => {
    const events = sampleSession() as any;
    // Live: feed each event through the SAME reducer as it happens.
    const live = new TranscriptSession();
    for (const e of events) live.append(e);
    // Replay: reduce the recorded events (same codepath).
    const replayCards = renderTranscript(events);
    expect(live.serialize()).toBe(JSON.stringify(replayCards));
    // And both contain the full transcript.
    const text = live.serialize();
    expect(text).toContain('"kind":"text"');
    expect(text).toContain("hello");
    expect(text).toContain('"kind":"tool"');
    expect(text).toContain("edit_file");
    expect(text).toContain('"kind":"error"');
  });

  test("the same reducer is used for live and replay (shared instance path)", () => {
    const evs = sampleSession() as any;
    // Replay via renderTranscript then serialize:
    const viaReplay = renderTranscript(evs);
    // Incremental via a single session:
    const s = new TranscriptSession();
    for (const e of evs) s.append(e);
    expect(JSON.stringify(viaReplay)).toBe(s.serialize());
  });
});

describe("B13-8 transcript — streaming partial JSON args", () => {
  test("tool args stream progressively without corrupting the final card", () => {
    const s = new TranscriptSession();
    s.appendTranscript({ kind: "TOOL_CALL_START", id: "t2", name: "call_tool", ts: "1" });
    s.appendTranscript({ kind: "TOOL_CALL_ARGS", id: "t2", argsJson: '{"a":1,', ts: "2" });
    const mid = s.snapshot();
    const midCard = mid[mid.length - 1]!;
    expect(midCard.kind).toBe("tool");
    if (midCard.kind === "tool") expect(midCard.argsJson).toBe('{"a":1,');
    s.appendTranscript({ kind: "TOOL_CALL_ARGS", id: "t2", argsJson: '"b":[1,2]}', ts: "3" });
    s.appendTranscript({ kind: "TOOL_CALL_END", id: "t2", ts: "4" });
    const card = s.snapshot().at(-1)!;
    expect(card.kind).toBe("tool");
    if (card.kind === "tool") {
      expect(card.argsJson).toBe('{"a":1,"b":[1,2]}');
      expect(card.parsedArgs).toEqual({ a: 1, b: [1, 2] });
      expect(card.argsParseError).toBe(false);
      expect(card.state).toBe("running");
    }
  });

  test("args chunks after END cannot corrupt a finalized card", () => {
    const s = new TranscriptSession();
    s.appendTranscript({ kind: "TOOL_CALL_START", id: "t3", name: "bash", ts: "1" });
    s.appendTranscript({ kind: "TOOL_CALL_ARGS", id: "t3", argsJson: '{"cmd":"ls"}', ts: "2" });
    s.appendTranscript({ kind: "TOOL_CALL_END", id: "t3", ts: "3" });
    const before = JSON.stringify(s.snapshot());
    // A stray chunk after END must be ignored (stream integrity).
    s.appendTranscript({ kind: "TOOL_CALL_ARGS", id: "t3", argsJson: ',"pwned":1}', ts: "4" });
    expect(JSON.stringify(s.snapshot())).toBe(before);
  });
});

describe("B13-8 transcript — state machine separates reasoning/content/tool", () => {
  test("streams never bleed into each other's panels", () => {
    const s = new TranscriptSession();
    s.appendTranscript({ kind: "TEXT_MESSAGE_CONTENT", source: "user", text: "hi", ts: "1" });
    s.appendTranscript({ kind: "REASONING_CONTENT", text: "think", ts: "2" });
    s.appendTranscript({ kind: "TEXT_MESSAGE_CONTENT", source: "agent", text: "answer", ts: "3" });
    s.appendTranscript({ kind: "TOOL_CALL_START", id: "t", name: "bash", ts: "4" });
    const cards = s.snapshot();
    // Content cards hold only content; reasoning only reasoning; tool only tool.
    expect(cards.filter((c) => c.kind === "text").map((c) => (c as any).text)).toEqual(["hi", "answer"]);
    expect(cards.filter((c) => c.kind === "reasoning").map((c) => (c as any).text)).toEqual(["think"]);
    expect(cards.filter((c) => c.kind === "tool")).toHaveLength(1);
    expect(kinds(cards)).toEqual(["text", "reasoning", "text", "tool"]);
  });
});

describe("B13-8 transcript — diff card", () => {
  test("edit-type tool result renders a unified diff inline", () => {
    const s = new TranscriptSession();
    s.appendTranscript({ kind: "TOOL_CALL_START", id: "d1", name: "edit_file", ts: "1" });
    s.appendTranscript({ kind: "TOOL_CALL_ARGS", id: "d1", argsJson: JSON.stringify({ path: "f.txt", oldText: "old line", newText: "new line" }), ts: "2" });
    s.appendTranscript({ kind: "TOOL_CALL_END", id: "d1", ts: "3" });
    s.appendTranscript({ kind: "TOOL_RESULT", id: "d1", ok: true, output: "ok", ts: "4" });
    const card = s.snapshot().at(-1)!;
    expect(card.kind).toBe("tool");
    if (card.kind === "tool") {
      expect(card.diff).toBeDefined();
      expect(card.diff!.changed).toBe(true);
      expect(card.diff!.unified).toContain("-old line");
      expect(card.diff!.unified).toContain("+new line");
    }
  });

  test("non-edit tool result has no diff", () => {
    const s = new TranscriptSession();
    s.appendTranscript({ kind: "TOOL_CALL_START", id: "n1", name: "bash", ts: "1" });
    s.appendTranscript({ kind: "TOOL_CALL_ARGS", id: "n1", argsJson: '{"cmd":"ls"}', ts: "2" });
    s.appendTranscript({ kind: "TOOL_CALL_END", id: "n1", ts: "3" });
    s.appendTranscript({ kind: "TOOL_RESULT", id: "n1", ok: true, output: "ok", ts: "4" });
    const card = s.snapshot().at(-1)!;
    if (card.kind === "tool") expect(card.diff).toBeUndefined();
  });

  test("toolDiff derives old/new across common spellings", () => {
    expect(toolDiff("edit_file", { oldText: "a", newText: "b" })?.unified).toContain("-a");
    expect(toolDiff("write_file", { path: "f", content: "x" })?.unified).toContain("+x");
    expect(toolDiff("bash", { cmd: "ls" })).toBeUndefined();
  });

  test("computeUnifiedDiff is deterministic and marks unchanged", () => {
    const same = computeUnifiedDiff("x\ny", "x\ny");
    expect(same.changed).toBe(false);
    expect(same.unified).toBe("");
    const d = computeUnifiedDiff("a\nb\nc", "a\nb\nc2");
    expect(d.changed).toBe(true);
    expect(d.unified).toContain("-c");
    expect(d.unified).toContain("+c2");
  });
});

describe("B13-8 transcript — session-event mapping", () => {
  test("fromSessionEvent maps persisted events to the vocabulary", () => {
    const te = fromSessionEvent({ t: "tool_call", ts: "1", id: "x1", name: "bash", input: { cmd: "ls" } } as any);
    expect(te.map((t) => t.kind)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    expect(fromSessionEvent({ t: "error", ts: "2", message: "e" } as any)[0]!.kind).toBe("AgentError");
    expect(fromSessionEvent({ t: "usage", ts: "3", inputTokens: 1, outputTokens: 1, costUSD: 0, spentUSD: 0 } as any)[0]!.kind).toBe("STATE_DELTA");
  });
});
