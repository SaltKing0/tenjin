import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SlackChannel,
  verifySlackSignature,
  type SlackRejection,
} from "../src/gateway/slack";
import { createMessageHandler } from "../src/gateway/handler";
import { createBot } from "../src/bots/profile";
import type { HarnessConfig } from "../src/config/types";
import type { Provider } from "../src/provider/types";
import type { AuditLog } from "../src/audit/log";

const SECRET = "signing-secret";
const TOKEN = "xoxb-test-token";

let apiServer: ReturnType<typeof Bun.serve>;
let posted: Array<{ channel: string; text: string; auth?: string | null }>;
const active: SlackChannel[] = [];

afterEach(() => {
  apiServer?.stop(true);
  for (const ch of active) ch.stop();
  active.length = 0;
});

function startFakeApi() {
  posted = [];
  apiServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat.postMessage")) {
        const body = (await req.json()) as { channel: string; text: string };
        posted.push({
          channel: body.channel,
          text: body.text,
          auth: req.headers.get("authorization"),
        });
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    },
  });
}

function signedHeaders(raw: string, secret: string = SECRET): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig =
    "v0=" +
    createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-slack-signature": sig,
    "x-slack-request-timestamp": ts,
  };
}

async function postEvent(
  ch: SlackChannel,
  body: unknown,
  secret: string = SECRET,
): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(ch.webhookUrl, {
    method: "POST",
    headers: signedHeaders(raw, secret),
    body: raw,
  });
}

function makeChannel(opts: Partial<ConstructorParameters<typeof SlackChannel>[0]> = {}): SlackChannel {
  return new SlackChannel(
    {
      botToken: TOKEN,
      signingSecret: SECRET,
      defaultBot: "worker",
      allowedChannels: ["C123"],
      apiBase: `http://localhost:${apiServer.port}`,
      ...opts,
    },
    () => {},
  );
}

async function startAndPost(body: unknown, secret?: string) {
  const ch = makeChannel();
  active.push(ch);
  const ac = new AbortController();
  await ch.start(ac.signal);
  return postEvent(ch, body, secret);
}

function messageEvent(channel: string, text: string, user = "U1") {
  return {
    type: "event_callback",
    event: { type: "message", channel, user, text, ts: "1" },
  };
}

describe("slack signature (#106)", () => {
  test("verifySlackSignature accepts a valid signature", () => {
    const raw = JSON.stringify({ hello: 1 });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", SECRET)
      .update(`v0:${ts}:${raw}`)
      .digest("hex");
    expect(verifySlackSignature(SECRET, raw, `v0=${sig}`, ts)).toBe(true);
  });

  test("verifySlackSignature rejects wrong secret, stale timestamp, missing header", () => {
    const raw = JSON.stringify({ hello: 1 });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", SECRET)
      .update(`v0:${ts}:${raw}`)
      .digest("hex");
    expect(verifySlackSignature("other-secret", raw, `v0=${sig}`, ts)).toBe(false);
    expect(verifySlackSignature(SECRET, raw, `v0=${sig}`, "1")).toBe(false);
    expect(verifySlackSignature(SECRET, raw, null, ts)).toBe(false);
  });
});

