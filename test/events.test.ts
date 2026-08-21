import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer } from "../src/gateway/http";
import { createRequest } from "../src/gateway/approvals";
import { emit, subscribe, listenerCount } from "../src/gateway/events";

let home: string;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function startServer() {
  home = mkdtempSync(join(tmpdir(), "tj-evt-"));
  return startHttpServer({
    config: { port: 0, host: "127.0.0.1", token: "tok" },
    handleMessage: async () => null,
    status: () => ({}),
  });
}

interface Frame {
  id: number;
  type: string;
  payload: unknown;
}

async function readFrame(res: Response): Promise<Frame> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("stream ended before a data frame");
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let id = 0;
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = Number(line.slice(4));
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue; // comment / heartbeat ping
      const ev = JSON.parse(data) as { type: string; payload: unknown };
      if (id === 0) throw new Error("frame missing id");
      return { id, type: ev.type, payload: ev.payload };
    }
  }
}

describe("SSE /api/events (#57)", () => {
  test("streams an approval.new event in realtime", async () => {
    const server = startServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: "run ls" });
    const frame = await readFrame(res);
    expect(frame.type).toBe("approval.created");
    expect(frame.payload).toEqual({ id: req.id });
    server.stop();
  });

  test("reconnect with Last-Event-ID replays events missed while offline", async () => {
    const server = startServer();

    const res1 = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers: { authorization: "Bearer tok" },
    });
    await Bun.sleep(20);
    const req1 = createRequest(home, { bot: "b", tool: "bash", inputSummary: "one" });
    const frame1 = await readFrame(res1);
    expect(frame1.type).toBe("approval.created");
    expect(frame1.payload).toEqual({ id: req1.id });

    const req2 = createRequest(home, { bot: "b", tool: "bash", inputSummary: "two" });

    const res2 = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers: { authorization: "Bearer tok", "Last-Event-ID": String(frame1.id) },
    });
    const frame2 = await readFrame(res2);
    expect(frame2.type).toBe("approval.created");
    expect(frame2.payload).toEqual({ id: req2.id });
    expect(frame2.id).toBeGreaterThan(frame1.id);
    server.stop();
  });

  test("a fresh connection (no Last-Event-ID) starts live, not from history", async () => {
    const server = startServer();
    const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: "pre-existing" });

    // Connect AFTER an event exists; with no Last-Event-ID the old event
    // should NOT be replayed — only live events arrive.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers: { authorization: "Bearer tok" },
    });
    await Bun.sleep(20);
    const req2 = createRequest(home, { bot: "b", tool: "bash", inputSummary: "live" });
    const frame = await readFrame(res);
    expect(frame.payload).toEqual({ id: req2.id });
    expect(frame.payload).not.toEqual({ id: req.id });
    server.stop();
  });

  test("the bus emits and replays through historySince for an arbitrary type", () => {
    const seen: Array<{ id: number; type: string }> = [];
    const off = subscribe((e) => seen.push({ id: e.id, type: e.type }));
    const ev = emit("custom.ping", { a: 1 });
    expect(ev.type).toBe("custom.ping");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(ev.id);
    off();
    emit("custom.after", {});
    expect(seen).toHaveLength(1);
  });
});


describe("SSE backpressure & zombie cleanup (#199)", () => {
  test("a client that never reads is closed and its listener removed", async () => {
    const server = startServer();
    const before = listenerCount();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);

    // Zombie: hold the stream open but never read from its body.
    const reader = res.body!.getReader();
    // Emit far more events than the history replay + backpressure budget; a
    // live client would consume them, a zombie accumulates them until the
    // listener is torn down.
    for (let i = 0; i < 100; i++) {
      emit("zombie.burst", { i });
    }
    // Give the server a moment to drain/close the stalled stream.
    await Bun.sleep(50);

    // The zombie's listener must be removed (no leak).
    expect(listenerCount()).toBe(before);

    // The writer closes the stalled stream. Buffered frames (up to the
    // backpressure budget) come first; drain until the reader reports done.
    let ended = false;
    for (let i = 0; i < 200 && !ended; i++) {
      const { done: d } = await reader.read();
      if (d) ended = true;
    }
    expect(ended).toBe(true);
    server.stop();
  });
});
