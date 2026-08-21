import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";
import { createConsoleApi } from "../src/gateway/console-api";
import { createBot } from "../src/bots/profile";
import { AuditLog } from "../src/audit/log";
import type { AuditEvent, AuditKind } from "../src/audit/log";
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

function seedAudit(
  ts: string,
  kind: AuditKind,
  actor: string,
  detail: string,
  bot?: string,
): void {
  const event: AuditEvent = { ts, kind, actor, detail, ...(bot ? { bot } : {}) };
  appendFileSync(join(home, "audit.jsonl"), `${JSON.stringify(event)}\n`);
}

const T_BEFORE = "2026-08-21T13:59:59.000Z";
const T_FROM = "2026-08-21T14:00:00.000Z";
const T_MID = "2026-08-21T14:30:00.000Z";
const T_TO = "2026-08-21T15:00:00.000Z";
const T_AFTER = "2026-08-21T15:00:01.000Z";

function seedWindow(): void {
  seedAudit(T_BEFORE, "gateway_msg", "u1", "before");
  seedAudit(T_FROM, "tool_block", "guard", "from-bound", "researcher");
  seedAudit(T_MID, "approval", "user", "inside", "researcher");
  seedAudit(T_TO, "write_exec", "gateway", "to-bound");
  seedAudit(T_AFTER, "budget_halt", "gateway", "after");
}

describe("audit time filter + export", () => {
  test("GET /api/audit?from&to hits exactly the inclusive window", async () => {
    seedWindow();
    const base = startServer();
    const res = await fetch(
      `${base}/api/audit?from=${encodeURIComponent(T_FROM)}&to=${encodeURIComponent(T_TO)}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { events: AuditEvent[] };
    expect(data.events.map((e) => e.detail)).toEqual(["from-bound", "inside", "to-bound"]);
  });

  test("kind still intersects the time window", async () => {
    seedWindow();
    const base = startServer();
    const res = await fetch(
      `${base}/api/audit?kind=approval&from=${encodeURIComponent(T_FROM)}&to=${encodeURIComponent(T_TO)}`,
      { headers: auth },
    );
    const data = (await res.json()) as { events: AuditEvent[] };
    expect(data.events).toHaveLength(1);
    expect(data.events[0]?.detail).toBe("inside");
  });

  test("invalid from/to returns 400", async () => {
    const base = startServer();
    const badFrom = await fetch(`${base}/api/audit?from=yesterday`, { headers: auth });
    expect(badFrom.status).toBe(400);
    expect(((await badFrom.json()) as { error: string }).error).toMatch(/from/i);
    const badTo = await fetch(`${base}/api/audit?to=not-a-date`, { headers: auth });
    expect(badTo.status).toBe(400);
    expect(((await badTo.json()) as { error: string }).error).toMatch(/to/i);
  });

  test("JSON export is a download of every event in the window", async () => {
    seedWindow();
    const base = startServer();
    const res = await fetch(
      `${base}/api/audit/export?format=json&from=${encodeURIComponent(T_FROM)}&to=${encodeURIComponent(T_TO)}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/i);
    expect(res.headers.get("content-disposition")).toMatch(/\.json/i);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const data = (await res.json()) as { events: AuditEvent[] };
    expect(data.events.map((e) => e.detail)).toEqual(["from-bound", "inside", "to-bound"]);
  });

  test("markdown export contains every event in the window", async () => {
    seedWindow();
    const base = startServer();
    const res = await fetch(
      `${base}/api/audit/export?format=markdown&from=${encodeURIComponent(T_FROM)}&to=${encodeURIComponent(T_TO)}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/i);
    expect(res.headers.get("content-disposition")).toMatch(/\.(md|markdown)/i);
    const body = await res.text();
    expect(body).toContain("events: 3");
    expect(body).toContain("from-bound");
    expect(body).toContain("inside");
    expect(body).toContain("to-bound");
    expect(body).not.toContain("before");
    expect(body).not.toContain("after");
  });

  test("export returns the full window, not the list endpoint's default tail", async () => {
    for (let i = 0; i < 120; i++) {
      const ts = new Date(Date.parse(T_FROM) + i * 1000).toISOString();
      seedAudit(ts, "gateway_msg", "u1", `msg ${i}`);
    }
    seedAudit(T_AFTER, "gateway_msg", "u1", "outside");
    const base = startServer();
    const list = await fetch(
      `${base}/api/audit?from=${encodeURIComponent(T_FROM)}&to=${encodeURIComponent(T_TO)}`,
      { headers: auth },
    );
    expect(((await list.json()) as { events: AuditEvent[] }).events).toHaveLength(100);
    const exp = await fetch(
      `${base}/api/audit/export?format=json&from=${encodeURIComponent(T_FROM)}&to=${encodeURIComponent(T_TO)}`,
      { headers: auth },
    );
    const data = (await exp.json()) as { events: AuditEvent[] };
    expect(data.events).toHaveLength(120);
    expect(data.events[0]?.detail).toBe("msg 0");
    expect(data.events[119]?.detail).toBe("msg 119");
    expect(data.events.some((e) => e.detail === "outside")).toBe(false);
  });

  test("unknown export format is 400", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/audit/export?format=csv`, { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/format/i);
  });

  test("export rejects invalid from; format=md is markdown", async () => {
    seedWindow();
    const base = startServer();
    const bad = await fetch(`${base}/api/audit/export?format=json&from=nope`, { headers: auth });
    expect(bad.status).toBe(400);
    const res = await fetch(
      `${base}/api/audit/export?format=md&from=${encodeURIComponent(T_FROM)}&to=${encodeURIComponent(T_TO)}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("markdown");
    expect(await res.text()).toContain("events: 3");
  });
});

test("audit endpoint filters by correlationId", async () => {
  const log = new AuditLog(join(home, "audit.jsonl"));
  log.append("delegation", "writer", "ask_bot -> researcher", "writer", "chain-1");
  log.append("write_exec", "user", "write_file succeeded", undefined, "chain-1");
  log.append("delegation", "writer", "other", undefined, "chain-2");
  const base = startServer();

  const res = await fetch(`${base}/api/audit?correlationId=chain-1`, { headers: auth });
  const data = (await res.json()) as any;
  const kinds = data.events.map((e: any) => e.kind);
  expect(kinds).toEqual(["delegation", "write_exec"]);
  expect(data.events.every((e: any) => e.correlationId === "chain-1")).toBe(true);
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

test("POST /api/settings/test validates a provider key via health check", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () => new Response("", { status: 200 }),
  });
  try {
    const base = startServer();
    const res = await fetch(`${base}/api/settings/test`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-live",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok?: boolean; status?: number; error?: string };
    expect(data.ok).toBe(true);
  } finally {
    upstream.stop(true);
  }
});

test("POST /api/settings/test reports a rejected key as ok:false", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () => new Response("invalid key", { status: 401 }),
  });
  try {
    const base = startServer();
    const res = await fetch(`${base}/api/settings/test`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "bad",
      }),
    });
    const data = (await res.json()) as { ok?: boolean; status?: number; error?: string };
    expect(data.ok).toBe(false);
    expect(data.status).toBe(401);
    expect(data.error).toContain("/models 401");
  } finally {
    upstream.stop(true);
  }
});
