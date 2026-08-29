import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless, toolsForPolicy, capPolicy, applyDenyTools } from "../src/agent/headless";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
} from "../src/provider/types";
import type { ToolDef } from "../src/tools/registry";

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

function writeSkill(home: string, name: string, description: string, body: string): void {
  const skillDir = join(home, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`,
  );
}

test("toolsForPolicy returns expected sets", () => {
  expect(toolsForPolicy("none")).toEqual([]);
  expect(toolsForPolicy("read-only").map((t) => t.name)).toEqual([
    "read_file",
    "glob",
    "grep",
    "web_fetch",
  ]);
  expect(toolsForPolicy("full").map((t) => t.name)).toEqual([
    "read_file",
    "glob",
    "grep",
    "write_file",
    "edit_file",
    "apply_patch",
    "bash",
    "web_fetch",
    "browser",
  ]);
});

test("capPolicy never upgrades and can only tighten", () => {
  expect(capPolicy("full", "read-only")).toBe("read-only");
  expect(capPolicy("read-only", "full")).toBe("read-only");
  expect(capPolicy("full", "none")).toBe("none");
  expect(capPolicy("full", undefined)).toBe("full");
  expect(capPolicy("read-only", "none")).toBe("none");
});

test("applyDenyTools strips named tools so a bot is stricter than global full policy", () => {
  const full = toolsForPolicy("full");
  const denied = applyDenyTools(full, ["bash", "write_file"]);
  expect(denied.map((t) => t.name)).toEqual(["read_file", "glob", "grep", "edit_file", "apply_patch", "web_fetch", "browser"]);
  expect(applyDenyTools(full, undefined).map((t) => t.name)).toEqual(full.map((t) => t.name));
});

test("toolsForPolicy adds use_skill/list_skills/save_skill by policy when skill dirs are given", () => {
  const skill = { home: dir, projectDir: dir };
  expect(toolsForPolicy("none", skill)).toEqual([]);
  expect(toolsForPolicy("read-only", skill).map((t) => t.name)).toEqual([
    "read_file",
    "glob",
    "grep",
    "web_fetch",
    "use_skill",
    "list_skills",
  ]);
  expect(toolsForPolicy("full", skill).map((t) => t.name)).toEqual([
    "read_file",
    "glob",
    "grep",
    "write_file",
    "edit_file",
    "apply_patch",
    "bash",
    "web_fetch",
    "browser",
    "use_skill",
    "list_skills",
    "save_skill",
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
    expect(system).not.toContain("# Facts");
    expect(system).not.toContain("# Skills");
    expect(system).not.toContain("# Memory —");
  });

  test("session log redacts secrets in tool output", async () => {
    require("node:fs").writeFileSync(
      join(dir, "note.txt"),
      "OPENAI_API_KEY=sk-abc1234567890xyz\n",
    );
    const provider = scriptProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "note.txt" } },
        ],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      endTurn("done"),
    ]);
    await runHeadless(base({ provider, sessionLogDir: join(dir, "sessions") }));

    const file = require("node:fs")
      .readdirSync(join(dir, "sessions"))
      .find((f: string) => f.endsWith(".jsonl"));
    expect(file).toBeTruthy();
    const raw = require("node:fs").readFileSync(
      join(dir, "sessions", file as string),
      "utf8",
    );
    expect(raw).not.toContain("sk-abc1234567890xyz");
    expect(raw).toContain("[REDACTED]");
  });

  test("session log leaves non-secret output intact", async () => {
    require("node:fs").writeFileSync(join(dir, "plain.txt"), "just a normal note\n");
    const provider = scriptProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "plain.txt" } },
        ],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      endTurn("done"),
    ]);
    await runHeadless(base({ provider, sessionLogDir: join(dir, "sessions") }));

    const file = require("node:fs")
      .readdirSync(join(dir, "sessions"))
      .find((f: string) => f.endsWith(".jsonl"));
    expect(file).toBeTruthy();
    const raw = require("node:fs").readFileSync(
      join(dir, "sessions", file as string),
      "utf8",
    );
    expect(raw).toContain("just a normal note");
  });

  test("facts.md from memoryDir lands in the system prompt", async () => {
    const memoryDir = join(dir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "facts.md"), "- [2026-08-21] prefers bun over node\n");
    const provider = base().provider as ReturnType<typeof scriptProvider>;
    await runHeadless(base({ provider, memoryDir }));
    const system = String(provider.requests[0]?.system);
    expect(system).toContain("# Facts");
    expect(system).toContain("prefers bun over node");
  });

  test("session summaries matching cwd are injected via buildMemorySection", async () => {
    const memoryDir = join(dir, "memory");
    mkdirSync(join(memoryDir, "summaries"), { recursive: true });
    writeFileSync(
      join(memoryDir, "summaries", "sess1.md"),
      [
        "---",
        "sessionId: sess1",
        `projectPath: ${JSON.stringify(dir)}`,
        "uptoEvent: 4",
        "created: 2026-08-21T09:00:00Z",
        "---",
        "shipped the auth rewrite",
        "",
      ].join("\n"),
    );
    const provider = base().provider as ReturnType<typeof scriptProvider>;
    await runHeadless(base({ provider, memoryDir }));
    const system = String(provider.requests[0]?.system);
    expect(system).toContain("# Memory — recent sessions in this project");
    expect(system).toContain("shipped the auth rewrite");
  });

  test("runtime disclosure index lists active tools and skills; use_skill loads the body", async () => {
    const home = join(dir, "home");
    writeSkill(home, "bun-testing", "How bun tests work", "Always run bun test.");
    const provider = scriptProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "use_skill", input: { name: "bun-testing" } },
        ],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      endTurn("loaded"),
    ]);
    const r = await runHeadless(base({ provider, home, policy: "read-only" }));
    expect(r.text).toBe("loaded");

    const first = provider.requests[0];
    expect(first?.tools.map((t) => t.name)).toContain("use_skill");
    expect(first?.tools.map((t) => t.name)).not.toContain("save_skill");
    const system = String(first?.system);
    expect(system).toContain("# Tools");
    expect(system).toContain("- read_file:");
    expect(system).toContain("- use_skill:");
    expect(system).not.toContain("- save_skill:");
    expect(system).toContain("# Skills");
    expect(system).toContain("- bun-testing: How bun tests work");
    expect(system).not.toContain("Always run bun test.");

    const second = provider.requests[1];
    if (!second) throw new Error("missing second request");
    const msgContent = second.messages[2]?.content;
    if (!msgContent || typeof msgContent === "string") {
      throw new Error("expected tool results in second request");
    }
    const skillResult = msgContent.find((b) => b.type === "tool_result" && b.toolUseId === "t1");
    if (skillResult?.type !== "tool_result") throw new Error("missing use_skill result");
    expect(skillResult.isError).toBeFalsy();
    expect(skillResult.content).toContain("Always run bun test.");
  });

  test("runtime disclosure index follows the final deny list and omits schema internals", async () => {
    const probe: ToolDef = {
      name: "runtime_probe",
      group: "read",
      description: "Visible first line\nHidden second line",
      inputSchema: {
        type: "object",
        properties: { hidden_schema_field: { type: "string" } },
        required: ["hidden_schema_field"],
      },
      async handler() {
        return "ok";
      },
    };
    const provider = base().provider as ReturnType<typeof scriptProvider>;
    await runHeadless(base({ provider, policy: "full", denyTools: ["bash"], extraTools: [probe] }));

    const first = provider.requests[0];
    expect(first?.tools.map((tool) => tool.name)).toContain("runtime_probe");
    expect(first?.tools.map((tool) => tool.name)).not.toContain("bash");
    const system = String(first?.system);
    expect(system).toContain("- runtime_probe: Visible first line");
    expect(system).not.toContain("Hidden second line");
    expect(system).not.toContain("hidden_schema_field");
    expect(system).not.toContain("- bash:");
  });

  test("full policy exposes save_skill; none exposes neither skill tool", async () => {
    const home = join(dir, "home");
    writeSkill(home, "policy-skill", "Only when activation is available", "Policy body.");
    const fullProvider = base().provider as ReturnType<typeof scriptProvider>;
    await runHeadless(base({ provider: fullProvider, home, policy: "full" }));
    expect(fullProvider.requests[0]?.tools.map((t) => t.name)).toContain("save_skill");
    expect(fullProvider.requests[0]?.tools.map((t) => t.name)).toContain("use_skill");
    expect(String(fullProvider.requests[0]?.system)).toContain("- policy-skill:");

    const noneProvider = scriptProvider([endTurn("ok")]);
    await runHeadless(base({ provider: noneProvider, home, policy: "none" }));
    expect(noneProvider.requests[0]?.tools).toEqual([]);
    expect(String(noneProvider.requests[0]?.system)).not.toContain("policy-skill");
  });

  test("globalBudget reached halts before the provider is called", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "sessions"), { recursive: true });
    // Seed a session that already blows past the daily cap.
    const now = new Date();
    writeFileSync(
      join(home, "sessions", "seed.jsonl"),
      JSON.stringify({ t: "session_start", id: "seed", ts: now.toISOString(), provider: "a", model: "m" }) +
        "\n" +
        JSON.stringify({ t: "usage", inputTokens: 1000, outputTokens: 0, costUSD: 2.0, spentUSD: 2.0, ts: now.toISOString() }) +
        "\n",
    );
    const provider = base().provider as ReturnType<typeof scriptProvider>;
    const r = await runHeadless(
      base({
        provider,
        home,
        globalBudget: { dailyUSD: 0.5 },
      }),
    );
    expect(r.stopReason).toBe("budget_exhausted");
    expect(provider.requests).toHaveLength(0);
  });
});
