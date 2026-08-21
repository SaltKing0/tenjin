import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, auditPath, formatAudit, formatAuditMarkdown } from "../src/audit/log";
import { Redactor } from "../src/security/redact";
import type { AuditEvent, AuditKind } from "../src/audit/log";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-audit-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test("append + query round-trip", () => {
  const log = new AuditLog(auditPath(home));
  log.append("tool_block", "guard", 'read_file blocked ".env"', "researcher");
  log.append("approval", "user", "bash approved", "researcher");
  log.append("budget_halt", "gateway", "halted at 0.5 USD");

  const all = log.query();
  expect(all).toHaveLength(3);
  expect(all[0]?.kind).toBe("tool_block");
  expect(all[2]?.kind).toBe("budget_halt");
});

test("filter by bot and kind", () => {
  const log = new AuditLog(auditPath(home));
  log.append("approval", "user", "a", "researcher");
  log.append("approval", "user", "b", "writer");
  log.append("delegation", "writer", "ask_bot -> researcher");

  expect(log.query({ bot: "researcher" })).toHaveLength(1);
  expect(log.query({ kind: "delegation" })).toHaveLength(1);
  expect(log.query({ bot: "writer", kind: "approval" })).toHaveLength(1);
  expect(log.query({ bot: "ghost" })).toEqual([]);
});

test("tail returns last N", () => {
  const log = new AuditLog(auditPath(home));
  for (let i = 0; i < 10; i++) log.append("gateway_msg", "u1", `msg ${i}`);
  const tail = log.query({ tail: 3 });
  expect(tail.map((e) => e.detail)).toEqual(["msg 7", "msg 8", "msg 9"]);
});

test("missing file queries empty; corrupted lines skipped", () => {
  expect(new AuditLog(auditPath(home)).query()).toEqual([]);
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  const log = new AuditLog(auditPath(home));
  appendFileSync(log.path, `${JSON.stringify({ ts: "t", kind: "approval", actor: "x", detail: "ok" })}\n{broken\n`);
  expect(log.query()).toHaveLength(1);
});

test("formatAudit renders readable lines", () => {
  const log = new AuditLog(auditPath(home));
  log.append("tool_block", "guard", 'read_file blocked ".env"', "researcher");
  const formatted = formatAudit(log.query());
  expect(formatted).toContain("tool_block");
  expect(formatted).toContain("[researcher]");
  expect(formatted).toContain('.env');
  expect(formatAudit([])).toBe("(no audit events)");
});

test("redacts secrets in detail by default", () => {
  const log = new AuditLog(auditPath(home));
  log.append("gateway_msg", "u1", "saw OPENAI_API_KEY=sk-abc1234567890");
  const events = log.query();
  expect(events[0]?.detail).not.toContain("sk-abc1234567890");
  expect(events[0]?.detail).toContain("[REDACTED]");
  expect(events[0]?.detail).toContain("OPENAI_API_KEY=");
});

test("honours a disabled redactor", () => {
  const log = new AuditLog(auditPath(home), new Redactor(false));
  log.append("gateway_msg", "u1", "OPENAI_API_KEY=sk-abc1234567890");
  expect(log.query()[0]?.detail).toContain("sk-abc1234567890");
});

function seedEvent(
  log: AuditLog,
  ts: string,
  kind: AuditKind,
  actor: string,
  detail: string,
  bot?: string,
): void {
  const event: AuditEvent = { ts, kind, actor, detail, ...(bot ? { bot } : {}) };
  appendFileSync(log.path, `${JSON.stringify(event)}\n`);
}

describe("query time window", () => {
  const t0 = "2026-08-21T13:59:59.000Z";
  const t1 = "2026-08-21T14:00:00.000Z";
  const tMid = "2026-08-21T14:30:00.000Z";
  const t2 = "2026-08-21T15:00:00.000Z";
  const t3 = "2026-08-21T15:00:01.000Z";

  function seeded(): AuditLog {
    const log = new AuditLog(auditPath(home));
    seedEvent(log, t0, "gateway_msg", "u1", "before window");
    seedEvent(log, t1, "tool_block", "guard", "at from bound", "researcher");
    seedEvent(log, tMid, "approval", "user", "inside window", "researcher");
    seedEvent(log, t2, "write_exec", "gateway", "at to bound");
    seedEvent(log, t3, "budget_halt", "gateway", "after window");
    return log;
  }

  test("from/to inclusive: hits exactly the window", () => {
    const log = seeded();
    const hit = log.query({
      from: Date.parse(t1),
      to: Date.parse(t2),
    });
    expect(hit.map((e) => e.detail)).toEqual([
      "at from bound",
      "inside window",
      "at to bound",
    ]);
  });

  test("from-only drops earlier events; to-only drops later events", () => {
    const log = seeded();
    expect(log.query({ from: Date.parse(t2) }).map((e) => e.detail)).toEqual([
      "at to bound",
      "after window",
    ]);
    expect(log.query({ to: Date.parse(t1) }).map((e) => e.detail)).toEqual([
      "before window",
      "at from bound",
    ]);
  });

  test("inverted from/to window is empty", () => {
    const log = seeded();
    expect(log.query({ from: Date.parse(t2), to: Date.parse(t1) })).toEqual([]);
  });

  test("kind still applies inside the window", () => {
    const log = seeded();
    const hit = log.query({
      from: Date.parse(t1),
      to: Date.parse(t2),
      kind: "approval",
    });
    expect(hit).toHaveLength(1);
    expect(hit[0]?.detail).toBe("inside window");
  });

  test("tail applies after the time filter", () => {
    const log = seeded();
    const hit = log.query({
      from: Date.parse(t1),
      to: Date.parse(t2),
      tail: 2,
    });
    expect(hit.map((e) => e.detail)).toEqual(["inside window", "at to bound"]);
  });

  test("unparseable timestamps are excluded when a window is set", () => {
    const log = new AuditLog(auditPath(home));
    seedEvent(log, "not-a-date", "approval", "user", "bad ts");
    seedEvent(log, tMid, "approval", "user", "good ts");
    expect(log.query({ from: Date.parse(t1), to: Date.parse(t2) }).map((e) => e.detail)).toEqual([
      "good ts",
    ]);
    expect(log.query().map((e) => e.detail)).toEqual(["bad ts", "good ts"]);
  });
});

describe("markdown export", () => {
  test("contains every event in the window and the count", () => {
    const log = new AuditLog(auditPath(home));
    seedEvent(log, "2026-08-21T14:00:00.000Z", "tool_block", "guard", "blocked .env", "researcher");
    seedEvent(log, "2026-08-21T14:30:00.000Z", "approval", "user", "bash ok");
    const events = log.query({
      from: Date.parse("2026-08-21T14:00:00.000Z"),
      to: Date.parse("2026-08-21T15:00:00.000Z"),
    });
    const md = formatAuditMarkdown(events);
    expect(md).toContain("events: 2");
    expect(md).toContain("tool_block");
    expect(md).toContain("blocked .env");
    expect(md).toContain("approval");
    expect(md).toContain("bash ok");
    expect(md).toContain("researcher");
  });

  test("empty window still renders a markdown document", () => {
    const md = formatAuditMarkdown([]);
    expect(md).toContain("events: 0");
    expect(md.toLowerCase()).toContain("no audit events");
  });
});
