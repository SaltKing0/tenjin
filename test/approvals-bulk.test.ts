import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";
import { createConsoleApi } from "../src/gateway/console-api";
import { AuditLog } from "../src/audit/log";
import { createRequest, type ApprovalRequest } from "../src/gateway/approvals";
import type { HarnessConfig } from "../src/config/types";

let home: string;
let server: HttpServerHandle | null = null;
const TOKEN = "ap-token";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-approve-"));
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(home, { recursive: true, force: true });
});

function seedRequests(n: number): { ids: string[]; reqs: ApprovalRequest[] } {
  const reqs: ApprovalRequest[] = [];
  for (let i = 0; i < n; i++) {
    reqs.push(createRequest(home, { bot: "researcher", tool: "write_file", input: { path: `f${i}.txt`, content: `c${i}` } }));
  }
  return { ids: reqs.map((r) => r.id), reqs };
}

function start(audit: AuditLog): string {
  const srv = startHttpServer({
    config: { port: 0, host: "127.0.0.1", token: TOKEN },
    handleMessage: async () => null,
    status: () => ({}),
    api: createConsoleApi({
      home,
      cwd: home,
      config: { provider: "anthropic", model: "m", maxTokens: 256, budgetUSD: 1, approval: {} } as HarnessConfig,
      registry: { get: () => ({}) } as never,
      audit,
    }),
    consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
  });
  server = srv;
  return `http://127.0.0.1:${srv.port}`;
}

describe("POST /api/approvals/bulk", () => {
  test("bulk approve resolves every request and emits one audit event each", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const { ids } = seedRequests(5);

    const res = await fetch(`${base}/api/approvals/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids, action: "approve" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { resolvedCount: number; resolved: string[]; failed: string[] };
    expect(data.resolvedCount).toBe(5);
    expect(data.failed).toEqual([]);

    // all five are resolved → N audit events
    const events = audit.query({ kind: "approval" });
    expect(events.length).toBe(5);
    // and no pending approvals remain
    const list = await fetch(`${base}/api/approvals`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = (await list.json()) as { pending: unknown[] };
    expect(body.pending).toEqual([]);
  });

  test("bulk deny resolves with denial audit events", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const { ids } = seedRequests(2);
    const res = await fetch(`${base}/api/approvals/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids, action: "deny" }),
    });
    expect(res.status).toBe(200);
    const events = audit.query({ kind: "approval" });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.detail.startsWith("deny"))).toBe(true);
  });

  test("unknown/expired ids are reported as failed, resolved ids still resolve", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const { ids } = seedRequests(2);
    const res = await fetch(`${base}/api/approvals/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids: [...ids, "does-not-exist"], action: "approve" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { resolvedCount: number; failed: string[] };
    expect(data.resolvedCount).toBe(2);
    expect(data.failed).toEqual(["does-not-exist"]);
    expect(audit.query({ kind: "approval" }).length).toBe(2);
  });

  test("validates action and ids", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const { ids } = seedRequests(1);

    const badAction = await fetch(`${base}/api/approvals/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids, action: "maybe" }),
    });
    expect(badAction.status).toBe(400);

    const noIds = await fetch(`${base}/api/approvals/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids: [], action: "approve" }),
    });
    expect(noIds.status).toBe(400);
    expect(audit.query({ kind: "approval" }).length).toBe(0);
  });
});

describe("approval diff data", () => {
  test("edit_file input with old/new yields a diff in the detail", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const r = createRequest(home, {
      bot: "researcher",
      tool: "edit_file",
      input: { path: "a.txt", oldText: "line1\nline2", newText: "line1\nline2\nline3" },
    });
    const res = await fetch(`${base}/api/approvals/${r.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { diff?: { old: string; new: string } };
    expect(data.diff).toEqual({ old: "line1\nline2", new: "line1\nline2\nline3" });
  });

  test("edit_file camelCase oldString/newString fields are recognized", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const r = createRequest(home, {
      bot: "researcher",
      tool: "edit_file",
      input: { path: "a.txt", oldString: "foo", newString: "bar" },
    });
    const res = await fetch(`${base}/api/approvals/${r.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const data = (await res.json()) as { diff?: { old: string; new: string } };
    expect(data.diff).toEqual({ old: "foo", new: "bar" });
  });

  test("write_file input is diffed against the current file contents", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    writeFileSync(join(home, "f.txt"), "before", "utf8");
    const r = createRequest(home, { bot: "researcher", tool: "write_file", input: { path: "f.txt", content: "after" } });
    const res = await fetch(`${base}/api/approvals/${r.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const data = (await res.json()) as { diff?: { old: string; new: string } };
    expect(data.diff).toEqual({ old: "before", new: "after" });
  });

  test("non-edit/write tools have no diff", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const r = createRequest(home, { bot: "researcher", tool: "bash", input: { command: "ls" } });
    const res = await fetch(`${base}/api/approvals/${r.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const data = (await res.json()) as { diff?: unknown };
    expect(data.diff).toBeUndefined();
  });
});

describe("approval redaction (#177)", () => {
  test("createRequest stores a redacted input + summary on disk (no secret leak)", () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const r = createRequest(home, {
      bot: "researcher",
      tool: "bash",
      input: { command: `curl -H "Authorization: Bearer ${secret}" https://x` },
    });
    // in-memory record is masked
    expect(JSON.stringify(r.input)).not.toContain("sk-abcdefghijklmnop");
    expect(r.inputSummary).not.toContain("sk-abcdefghijklmnop");
    expect(r.inputSummary).toContain("[REDACTED]");
    // the notice body (built from inputSummary) is therefore masked too
    expect(`Approval needed [${r.id}] ${r.inputSummary}`).not.toContain("sk-abcdefghijklmnop");

    // disk file is masked as well
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const disk = readFileSync(join(home, "approvals", `${r.id}.json`), "utf8");
    expect(disk).not.toContain("sk-abcdefghijklmnop");
    expect(disk).toContain("[REDACTED]");
  });

  test("GET /api/approvals/:id returns a redacted input", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const base = start(audit);
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const r = createRequest(home, {
      bot: "researcher",
      tool: "bash",
      input: { command: `SECRET=${secret}` },
    });
    const res = await fetch(`${base}/api/approvals/${r.id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(data)).not.toContain("ghp_abcdefghijklmnop");
    expect(JSON.stringify(data)).toContain("[REDACTED]");
  });

  test("browser approvals mask opaque type text and sensitive URL fields", () => {
    const typed = "short opaque value";
    const r = createRequest(home, {
      bot: "researcher",
      tool: "browser",
      inputSummary: `type ${typed}`,
      input: {
        action: "type",
        url: "https://alice:password@example.test/?code=oauth-code&city=Berlin",
        selector: "#password",
        text: typed,
      },
    });
    const serialized = JSON.stringify(r);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(typed);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain(":password@");
    expect(serialized).not.toContain("oauth-code");
    expect(serialized).toContain("city=Berlin");

    const summaryOnly = createRequest(home, {
      bot: "researcher",
      tool: "browser",
      inputSummary: "type 1234 into #pin",
    });
    expect(JSON.stringify(summaryOnly)).not.toContain("1234");
  });
});

void mkdirSync;
