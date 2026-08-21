import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, auditPath, formatAudit } from "../src/audit/log";
import { Redactor } from "../src/security/redact";

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
