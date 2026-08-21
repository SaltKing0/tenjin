import { describe, test, expect } from "bun:test";
import {
  WebhookChannel,
  verifyWebhookSignature,
  webhookSignature,
  hashId,
  type WebhookOptions,
} from "../src/gateway/webhook";
import { parseGatewaySettings } from "../src/gateway/config";
import type { ChannelInbound } from "../src/gateway/channel";

const SECRET = "shh-secret";

function timestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function signedBody(
  body: Record<string, unknown>,
  secret = SECRET,
  ts = timestamp(),
): { raw: string; signature: string; ts: string } {
  const raw = JSON.stringify(body);
  return { raw, signature: webhookSignature(secret, ts, raw), ts };
}

/** Drive the channel's HTTP handler directly with a Request — no real server. */
function hit(
  opts: Partial<WebhookOptions> & { secret?: string; handler?: (m: ChannelInbound) => Promise<string | null> },
  body: { raw: string; signature: string; ts: string },
): Promise<Response> {
  const ch = new WebhookChannel(
    {
      secret: opts.secret ?? SECRET,
      defaultBot: "researcher",
      allowedSenders: opts.allowedSenders ?? [],
      outboundWebhookUrl: opts.outboundWebhookUrl,
      maxMessageLength: opts.maxMessageLength ?? 64,
      ...opts,
    },
    () => {},
  );
  // Wire an echo handler unless the test overrides it.
  ch.onMessage(opts.handler ?? (async (m: ChannelInbound) => `echo:${m.text}`));
  const req = new Request("http://127.0.0.1:1/channel/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": body.signature,
      "x-webhook-timestamp": body.ts,
    },
    body: body.raw,
  });
  // eventHandler is the exact function the server invokes.
  return (ch as unknown as { eventHandler: (r: Request) => Promise<Response> }).eventHandler(req);
}

describe("verifyWebhookSignature", () => {
  test("accepts a valid signature", () => {
    const { raw, signature, ts } = signedBody({ text: "hi" });
    expect(verifyWebhookSignature(SECRET, raw, signature, ts)).toBe(true);
  });

  test("rejects a wrong secret", () => {
    const { raw, signature, ts } = signedBody({ text: "hi" });
    expect(verifyWebhookSignature("other-secret", raw, signature, ts)).toBe(false);
  });

  test("rejects a tampered body", () => {
    const { raw, signature, ts } = signedBody({ text: "hi" });
    expect(verifyWebhookSignature(SECRET, raw.replace("hi", "bye"), signature, ts)).toBe(false);
  });

  test("rejects a stale timestamp (replay)", () => {
    const { raw, signature } = signedBody({ text: "hi" }, SECRET, String(Math.floor(Date.now() / 1000) - 400));
    expect(verifyWebhookSignature(SECRET, raw, signature, timestamp())).toBe(false);
  });

  test("rejects missing signature or timestamp", () => {
    const { raw } = signedBody({ text: "hi" });
    expect(verifyWebhookSignature(SECRET, raw, null, timestamp())).toBe(false);
    expect(verifyWebhookSignature(SECRET, raw, "sha256=x", null)).toBe(false);
  });

  test("hashId is stable and non-zero", () => {
    expect(hashId("alice")).toBe(hashId("alice"));
    expect(hashId("alice")).not.toBe(hashId("bob"));
    expect(hashId("alice")).toBeGreaterThan(0);
  });
});

describe("WebhookChannel HTTP handler", () => {
  test("signed message in → JSON reply out", async () => {
    const body = signedBody({ text: "hello", sender: "n8n" });
    const res = await hit({}, body);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { reply: string };
    expect(data.reply).toBe("echo:hello");
  });

  test("no handler / empty message → reply null", async () => {
    const ch = new WebhookChannel({ secret: SECRET, defaultBot: "researcher", allowedSenders: [] }, () => {});
    const body = signedBody({ text: "" });
    const res = await (ch as unknown as { eventHandler: (r: Request) => Promise<Response> }).eventHandler(
      new Request("http://127.0.0.1:1/channel/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": body.signature,
          "x-webhook-timestamp": body.ts,
        },
        body: body.raw,
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { reply: string | null };
    expect(data.reply).toBeNull();
  });

  test("wrong signature → 401", async () => {
    const body = signedBody({ text: "hello" }, "wrong-secret");
    const res = await hit({}, body);
    expect(res.status).toBe(401);
  });

  test("malformed json → 400", async () => {
    const raw = "{ not json";
    const ts = timestamp();
    const signature = webhookSignature(SECRET, ts, raw);
    const ch = new WebhookChannel({ secret: SECRET, defaultBot: "researcher", allowedSenders: [] }, () => {});
    const res = await (ch as unknown as { eventHandler: (r: Request) => Promise<Response> }).eventHandler(
      new Request("http://127.0.0.1:1/channel/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": signature,
          "x-webhook-timestamp": ts,
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(400);
  });

  test("allowedSenders rejects an unauthorized sender", async () => {
    const body = signedBody({ text: "hello", sender: "evil" });
    const res = await hit({ allowedSenders: ["github"] }, body);
    expect(res.status).toBe(401);
  });

  test("allowedSenders accepts an allowed sender", async () => {
    const body = signedBody({ text: "pr merged", sender: "github" });
    const res = await hit({ allowedSenders: ["github"] }, body);
    expect(res.status).toBe(200);
  });

  test("handler error → 500", async () => {
    const body = signedBody({ text: "boom", sender: "n8n" });
    const res = await hit({ handler: async () => { throw new Error("boom"); } }, body);
    expect(res.status).toBe(500);
  });

  test("reply is forwarded to the outbound webhook when configured", async () => {
    let received: string | null = null;
    const target = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received = await req.text();
        return Response.json({ ok: true });
      },
    });
    try {
      const url = `http://127.0.0.1:${target.port}/out`;
      const body = signedBody({ text: "ping", sender: "n8n" });
      const res = await hit({ outboundWebhookUrl: url }, body);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
      // The outbound POST is awaited by deliverReply, so it has already landed.
      expect(received).not.toBeNull();
      if (received) {
        const parsed = JSON.parse(received) as { text?: unknown };
        expect(parsed.text).toBe("echo:ping");
      }
    } finally {
      target.stop(true);
    }
  });
});

describe("gateway config webhook", () => {
  test("parses webhook config and adds it to default channels", () => {
    const s = parseGatewaySettings({
      webhook: {
        enabled: true,
        defaultBot: "researcher",
        secret: "xyz",
        allowedSenders: ["github"],
        outboundWebhookUrl: "https://example.com/hook",
      },
    });
    expect(s.webhook?.enabled).toBe(true);
    expect(s.webhook?.secret).toBe("xyz");
    expect(s.webhook?.allowedSenders).toEqual(["github"]);
    expect(s.channels).toContain("webhook");
  });

  test("enabled webhook without a secret is a config error", () => {
    expect(() =>
      parseGatewaySettings({ webhook: { enabled: true, allowedSenders: [] } }),
    ).toThrow(/secret/);
  });
});