describe("SlackChannel (#106)", () => {
  test("url_verification challenge is answered verbatim", async () => {
    startFakeApi();
    const res = await startAndPost({ type: "url_verification", challenge: "challenge-xyz" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("challenge-xyz");
  });

  test("request with a bad signature is rejected before handling", async () => {
    startFakeApi();
    const res = await startAndPost(messageEvent("C123", "hello"), "wrong-secret");
    expect(res.status).toBe(401);
    expect(posted).toEqual([]);
  });

  test("allowlisted message in → handler reply posts to the originating channel", async () => {
    startFakeApi();
    let got = "";
    const ch = makeChannel();
    active.push(ch);
    ch.onMessage(async (msg) => {
      got = msg.text;
      return "REPLY_OK";
    });
    const ac = new AbortController();
    await ch.start(ac.signal);
    await postEvent(ch, messageEvent("C123", "hello slack"));
    await Bun.sleep(20);
    expect(got).toBe("hello slack");
    expect(posted.some((p) => p.text === "REPLY_OK" && p.channel === "C123")).toBe(true);
    ac.abort();
  });

  test("handler error posts a polite error to the channel", async () => {
    startFakeApi();
    const ch = makeChannel();
    active.push(ch);
    ch.onMessage(async () => {
      throw new Error("boom");
    });
    const ac = new AbortController();
    await ch.start(ac.signal);
    await postEvent(ch, messageEvent("C123", "boom"));
    await Bun.sleep(20);
    expect(posted.some((p) => p.text.includes("error") && p.channel === "C123")).toBe(true);
    ac.abort();
  });

  test("reply over the outbound limit arrives complete, chunked (#201)", async () => {
    startFakeApi();
    const longReply = Array.from({ length: 5 }, (_, i) => `chunk ${i} ` + "x".repeat(20)).join(
      "\n",
    );
    const ch = makeChannel({ maxOutboundLength: 15 });
    active.push(ch);
    ch.onMessage(async () => longReply);
    const ac = new AbortController();
    await ch.start(ac.signal);
    await postEvent(ch, messageEvent("C123", "long answer"));
    await Bun.sleep(20);
    const parts = posted.filter((p) => p.channel === "C123").map((p) => p.text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(longReply);
    expect(parts.every((t) => t.length <= 15)).toBe(true);
    ac.abort();
  });

  test("delivery failure is not reported as a generic handler error (#201)", async () => {
    startFakeApi();
    // After this body we swap the responder to return a hard failure.
    const ch = makeChannel();
    active.push(ch);
    ch.onMessage(async () => "REPLY_OK");
    const ac = new AbortController();
    await ch.start(ac.signal);
    // Override the server AFTER construction so the channel posts fail.
    apiServer.stop(true);
    apiServer = Bun.serve({
      port: 0,
      fetch: async () => Response.json({ ok: false, error: "channel_not_found" }, { status: 404 }),
    });
    // Point the channel at the new port.
    (ch as unknown as { opts: { apiBase: string } }).opts.apiBase = `http://localhost:${(
      apiServer as unknown as { port: number }
    ).port}`;
    await postEvent(ch, messageEvent("C123", "boom"));
    await Bun.sleep(20);
    // The reply was generated but delivery failed — no polite "error:" echo.
    expect(posted.some((p) => p.text.includes("error"))).toBe(false);
    ac.abort();
  });

  test("disallowed channel is rejected and not routed to the handler", async () => {
    startFakeApi();
    const rejected: SlackRejection[] = [];
    const ch = makeChannel({ onRejected: (r) => rejected.push(r) });
    active.push(ch);
    let called = false;
    ch.onMessage(async (msg) => {
      called = true;
      return "nope";
    });
    const ac = new AbortController();
    await ch.start(ac.signal);
    await postEvent(ch, messageEvent("D999", "intrude"));
    await Bun.sleep(20);
    expect(called).toBe(false);
    expect(rejected).toEqual([{ channelId: "D999", userId: "U1", reason: "unauthorized" }]);
    expect(posted.filter((p) => p.text !== "intrude")).toEqual([]);
    ac.abort();
  });

  test("messages over maxMessageLength are rejected politely", async () => {
    startFakeApi();
    const rejected: SlackRejection[] = [];
    const ch = makeChannel({ maxMessageLength: 10, onRejected: (r) => rejected.push(r) });
    active.push(ch);
    ch.onMessage(async () => null);
    const ac = new AbortController();
    await ch.start(ac.signal);
    await postEvent(ch, messageEvent("C123", "x".repeat(50)));
    await Bun.sleep(20);
    expect(rejected).toEqual([{ channelId: "C123", userId: "U1", reason: "too_long" }]);
    expect(posted.some((p) => /too long/i.test(p.text))).toBe(true);
    ac.abort();
  });

  test("rate limit rejects once a channel exceeds the window", async () => {
    startFakeApi();
    const rejected: SlackRejection[] = [];
    const ch = makeChannel({ rateLimitMax: 2, rateLimitWindowMs: 60_000, onRejected: (r) => rejected.push(r) });
    active.push(ch);
    const handled: string[] = [];
    ch.onMessage(async (msg) => {
      handled.push(msg.text);
      return null;
    });
    const ac = new AbortController();
    await ch.start(ac.signal);
    await postEvent(ch, messageEvent("C123", "m1"));
    await postEvent(ch, messageEvent("C123", "m2"));
    await postEvent(ch, messageEvent("C123", "m3"));
    await Bun.sleep(20);
    expect(handled).toEqual(["m1", "m2"]);
    expect(rejected).toEqual([{ channelId: "C123", userId: "U1", reason: "rate_limited" }]);
    ac.abort();
  });

  // #200: a Slack redelivery of the same event_id must run the agent exactly once.
  test("a redelivered event_id runs exactly once (idempotent)", async () => {
    startFakeApi();
    let runs = 0;
    const ch = makeChannel();
    active.push(ch);
    ch.onMessage(async () => {
      runs += 1;
      return null;
    });
    const ac = new AbortController();
    await ch.start(ac.signal);
    const body = {
      type: "event_callback",
      event_id: "Ev-dup-1",
      event: { type: "message", channel: "C123", user: "U1", text: "hello", ts: "1" },
    };
    await postEvent(ch, body);
    await postEvent(ch, body); // Slack retries with the same event_id
    await Bun.sleep(30);
    expect(runs).toBe(1);
    ac.abort();
  });

  // #200: the run is fire-and-forget — the 2xx ack goes out before a slow run ends.
  test("a slow run does not block the 2xx ack", async () => {
    startFakeApi();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let finished = false;
    const ch = makeChannel();
    active.push(ch);
    ch.onMessage(async () => {
      await gate;
      finished = true;
      return null;
    });
    const ac = new AbortController();
    await ch.start(ac.signal);
    const resPromise = postEvent(ch, messageEvent("C123", "slow"));
    const ack = await Promise.race([resPromise, Bun.sleep(100).then(() => "TIMEOUT")]);
    expect(ack).not.toBe("TIMEOUT"); // ack returned while the run is still blocked
    release();
    await resPromise;
    await Bun.sleep(10);
    expect(finished).toBe(true); // the background run still completed
    ac.abort();
  });

  test("e2e: real message handler runs the bot and posts the reply back to slack", async () => {
    startFakeApi();
    const home = mkdtempSync(join(tmpdir(), "tj-slk-"));
    createBot(home, "worker");
    const handle = createMessageHandler({
      home,
      cwd: home,
      config: {
        provider: "anthropic",
        model: "m",
        maxTokens: 512,
        budgetUSD: 1,
        approval: {},
      } satisfies HarnessConfig,
      registry: {
        get: () =>
          ({
            name: "mock",
            async chat() {
              return {
                stopReason: "end_turn",
                content: [{ type: "text", text: "SLACK_REPLY" }],
                usage: { inputTokens: 10, outputTokens: 5 },
              };
            },
          }) as unknown,
      } as never,
      availableBots: ["worker"],
      defaultBot: "worker",
      allowWrites: false,
      approvalTimeoutMs: 500,
      guard: null,
      audit: { append: () => {} } as unknown as AuditLog,
      log: () => {},
    });
    const ch = makeChannel({ adminChannel: "C123" });
    active.push(ch);
    ch.onMessage((msg) =>
      handle(msg.text, {
        actor: String(msg.userId),
        source: "slack",
        chatId: msg.chatId,
        userId: msg.userId,
      }),
    );
    const ac = new AbortController();
    await ch.start(ac.signal);
    await postEvent(ch, messageEvent("C123", "summarize the repo"));
    await Bun.sleep(60);
    expect(posted.some((p) => p.text === "SLACK_REPLY" && p.channel === "C123")).toBe(true);
    rmSync(home, { recursive: true, force: true });
    ac.abort();
  });
});
