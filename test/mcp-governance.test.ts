import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpTools, closeAllMcpClients } from "../src/tools/mcp";
import type { McpServerConfig } from "../src/tools/mcp";
import type { HarnessConfig } from "../src/config/types";
import { dispatch } from "../src/tools/registry";
import { SecurityGuard } from "../src/security/guard";
import { Redactor } from "../src/security/redact";

// #347: MCP governance routing — untrusted by default.
// Risk grades, guard deny-list, output redaction, per-call budget, flag audit.

const FIX = join(import.meta.dir, "fixtures");
const BUN = process.execPath;

function serverCfg(
  name: string,
  extra: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    name,
    command: BUN,
    args: [join(FIX, "mcp-fs-server.js")],
    scope: "local",
    enabled: true,
    ...extra,
  };
}

function harness(mcp: unknown): HarnessConfig {
  return { mcp } as unknown as HarnessConfig;
}

afterEach(() => closeAllMcpClients());

describe("MCP risk grades", () => {
  test("default server tools are write-grade (require approval); readOnly -> read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-grade-"));
    try {
      const writeTools = await createMcpTools(
        harness({ servers: [serverCfg("demo", { env: { MCP_FS_ROOT: dir } })] }),
      );
      const read = writeTools.find((t) => t.name === "mcp__demo__read_file")!;
      expect(read.group).toBe("write"); // untrusted default: requires approval

      const roTools = await createMcpTools(
        harness({ servers: [serverCfg("rodemo", { readOnly: true, env: { MCP_FS_ROOT: dir } })] }),
      );
      const roRead = roTools.find((t) => t.name === "mcp__rodemo__read_file")!;
      expect(roRead.group).toBe("read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP guard deny-list", () => {
  test("guard blocks a denied MCP tool with a clean message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-guard-"));
    try {
      const tools = await createMcpTools(
        harness({ servers: [serverCfg("demo", { env: { MCP_FS_ROOT: dir } })] }),
      );
      const guard = new SecurityGuard([], undefined, {
        mcpDenyPatterns: ["*read_file*"],
      });
      const r = await dispatch(
        tools,
        "mcp__demo__read_file",
        { path: "hello.txt" },
        { cwd: dir, guard },
      );
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/denied by security policy/i);
      expect(r.output).not.toContain("at ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-denied MCP tool passes the guard and runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-guard-ok-"));
    writeFileSync(join(dir, "hello.txt"), "hi\n");
    try {
      const tools = await createMcpTools(
        harness({ servers: [serverCfg("demo", { env: { MCP_FS_ROOT: dir } })] }),
      );
      const guard = new SecurityGuard([], undefined, {
        mcpDenyPatterns: ["*danger*"], // does not match read_file
      });
      const r = await dispatch(
        tools,
        "mcp__demo__read_file",
        { path: "hello.txt" },
        { cwd: dir, guard },
      );
      expect(r.ok).toBe(true);
      expect(r.output).toContain("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP output redaction", () => {
  test("redaction fires on secret-bearing output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-redact-"));
    writeFileSync(join(dir, "secret.txt"), "token sk-abc123XYZ\n");
    try {
      const tools = await createMcpTools(
        harness({ servers: [serverCfg("demo", { env: { MCP_FS_ROOT: dir } })] }),
        { redactor: new Redactor(true) },
      );
      const tool = tools.find((t) => t.name === "mcp__demo__read_file")!;
      const out = await tool.handler({ path: "secret.txt" }, { cwd: dir });
      expect(out).not.toContain("sk-abc123XYZ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP per-call budget", () => {
  test("budget counter decrements on each MCP call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-budget-"));
    writeFileSync(join(dir, "a.txt"), "a\n");
    try {
      let calls = 0;
      const tools = await createMcpTools(
        harness({ servers: [serverCfg("demo", { env: { MCP_FS_ROOT: dir } })] }),
        { budget: { consume: () => { calls += 1; return true; } } },
      );
      const tool = tools.find((t) => t.name === "mcp__demo__read_file")!;
      await tool.handler({ path: "a.txt" }, { cwd: dir });
      await tool.handler({ path: "a.txt" }, { cwd: dir });
      expect(calls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exhausted budget halts the MCP call with a clean message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-budget-halt-"));
    writeFileSync(join(dir, "a.txt"), "a\n");
    try {
      const tools = await createMcpTools(
        harness({ servers: [serverCfg("demo", { env: { MCP_FS_ROOT: dir } })] }),
        { budget: { consume: () => false } },
      );
      const tool = tools.find((t) => t.name === "mcp__demo__read_file")!;
      await expect(
        tool.handler({ path: "a.txt" }, { cwd: dir }),
      ).rejects.toThrow(/budget exhausted/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flag audit (G6)", () => {
  test("empty config -> no tools, zero behavior change", async () => {
    expect(await createMcpTools({} as HarnessConfig)).toEqual([]);
  });
});
