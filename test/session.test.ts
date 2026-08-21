import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog, idFromPath } from "../src/session/log";
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

test("readEvents reports each corrupt line with path+line and still loads the rest", () => {
  const log = SessionLog.create(dir);
  log.append(userMsg("good one"));
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  appendFileSync(log.path, `{broken json\n`);
  log.append(userMsg("good two"));

  const { events, corrupt } = log.readEvents();
  expect(events.map((e) => (e.t === "message" ? e.content : "?"))).toEqual([
    "good one",
    "good two",
  ]);
  expect(corrupt).toHaveLength(1);
  expect(corrupt[0]?.path).toBe(log.path);
  expect(corrupt[0]?.line).toBe(2);
  expect(log.events()).toHaveLength(2);
});

test("sidecar index is written on append with preview, parentId and mtime", () => {
  const log = SessionLog.create(dir);
  log.append({
    t: "session_start",
    id: log.id,
    ts: "t",
    provider: "p",
    model: "m",
    parent: { id: "abc", uptoEvent: 1 },
  });
  log.append(userMsg("hello index"));

  const metaPath = log.path.replace(/\.jsonl$/, ".meta.json");
  expect(existsSync(metaPath)).toBe(true);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
    preview: string;
    parentId: string;
    mtimeMs: number;
  };
  expect(meta.parentId).toBe("abc");
  expect(meta.preview).toBe("hello index");
  expect(meta.mtimeMs).toBeGreaterThan(0);
});

test("list uses sidecar index; fallback full-scan yields identical results", () => {
  const a = SessionLog.create(dir);
  a.append({
    t: "session_start",
    id: a.id,
    ts: "t",
    provider: "p",
    model: "m",
    parent: { id: "parent-one", uptoEvent: 0 },
  });
  a.append(userMsg("first session about testing something longer than sixty chars"));

  const b = SessionLog.create(dir);
  b.append({ t: "session_start", id: b.id, ts: "t", provider: "p", model: "m" });
  b.append(userMsg("second session"));

  const withIndex = SessionLog.list(dir);
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".meta.json")) unlinkSync(join(dir, f));
  }
  const fallback = SessionLog.list(dir);

  expect(withIndex).toHaveLength(2);
  expect(fallback).toHaveLength(2);
  expect(withIndex).toEqual(fallback);
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

  test("fork records parent and events() returns full history", () => {
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

  test("forked session delivers identical event history via the parent chain", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id);
    const src = source.events();
    const got = fork.events();
    expect(got).toHaveLength(src.length);
    expect(got.slice(1)).toEqual(src.slice(1));
  });

  test("fork writes a back-reference and does not copy parent events onto disk", () => {
    const source = seedSource();
    source.append(userMsg("x".repeat(8_000)));
    const sourceSize = statSync(source.path).size;
    const fork = SessionLog.fork(dir, source.id);
    const raw = readFileSync(fork.path, "utf8").trim();
    const lines = raw.split("\n");
    expect(lines).toHaveLength(1);
    const start = JSON.parse(lines[0]!);
    expect(start.t).toBe("session_start");
    expect(start.parent).toEqual({ id: source.id, uptoEvent: source.events().length });
    expect(raw).not.toContain("question one");
    expect(statSync(fork.path).size).toBeLessThan(sourceSize / 2);
  });

  test("events() follows the parent chain then own appended events", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id, 3);
    fork.append(userMsg("new on branch"));
    const messages = rebuildMessages(fork.events());
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2]?.content).toBe("new on branch");
    expect(readFileSync(fork.path, "utf8")).toContain("new on branch");
    expect(readFileSync(fork.path, "utf8")).not.toContain("question one");
  });

  test("nested fork events() walk the chain without duplicating storage", () => {
    const a = seedSource();
    a.append(userMsg("payload-" + "Z".repeat(4_000)));
    const b = SessionLog.fork(dir, a.id);
    b.append(userMsg("branch b"));
    const c = SessionLog.fork(dir, b.id);
    expect(c.events().slice(1)).toEqual(b.events().slice(1));
    expect(readFileSync(c.path, "utf8")).not.toContain("payload-");
    expect(readFileSync(c.path, "utf8")).not.toContain("branch b");
    expect(statSync(c.path).size).toBeLessThan(statSync(a.path).size / 2);
  });

  test("list preview of a fresh fork comes from inherited history", () => {
    const source = seedSource();
    const fork = SessionLog.fork(dir, source.id);
    const row = SessionLog.list(dir).find((s) => s.id === fork.id);
    expect(row?.preview).toBe("question one");
  });
});

test("idFromPath uses basename (windows-safe)", () => {
  expect(idFromPath("/tmp/sessions/20260101-abcd.jsonl")).toBe("20260101-abcd");
  expect(idFromPath("C:\\Users\\me\\sessions\\20260101-abcd.jsonl")).toBe("20260101-abcd");
  expect(idFromPath("20260101-abcd.jsonl")).toBe("20260101-abcd");
});

test("events() throws when a fork's parent file is gone", () => {
  const source = SessionLog.create(dir);
  source.append({
    t: "session_start",
    id: source.id,
    ts: "t",
    provider: "p",
    model: "m",
  });
  source.append(userMsg("keep me"));
  const fork = SessionLog.fork(dir, source.id);
  unlinkSync(source.path);
  expect(() => fork.events()).toThrow(/parent/);
});
