import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog } from "../src/session/log";
import { subscribe, emit, historySince } from "../src/gateway/events";
import { startHttpServer } from "../src/gateway/http";

/**
 * Soak / load test (#138). Generates realistic volumes and asserts the harness
 * stays correct and bounded under them. Thresholds are deliberately generous so
 * the suite is robust on a shared machine — the intent is to catch gross
 * regressions (dropped events, unbounded memory, pathologically slow listing),
 * not to benchmark a specific number.
 */

let home: string;
let sessions: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-soak-"));
  sessions = mkdtempSync(join(tmpdir(), "tj-soak-sess-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
});

function appendEventFrame(log: SessionLog, i: number): void {
  log.append({ t: "message", role: "user", content: `task step ${i} `.repeat(3), ts: `t${i}` });
  log.append({
    t: "message",
    role: "assistant",
    content: [{ type: "text", text: `outcome ${i}` }],
    ts: `t${i}`,
  });
}

/**
 * Generate many sessions, each with many events, a few of them as forks so the
 * lineage (parentId) machinery is exercised under volume.
 */
function payloadSessions(n: number, eventsPer: number): SessionLog[] {
  const logs: SessionLog[] = [];
  for (let i = 0; i < n; i++) {
    const log = SessionLog.create(sessions);
    log.append({
      t: "session_start",
      id: log.id,
      ts: `s${i}`,
      provider: "anthropic",
      model: "test-model",
    });
    for (let e = 0; e < eventsPer / 2; e++) appendEventFrame(log, e);
    logs.push(log);
    // fork one in every 10 sessions
    if (i % 10 === 0 && i > 0) {
      const forked = SessionLog.fork(sessions, log.id, Math.floor(eventsPer / 2));
      forked.append({ t: "message", role: "user", content: `fork add ${i}`, ts: "t" });
      logs.push(forked);
    }
  }
  return logs;
}

describe("soak: session volume (#138)", () => {
  test("100 sessions x ~100 events list fully and fast, with fork lineage", () => {
    const logs = payloadSessions(100, 100);
    expect(logs.length).toBeGreaterThanOrEqual(100);

    const t0 = performance.now();
    const listed = SessionLog.list(sessions);
    const elapsed = performance.now() - t0;

    // 100 originals + the fork fan-out (every 10th, from the second one onward)
    expect(listed.length).toBeGreaterThanOrEqual(109);
    expect(listed.length).toBeLessThanOrEqual(110);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("soak: event bus fan-out (#138)", () => {
  test("50 subscribers each receive all 100 emitted events (no loss)", () => {
    const subscribers = 50;
    const events = 100;
    const received: number[][] = Array.from({ length: subscribers }, () => []);
    const unsubs: Array<() => void> = [];
    for (let s = 0; s < subscribers; s++) {
      const sIdx = s;
      const un = subscribe((e) => {
        const arr = received[sIdx]!;
        if (arr.length < events) arr.push(e.id);
        else arr.push(-1); // overflow marker → would prove duplicate
      });
      unsubs.push(un);
    }
    try {
      for (let i = 0; i < events; i++) emit(`event_${i}`, { n: i });
      for (let s = 0; s < subscribers; s++) {
        expect((received[s] ?? []).filter((id) => id > 0).length).toBe(events);
      }
      // history replays last events too
      expect(historySince(0).some((e) => e.type === "event_99")).toBe(true);
    } finally {
      for (const un of unsubs) un();
    }
  });
});

describe("soak: SSE stream no-loss over HTTP (#138)", () => {
  const base = (handle: { port: number }) => `http://127.0.0.1:${handle.port}`;

  async function openSseReader(baseUrl: string) {
    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { authorization: "Bearer SECRETTOKEN" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const ids = new Set<number>();
    let buf = "";
    return {
      async pull(timeoutMs: number, count: number) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && ids.size < count) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value, { stream: true });
          for (let idx; (idx = buf.indexOf("\n\n")) !== -1; ) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const m = /^id: (\d+)/m.exec(block);
            if (m) ids.add(parseInt(m[1] ?? "", 10));
          }
        }
      },
      ids,
    };
  }

  test("N concurrent SSE connections each receive all broadcast events", async () => {
    const connections = 10;
    const toEmit = 20;
    const handle = startHttpServer({
      config: { port: 0, host: "127.0.0.1", token: "SECRETTOKEN" },
      handleMessage: async () => "ok",
      status: () => ({}),
      consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
    });
    const baseUrl = base(handle);
    try {
      // Open every connection first so they're subscribed before we emit.
      const readers = await Promise.all(
        Array.from({ length: connections }, () => openSseReader(baseUrl)),
      );
      for (let i = 0; i < toEmit; i++) emit(`sse_${i}`, { n: i });
      await Promise.all(readers.map((r) => r.pull(8000, toEmit)));
      for (const r of readers) {
        expect(r.ids.size).toBe(toEmit);
      }
    } finally {
      handle.stop();
    }
  });
});

describe("soak: memory bounded under churn (#138)", () => {
  // Heavy disk I/O (1000 sessions × ~100 events written to a temp dir); this
  // routinely exceeds Bun's default 5000 ms per-test timeout on a busy/shared
  // machine, so give it an explicit generous window.
  test("repeated session generation does not grow RSS unboundedly", () => {
    const before = process.memoryUsage().rss;
    const sessions2 = mkdtempSync(join(tmpdir(), "tj-soak-churn-"));
    try {
      for (let round = 0; round < 20; round++) {
        for (let s = 0; s < 50; s++) {
          const log = SessionLog.create(sessions2);
          for (let e = 0; e < 50; e++) appendEventFrame(log, e);
        }
      }
      if (globalThis.gc) (globalThis.gc as () => void)();
      const growth = process.memoryUsage().rss - before;
      // Generous bound: catches a real unbounded leak, tolerates interpreter jitter.
      expect(growth).toBeLessThan(256 * 1024 * 1024);
    } finally {
      rmSync(sessions2, { recursive: true, force: true });
    }
  }, 30_000);
});
