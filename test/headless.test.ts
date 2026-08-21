import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless, toolsForPolicy } from "../src/agent/headless";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
} from "../src/provider/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tj-headless-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

const endTurn = (text: string, usage = { inputTokens: 100, outputTokens: 10 }): ChatResponse => ({
  stopReason: "end_turn",
  content: [{ type: "text", text }],
  usage,
});

test("toolsForPolicy returns expected sets", () => {
  expect(toolsForPolicy("none")).toEqual([]);
  expect(toolsForPolicy("read-only").map((t) => t.name)).toEqual([
    "read_file",
    "glob",
    "grep",
  ]);
});

describe("runHeadless", () => {
  const base = (over: Partial<Parameters<typeof runHeadless>[0]> = {}) => ({
    provider: scriptProvider([endTurn("ok")]),
    model: "claude-sonnet-4-5",
    soulText: "You are test.",
    cwd: dir,
    message: "hello",
    maxTokens: 512,
    capUSD: 1,
    ...over,
  });

  test("returns text, stopReason, cost", async () => {
    const provider = base().provider as ReturnType<typeof scriptProvider>;
    const r = await runHeadless(base({ provider }));
    expect(r.text).toBe("ok");
    expect(r.stopReason).toBe("end_turn");
    expect(r.costUSD).toBeCloseTo((100 * 3 + 10 * 15) / 1_000_000);
  });

  test("policy none sends zero tools", async () => {
    const provider = base().provider as ReturnType<typeof scriptProvider>;
    await runHeadless(base({ provider, policy: "none" }));
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  test("read-only allows reads and denies writes mid-turn", async () => {
    require("node:fs").writeFileSync(join(dir, "sample.txt"), "sample body");
    const provider = scriptProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "sample.txt" } },
          { type: "tool_use", id: "t2", name: "bash", input: { command: "echo hi" } },
        ],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      endTurn("done"),
    ]);
    const r = await runHeadless(base({ provider }));
    expect(r.text).toBe("done");

    const second = provider.requests[1];
    if (!second) throw new Error("missing second request");
    const msgContent = second.messages[2]?.content;
    if (!msgContent || typeof msgContent === "string") {
      throw new Error("expected tool results in second request");
    }
    const blocks = msgContent;
    const readResult = blocks.find((b) => b.type === "tool_result" && b.toolUseId === "t1");
    const bashResult = blocks.find((b) => b.type === "tool_result" && b.toolUseId === "t2");
    if (readResult?.type !== "tool_result" || bashResult?.type !== "tool_result") {
      throw new Error("missing tool results");
    }
    expect(readResult.isError).toBeFalsy();
    expect(readResult.content).toContain("sample body");
    expect(bashResult.isError).toBe(true);
    expect(bashResult.content).toMatch(/Unknown tool|declined/);
    expect(bashResult.content).not.toContain("hi\n");
  });

  test("cap halts runaway turns", async () => {
    const provider = scriptProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
        usage: { inputTokens: 50_000_000, outputTokens: 0 },
      },
    ]);
    const r = await runHeadless(base({ provider, capUSD: 5 }));
    expect(r.stopReason).toBe("budget_exhausted");
    expect(provider.requests).toHaveLength(1);
  });

  test("system prompt carries soul and AGENTS.md", async () => {
    require("node:fs").writeFileSync(join(dir, "AGENTS.md"), "use tabs");
    const provider = base().provider as ReturnType<typeof scriptProvider>;
    await runHeadless(base({ provider, agentsMd: "use tabs" }));
    const system = String(provider.requests[0]?.system);
    expect(system).toContain("You are test.");
    expect(system).toContain("use tabs");
  });
});
