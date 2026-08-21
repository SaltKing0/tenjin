import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatStreamResponse,
  createMessageHandler,
} from "../src/gateway/handler";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
} from "../src/provider/types";
import type { HarnessConfig } from "../src/config/types";
import type { AuditLog } from "../src/audit/log";
import { createBot } from "../src/bots/profile";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-stream-"));
  createBot(home, "tester");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const config = (): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 256,
  budgetUSD: 1,
  approval: {},
});

function streamingProvider(): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "mock",
    requests,
    async chat(req: ChatRequest, callbacks): Promise<ChatResponse> {
      requests.push(req);
      callbacks?.onTextDelta?.("Hel");
      callbacks?.onTextDelta?.("lo ");
      callbacks?.onTextDelta?.("world");
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Hello world" }],
        usage: { inputTokens: 10, outputTokens: 3 },
      };
    },
  };
}

function makeHandler(provider: Provider) {
  return createMessageHandler({
    home,
    cwd: home,
    config: config(),
    registry: { get: () => provider } as never,
    availableBots: [],
    defaultBot: "tester",
    allowWrites: false,
    approvalTimeoutMs: 1000,
    guard: null,
    audit: { append: () => {} } as unknown as AuditLog,
    log: () => {},
  });
}

test("chatStreamResponse emits delta frames then done", async () => {
  const handle = (text: string, ctx: { onDelta?: (d: string) => void }) => {
    ctx.onDelta?.("Hel");
    ctx.onDelta?.("lo");
    return Promise.resolve("Hello");
  };
  const res = chatStreamResponse(handle, "hi", { actor: "console", source: "http" });
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const raw = await res.text();
  const frames = raw
    .split("\n\n")
    .filter(Boolean)
    .map((f) => JSON.parse(f.replace(/^data: /, "")));
  expect(frames).toEqual([
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
    { type: "done", reply: "Hello" },
  ]);
});

test("handler errors become error frame, not throw", async () => {
  const handle = () => Promise.reject(new Error("boom"));
  const res = chatStreamResponse(handle, "hi", { actor: "console", source: "http" });
  const raw = await res.text();
  expect(raw).toContain('"type":"error"');
  expect(raw).toContain("boom");
});

test("createMessageHandler forwards onDelta to the model stream", async () => {
  const provider = streamingProvider();
  const handle = makeHandler(provider);
  const deltas: string[] = [];
  const reply = await handle("say hi", {
    actor: "console",
    source: "http",
    onDelta: (d) => deltas.push(d),
  });
  expect(reply).toBe("Hello world");
  expect(deltas.join("")).toBe("Hello world");
});
