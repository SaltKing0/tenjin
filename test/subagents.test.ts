import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDef } from "../src/tools/registry";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig, ProviderName } from "../src/config/types";
import {
  validateSubagentRole,
  roleToolset,
  roleModelRef,
  runSubagent,
  EXPLORE_ROLE,
  GENERAL_PURPOSE_ROLE,
  BUILTIN_ROLES,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  isWriteTool,
  PLAN_VETO_MESSAGE,
} from "../src/bots/subagents";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-subagent-"));
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

function tool(name: string): ToolDef {
  return {
    name,
    group: isWriteTool(name) ? "write" : "read",
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => "ok",
  };
}
/** All read + write tool names so every built-in role's allowlist validates. */
const KNOWN_TOOLS: ToolDef[] = [
  ...[...READ_TOOL_NAMES].map(tool),
  ...[...WRITE_TOOL_NAMES].map(tool),
];

function mockProvider(reply: string): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "mock",
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

describe("B11-1 schema validation rejects bad definitions at definition time", () => {
  test("missing fields are rejected", () => {
    expect(() => validateSubagentRole({ name: "x", systemPrompt: "p", tools: ["read_file"] })).toThrow(/missing an id/);
    expect(() => validateSubagentRole({ id: "a", systemPrompt: "p", tools: ["read_file"] })).toThrow(/missing a name/);
    expect(() => validateSubagentRole({ id: "a", name: "A", tools: ["read_file"] })).toThrow(/missing a systemPrompt/);
    expect(() => validateSubagentRole({ id: "a", name: "A", systemPrompt: "p" })).toThrow(/tools/);
    expect(() => validateSubagentRole({ id: "a", name: "A", systemPrompt: "p", tools: [] })).toThrow(/at least one tool/);
  });

  test("unknown tools are rejected", () => {
    expect(() =>
      validateSubagentRole(
        { id: "a", name: "A", systemPrompt: "p", tools: ["read_file", "not_a_tool"] },
        { knownTools: KNOWN_TOOLS.map((t) => t.name) },
      ),
    ).toThrow(/unknown tool/);
  });

  test("bad budget is rejected", () => {
    expect(() =>
      validateSubagentRole({
        id: "a",
        name: "A",
        systemPrompt: "p",
        tools: ["read_file"],
        budget: { capUSD: -1 },
      }),
    ).toThrow(/invalid budget/);
  });
});

describe("B11-1 Explore role cannot hold write tools (toolset enforced)", () => {
  test("the built-in Explore role is read-only and never allows a write tool", () => {
    expect(EXPLORE_ROLE.permissions?.write).toBe(false);
    const toolset = roleToolset(EXPLORE_ROLE, KNOWN_TOOLS);
    expect(toolset.length).toBeGreaterThan(0);
    expect(toolset.some((t) => isWriteTool(t.name))).toBe(false);
    // every allowlisted tool is a read tool
    for (const t of toolset) expect(READ_TOOL_NAMES.has(t.name)).toBe(true);
  });

  test("a read-only role that lists a write tool is rejected at definition", () => {
    expect(() =>
      validateSubagentRole({
        id: "explore",
        name: "Explore",
        systemPrompt: "research only",
        tools: ["read_file", "write_file"],
        permissions: { write: false },
      }),
    ).toThrow(/read-only but allows write tool/);
  });

  test("general-purpose role holds the full toolset including write tools", () => {
    expect(GENERAL_PURPOSE_ROLE.permissions?.write).toBe(true);
    const names = roleToolset(GENERAL_PURPOSE_ROLE, KNOWN_TOOLS).map((t) => t.name);
    expect(names.length).toBe(READ_TOOL_NAMES.size + WRITE_TOOL_NAMES.size);
    expect(names.some(isWriteTool)).toBe(true);
    expect(BUILTIN_ROLES["explore"]).toBeDefined();
    expect(BUILTIN_ROLES["general-purpose"]).toBeDefined();
  });
});

describe("B11-1 Plan-style role definition is rejected (veto)", () => {
  test("a role that smells like a Plan role is rejected with the veto pointer", () => {
    try {
      validateSubagentRole({
        id: "planner",
        name: "Plan architect",
        systemPrompt: "You produce a detailed plan before any work.",
        tools: ["read_file"],
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("vetoed");
      expect((e as Error).message).toContain("#25/#45");
    }
    // the constant carries the pointer to the veto
    expect(PLAN_VETO_MESSAGE).toContain("tasks + delegation");
  });
});

describe("B11-1 definition feeds delegation end-to-end (one mocked turn)", () => {
  test("runSubagent runs a headless turn and returns a bounded contract + sidecar", async () => {
    const provider = mockProvider("I explored and found X.");
    const deps = {
      home,
      cwd: home,
      getProvider: (name: ProviderName) => provider,
      globalConfig: globalConfig(),
      knownTools: KNOWN_TOOLS,
    };
    const contract = await runSubagent(deps, EXPLORE_ROLE, "find the answer");

    expect(provider.requests.length).toBe(1);
    expect(contract.status).toBe("success");
    expect(contract.target).toBe("explore");
    expect(contract.costUSD).toBeGreaterThanOrEqual(0);
    expect(contract.summary).toContain("I explored and found X.");
    // context firewall: full output persisted to a sidecar, contract is bounded
    expect(contract.sidecarPath).toBeDefined();
    expect(existsSync(contract.sidecarPath!)).toBe(true);
    // the model ref defaults to the cheap model for a read-only role
    const ref = roleModelRef(EXPLORE_ROLE, globalConfig());
    expect(ref.model).toBeTruthy();
  });

  test("invalid definition aborts the delegation before any turn", async () => {
    const provider = mockProvider("x");
    const deps = {
      home,
      cwd: home,
      getProvider: (name: ProviderName) => provider,
      globalConfig: globalConfig(),
      knownTools: KNOWN_TOOLS,
    };
    await expect(
      runSubagent(deps, { ...EXPLORE_ROLE, id: "explore", tools: ["write_file"] }, "msg"),
    ).rejects.toThrow(/read-only but allows write tool/);
    expect(provider.requests.length).toBe(0); // nothing ran
  });
});
