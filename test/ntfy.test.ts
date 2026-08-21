import { describe, test, expect, afterEach } from "bun:test";
import {
  parseNtfy,
  ntfyMessage,
  ntfyPriority,
  deliverNtfy,
  attachNtfy,
  type NtfyConfig,
} from "../src/gateway/ntfy";
import { emit } from "../src/gateway/events";

type Rec = { body: string; priority: string | null; title: string | null };

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Local fake-ntfy sink; returns 200 and records the received push. */
function startSink(): { url: string; recs: Rec[] } {
  const recs: Rec[] = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      return req.text().then((body) => {
        recs.push({
          body,
          priority: req.headers.get("Priority"),
          title: req.headers.get("Title"),
        });
        return new Response("ok", { status: 200 });
      });
    },
  });
  return { url: `http://127.0.0.1:${server!.port}/topic`, recs };
}

const ev = (type: string, payload: unknown = {}) => ({
  id: 7,
  type,
  ts: 1234,
  payload,
});

const cfg = (over: Partial<NtfyConfig> = {}): NtfyConfig => ({
  topicUrl: "https://ntfy.sh/mytopic",
  ...over,
});

describe("parseNtfy", () => {
  test("unset config yields null", () => {
    expect(parseNtfy(undefined)).toBeNull();
    expect(parseNtfy(null)).toBeNull();
  });

  test("parses a topicUrl with optional priority", () => {
    const c = parseNtfy({ topicUrl: "https://ntfy.sh/x", priority: "high" });
    expect(c?.topicUrl).toBe("https://ntfy.sh/x");
    expect(c?.priority).toBe("high");
  });

  test("rejects a missing topicUrl", () => {
    expect(() => parseNtfy({ priority: "high" })).toThrow(/topicUrl/);
    expect(() => parseNtfy("wat")).toThrow(/mapping/);
  });

  test("rejects an invalid priority (global or per-type)", () => {
    expect(() => parseNtfy({ topicUrl: "https://ntfy.sh/x", priority: "ultra" })).toThrow(/priority/);
    expect(() =>
      parseNtfy({ topicUrl: "https://ntfy.sh/x", priorities: { "job.failed": "ultra" } }),
    ).toThrow(/priorities/);
  });

  test("parses per-event priority overrides", () => {
    const c = parseNtfy({
      topicUrl: "https://ntfy.sh/x",
      priority: "default",
      priorities: { "job.failed": "urgent", "approval.created": "high" },
    });
    expect(ntfyPriority(c!, "job.failed")).toBe("urgent");
    expect(ntfyPriority(c!, "approval.created")).toBe("high");
    expect(ntfyPriority(c!, "task.done")).toBe("default"); // falls back to base
  });
});

describe("ntfyMessage / ntfyPriority", () => {
  test("builds compact per-event messages", () => {
    expect(ntfyMessage(ev("approval.created", { id: "r1" }))).toContain("Approval needed");
    expect(ntfyMessage(ev("approval.resolved", { id: "r1", status: "approved" }))).toBe(
      "Approval approved: r1",
    );
    expect(ntfyMessage(ev("job.failed", { name: "nightly", bot: "worker", error: "boom" }))).toContain(
      "Job failed: nightly (worker): boom",
    );
    expect(ntfyMessage(ev("budget.exceeded", { reason: "tree limit" }))).toBe(
      "Budget exceeded: tree limit",
    );
    expect(ntfyMessage(ev("task.done", { id: "t1", bot: "researcher", status: "done" }))).toBe(
      "Task done: t1 (researcher)",
    );
  });
});

describe("deliverNtfy", () => {
  test("posts the compact message to the topic with title and default priority omitted", async () => {
    const sink = startSink();
    const ok = await deliverNtfy(cfg({ topicUrl: sink.url }), ev("budget.exceeded", { reason: "over" }));
    expect(ok).toBe(true);
    expect(sink.recs).toHaveLength(1);
    const rec = sink.recs[0]!;
    expect(rec.body).toBe("Budget exceeded: over");
    expect(rec.title).toBe("Tenjin");
    // default priority -> no Priority header (ntfy default)
    expect(rec.priority).toBeNull();
  });

  test("sends the Priority header when configured", async () => {
    const sink = startSink();
    await deliverNtfy(
      cfg({ topicUrl: sink.url, priorities: { "job.failed": "urgent" } }),
      ev("job.failed", { name: "n", bot: "b", error: "e" }),
    );
    expect(sink.recs[0]?.priority).toBe("urgent");
  });

  test("delivery failure returns false", async () => {
    const ok = await deliverNtfy(cfg({ topicUrl: "http://127.0.0.1:1/nope" }), ev("task.done"));
    expect(ok).toBe(false);
  });
});

describe("attachNtfy (event-bus wiring)", () => {
  test("an emitted event reaches the ntfy topic as a push", async () => {
    const sink = startSink();
    const off = attachNtfy(cfg({ topicUrl: sink.url }));
    try {
      emit("approval.created", { id: "req-1" });
      await sleepUntil(() => sink.recs.length > 0, 1000);
    } finally {
      off();
    }
    expect(sink.recs).toHaveLength(1);
    expect(sink.recs[0]?.body).toContain("Approval needed: req-1");
  });

  test("closing the subscription stops delivery", async () => {
    const sink = startSink();
    const off = attachNtfy(cfg({ topicUrl: sink.url }));
    off();
    emit("budget.exceeded", { reason: "x" });
    await new Promise((r) => setTimeout(r, 150));
    expect(sink.recs).toHaveLength(0);
  });
});

function sleepUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (check() || Date.now() - start > timeoutMs) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
}
