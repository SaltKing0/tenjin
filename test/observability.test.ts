import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";
import {
  buildHealth,
  buildMetrics,
  resetObservabilityCache,
  OBSERVABILITY_CACHE_TTL_MS,
} from "../src/gateway/observability";
import { ProviderStats, monitoredProvider } from "../src/provider/stats";
import { ProviderRegistry } from "../src/provider/registry";
import { createRequest } from "../src/gateway/approvals";
import type { ChatRequest, Provider } from "../src/provider/types";

let home: string;
let server: HttpServerHandle | null = null;
const TOKEN = "observability-token";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-obs-"));
  resetObservabilityCache();
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(home, { recursive: true, force: true });
});

/** Seed one session file that records `costUSD` spend today. */
function seedSession(id: string, costUSD: number): void {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const events = [
    { t: "session_start", id, ts: now, provider: "anthropic", model: "m" },
    { t: "message", role: "user", content: "hello", ts: now },
    { t: "usage", inputTokens: 10, outputTokens: 5, costUSD, spentUSD: costUSD, ts: now },
  ];
  writeFileSync(
    join(dir, `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

const chatReq: ChatRequest = {
  model: "m",
  system: "",
  messages: [],
  tools: [],
  maxTokens: 16,
};

describe("ProviderStats", () => {
  test("counts errors and successes per provider", () => {
    const s = new ProviderStats();
    s.recordError("anthropic");
    s.recordError("anthropic");
    s.recordError("openai");
    s.recordSuccess("anthropic");
    expect(s.total()).toBe(3);
    const r = s.reachability();
    expect(r.anthropic!.errors).toBe(2);
    expect(r.anthropic!.up).toBe(true);
    expect(r.openai!.errors).toBe(1);
    expect(r.openai!.up).toBe(false);
  });

  test("no data yields null reachability and zero total", () => {
    const s = new ProviderStats();
    expect(s.total()).toBe(0);
    expect(s.reachability()).toEqual({});
  });

  test("monitoredProvider records success and rethrows errors", async () => {
    const s = new ProviderStats();
    const ok: Provider = {
      name: "mock",
      async chat() {
        return {
          stopReason: "end_turn" as const,
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const fail: Provider = {
      name: "mock",
      async chat() {
        throw new Error("boom");
      },
    };
    await monitoredProvider(ok, s).chat(chatReq);
    expect(s.total()).toBe(0);
    expect(s.reachability().mock!.up).toBe(true);
    await expect(monitoredProvider(fail, s).chat(chatReq)).rejects.toThrow("boom");
    expect(s.total()).toBe(1);
    expect(s.reachability().mock!.up).toBe(false);
  });
});

describe("registry provider monitoring", () => {
  test("registry-wrapped provider feeds the shared stats", async () => {
    const stats = new ProviderStats();
    const registry = new ProviderRegistry(undefined, {}, undefined, true, undefined, stats);
    registry.register({
      name: "boom",
      create: () => ({
        name: "boom",
        async chat(): Promise<never> {
          throw new Error("boom");
        },
      }),
    });
    const p = registry.get("boom");
    await expect(p.chat(chatReq)).rejects.toThrow("boom");
    expect(stats.total()).toBe(1);
    const r = stats.reachability().boom!;
    expect(r.errors).toBe(1);
    expect(r.up).toBe(false);
  });
});

describe("buildMetrics", () => {
  test("emits the required metrics with correct values", () => {
    seedSession("s1", 0.5);
    seedSession("s1b", 0.25);
    createRequest(home, { bot: "researcher", tool: "write_file" });
    const stats = new ProviderStats();
    stats.recordError("anthropic");
    stats.recordError("anthropic");
    const jobs = [
      { running: false, nextDueMs: Date.now() - 1000 }, // due → pending
      { running: false, nextDueMs: Date.now() + 60_000 }, // future → not pending
      { running: true, nextDueMs: 0 }, // active, not pending
    ];
    const text = buildMetrics(Date.now(), { home, stats, jobs });
    expect(text).toContain("# TYPE tenjin_spend_usd_total counter");
    expect(text).toContain("tenjin_spend_usd_total 0.75");
    expect(text).toContain("# TYPE tenjin_jobs_pending gauge");
    expect(text).toContain("tenjin_jobs_pending 1");
    expect(text).toContain("# TYPE tenjin_sessions_total gauge");
    expect(text).toContain("tenjin_sessions_total 2");
    expect(text).toContain("# TYPE tenjin_provider_errors_total counter");
    expect(text).toContain("tenjin_provider_errors_total 2");
    expect(text).toContain('tenjin_provider_errors_total{provider="anthropic"} 2');
    // Prometheus text opens each metric with a TYPE line.
    expect(text.match(/# TYPE /g)?.length).toBe(4);
  });
});

describe("buildHealth", () => {
  test("reports jobs, approvals, spend and provider reachability", () => {
    seedSession("s1", 0.5);
    createRequest(home, { bot: "researcher", tool: "write_file" });
    const stats = new ProviderStats();
    stats.recordSuccess("anthropic");
    const jobs = [
      { running: true, nextDueMs: 0 },
      { running: false, nextDueMs: Date.now() - 500 },
    ];
    const h = buildHealth(Date.now(), { home, stats, jobs });
    expect(h.activeJobs).toBe(1);
    expect(h.pendingJobs).toBe(1);
    expect(h.pendingApprovals).toBe(1);
    expect(h.budgetSpentTodayUSD).toBe(0.5);
    expect(h.sessions).toBe(1);
    expect(h.spendUSDTotal).toBe(0.5);
    expect((h.providers as Record<string, { up: boolean }>).anthropic!.up).toBe(true);
  });
});

describe("observability spend cache (#186)", () => {
  test("numbers are identical to direct aggregation and spend is cached within TTL", () => {
    seedSession("s1", 0.5);
    const t = new Date();
    const stats = new ProviderStats();
    const h1 = buildHealth(t.getTime(), { home, stats, jobs: [] });
    expect(h1.spendUSDTotal).toBe(0.5);
    expect(h1.budgetSpentTodayUSD).toBe(0.5);

    // New spend lands after the first computation, but within the TTL the
    // cached totals are returned (no full rescan of the session logs).
    seedSession("s2", 0.25);
    const withinTtl = new Date(t.getTime() + OBSERVABILITY_CACHE_TTL_MS - 1);
    const h2 = buildHealth(withinTtl.getTime(), { home, stats, jobs: [] });
    expect(h2.spendUSDTotal).toBe(0.5); // stale-by-design within TTL

    // After the TTL expires the rescan picks up the new session.
    const pastTtl = new Date(t.getTime() + OBSERVABILITY_CACHE_TTL_MS + 1);
    const h3 = buildHealth(pastTtl.getTime(), { home, stats, jobs: [] });
    expect(h3.spendUSDTotal).toBe(0.75);
  });
});

describe("http endpoints", () => {
  function start(): string {
    const stats = new ProviderStats();
    seedSession("s1", 0.5);
    const srv = startHttpServer({
      config: { port: 0, host: "127.0.0.1", token: TOKEN },
      handleMessage: async () => null,
      status: () => ({}),
      health: () => buildHealth(Date.now(), { home, stats, jobs: [] }),
      metrics: () => buildMetrics(Date.now(), { home, stats, jobs: [] }),
    });
    server = srv;
    return `http://127.0.0.1:${srv.port}`;
  }

  test("GET /api/health returns structured body with uptime", async () => {
    const base = start();
    const res = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.uptimeMs).toBe("number");
    expect(body.sessions).toBe(1);
    expect(body.budgetSpentTodayUSD).toBe(0.5);
  });

  test("GET /metrics returns Prometheus text", async () => {
    const base = start();
    const res = await fetch(`${base}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("tenjin_spend_usd_total");
    expect(text).toContain("tenjin_jobs_pending");
    expect(text).toContain("tenjin_sessions_total");
    expect(text).toContain("tenjin_provider_errors_total");
  });

  test("metrics and health reject without a token (401)", async () => {
    const base = start();
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(401);
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(401);
  });

  test("server without health/metrics wired returns 404", async () => {
    const srv = startHttpServer({
      config: { port: 0, host: "127.0.0.1", token: TOKEN },
      handleMessage: async () => null,
      status: () => ({}),
    });
    server = srv;
    const base = `http://127.0.0.1:${srv.port}`;
    const health = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(health.status).toBe(404);
    const metrics = await fetch(`${base}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(metrics.status).toBe(404);
  });
});
