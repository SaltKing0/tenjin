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
