import { describe, test, expect } from "bun:test";
import { renderTrajectory } from "../src/session/trajectory";
import type { SessionEvent } from "../src/session/events";

const start: SessionEvent = {
  t: "session_start",
  id: "s1",
  ts: "t",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
};

test("empty event list renders placeholder", () => {
  expect(renderTrajectory([])).toEqual(["(empty session)"]);
});

test("header includes provider/model and fork lineage", () => {
  const lines = renderTrajectory([
    {
      ...start,
      parent: { id: "parent0", uptoEvent: 7 },
    },
  ]);
  expect(lines[0]).toContain("session s1");
  expect(lines[0]).toContain("anthropic:claude-sonnet-4-5");
  expect(lines[0]).toContain("forked from parent0 @7");
});

test("full conversation flow renders in order", () => {
  const events: SessionEvent[] = [
    start,
    { t: "message", role: "user", content: "fix the login bug", ts: "t" },
    {
      t: "message",
      role: "assistant",
      content: [{ type: "text", text: "Looking at auth." }],
      ts: "t",
    },
    { t: "tool_call", id: "c1", name: "read_file", input: { path: "auth.ts" }, ts: "t" },
    { t: "tool_result", id: "c1", name: "read_file", ok: true, output: "x".repeat(2500), ts: "t" },
    { t: "tool_call", id: "c2", name: "bash", input: { command: "bun test" }, ts: "t" },
    { t: "tool_result", id: "c2", name: "bash", ok: false, output: "exit: 1\nverbose fail", ts: "t" },
    {
      t: "message",
      role: "assistant",
      content: [{ type: "text", text: "Fixed it." }],
      ts: "t",
    },
    {
      t: "usage",
      inputTokens: 12345,
      outputTokens: 678,
      costUSD: 0.0421,
      spentUSD: 0.0421,
      ts: "t",
    },
  ];
  const lines = renderTrajectory(events);
  const header = "session s1 · anthropic:claude-sonnet-4-5";
  expect(lines).toEqual([
    header,
    "─".repeat(header.length),
    "you> fix the login bug",
    "tenjin> Looking at auth.",
    '  -> read_file {"path":"auth.ts"}',
    "  <- read_file ok (2.5k chars)",
    '  -> bash {"command":"bun test"}',
    "  <- bash ERR: exit: 1",
    "tenjin> Fixed it.",
    "$ in 12.3k out 678 · $0.04 turn · $0.04 spent",
  ]);
});

test("long user messages and assistant text are truncated", () => {
  const lines = renderTrajectory([
    start,
    { t: "message", role: "user", content: "y".repeat(300), ts: "t" },
    { t: "message", role: "assistant", content: [{ type: "text", text: "z".repeat(300) }], ts: "t" },
  ]);
  expect(lines[2]).toBe(`you> ${"y".repeat(160)}…`);
  expect(lines[3]).toBe(`tenjin> ${"z".repeat(160)}…`);
});

test("assistant tool_use blocks are not duplicated (calls come from events)", () => {
  const lines = renderTrajectory([
    start,
    {
      t: "message",
      role: "assistant",
      content: [
        { type: "text", text: "using a tool" },
        { type: "tool_use", id: "x", name: "glob", input: {} },
      ],
      ts: "t",
    },
    { t: "tool_call", id: "x", name: "glob", input: {}, ts: "t" },
    { t: "tool_result", id: "x", name: "glob", ok: true, output: "a.ts", ts: "t" },
  ]);
  const callLines = lines.filter((l) => l.includes("-> glob"));
  expect(callLines).toHaveLength(1);
});

test("declined tool call shows as ERR with declined message", () => {
  const lines = renderTrajectory([
    start,
    { t: "tool_call", id: "d1", name: "bash", input: { command: "rm -rf /" }, ts: "t" },
    {
      t: "tool_result",
      id: "d1",
      name: "bash",
      ok: false,
      output: "User declined this tool call.",
      ts: "t",
    },
  ]);
  expect(lines).toContain("  <- bash ERR: User declined this tool call.");
});

test("error events render with ! prefix", () => {
  const lines = renderTrajectory([start, { t: "error", message: "api 500: oops\nstack", ts: "t" }]);
  expect(lines).toContain("! error: api 500: oops");
});

test("user message with block content is skipped (logged via dedicated events)", () => {
  const lines = renderTrajectory([
    start,
    {
      t: "message",
      role: "user",
      content: [{ type: "tool_result", toolUseId: "q", content: "data" }],
      ts: "t",
    },
  ]);
  const header = "session s1 · anthropic:claude-sonnet-4-5";
  expect(lines).toEqual([header, "─".repeat(header.length)]);
});
