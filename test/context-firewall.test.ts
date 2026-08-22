import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAskBotTool, delegationArtifactsDir, CONTRACT_SUMMARY_MAX_CHARS } from "../src/bots/delegate";
import type { AskBotDeps } from "../src/bots/delegate";
import { createBot } from "../src/bots/profile";
import { dispatch } from "../src/tools/registry";
import { TreeBudget } from "../src/agent/budget";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig, ProviderName } from "../src/config/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-cfw-"));
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
): Provider & { requests: ChatRequest[] } {
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
  config?: HarnessConfig;
  audit?: AskBotDeps["audit"];
  treeBudget?: TreeBudget;
} = {}) =>
  createAskBotTool({
    home,
    fromBot: "writer",
    cwd: home,
    getProvider: (_n: ProviderName) => opts.provider ?? mockProvider("DELEGATED ANSWER"),
    globalConfig: opts.config ?? globalConfig(),
    audit: opts.audit,
  });

const ask = (tool: any, args: any, ctx: any = {}) =>
  dispatch([tool], "ask_bot", args, { cwd: home, ...ctx });

function sidecarFiles(): string[] {
  return readdirSync(delegationArtifactsDir(home)).filter((f) => f.endsWith(".md"));
}

const LONG_OUTPUT_TAIL = "UNIQUE_TAIL_MARKER_BEYOND_SUMMARY_CAP";
const LONG_OUTPUT = "HEAD_OF_ANSWER " + "x".repeat(CONTRACT_SUMMARY_MAX_CHARS) + " " + LONG_OUTPUT_TAIL;

describe("B11-2 delegation context firewall", () => {
  test("contract shape asserted for every delegation outcome", async () => {
    // success
    let r = await ask(makeTool(), { bot: "researcher", message: "hi" });
    expect(r.output).toContain("[delegation contract]");
    expect(r.output).toContain("status: success");
    expect(r.output).toContain("summary: ");
    expect(r.output).toContain("sidecar:");
    expect(r.output).toContain("diff_summary:");

    // budget_exhausted
    const budgetTool = makeTool({
      provider: scriptProvider([
        {
          stopReason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
          usage: { inputTokens: 10_000_000, outputTokens: 0 },
        },
      ]),
    });
    r = await ask(budgetTool, { bot: "researcher", message: "big" });
    expect(r.output).toContain("status: budget_exhausted");

    // no_text (empty end_turn)
    r = await ask(makeTool({ provider: mockProvider("") }), { bot: "researcher", message: "x" });
    expect(r.output).toContain("status: no_text");

    // tree_budget_exceeded
    const tb = new TreeBudget(1, 0);
    const treeTool = makeTool({
      provider: {
        name: "tc",
        async chat() {
          return {
            stopReason: "tool_use",
            content: [{ type: "tool_use", id: "tc", name: "read_file", input: { path: "." } }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      } as unknown as Provider,
    });
    r = await ask(treeTool, { bot: "researcher", message: "m" }, { treeBudget: tb });
    expect(r.output).toContain("status: tree_budget_exceeded");
    expect(r.output).toContain("shared tree budget exhausted");
  });

  test("sidecar written; its full content ABSENT from parent prompt assembly", async () => {
    const provider = mockProvider(LONG_OUTPUT);
    const r = await ask(makeTool({ provider }), { bot: "researcher", message: "long job" });

    // contract summary is bounded — the tail beyond the cap is NOT inline
    expect(r.output).not.toContain(LONG_OUTPUT_TAIL);
    expect(r.output.length).toBeLessThan(CONTRACT_SUMMARY_MAX_CHARS + 1000);

    // sidecar file exists and holds the FULL detail
    const files = sidecarFiles();
    expect(files).toHaveLength(1);
    const full = readFileSync(join(delegationArtifactsDir(home), files[0]!), "utf8");
    expect(full).toContain(LONG_OUTPUT_TAIL);
    // the parent transcript references the sidecar path so it can read on demand
    expect(r.output).toMatch(/sidecar: \S+\.md/);
  });

  test("parent context stays bounded across k=5 sequential delegations (O(n) assert)", async () => {
    const provider = mockProvider(LONG_OUTPUT);
    const tool = makeTool({ provider });
    let totalInline = 0;
    for (let i = 0; i < 5; i++) {
      const r = await ask(tool, { bot: "researcher", message: `task ${i}` });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("status: success");
      // each contract is bounded regardless of the subagent's large output
      expect(r.output.length).toBeLessThan(CONTRACT_SUMMARY_MAX_CHARS + 1000);
      totalInline += r.output.length;
    }
    // 5 bounded contracts, not 5 full outputs — linear, not k*n
    expect(totalInline).toBeLessThan(5 * (CONTRACT_SUMMARY_MAX_CHARS + 1000));
    // every full detail lives in a sidecar (5 artifacts)
    expect(sidecarFiles()).toHaveLength(5);
  });

  test("subagent first prompt contains handoff brief only (no parent history)", async () => {
    const provider = mockProvider("ok");
    const tool = makeTool({ provider });
    await ask(tool, { bot: "researcher", message: "what is auth.ts doing?" });

    const req = provider.requests[0];
    expect(req).toBeDefined();
    // exactly one USER message — the handoff brief — and it is the FIRST
    // message (no parent transcript precedes it)
    const msgs = req?.messages ?? [];
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toBe("what is auth.ts doing?");
    // no earlier user message carries any parent context
    expect(msgs.filter((m: any) => m.role === "user")).toHaveLength(1);
    // the subagent gets its own system definition, not the parent's
    expect(req?.system).toContain("You are researcher. Be terse.");
  });
});
