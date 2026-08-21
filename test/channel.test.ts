import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerChannel,
  channelFactory,
  knownChannel,
  type Channel,
  type ChannelInbound,
} from "../src/gateway/channel";
import { createMessageHandler } from "../src/gateway/handler";
import { createBot } from "../src/bots/profile";
import type { HarnessConfig } from "../src/config/types";
import type { Provider } from "../src/provider/types";
import type { AuditLog } from "../src/audit/log";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-ch-"));
  createBot(home, "worker");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const config = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 512,
  budgetUSD: 1,
  approval: {},
  ...over,
});

function mockProvider(reply: string): Provider {
  return {
    name: "mock",
    async chat() {
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

function fakeChannel(): {
  channel: Channel;
  sent: string[];
  receive: (text: string) => Promise<string | null>;
} {
  const sent: string[] = [];
  let handler: ((msg: ChannelInbound) => Promise<string | null>) | undefined;
  const channel: Channel = {
    name: "fake",
    onMessage: (h) => {
      handler = h;
    },
    send: async (text) => {
      sent.push(text);
    },
    start: async () => {},
    stop: () => {},
  };
  return {
    channel,
    sent,
    receive: async (text: string) => {
      if (!handler) throw new Error("fake channel has no handler");
      const reply = await handler({ text, chatId: 1, userId: 7 });
      if (reply) await channel.send(reply);
      return reply;
    },
  };
}

describe("channel registry (#97)", () => {
  test("telegram is a known channel; unknown kinds are not", () => {
    expect(knownChannel("telegram")).toBe(true);
    expect(knownChannel("slack")).toBe(false);
    expect(channelFactory("telegram")).toBeDefined();
  });
});

describe("fake channel in the gateway (#97)", () => {
  test("message in → bot reply out through the Channel abstraction", async () => {
    const fake = fakeChannel();
    registerChannel("fake", () => fake.channel);

    const handle = createMessageHandler({
      home,
      cwd: home,
      config: config(),
      registry: { get: () => mockProvider("FAKE_REPLY") } as never,
      availableBots: ["worker"],
      defaultBot: "worker",
      allowWrites: false,
      approvalTimeoutMs: 500,
      guard: null,
      audit: { append: () => {} } as unknown as AuditLog,
      log: () => {},
    });

    fake.channel.onMessage((msg) =>
      handle(msg.text, {
        actor: String(msg.userId),
        source: "telegram",
        chatId: msg.chatId,
        userId: msg.userId,
      }),
    );

    const reply = await fake.receive("analyze the auth flow");
    expect(reply).toBe("FAKE_REPLY");
    expect(fake.sent).toContain("FAKE_REPLY");
  });
});
