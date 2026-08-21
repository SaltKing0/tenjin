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
import { createBot } from "../src/bots/profile";
import { AuditLog } from "../src/audit/log";
import { SessionLog } from "../src/session/log";
import type { HarnessConfig } from "../src/config/types";
import type { ChatResponse, Provider } from "../src/provider/types";

let home: string;
let server: HttpServerHandle | null = null;
const TOKEN = "console-token";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-replay-"));
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

function seedSession(bot: string, id: string): void {
  const dir = join(home, "bots", bot, "sessions");
  mkdirSync(dir, { recursive: true });
  const events = [
    { t: "session_start", id, ts: "2026-08-21T10:00:00Z", provider: "anthropic", model: "m", bot },
    { t: "message", role: "user", content: `hello from ${id}`, ts: "t" },
    { t: "tool_call", id: "tc1", name: "read_file", input: { path: "auth.ts" }, ts: "t" },
    { t: "tool_result", id: "tc1", name: "read_file", ok: true, output: "contents", ts: "t" },
    { t: "message", role: "assistant", content: [{ type: "text", text: "found it" }], ts: "t" },
    { t: "usage", inputTokens: 10, outputTokens: 5, costUSD: 0.01, spentUSD: 0.01, ts: "t" },
  ];
  writeFileSync(
    join(dir, `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

function startServer(opts: { config?: HarnessConfig; jobs?: JobsApi } = {}): string {
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

describe("session replay events", () => {
  test("GET /api/sessions/:id/events returns the full trajectory", async () => {
    seedSession("researcher", "sess1");
    const base = startServer();
    const res = await fetch(`${base}/api/sessions/sess1/events?bot=researcher`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; events: unknown[] };
    expect(body.id).toBe("sess1");
    const events = body.events as Array<{ t: string }>;
    expect(events.map((e) => e.t)).toEqual([
      "session_start",
      "message",
      "tool_call",
      "tool_result",
      "message",
      "usage",
    ]);
    // full trajectory — no truncation of tool payload
    const toolCall = events.find((e) => e.t === "tool_call") as unknown as { input: { path: string } };
    expect(toolCall?.input).toEqual({ path: "auth.ts" });
  });

  test("GET /api/sessions/:id/events for unknown session is 404", async () => {
    const base = startServer();
    const res = await fetch(`${base}/api/sessions/ghost/events?bot=researcher`, { headers: auth });
    expect(res.status).toBe(404);
  });

  test("POST /api/sessions/:id/fork copies the session under a new id", async () => {
    seedSession("researcher", "sess1");
    const base = startServer();
    const res = await fetch(`${base}/api/sessions/sess1/fork?bot=researcher`, { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; parentId: string };
    expect(body.ok).toBe(true);
    expect(body.id).not.toBe("sess1");
    expect(body.parentId).toBe("sess1");

    // fork appears as a session and carries the original's content
    const eventsRes = await fetch(`${base}/api/sessions/${body.id}/events?bot=researcher`, { headers: auth });
    const forked = (await eventsRes.json()) as { events: Array<{ t: string }> };
    expect(forked.events.some((e) => e.t === "message")).toBe(true);
  });

  test("console sessions panel wires the replay timeline and fork button", () => {
    const js = readFileSync(
      join(import.meta.dir, "..", "src", "gateway", "console", "app.js"),
      "utf8",
    );
    expect(js).toContain("/api/sessions/");
    expect(js).toContain("/events?bot=");
    expect(js).toContain("/fork?bot=");
    expect(js).toContain("Fork");
    expect(js).toContain("openReplay");
  });
});
