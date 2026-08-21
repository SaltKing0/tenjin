import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { ProviderRegistry } from "../src/provider/registry";

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

test("chat injects bot facts.md and exposes use_skill", async () => {
  const mem = join(home, "bots", "tester", "memory");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "facts.md"), "- [2026-08-21] tester prefers terse replies\n");
  mkdirSync(join(home, "skills", "terse"), { recursive: true });
  writeFileSync(
    join(home, "skills", "terse", "SKILL.md"),
    '---\nname: "terse"\ndescription: "Keep replies short"\n---\nBe terse.\n',
  );

  const provider = streamingProvider();
  const handle = makeHandler(provider);
  await handle("say hi", { actor: "console", source: "http" });

  const req = provider.requests[0];
  expect(req).toBeDefined();
  const system = String(req?.system);
  expect(system).toContain("# Facts");
  expect(system).toContain("tester prefers terse replies");
  expect(system).toContain("# Skills");
  expect(system).toContain("terse");
  const names = req?.tools.map((t) => t.name) ?? [];
  expect(names).toContain("use_skill");
  expect(names).not.toContain("save_skill");
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

function framesOf(raw: string): Array<{ type: string; message?: string }> {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((f) => JSON.parse(f.replace(/^data: /, "")));
}

function withClearedKeys<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return fn().finally(() => {
    if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
  });
}

test("missing provider key names the active model and Settings hint in the stream error", async () => {
  await withClearedKeys(async () => {
    const handle = createMessageHandler({
      home,
      cwd: home,
      config: config(),
      registry: new ProviderRegistry(),
      availableBots: [],
      defaultBot: "tester",
      allowWrites: false,
      approvalTimeoutMs: 1000,
      guard: null,
      audit: { append: () => {} } as unknown as AuditLog,
      log: () => {},
    });
    const res = chatStreamResponse(handle, "hi", { actor: "console", source: "http" });
    const frames = framesOf(await res.text());
    const err = frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    expect(err!.message).toContain("ANTHROPIC_API_KEY");
    expect(err!.message).toContain("anthropic:claude-sonnet-4-5");
    expect(err!.message).toContain("change it in Settings → Models");
  });
});

test("bot-pinned model is named when its provider key is missing", async () => {
  await withClearedKeys(async () => {
    writeFileSync(join(home, "bots", "tester", "config.yaml"), "model: openai:gpt-4o\n");
    const handle = createMessageHandler({
      home,
      cwd: home,
      config: config(),
      registry: new ProviderRegistry(),
      availableBots: ["tester"],
      defaultBot: "tester",
      allowWrites: false,
      approvalTimeoutMs: 1000,
      guard: null,
      audit: { append: () => {} } as unknown as AuditLog,
      log: () => {},
    });
    await expect(handle("hi", { actor: "console", source: "http" })).rejects.toThrow(
      /openai:gpt-4o.*change it in Settings → Models/s,
    );
  });
});

test("provider chat failures also name the active model", async () => {
  const provider: Provider = {
    name: "mock",
    async chat() {
      throw new Error("upstream 500");
    },
  };
  const handle = makeHandler(provider);
  const res = chatStreamResponse(handle, "hi", { actor: "console", source: "http" });
  const frames = framesOf(await res.text());
  const err = frames.find((f) => f.type === "error");
  expect(err?.message).toContain("upstream 500");
  expect(err?.message).toContain("anthropic:claude-sonnet-4-5");
  expect(err?.message).toContain("change it in Settings → Models");
});
