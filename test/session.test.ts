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
