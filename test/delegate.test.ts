import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAskBotTool } from "../src/bots/delegate";
import { createBot } from "../src/bots/profile";
import { dispatch } from "../src/tools/registry";
import { Budget } from "../src/agent/budget";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig, ProviderName } from "../src/config/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-delegate-"));
  createBot(home, "researcher", { soul: "You are researcher. Be terse." });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const globalConfig = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 1024,
  budgetUSD: 5,
  approval: {},
  ...over,
});

function mockProvider(
  reply: string,
  usage = { inputTokens: 1000, outputTokens: 500 },
): Provider & { requests: ChatRequest[]; tools?: unknown } {
  const requests: ChatRequest[] = [];
  return {
    name: "mock",
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage,
      };
    },
  };
}

function scriptProvider(script: ChatResponse[]): Provider & { requests: ChatRequest[] } {
  let i = 0;
  const requests: ChatRequest[] = [];
  return {
    name: "script",
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      const next = script[i++];
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
}

const makeTool = (opts: {
  provider?: Provider;
  fromBot?: string;
  sessionBudget?: Budget;
  config?: HarnessConfig;
} = {}) =>
  createAskBotTool({
    home,
    fromBot: opts.fromBot ?? "writer",
    cwd: home,
    getProvider: (_n: ProviderName) => opts.provider ?? mockProvider("DELEGATED ANSWER"),
    globalConfig: opts.config ?? globalConfig(),
    sessionBudget: opts.sessionBudget,
  });

const ask = (tool: Provider extends never ? never : any, args: any) =>
  dispatch([tool], "ask_bot", args, { cwd: home });

describe("ask_bot", () => {
  test("delegates and returns answer with spend metadata", async () => {
    const tool = makeTool();
    const r = await ask(tool, { bot: "researcher", message: "what is auth.ts doing?" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("DELEGATED ANSWER");
    expect(r.output).toMatch(/\[delegated to researcher \([^)]+\), \$0\.01\]/);
  });

  test("uses target bot soul and pinned model", async () => {
    writeFileSync(
      join(home, "bots", "researcher", "config.yaml"),
      'model: "openai:cheap-model"\n',
    );
    const provider = mockProvider("ok");
    const tool = makeTool({ provider });
    await ask(tool, { bot: "researcher", message: "hi" });
    const req = provider.requests[0];
    expect(req?.model).toBe("cheap-model");
    expect(req?.system).toContain("You are researcher. Be terse.");
  });

  test("delegated toolset is read-only (no ask_bot, no bash)", async () => {
    const provider = mockProvider("ok");
    const tool = makeTool({ provider });
    await ask(tool, { bot: "researcher", message: "hi" });
    const names = provider.requests[0]?.tools.map((t: any) => t.name) ?? [];
    expect(names).not.toContain("ask_bot");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write_file");
    expect(names).toContain("read_file");
  });

  test("self-delegation rejected", async () => {
    const r = await ask(makeTool({ fromBot: "researcher" }), {
      bot: "researcher",
      message: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("yourself");
  });

  test("unknown bot rejected with roster hint", async () => {
    const r = await ask(makeTool(), { bot: "ghost", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('unknown bot "ghost"');
  });

  test("cap stops further iterations at target bot budgetUSD", async () => {
    writeFileSync(
      join(home, "bots", "researcher", "config.yaml"),
      "budgetUSD: 0.005\n",
    );
    const provider = scriptProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
        usage: { inputTokens: 10_000_000, outputTokens: 0 },
      },
    ]);
    const tool = makeTool({ provider });
    const r = await ask(tool, { bot: "researcher", message: "big job" });
    expect(r.output).toContain("returned no text (budget_exhausted)");
    expect(provider.requests).toHaveLength(1);
  });

  test("session remaining budget clamps the delegation cap", async () => {
    const provider = scriptProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
        usage: { inputTokens: 10_000_000, outputTokens: 0 },
      },
    ]);
    const sessionBudget = new Budget(0.5);
    sessionBudget.spentUSD = 0.4999;
    const tool = makeTool({ provider, sessionBudget });
    const r = await ask(tool, { bot: "researcher", message: "x" });
    expect(r.output).toContain("(budget_exhausted)");
    expect(provider.requests).toHaveLength(1);
  });

  test("empty message rejected", async () => {
    const r = await ask(makeTool(), { bot: "researcher", message: "   " });
    expect(r.ok).toBe(false);
  });
});
