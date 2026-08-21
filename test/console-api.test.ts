import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";
import { createConsoleApi } from "../src/gateway/console-api";
import { createBot } from "../src/bots/profile";
import { AuditLog } from "../src/audit/log";
import { createRequest } from "../src/gateway/approvals";
import type { HarnessConfig } from "../src/config/types";

let home: string;
let server: HttpServerHandle | null = null;
const TOKEN = "console-token";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-console-"));
  createBot(home, "researcher");
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(home, { recursive: true, force: true });
});

const config = (): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 512,
  budgetUSD: 1,
  approval: {},
});

function seedSession(bot: string | null, id: string): void {
  const dir = bot
    ? join(home, "bots", bot, "sessions")
    : join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  const events = [
    { t: "session_start", id, ts: "2026-08-21T10:00:00Z", provider: "anthropic", model: "m", ...(bot ? { bot } : {}) },
    { t: "message", role: "user", content: `hello from ${id}`, ts: "t" },
    { t: "usage", inputTokens: 10, outputTokens: 5, costUSD: 0.01, spentUSD: 0.01, ts: "t" },
  ];
  writeFileSync(
    join(dir, `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

function startServer(): string {
  const audit = new AuditLog(join(home, "audit.jsonl"));
  server = startHttpServer({
    config: { port: 0, host: "127.0.0.1", token: TOKEN },
    handleMessage: async () => null,
    status: () => ({}),
    api: createConsoleApi({
      home,
      cwd: home,
      config: config(),
      registry: { get: () => ({ name: "mock", chat: async () => ({ stopReason: "end_turn", content: [], usage: { inputTokens: 0, outputTokens: 0 } }) }) } as never,
      audit,
    }),
    consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
  });
  return `http://127.0.0.1:${server.port}`;
}

const auth = { authorization: `Bearer ${TOKEN}` };

test("static console files served without auth (public shell)", async () => {
  const base = startServer();
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

test("api requires bearer token", async () => {
  const base = startServer();
  const res = await fetch(`${base}/api/bots`);
  expect(res.status).toBe(401);
});

test("GET /api/bots lists bots with model and unread", async () => {
  const base = startServer();
  const res = await fetch(`${base}/api/bots`, { headers: auth });
  const data = (await res.json()) as any;
  expect(data.bots).toHaveLength(1);
  expect(data.bots[0].name).toBe("researcher");
  expect(typeof data.bots[0].model).toBe("string");
  expect(data.bots[0].unread).toBe(0);
});

describe("sessions + trajectory", () => {
  beforeEach(() => seedSession(null, "solo-1"));
  beforeEach(() => seedSession("researcher", "bot-1"));

  test("lists solo sessions by default", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/sessions`, { headers: auth });
    const data = (await res.json()) as any;
    expect(data.scope).toBe("solo");
    expect(data.sessions[0]?.id).toBe("solo-1");
  });

  test("lists bot-scoped sessions", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/sessions?bot=researcher`, { headers: auth });
    const data = (await res.json()) as any;
    expect(data.sessions[0]?.id).toBe("bot-1");
  });

  test("trajectory returns rendered lines", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/session/bot-1?bot=researcher`, { headers: auth });
    const data = (await res.json()) as any;
    expect(data.lines.some((l: string) => l.includes("hello from bot-1"))).toBe(true);
  });

  test("unknown bot rejected; traversal-safe", async () => {
    const base = startServer();
    const r1 = await fetch(`${base}/api/sessions?bot=../..`, { headers: auth });
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${base}/api/session/..%2F..%2Fetc%2Fpasswd`, { headers: auth });
    expect([400, 404]).toContain(r2.status);
  });
});

test("spend endpoint aggregates seeded sessions", async () => {
  seedSession(null, "s1");
  const base = startServer();
  const res = await fetch(`${base}/api/spend`, { headers: auth });
  const data = (await res.json()) as any;
  expect(data.rows).toHaveLength(1);
  expect(data.rows[0].costUSD).toBeCloseTo(0.01);
});

test("audit endpoint filters by kind", async () => {
  const log = new AuditLog(join(home, "audit.jsonl"));
  log.append("tool_block", "guard", "blocked .env");
  log.append("approval", "user", "bash approved");
  const base = startServer();
  const res = await fetch(`${base}/api/audit?kind=tool_block`, { headers: auth });
  const data = (await res.json()) as any;
  expect(data.events).toHaveLength(1);
  expect(data.events[0].detail).toContain(".env");
});

describe("approvals endpoints", () => {
  test("pending list + resolve via POST", async () => {
    const req = createRequest(home, { bot: "researcher", tool: "write_file", inputSummary: "foo.txt" });
    const base = startServer();

    const listRes = await fetch(`${base}/api/approvals`, { headers: auth });
    const listData = (await listRes.json()) as any;
    expect(listData.pending).toHaveLength(1);
    expect(listData.pending[0].tool).toBe("write_file");

    const approveRes = await fetch(`${base}/api/approvals/${req.id}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approveRes.status).toBe(200);

    const after = await fetch(`${base}/api/approvals`, { headers: auth });
    expect(((await after.json()) as any).pending).toHaveLength(0);
  });

  test("invalid action rejected; double-resolve 404s", async () => {
    const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: "x" });
    const base = startServer();
    const bad = await fetch(`${base}/api/approvals/${req.id}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ action: "yolo" }),
    });
    expect(bad.status).toBe(400);
    await fetch(`${base}/api/approvals/${req.id}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ action: "deny" }),
    });
    const again = await fetch(`${base}/api/approvals/${req.id}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ action: "deny" }),
    });
    expect(again.status).toBe(404);
  });
});
