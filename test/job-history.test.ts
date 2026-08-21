import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Gateway,
  pushRun,
  normalizeHistory,
  loadGatewayState,
  saveGatewayState,
  DEFAULT_JOB_HISTORY_LEN,
  type JobRunRecord,
} from "../src/gateway/gateway";
import { parseGatewaySettings } from "../src/gateway/config";
import { ProviderRegistry } from "../src/provider/registry";
import { createBot } from "../src/bots/profile";
import type { HarnessConfig } from "../src/config/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-hist-"));
  createBot(home, "worker");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function rec(i: number): JobRunRecord {
  return { atMs: 1000 + i, status: "ok", stopReason: "end_turn", costUSD: i, durationMs: 1 };
}

const config = (over: Partial<HarnessConfig> = {}): HarnessConfig =>
  ({
    provider: "mock",
    model: "mock-model",
    maxTokens: 256,
    budgetUSD: 1,
    approval: {},
    ...over,
  }) as HarnessConfig;

function mockRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry(undefined, {}, undefined);
  registry.register({
    name: "mock",
    create: () => ({
      name: "mock",
      async chat() {
        return {
          stopReason: "end_turn" as const,
          content: [{ type: "text" as const, text: "ok" }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    }),
  });
  return registry;
}

function gatewayConfig(jobHistoryLen?: number): unknown {
  return {
    gateway: {
      jobs: [{ name: "j1", bot: "worker", prompt: "do it", every: "10m" }],
      ...(jobHistoryLen !== undefined ? { jobHistoryLen } : {}),
    },
  };
}

describe("pushRun", () => {
  test("caps history to the newest `cap` runs after 25 pushes", () => {
    let history: JobRunRecord[] = [];
    for (let i = 0; i < 25; i++) history = pushRun(history, rec(i), 20);
    expect(history.length).toBe(20);
    // Newest first: the 25th run (i=24) is at the front.
    expect(history[0]!.atMs).toBe(1024);
    // Older runs are dropped.
    expect(history.some((r) => r.atMs === 1000)).toBe(false);
  });

  test("cap of 0 keeps everything", () => {
    let history: JobRunRecord[] = [];
    for (let i = 0; i < 5; i++) history = pushRun(history, rec(i), 0);
    expect(history.length).toBe(5);
  });

  test("keeps newest-first ordering within the cap", () => {
    const h = pushRun(pushRun([], rec(1), 3), rec(2), 3);
    expect(h.map((r) => r.atMs)).toEqual([1002, 1001]);
  });
});

describe("normalizeHistory", () => {
  test("drops malformed entries and coerces statuses", () => {
    const out = normalizeHistory(
      [
        { atMs: 5, status: "ok", stopReason: "a", costUSD: 1, durationMs: 1 },
        { bogus: true },
        { atMs: "bad", status: "error", stopReason: "x" },
        { atMs: 7, status: "nonsense-status", stopReason: "b", costUSD: 2, durationMs: 2 },
      ],
      10,
    );
    expect(out.length).toBe(2);
    expect(out[0]!.atMs).toBe(5);
    expect(out[1]!.status).toBe("ok"); // unknown status coerced to ok
  });

  test("caps long input to cap", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      atMs: i,
      status: "ok" as const,
      stopReason: "s",
      costUSD: 0,
      durationMs: 0,
    }));
    expect(normalizeHistory(many, 20).length).toBe(20);
  });

  test("non-array returns empty", () => {
    expect(normalizeHistory(null, 20)).toEqual([]);
    expect(normalizeHistory("x", 20)).toEqual([]);
  });
});

describe("gateway state v1 -> v2 migration", () => {
  test("old lastRun becomes a one-entry history", () => {
    writeFileSync(
      join(home, "gateway-state.json"),
      JSON.stringify({
        version: 1,
        jobs: { j1: { lastRun: { atMs: 1234, stopReason: "end_turn", costUSD: 0.5 } } },
      }),
    );
    const state = loadGatewayState(home);
    expect(state.version).toBe(2);
    const h = state.jobs.j1!.history;
    expect(h.length).toBe(1);
    expect(h[0]!.atMs).toBe(1234);
    expect(h[0]!.status).toBe("ok");
  });

  test("an errored lastRun migrates with status error", () => {
    writeFileSync(
      join(home, "gateway-state.json"),
      JSON.stringify({
        version: 1,
        jobs: { j1: { lastRun: { atMs: 9, stopReason: "error", costUSD: 0, error: "boom" } } },
      }),
    );
    const h = loadGatewayState(home).jobs.j1!.history;
    expect(h[0]!.status).toBe("error");
    expect(h[0]!.error).toBe("boom");
  });
});

