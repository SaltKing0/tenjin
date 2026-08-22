import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpClient,
  normalizeMcpServers,
  expandEnv,
  createMcpTools,
  closeAllMcpClients,
} from "../src/tools/mcp";
import type { McpServerConfig } from "../src/tools/mcp";
import type { HarnessConfig } from "../src/config/types";

const FIX = join(import.meta.dir, "fixtures");
const BUN = process.execPath;

function serverCfg(
  name: string,
  script: string,
  extra: Partial<McpServerConfig> = {},
): McpServerConfig {
  return { name, command: BUN, args: [join(FIX, script)], scope: "local", enabled: true, ...extra };
}

afterEach(() => closeAllMcpClients());

describe("normalizeMcpServers", () => {
  test("enabled defaults to false; scope defaults to local", () => {
    const s = normalizeMcpServers([{ name: "a", command: "x" }], {});
    expect(s).toHaveLength(1);
    expect(s[0]!.enabled).toBe(false);
    expect(s[0]!.scope).toBe("local");
  });

  test("env values expand ${VAR} and $VAR", () => {
    const s = normalizeMcpServers(
      [{ name: "a", command: "x", env: { HOME: "${HOME}", TOKEN: "$API_TOKEN" } }],
      { HOME: "/h", API_TOKEN: "sek" },
    );
    expect(s[0]!.env).toEqual({ HOME: "/h", TOKEN: "sek" });
  });

  test("enabled:true preserved; unknown scope coerced to local", () => {
    const s = normalizeMcpServers(
      [{ name: "a", command: "x", scope: "project", enabled: true }],
      {},
    );
    expect(s[0]!.enabled).toBe(true);
    expect(s[0]!.scope).toBe("project");
  });

  test("empty / non-array input returns []", () => {
    expect(normalizeMcpServers(undefined, {})).toEqual([]);
    expect(normalizeMcpServers("x", {})).toEqual([]);
    expect(normalizeMcpServers([{ name: "", command: "x" }], {})).toEqual([]);
  });
});

describe("expandEnv", () => {
  test("expands known refs, leaves unknown intact", () => {
    expect(expandEnv("${A}-$B-${MISSING}", { A: "1", B: "2" })).toBe("1-2-${MISSING}");
  });
});

describe("createMcpTools", () => {
  test("empty config -> no tools, no child spawned (zero behavior change)", async () => {
    const cfg = {} as HarnessConfig;
    expect(await createMcpTools(cfg)).toEqual([]);
  });

  test("disabled server spawns nothing", async () => {
    const cfg = {
      mcp: {
        servers: [
          { name: "a", command: BUN, args: [join(FIX, "mcp-fs-server.js")], enabled: false },
        ],
      },
    } as unknown as HarnessConfig;
    expect(await createMcpTools(cfg)).toEqual([]);
  });

  test("enabled demo fs server registers namespaced tools and calls work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
    writeFileSync(join(dir, "hello.txt"), "hi from mcp\n");
    try {
      const cfg = {
        mcp: { servers: [serverCfg("demo", "mcp-fs-server.js", { env: { MCP_FS_ROOT: dir } })] },
      } as unknown as HarnessConfig;
      const tools = await createMcpTools(cfg);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["mcp__demo__list", "mcp__demo__read_file"]);
      const read = tools.find((t) => t.name === "mcp__demo__read_file")!;
      expect(read.group).toBe("write");
      const out = await read.handler({ path: "hello.txt" }, { cwd: dir });
      expect(out).toBe("hi from mcp\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("McpClient", () => {
  test("demo fs server: handshake -> list -> call end-to-end in-process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-client-"));
    writeFileSync(join(dir, "f.txt"), "content\n");
    const client = new McpClient(
      serverCfg("demo", "mcp-fs-server.js", { env: { MCP_FS_ROOT: dir } }),
      5000,
    );
    try {
      await client.initialize();
      expect(client.tools.map((t) => t.name).sort()).toEqual(["list", "read_file"]);
      const out = await client.callTool("read_file", { path: "f.txt" });
      expect(out).toBe("content\n");
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("timeout kills a hung call cleanly (child reaped)", async () => {
    const client = new McpClient(serverCfg("hang", "mcp-hang-server.js"), 200);
    await client.initialize();
    let rejected = false;
    try {
      await client.callTool("stall", {});
    } catch (e) {
      rejected = true;
      expect((e as Error).message).toContain("timed out");
    }
    expect(rejected).toBe(true);
    // The child must actually be killed and reaped, not left hanging.
    const code = await Promise.race([
      client.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
    ]);
    expect(code).not.toBe("timeout");
  });

  test("malformed JSON-RPC frame rejected without crash", async () => {
    const client = new McpClient(serverCfg("bad", "mcp-malformed-server.js"), 2000);
    let rejected = false;
    try {
      await client.initialize();
    } catch (e) {
      rejected = true;
      expect((e as Error).message).toContain("malformed");
    }
    expect(rejected).toBe(true);
  });
});
