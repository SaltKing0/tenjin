import { describe, test, expect, afterEach } from "bun:test";
import {
  parseWebhooks,
  signPayload,
  targetWants,
  deliver,
  attachWebhooks,
  type WebhookTarget,
} from "../src/gateway/webhooks";
import { emit } from "../src/gateway/events";

type Rec = { body: string; sig: string | null };

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Local sink: fails the first `failures` requests, then records the rest. */
function startSink(failures = 0): { url: string; recs: Rec[]; attempts(): number } {
  const recs: Rec[] = [];
  const state = { n: 0 };
  server = Bun.serve({
    port: 0,
    fetch(req) {
      state.n++;
      if (state.n <= failures) return new Response("fail", { status: 500 });
      return req.text().then((body) => {
        recs.push({ body, sig: req.headers.get("x-tenjin-signature") });
        return new Response("ok", { status: 200 });
      });
    },
  });
  return { url: `http://127.0.0.1:${server!.port}/hook`, recs, attempts: () => state.n };
}

const ev = (type: string, payload: unknown = {}) => ({
  id: 7,
  type,
  ts: 1234,
  payload,
});

const target = (over: Partial<WebhookTarget> = {}): WebhookTarget => ({
  url: "http://127.0.0.1:1/x",
  secret: "secret",
  events: ["budget.exceeded"],
  ...over,
});

describe("parseWebhooks", () => {
  test("accepts valid targets", () => {
    const out = parseWebhooks([
      { url: "https://x.com/h", secret: "s", events: ["approval.created", "job.failed"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.events).toEqual(["approval.created", "job.failed"]);
  });

  test("rejects a missing secret / url", () => {
    expect(() => parseWebhooks([{ url: "https://x", events: ["job.failed"] }])).toThrow(/secret/);
    expect(() => parseWebhooks([{ secret: "s", events: ["job.failed"] }])).toThrow(/`url`/);
  });

  test("rejects an unknown event type", () => {
    expect(() =>
      parseWebhooks([{ url: "https://x", secret: "s", events: ["nope"] }]),
    ).toThrow(/unknown event/);
  });

  test("empty config yields no targets", () => {
    expect(parseWebhooks(undefined)).toEqual([]);
    expect(parseWebhooks([])).toEqual([]);
  });
});

describe("signPayload / targetWants", () => {
  test("HMAC is deterministic", () => {
    const a = signPayload("k", "body");
    const b = signPayload("k", "body");
    expect(a).toBe(b);
    expect(a).not.toBe(signPayload("k2", "body"));
  });

  test("targetWants filters by event type", () => {
    const t = target({ events: ["job.failed"] });
    expect(targetWants(t, "job.failed")).toBe(true);
    expect(targetWants(t, "approval.created")).toBe(false);
  });
});

describe("deliver", () => {
  test("posts a signed JSON payload", async () => {
    const sink = startSink();
    const r = await deliver(target({ url: sink.url, events: ["budget.exceeded"] }), ev("budget.exceeded", { reason: "over" }));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.dead).toBe(false);
    expect(sink.recs).toHaveLength(1);
    const rec = sink.recs[0]!;
    const body = JSON.parse(rec.body);
    expect(body.type).toBe("budget.exceeded");
    expect(body.payload.reason).toBe("over");
    expect(body.id).toBe(7);
    // signature matches the delivered body
    expect(rec.sig).toBe(`sha256=${signPayload("secret", rec.body)}`);
  });

  test("retries with backoff until success", async () => {
    const sink = startSink(2); // first two attempts fail
    const r = await deliver(target({ url: sink.url, retries: 4 }), ev("job.failed"));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(sink.attempts()).toBe(3);
    expect(sink.recs).toHaveLength(1);
  });

  test("dead-letters after the final attempt", async () => {
    const sink = startSink(99);
    const r = await deliver(target({ url: sink.url, retries: 2 }), ev("approval.created"));
    expect(r.ok).toBe(false);
    expect(r.dead).toBe(true);
    expect(r.attempts).toBe(2);
    expect(sink.recs).toHaveLength(0);
  });
});

describe("attachWebhooks (event-bus wiring)", () => {
  test("an emitted matching event reaches the webhook endpoint", async () => {
    const sink = startSink();
    const off = attachWebhooks([target({ url: sink.url, retries: 1 })]);
    try {
      emit("budget.exceeded", { reason: "tree limit" });
      await sleepUntil(() => sink.recs.length > 0, 1000);
    } finally {
      off();
    }
    expect(sink.recs).toHaveLength(1);
    expect(JSON.parse(sink.recs[0]!.body).type).toBe("budget.exceeded");
  });

  test("an event the target does not subscribe to is not delivered", async () => {
    const sink = startSink();
    const off = attachWebhooks([target({ url: sink.url, events: ["job.failed"], retries: 1 })]);
    try {
      emit("approval.created", { id: "x" });
      emit("job.status", { name: "n" }); // not in the subscribed set
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      off();
    }
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
