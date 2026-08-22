import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isModelVisible,
  deriveModelHistory,
  renderDerivedHistory,
  deriveSequence,
  validateSequence,
  isCompleteEvent,
  replayState,
  emptyReplayState,
} from "../src/session/event-store";
import { SessionLog } from "../src/session/log";
import type { SessionEvent } from "../src/session/events";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tj-estore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function msg(role: "user" | "assistant", content: string, ts = "t"): SessionEvent {
  return { t: "message", role, content, ts };
}
function toolCall(id: string, name = "bash"): SessionEvent {
  return { t: "tool_call", id, name, input: {}, ts: "t" };
}
function toolResult(id: string, name = "bash", output = "ok"): SessionEvent {
  return { t: "tool_result", id, name, ok: true, output, ts: "t" };
}

describe("B3-1 replay determinism", () => {
  test("same event set -> byte-identical derived history, twice", () => {
    const events: SessionEvent[] = [
      msg("user", "refactor the retry loop"),
      toolCall("c1", "bash"),
      toolResult("c1", "bash", "done"),
      msg("assistant", "backoff implemented"),
    ];
    const a = renderDerivedHistory(events);
    const b = renderDerivedHistory(events);
    expect(a).toBe(b);
    expect(a).toContain("user: refactor the retry loop");
    expect(a).toContain("tool_call(bash)");
    expect(a).toContain("tool_result(bash): done");
  });
});

describe("B3-1 crash-safe replay (no partial event applied)", () => {
  test("crash mid-turn: committed events replay to a consistent state", () => {
    // The run crashed after issuing a tool_call whose observation was never
    // recorded. The tool_call is itself committed (it was issued), so replay
    // reconstructs a consistent state with the message + the tool_call; only
    // the (never-written) observation is absent — nothing partial is invented.
    const events: SessionEvent[] = [msg("user", "do it"), toolCall("c9")];
    const state = replayState(emptyReplayState(), events);
    expect(state.committed).toBe(2);
    expect(state.messageCount).toBe(1);
    expect(state.toolCalls).toBe(1);
  });

  test("a truncated/incomplete event is never applied (no partial event)", () => {
    // A half-written final event (empty message) is not a valid committed event;
    // replay stops before it, applying only the complete prefix.
    const events: SessionEvent[] = [msg("user", "ok"), msg("assistant", "")];
    const state = replayState(emptyReplayState(), events);
    expect(state.committed).toBe(1);
    expect(state.messageCount).toBe(1);
  });

  test("complete event set replays fully and deterministically", () => {
    const events: SessionEvent[] = [
      msg("user", "a"),
      toolCall("c1"),
      toolResult("c1"),
      msg("assistant", "b"),
    ];
    const s1 = replayState(emptyReplayState(), events);
    const s2 = replayState(emptyReplayState(), events);
    expect(s1).toEqual(s2);
    expect(s1.committed).toBe(4);
    expect(s1.toolCalls).toBe(1);
    expect(s1.lastUserMessage).toBe("a");
  });

  test("isCompleteEvent flags a half-written message as incomplete", () => {
    expect(isCompleteEvent({ t: "message", role: "user", content: "", ts: "t" })).toBe(false);
    expect(isCompleteEvent(msg("user", "hi"))).toBe(true);
    expect(isCompleteEvent({ t: "tool_call", id: "", name: "", input: {}, ts: "t" })).toBe(false);
  });
});

describe("B3-1 committed files are never rewritten on append (mtime/inode)", () => {
  test("appending preserves the committed prefix bytes and inode; only mtime moves", () => {
    const log = SessionLog.create(dir);
    log.append(msg("user", "first"));
    log.append(toolCall("c1"));

    const path = log.path;
    const before = readFileSync(path, "utf8");
    const inodeBefore = statSync(path).ino;
    const mtimeBefore = statSync(path).mtimeMs;

    // Small delay so mtime can differ (1ms granularity is common).
    const t0 = Date.now();
    while (Date.now() - t0 < 5) { /* spin */ }

    log.append(toolResult("c1", "bash", "done"));

    const after = readFileSync(path, "utf8");
    const inodeAfter = statSync(path).ino;

    expect(inodeAfter).toBe(inodeBefore); // same file, appended in place
    expect(after.startsWith(before)).toBe(true); // committed prefix untouched
    expect(after.length).toBeGreaterThan(before.length); // only new bytes added
    expect(statSync(path).mtimeMs).toBeGreaterThanOrEqual(mtimeBefore);
  });
});

describe("B3-2 sequence integrity (seq-gap corruption class #2167)", () => {
  test("seq is derived from a FRESH load, never a stale snapshot", () => {
    // A fresh load of 3 events always yields exactly 1,2,3 regardless of any
    // previously held in-memory counter.
    const fresh = deriveSequence([{}, {}, {}]);
    expect(fresh).toEqual([1, 2, 3]);
    expect(deriveSequence([{}])).toEqual([1]);
  });

  test("a gap in seq is detected and rejected at load", () => {
    expect(validateSequence([1, 2, 3]).ok).toBe(true);
    expect(validateSequence([1, 2, 4]).ok).toBe(false); // gap: 3 missing
    expect(validateSequence([1, 3, 4]).ok).toBe(false);
    expect(validateSequence([1, 1, 2]).ok).toBe(false); // duplicate
    expect(validateSequence([2, 1, 3]).ok).toBe(false); // out of order
  });

  test("gap reason names the corrupt index", () => {
    const res = validateSequence([1, 2, 4]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("index 2");
  });
});

describe("B3-1 internal events excluded from model history but in audit view", () => {
  test("internal events never leak into derived history but remain in the raw list", () => {
    const events: SessionEvent[] = [
      msg("user", "hi"),
      { t: "tool_call", id: "c1", name: "bash", input: {}, ts: "t" },
      { t: "tool_result", id: "c1", name: "bash", ok: true, output: "o", ts: "t" },
      { t: "usage", inputTokens: 1, outputTokens: 1, costUSD: 0, spentUSD: 0, ts: "t" },
      { t: "error", message: "boom", ts: "t" },
      { t: "compression", beforeTokens: 100, afterTokens: 50, elidedTokens: 50, ts: "t" },
    ];
    const history = deriveModelHistory(events);
    expect(history).toHaveLength(3); // message + tool_call + tool_result only
    const rendered = renderDerivedHistory(events);
    expect(rendered).not.toContain("boom");
    expect(rendered).not.toContain("usage");
    // Audit view = the raw event list still carries the internal events.
    expect(events.filter(isModelVisible)).toHaveLength(3);
    expect(events).toHaveLength(6);
  });

  test("isModelVisible classification is correct", () => {
    expect(isModelVisible(msg("user", "x"))).toBe(true);
    expect(isModelVisible(toolCall("c"))).toBe(true);
    expect(isModelVisible(toolResult("c"))).toBe(true);
    expect(isModelVisible({ t: "usage", inputTokens: 1, outputTokens: 1, costUSD: 0, spentUSD: 0, ts: "t" })).toBe(false);
    expect(isModelVisible({ t: "error", message: "e", ts: "t" })).toBe(false);
  });
});
