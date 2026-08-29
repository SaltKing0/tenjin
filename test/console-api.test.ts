import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";
import { createConsoleApi, type JobsApi } from "../src/gateway/console-api";
import { Gateway } from "../src/gateway/gateway";
import { createBot } from "../src/bots/profile";
import { factsPath } from "../src/tools/memory";
import { AuditLog } from "../src/audit/log";
import type { AuditEvent, AuditKind } from "../src/audit/log";
import { createRequest } from "../src/gateway/approvals";
import type { HarnessConfig } from "../src/config/types";
import type { ChatResponse, Provider } from "../src/provider/types";

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

function startServer(opts: {
  config?: HarnessConfig;
  jobs?: JobsApi;
} = {}): string {
  const audit = new AuditLog(join(home, "audit.jsonl"));
  const cfg = opts.config ?? config();
  server = startHttpServer({
    config: { port: 0, host: "127.0.0.1", token: TOKEN },
    handleMessage: async () => null,
    status: () => ({}),
    api: createConsoleApi({
      home,
      cwd: home,
      config: cfg,
      registry: { get: () => ({ name: "mock", chat: async () => ({ stopReason: "end_turn", content: [], usage: { inputTokens: 0, outputTokens: 0 } }) }) } as never,
      audit,
      jobs: opts.jobs,
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

test("GET /api/bots reports per-bot memory count for scope defaults (#277)", async () => {
  const base = startServer();
  // researcher has no memory yet
  const empty = (await (await fetch(`${base}/api/bots`, { headers: auth })).json()) as any;
  expect(empty.bots[0].memory).toBe(0);
  // seed a facts file -> memory count becomes 1
  mkdirSync(join(home, "bots", "researcher", "memory"), { recursive: true });
  writeFileSync(factsPath(join(home, "bots", "researcher", "memory")), "a durable fact\n");
  const withMem = (await (await fetch(`${base}/api/bots`, { headers: auth })).json()) as any;
  expect(withMem.bots[0].memory).toBe(1);
});

describe("bots CRUD + SOUL editor", () => {
  test("POST /api/bots creates a bot and it appears in the list", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "My Writer!", soul: "# SOUL — my-writer\nDraft things." }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.name).toBe("my-writer");
    expect(data.soul).toContain("Draft things");
    expect(readFileSync(join(home, "bots", "my-writer", "SOUL.md"), "utf8")).toContain("Draft things");
    const list = await fetch(`${base}/api/bots`, { headers: auth });
    expect(((await list.json()) as any).bots.some((b: any) => b.name === "my-writer")).toBe(true);
  });

  test("POST /api/bots with role generates SOUL from template (#253)", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Librarian", role: "researcher" }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.name).toBe("librarian");
    const soul = readFileSync(join(home, "bots", "librarian", "SOUL.md"), "utf8");
    // The template keeps the supplied name's casing in the header/voice.
    expect(soul).toContain("Librarian");
    expect(soul).toContain("investigation specialist");
  });

  test("POST /api/bots with role + model pins the model (#253)", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Scribe", role: "writer", model: "anthropic:claude-sonnet-4-5" }),
    });
    expect(res.status).toBe(201);
    const cfg = readFileSync(join(home, "bots", "scribe", "config.yaml"), "utf8");
    expect(cfg).toContain("model");
    expect(cfg).toContain("anthropic:claude-sonnet-4-5");
  });

  test("POST /api/bots with unknown role returns 400 (#253)", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Oddball", role: "not-a-role" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/bots rejects duplicate and invalid names", async () => {
    const base = startServer();
    const dup = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "researcher" }),
    });
    expect(dup.status).toBe(409);
    const empty = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: " " }),
    });
    expect(empty.status).toBe(400);
    const bad = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "!!!" }),
    });
    expect(bad.status).toBe(400);
  });

  test("GET /api/bots/:name returns full detail incl. soul; unknown is 404", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/bots/researcher`, { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.name).toBe("researcher");
    expect(typeof data.soul).toBe("string");
    expect(data.soul).toContain("SOUL");
    const missing = await fetch(`${base}/api/bots/nope`, { headers: auth });
    expect(missing.status).toBe(404);
  });

  test("PUT /api/bots/:name writes SOUL.md round-trip", async () => {
    const base = startServer();
    const newSoul = "# SOUL — researcher\nUpdated role.";
    const res = await fetch(`${base}/api/bots/researcher`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ soul: newSoul }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.soul).toBe(newSoul);
    expect(readFileSync(join(home, "bots", "researcher", "SOUL.md"), "utf8")).toBe(newSoul);
  });

  test("PUT renames a bot; old name disappears, new name resolves", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/bots/researcher`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ rename: "Scribe" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).name).toBe("scribe");
    const list = ((await (await fetch(`${base}/api/bots`, { headers: auth })).json()) as any).bots;
    expect(list.some((b: any) => b.name === "scribe")).toBe(true);
    expect(list.some((b: any) => b.name === "researcher")).toBe(false);
    expect(await fetch(`${base}/api/bots/scribe`, { headers: auth }).then((r) => r.status)).toBe(200);
  });

  test("PUT rename to existing name is 409; empty soul is 400", async () => {
    const base = startServer();
    createBot(home, "writer");
    const conflict = await fetch(`${base}/api/bots/writer`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ rename: "researcher" }),
    });
    expect(conflict.status).toBe(409);
    const empty = await fetch(`${base}/api/bots/researcher`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ soul: "   " }),
    });
    expect(empty.status).toBe(400);
  });

  test("DELETE /api/bots/:name removes the bot; unknown is 404", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/bots/researcher`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(200);
    const list = ((await (await fetch(`${base}/api/bots`, { headers: auth })).json()) as any).bots;
    expect(list).toHaveLength(0);
    expect(existsSync(join(home, "bots", "researcher"))).toBe(false);
    const missing = await fetch(`${base}/api/bots/researcher`, { method: "DELETE", headers: auth });
    expect(missing.status).toBe(404);
  });

  test("full CRUD round-trip persists SOUL.md through create/read/update/delete", async () => {
    const base = startServer();
    const created = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "temp", soul: "original soul" }),
    });
    expect(created.status).toBe(201);
    const read = await fetch(`${base}/api/bots/temp`, { headers: auth });
    expect(((await read.json()) as any).soul).toBe("original soul");
    const updated = await fetch(`${base}/api/bots/temp`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ soul: "edited soul", rename: "temp2" }),
    });
    expect(updated.status).toBe(200);
    const data = (await updated.json()) as any;
    expect(data.name).toBe("temp2");
    expect(data.soul).toBe("edited soul");
    const del = await fetch(`${base}/api/bots/temp2`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    expect(existsSync(join(home, "bots", "temp2"))).toBe(false);
  });

  test("console bots panel wires create, SOUL edit, rename, and delete", () => {
    const js = readFileSync(
      join(import.meta.dir, "..", "src", "gateway", "console", "app.js"),
      "utf8",
    );
    const css = readFileSync(
      join(import.meta.dir, "..", "src", "gateway", "console", "style.css"),
      "utf8",
    );
    expect(js).toMatch(/\/api\/bots"/);
    expect(js).toMatch(/method: "POST"/);
    expect(js).toMatch(/method: "PUT"/);
    expect(js).toMatch(/method: "DELETE"/);
    expect(js).toMatch(/soul-input/);
    expect(js).toMatch(/rename-input/);
    expect(js).toMatch(/Create bot/);
    expect(css).toMatch(/\.soul-input/);
    expect(css).toMatch(/\.bot-actions/);
  });
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

  test("bot=all merges every agent's sessions, labeled with its agent", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/sessions?bot=all`, { headers: auth });
    const data = (await res.json()) as any;
    expect(data.scope).toBe("all");
    const ids = data.sessions.map((s: any) => s.id).sort();
    expect(ids).toEqual(["bot-1", "solo-1"]);
    const byId = new Map<string, any>(data.sessions.map((s: any) => [s.id, s]));
    expect(byId.get("solo-1")!.bot).toBe("solo");
    expect(byId.get("bot-1")!.bot).toBe("researcher");
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

  test("pagination honors limit/offset and reports total (#58)", async () => {
    // beforeEach already seeded solo-1 → 6 solo sessions in total.
    for (let i = 0; i < 5; i++) seedSession(null, `p${i}`);
    const base = startServer();
    const page = await (await fetch(`${base}/api/sessions?limit=2&offset=1`, { headers: auth })).json() as any;
    expect(page.total).toBe(6);
    expect(page.sessions).toHaveLength(2);
    const second = await (await fetch(`${base}/api/sessions?limit=10&offset=4`, { headers: auth })).json() as any;
    expect(second.sessions).toHaveLength(2);
    expect(second.total).toBe(6);
  });

  test("free-text search filters on the preview (#58)", async () => {
    seedSession(null, "s-a");
    for (const id of ["s-b", "s-c"]) seedSession(null, id);
    const base = startServer();
    const res = await fetch(`${base}/api/sessions?q=hello%20from%20s-b`, { headers: auth });
    const data = (await res.json()) as any;
    expect(data.sessions.every((s: any) => s.id === "s-b")).toBe(true);
    const none = await fetch(`${base}/api/sessions?q=zzz-no-match`, { headers: auth });
    const empty = (await none.json()) as any;
    expect(empty.total).toBe(0);
    expect(empty.sessions).toHaveLength(0);
  });

  test("pagination rejects bad limit/offset (#58)", async () => {
    const base = startServer();
    expect((await fetch(`${base}/api/sessions?limit=0`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/sessions?limit=501`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/sessions?offset=-1`, { headers: auth })).status).toBe(400);
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

test("spend endpoint returns per-bot breakdown", async () => {
  seedSession(null, "s1");
  seedSession("researcher", "s2");
  createBot(home, "writer");
  seedSession("writer", "s3");
  const base = startServer();
  const res = await fetch(`${base}/api/spend`, { headers: auth });
  const data = (await res.json()) as any;
  const byBot = data.byBot as Array<{ scope: string; sessions: number; costUSD: number }>;
  // scope aggregation: solo session + researcher + writer
  const scopes = byBot.map((b) => b.scope);
  expect(scopes).toContain("solo");
  expect(scopes).toContain("researcher");
  expect(scopes).toContain("writer");
  const writer = byBot.find((b) => b.scope === "writer")!;
  expect(writer.sessions).toBe(1);
  expect(writer.costUSD).toBeCloseTo(0.01);
  const researcher = byBot.find((b) => b.scope === "researcher")!;
  expect(researcher.costUSD).toBeCloseTo(0.01);
  // separate sums: solo and researcher independently
  const solo = byBot.find((b) => b.scope === "solo")!;
  expect(solo.costUSD).toBeCloseTo(0.01);
  expect(solo.costUSD + researcher.costUSD + writer.costUSD).toBeCloseTo(0.03);
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

  test("GET /api/approvals/:id returns a bash command longer than 300 chars in full", async () => {
    const command =
      "find /var/log -type f -name '*.log' -print0 | xargs -0 grep -n " +
      `"${"token-fragment-".repeat(25)}"`;
    expect(command.length).toBeGreaterThan(300);
    const req = createRequest(home, {
      bot: "researcher",
      tool: "bash",
      input: { command },
    });
    const base = startServer();
    const listRes = await fetch(`${base}/api/approvals`, { headers: auth });
    const listData = (await listRes.json()) as {
      pending: Array<{ input?: unknown; inputSummary: string }>;
    };
    expect(listData.pending).toHaveLength(1);
    expect(listData.pending[0]?.input).toBeUndefined();
    expect(listData.pending[0]?.inputSummary.length).toBeLessThanOrEqual(300);
    expect(listData.pending[0]?.inputSummary.includes(command)).toBe(false);

    const res = await fetch(`${base}/api/approvals/${req.id}`, { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: string;
      tool: string;
      inputSummary: string;
      input: { command: string };
    };
    expect(data.id).toBe(req.id);
    expect(data.tool).toBe("bash");
    expect(data.inputSummary.length).toBeLessThanOrEqual(300);
    expect(data.input.command).toBe(command);
    expect(data.input.command.length).toBeGreaterThan(300);
  });

  test("GET /api/approvals/:id is 404 for an unknown id", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/approvals/deadbeef`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

test("console approvals panel opens a scrollable monospace full-view via GET /api/approvals/:id", () => {
  const js = readFileSync(
    join(import.meta.dir, "..", "src", "gateway", "console", "app.js"),
    "utf8",
  );
  const css = readFileSync(
    join(import.meta.dir, "..", "src", "gateway", "console", "style.css"),
    "utf8",
  );
  expect(js).toMatch(/apiJson\(`\/api\/approvals\/\$\{req\.id\}`\)/);
  expect(js).toMatch(/el\(\s*"pre"/);
  expect(js).toMatch(/approval-input/);
  expect(css).toMatch(/pre\.approval-input/);
  expect(css).toMatch(/pre\.approval-input[\s\S]*overflow:\s*auto/);
  expect(css).toMatch(/pre\.approval-input[\s\S]*max-height/);
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

function mockProvider(reply = "job output"): Provider {
  return {
    name: "mock",
    async chat(): Promise<ChatResponse> {
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

interface JobRow {
  name: string;
  bot: string;
  prompt: string;
  cron: string | null;
  every: string | null;
  policy: string;
  lastRun: { at: string; stopReason: string; costUSD: number; error?: string } | null;
  nextDue: string;
  nextDueMs: number;
  running: boolean;
}

describe("jobs API", () => {
  test("GET /api/jobs lists defined jobs with cron, policy, lastRun, nextDue", async () => {
    const base = startServer({
      config: {
        ...config(),
        gateway: {
          jobs: [
            { name: "digest", bot: "researcher", prompt: "summarize today", cron: "0 9 * * *" },
            { name: "ping", bot: "researcher", prompt: "ping", every: "15m" },
          ],
        },
      },
    });
    const res = await fetch(`${base}/api/jobs`, { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { jobs: JobRow[] };
    expect(data.jobs.map((j) => j.name)).toEqual(["digest", "ping"]);

    const digest = data.jobs[0];
    if (!digest) throw new Error("missing digest");
    expect(digest.bot).toBe("researcher");
    expect(digest.prompt).toBe("summarize today");
    expect(digest.cron).toBe("0 9 * * *");
    expect(digest.every).toBeNull();
    expect(digest.policy).toBe("read-only");
    expect(digest.lastRun).toBeNull();
    expect(digest.running).toBe(false);
    expect(digest.nextDueMs).toBeGreaterThan(Date.now() - 1000);
    expect(new Date(digest.nextDue).getTime()).toBe(digest.nextDueMs);

    const ping = data.jobs[1];
    if (!ping) throw new Error("missing ping");
    expect(ping.every).toBe("15m");
    expect(ping.cron).toBeNull();
    expect(ping.policy).toBe("read-only");
  });

  test("GET /api/jobs includes the heartbeat when enabled", async () => {
    const base = startServer({
      config: {
        ...config(),
        gateway: { heartbeat: { enabled: true, bot: "researcher", every: "30m" } },
      },
    });
    const data = (await (await fetch(`${base}/api/jobs`, { headers: auth })).json()) as {
      jobs: JobRow[];
    };
    expect(data.jobs.some((j) => j.name === "heartbeat")).toBe(true);
  });

  test("POST /api/jobs/:id/run fires immediately, records lastRun, leaves nextDue unchanged", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: {
        ...config(),
        gateway: {
          jobs: [{ name: "digest", bot: "researcher", prompt: "summarize", every: "1h" }],
        },
      },
      registry: { get: () => mockProvider("DIGEST BODY") } as never,
    });
    const before = gw.jobs[0]?.nextDueMs;
    expect(before).toBeGreaterThan(0);

    const base = startServer({
      jobs: {
        list: () => gw.listJobs(),
        runNow: (name) => gw.runNow(name),
      },
    });

    const res = await fetch(`${base}/api/jobs/${encodeURIComponent("digest")}/run`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      name: string;
      stopReason: string;
      costUSD: number;
      text: string;
    };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("digest");
    expect(body.stopReason).toBe("end_turn");
    expect(body.text).toContain("DIGEST BODY");
    expect(body.costUSD).toBeGreaterThan(0);

    const listed = (await (await fetch(`${base}/api/jobs`, { headers: auth })).json()) as {
      jobs: JobRow[];
    };
    const digest = listed.jobs.find((j) => j.name === "digest");
    expect(digest?.nextDueMs).toBe(before);
    expect(digest?.lastRun?.stopReason).toBe("end_turn");
    expect(digest?.lastRun?.costUSD).toBe(body.costUSD);
    expect(typeof digest?.lastRun?.at).toBe("string");
  });

  test("POST /api/jobs/:id/run unknown job is 404", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: {
        ...config(),
        gateway: { jobs: [{ name: "digest", bot: "researcher", prompt: "p", every: "1h" }] },
      },
      registry: { get: () => mockProvider() } as never,
    });
    const base = startServer({
      jobs: { list: () => gw.listJobs(), runNow: (name) => gw.runNow(name) },
    });
    const res = await fetch(`${base}/api/jobs/nope/run`, { method: "POST", headers: auth });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown job/i);
  });

  test("POST /api/jobs/:id/run while already running is 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gw = new Gateway({
      home,
      cwd: home,
      config: {
        ...config(),
        gateway: { jobs: [{ name: "digest", bot: "researcher", prompt: "p", every: "1h" }] },
      },
      registry: {
        get: () => ({
          name: "mock",
          async chat(): Promise<ChatResponse> {
            await gate;
            return {
              stopReason: "end_turn",
              content: [{ type: "text", text: "done" }],
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        }),
      } as never,
    });
    const base = startServer({
      jobs: { list: () => gw.listJobs(), runNow: (name) => gw.runNow(name) },
    });

    const first = fetch(`${base}/api/jobs/digest/run`, { method: "POST", headers: auth });
    let listed: JobRow[] = [];
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(10);
      listed = ((await (await fetch(`${base}/api/jobs`, { headers: auth })).json()) as {
        jobs: JobRow[];
      }).jobs;
      if (listed[0]?.running) break;
    }
    expect(listed[0]?.running).toBe(true);

    const second = await fetch(`${base}/api/jobs/digest/run`, { method: "POST", headers: auth });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/already running/i);

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(((await firstRes.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("POST /api/jobs/:id/run without a live gateway is 503", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/jobs/digest/run`, { method: "POST", headers: auth });
    expect(res.status).toBe(503);
  });

  test("console jobs panel JS lists jobs, shows details, and posts run now", () => {
    const js = readFileSync(
      join(import.meta.dir, "..", "src", "gateway", "console", "app.js"),
      "utf8",
    );
    expect(js).toContain('["routines", "Routines", panelJobs]');
    expect(js).toContain("/api/jobs");
    expect(js).toContain("/run");
    expect(js).toContain("Run now");
  });
});

describe("memory endpoint", () => {
  const memDirFor = (bot: string) => join(home, "bots", bot, "memory");

  test("GET /api/memory/:bot returns facts, summaries and vector stats", async () => {
    const mem = memDirFor("researcher");
    mkdirSync(join(mem, "summaries"), { recursive: true });
    writeFileSync(join(mem, "facts.md"), "- [2026-08-21] researcher prefers citations\n- [2026-08-21] terse style\n");
    writeFileSync(
      join(mem, "summaries", "sess1.md"),
      [
        "---",
        "sessionId: sess1",
        "projectPath: /p",
        "uptoEvent: 3",
        "created: 2026-08-21T10:00:00Z",
        "---",
        "Investigated auth.ts.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(mem, "vectors.jsonl"),
      [
        JSON.stringify({ id: "c1", sessionId: "sess1", projectPath: "/p", role: "user", text: "auth", embedding: [0.1, 0.2, 0.3], created: "t", embedModel: "model-x", embedDim: 3 }),
        JSON.stringify({ id: "c2", sessionId: "sess1", projectPath: "/p", role: "assistant", text: "ok", embedding: [0.4, 0.5, 0.6], created: "t", embedModel: "model-x", embedDim: 3 }),
      ].join("\n") + "\n",
    );

    const base = startServer();
    const res = await fetch(`${base}/api/memory/researcher`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bot: string;
      facts: string | null;
      summaries: Array<{ sessionId: string; text: string }>;
      vector: { count: number; embedModel: string | null; dim: number | null };
    };
    expect(body.bot).toBe("researcher");
    expect(body.facts).toContain("researcher prefers citations");
    expect(body.summaries).toHaveLength(1);
    expect(body.summaries[0]?.sessionId).toBe("sess1");
    expect(body.summaries[0]?.text).toContain("Investigated auth.ts.");
    expect(body.vector.count).toBe(2);
    expect(body.vector.embedModel).toBe("model-x");
    expect(body.vector.dim).toBe(3);
  });

  test("bot without memory returns empty fields, not an error", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/memory/researcher`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { facts: string | null; summaries: unknown[]; vector: { count: number } };
    expect(body.facts).toBeNull();
    expect(body.summaries).toEqual([]);
    expect(body.vector.count).toBe(0);
  });

  test("unknown bot is rejected", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/memory/ghost`, { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown bot");
  });

  test("console memory panel is registered and wired to the endpoint", () => {
    const js = readFileSync(
      join(import.meta.dir, "..", "src", "gateway", "console", "app.js"),
      "utf8",
    );
    expect(js).toContain('active === "memory"');
    expect(js).toContain("await panelMemory(host)");
    expect(js).toContain("/api/memory/");
    expect(js).toContain("read-only view of a bot's facts");
    expect(js).toContain("chunks:");
  });
});

describe("audit kind validation (#58)", () => {
  test("GET /api/audit serves the backend kind list", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/audit`, { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { events: unknown[]; kinds: string[] };
    expect(Array.isArray(data.kinds)).toBe(true);
    expect(data.kinds).toContain("tool_block");
    expect(data.kinds).toContain("approval");
    expect(data.kinds).toContain("guard_disabled");
  });

  test("unknown audit kind returns 400 instead of silent empty results", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/audit?kind=bogus_kind`, { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown audit kind");
    const ok = await fetch(`${base}/api/audit?kind=approval`, { headers: auth });
    expect(ok.status).toBe(200);
  });
});

describe("first-run setup state (#251)", () => {
  let freshHome: string;
  let freshServer: HttpServerHandle | null = null;

  /** Serve a console API against its own home, so we can test a truly empty home. */
  function startFreshServer(cfg: HarnessConfig): string {
    const audit = new AuditLog(join(freshHome, "audit.jsonl"));
    freshServer = startHttpServer({
      config: { port: 0, host: "127.0.0.1", token: TOKEN },
      handleMessage: async () => null,
      status: () => ({}),
      api: createConsoleApi({
        home: freshHome,
        cwd: freshHome,
        config: cfg,
        registry: {
          get: () => ({
            name: "mock",
            chat: async () => ({ stopReason: "end_turn", content: [], usage: { inputTokens: 0, outputTokens: 0 } }),
          }),
        } as never,
        audit,
      }),
      consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
    });
    return `http://127.0.0.1:${freshServer.port}`;
  }

  beforeEach(() => {
    freshHome = mkdtempSync(join(tmpdir(), "tj-fresh-"));
  });

  afterEach(() => {
    freshServer?.stop();
    freshServer = null;
    rmSync(freshHome, { recursive: true, force: true });
  });

  test("fresh home reports a fully unset state", async () => {
    const base = startFreshServer({ ...config(), model: "" });
    const res = await fetch(`${base}/api/setup/state`, { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, boolean>;
    expect(data).toEqual({
      hasModel: false,
      hasBot: false,
      hasGatewayToken: false,
      channelsEnabled: false,
      hasBudgetLimit: true,
    });
  });

  test("configured home reports model, bot, token and channels", async () => {
    createBot(freshHome, "researcher");
    const base = startFreshServer({
      ...config(),
      model: "claude-sonnet-4-5",
      gateway: {
        listen: { port: 3000, host: "0.0.0.0", token: "real-token" },
        channels: ["telegram"],
      },
    });
    const res = await fetch(`${base}/api/setup/state`, { headers: auth });
    const data = (await res.json()) as Record<string, boolean>;
    expect(data.hasModel).toBe(true);
    expect(data.hasBot).toBe(true);
    expect(data.hasGatewayToken).toBe(true);
    expect(data.channelsEnabled).toBe(true);
    expect(data.hasBudgetLimit).toBe(true);
  });

  test("present but empty model counts as not set", async () => {
    createBot(freshHome, "researcher");
    const base = startFreshServer({ ...config(), model: "   " });
    const res = await fetch(`${base}/api/setup/state`, { headers: auth });
    const data = (await res.json()) as Record<string, boolean>;
    expect(data.hasModel).toBe(false);
    expect(data.hasBot).toBe(true);
  });
});
