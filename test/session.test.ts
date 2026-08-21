import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog } from "../src/session/log";
import {
  rebuildMessages,
  sumUsage,
  type SessionEvent,
} from "../src/session/events";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenjin-sess-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function userMsg(text: string): SessionEvent {
  return { t: "message", role: "user", content: text, ts: "2026-01-01T00:00:00Z" };
}

test("create appends and reads back events", () => {
  const log = SessionLog.create(dir);
  log.append(userMsg("hello"));
  log.append({ t: "error", message: "boom", ts: "t" });

  const events = log.events();
  expect(events).toHaveLength(2);
  expect(events[0]).toEqual(userMsg("hello"));
  expect(events[1]?.t).toBe("error");
});

test("open and resolve by prefix", () => {
  const log = SessionLog.create(dir);
  log.append(userMsg("x"));

  const reopened = SessionLog.open(log.path);
  expect(reopened.id).toBe(log.id);
  expect(reopened.events()).toHaveLength(1);

  const resolved = SessionLog.resolve(dir, log.id.slice(0, 8));
  expect(resolved.path).toBe(log.path);
});

test("resolve throws for unknown id", () => {
  expect(() => SessionLog.resolve(dir, "nope")).toThrow(/no session matching/);
});

test("list returns newest first with preview", () => {
  const a = SessionLog.create(dir);
  a.append(userMsg("first session about testing"));
  const b = SessionLog.create(dir);
  b.append({ t: "session_start", id: b.id, ts: "t", provider: "p", model: "m" });
  b.append(userMsg("second session"));

  const all = SessionLog.list(dir);
  expect(all).toHaveLength(2);
  expect(all[0]?.id).toBe(b.id);
  expect(all[0]?.preview).toBe("second session");
  expect(all[1]?.preview).toContain("first session");
});

test("rebuildMessages restores conversation order", () => {
  const events: SessionEvent[] = [
    userMsg("question"),
    {
      t: "message",
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      ts: "t",
    },
    { t: "tool_call", id: "1", name: "read_file", input: {}, ts: "t" },
    { t: "tool_result", id: "1", name: "read_file", ok: true, output: "...", ts: "t" },
    userMsg("follow-up"),
  ];
  const messages = rebuildMessages(events);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
});

test("sumUsage takes max spentUSD (cumulative) and sums tokens", () => {
  const events: SessionEvent[] = [
    { t: "usage", inputTokens: 10, outputTokens: 5, costUSD: 0.01, spentUSD: 0.01, ts: "t" },
    { t: "usage", inputTokens: 20, outputTokens: 8, costUSD: 0.02, spentUSD: 0.03, ts: "t" },
  ];
  const s = sumUsage(events);
  expect(s.inputTokens).toBe(30);
  expect(s.outputTokens).toBe(13);
  expect(s.spentUSD).toBeCloseTo(0.03);
});

test("corrupted lines are skipped on read", () => {
  const log = SessionLog.create(dir);
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  appendFileSync(log.path, `${JSON.stringify(userMsg("good"))}\n{broken json\n`);
  const events = log.events();
  expect(events).toHaveLength(1);
});

describe("fork", () => {
  function seedSource(): SessionLog {
    const log = SessionLog.create(dir);
    log.append({
      t: "session_start",
      id: log.id,
      ts: "t",
      provider: "anthropic",
      model: "test-model",
    });
    log.append(userMsg("question one"));
    log.append({
      t: "message",
      role: "assistant",
      content: [{ type: "text", text: "answer one" }],
      ts: "t",
    });
    log.append(userMsg("question two"));
    return log;
  }

  test("fork copies all events by default and records parent", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id);

    expect(fork.id).not.toBe(source.id);
    const events = fork.events();
    expect(events[0]?.t).toBe("session_start");
    if (events[0]?.t !== "session_start") throw new Error("unreachable");
    expect(events[0].id).toBe(fork.id);
    expect(events[0].parent).toEqual({ id: source.id, uptoEvent: 4 });

    const messages = rebuildMessages(events);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    if (typeof messages[0]?.content !== "string") throw new Error("expected string");
    expect(messages[0].content).toBe("question one");
  });

  test("fork at event n truncates history", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id, 3);

    const events = fork.events();
    if (events[0]?.t !== "session_start") throw new Error("unreachable");
    expect(events[0].parent).toEqual({ id: source.id, uptoEvent: 3 });
    expect(rebuildMessages(events)).toHaveLength(2);
  });

  test("fork at 0 produces an empty continuation", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id, 0);
    const events = fork.events();
    if (events[0]?.t !== "session_start") throw new Error("unreachable");
    expect(events[0].parent?.uptoEvent).toBe(0);
    expect(events).toHaveLength(1);
  });

  test("out-of-range fork point clamps to end", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id, 999);
    const start = fork.events()[0];
    if (start?.t !== "session_start") throw new Error("unreachable");
    expect(start.parent?.uptoEvent).toBe(4);
  });

  test("fork of unknown id throws", () => {
    expect(() => SessionLog.fork(dir, "ghost")).toThrow(/no session matching/);
  });

  test("fork of a fork chains lineage", () => {
    const a = seedSource();
    const b = SessionLog.fork(dir, a.id);
    b.append(userMsg("branch b"));
    const c = SessionLog.fork(dir, b.id, 2);

    const cEvents = c.events();
    if (cEvents[0]?.t !== "session_start") throw new Error("unreachable");
    expect(cEvents[0].parent?.id).toBe(b.id);
    expect(cEvents[0].parent?.uptoEvent).toBe(2);
    expect(c.id).not.toBe(b.id);
  });

  test("forked file inherits provider/model from source", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id);
    const start = fork.events()[0];
    if (start?.t !== "session_start") throw new Error("unreachable");
    expect(start.provider).toBe("anthropic");
    expect(start.model).toBe("test-model");
  });

  test("list exposes parentId for forks", () => {
    const source = seedSource();
    SessionLog.fork(dir, source.id);
    const all = SessionLog.list(dir);
    const forkRow = all.find((s) => s.parentId !== undefined);
    expect(forkRow?.parentId).toBe(source.id);
    const sourceRow = all.find((s) => s.id === source.id);
    expect(sourceRow?.parentId).toBeUndefined();
  });

  test("source session is untouched after fork", () => {
    const source = seedSource();
    const before = source.events().length;
    SessionLog.fork(dir, source.id, 2);
    expect(source.events().length).toBe(before);
  });
});