describe("gateway state save/load roundtrip", () => {
  test("history survives save -> load (restart preserves history)", () => {
    const history = [rec(2), rec(1)];
    const state = { version: 2 as const, jobs: { j1: { history } } };
    saveGatewayState(home, state);
    const loaded = loadGatewayState(home);
    expect(loaded).toEqual(state);
  });
});

describe("Gateway hydration", () => {
  test("reconstructs history and lastRun from persisted state", () => {
    const history: JobRunRecord[] = [
      { atMs: 100, status: "error", stopReason: "error", costUSD: 0, durationMs: 5, error: "boom" },
      { atMs: 50, status: "ok", stopReason: "end_turn", costUSD: 0.1, durationMs: 4 },
    ];
    saveGatewayState(home, { version: 2, jobs: { j1: { history } } });
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({ gateway: { jobs: [{ name: "j1", bot: "worker", prompt: "p", every: "10m" }] } }),
      registry: mockRegistry(),
      log: () => {},
    });
    const job = gw.listJobs().find((j) => j.name === "j1")!;
    expect(job.history.length).toBe(2);
    expect(job.history[0]!.status).toBe("error");
    expect(job.lastRun?.error).toBe("boom");
  });
});

describe("Gateway runNow records history", () => {
  test("a successful run appends one ok record and persists it", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({ gateway: { jobs: [{ name: "j1", bot: "worker", prompt: "p", every: "10m" }] } }),
      registry: mockRegistry(),
      log: () => {},
    });
    const res = await gw.runNow("j1");
    expect(res.ok).toBe(true);
    const job = gw.listJobs().find((j) => j.name === "j1")!;
    expect(job.history.length).toBe(1);
    expect(job.history[0]!.status).toBe("ok");
    expect(job.history[0]!.durationMs).toBeGreaterThanOrEqual(0);
    // Persisted: a fresh Gateway rehydrates the history.
    const gw2 = new Gateway({
      home,
      cwd: home,
      config: config({ gateway: { jobs: [{ name: "j1", bot: "worker", prompt: "p", every: "10m" }] } }),
      registry: mockRegistry(),
      log: () => {},
    });
    expect(gw2.listJobs().find((j) => j.name === "j1")!.history.length).toBe(1);
  });

  test("jobView exposes the history", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({ gateway: { jobs: [{ name: "j1", bot: "worker", prompt: "p", every: "10m" }] } }),
      registry: mockRegistry(),
      log: () => {},
    });
    await gw.runNow("j1");
    const view = gw.listJobs().find((j) => j.name === "j1")!;
    expect(view.history.length).toBe(1);
    expect(view.history[0]!.status).toBe("ok");
    expect(typeof view.history[0]!.at).toBe("string");
  });
});

describe("gateway config jobHistoryLen", () => {
  test("parses and exposes jobHistoryLen", () => {
    const s = parseGatewaySettings({ jobHistoryLen: 5, jobs: [] });
    expect(s.jobHistoryLen).toBe(5);
  });

  test("defaults to unset (Gateway uses DEFAULT_JOB_HISTORY_LEN)", () => {
    expect(parseGatewaySettings({}).jobHistoryLen).toBeUndefined();
    expect(DEFAULT_JOB_HISTORY_LEN).toBe(20);
  });

  test("rejects a non-positive jobHistoryLen", () => {
    expect(() => parseGatewaySettings({ jobHistoryLen: 0 })).toThrow(/jobHistoryLen/);
    expect(() => parseGatewaySettings({ jobHistoryLen: 2.5 })).toThrow(/jobHistoryLen/);
  });

  test("a small jobHistoryLen caps live history via Gateway", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({ gateway: { jobs: [{ name: "j1", bot: "worker", prompt: "p", every: "10m" }], jobHistoryLen: 2 } }),
      registry: mockRegistry(),
      log: () => {},
    });
    for (let i = 0; i < 3; i++) await gw.runNow("j1");
    const view = gw.listJobs().find((j) => j.name === "j1")!;
    expect(view.history.length).toBe(2);
  });
});
