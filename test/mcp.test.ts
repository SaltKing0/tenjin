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
import { Redactor } from "../src/security/redact";

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

  test("non-boolean flags fail closed instead of coercing strings", () => {
    const [disabled] = normalizeMcpServers(
      [{ name: "a", command: "x", enabled: "false", readOnly: "true" }],
      {},
    );
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.readOnly).toBe(false);

    const [writeGrade] = normalizeMcpServers(
      [{ name: "b", command: "x", enabled: true, readOnly: "false" }],
      {},
    );
    expect(writeGrade?.enabled).toBe(true);
    expect(writeGrade?.readOnly).toBe(false);
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

  test("rejects an invalid server name before spawning its command", async () => {
    const warnings: string[] = [];
    const cfg = {
      mcp: {
        servers: [serverCfg("bad server name", "does-not-exist.js")],
      },
    } as unknown as HarnessConfig;
    expect(await createMcpTools(cfg, { warn: (message) => warnings.push(message) })).toEqual([]);
    expect(warnings).toEqual(["[mcp] skipped a server with an invalid name"]);
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

  test("MCP child inherits safe base variables plus only explicitly configured env", async () => {
    const hostEnv = {
      PATH: process.env.PATH,
      LANG: "C",
      HOME: "/host/home",
      OPENAI_API_KEY: "provider-secret",
      TELEGRAM_BOT_TOKEN: "channel-secret",
      EXPLICIT_SOURCE: "granted-value",
    };
    const cfg = {
      mcp: {
        servers: [
          serverCfg("env", "mcp-env-server.js", {
            env: {
              MCP_ALLOWED: "$EXPLICIT_SOURCE",
              OPENAI_API_KEY: "$OPENAI_API_KEY",
            },
          }),
        ],
      },
    } as unknown as HarnessConfig;

    const tools = await createMcpTools(cfg, { hostEnv });
    const inspect = tools.find((t) => t.name === "mcp__env__inspect_env")!;
    const output = await inspect.handler({}, { cwd: process.cwd() });
    const childEnv = JSON.parse(output) as Record<string, string>;

    expect(childEnv.LANG).toBe("C");
    expect(childEnv.MCP_ALLOWED).toBe("granted-value");
    // The credential reaches this one child because the server explicitly
    // names it, but is masked again at the MCP output boundary.
    expect(childEnv.OPENAI_API_KEY).toBe("[REDACTED]");
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(childEnv.EXPLICIT_SOURCE).toBeUndefined();
    expect(childEnv.HOME).toBeUndefined();
  });

  test("redaction:false exposes explicitly configured values by request", async () => {
    const secret = "opaque-provider-secret";
    const cfg = {
      mcp: {
        servers: [
          serverCfg("env", "mcp-env-server.js", {
            env: { OPENAI_API_KEY: "$OPENAI_API_KEY" },
          }),
        ],
      },
    } as unknown as HarnessConfig;
    const tools = await createMcpTools(cfg, {
      hostEnv: { PATH: process.env.PATH, OPENAI_API_KEY: secret },
      redactor: new Redactor(false),
    });
    const inspect = tools.find((t) => t.name === "mcp__env__inspect_env")!;
    const output = await inspect.handler({}, { cwd: process.cwd() });
    expect(JSON.parse(output).OPENAI_API_KEY).toBe(secret);
  });

  test("initialization warnings redact opaque sensitive env values by default", async () => {
    const secret = "opaque-init-warning-secret";
    const warnings: string[] = [];
    const cfg = {
      mcp: {
        servers: [
          serverCfg("secret", "mcp-secret-server.js", {
            env: { API_TOKEN: secret, MCP_MODE: "init-error" },
          }),
        ],
      },
    } as unknown as HarnessConfig;

    expect(await createMcpTools(cfg, { warn: (message) => warnings.push(message) })).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[REDACTED]");
    expect(warnings[0]).not.toContain(secret);
  });

  test("remote input schema metadata is redacted before registration", async () => {
    const secret = "opaque-schema-secret";
    const cfg = {
      mcp: {
        servers: [
          serverCfg("secret", "mcp-secret-server.js", { env: { API_TOKEN: secret } }),
        ],
      },
    } as unknown as HarnessConfig;

    const tools = await createMcpTools(cfg);
    const reveal = tools.find((tool) => tool.name === "mcp__secret__reveal")!;
    const schema = JSON.stringify(reveal.inputSchema.properties);
    expect(schema).toContain("[REDACTED]");
    expect(schema).not.toContain(secret);
  });

  test("skips hostile runtime names and malformed schemas without leaking metadata", async () => {
    const secret = "opaque-hostile-schema-secret";
    const cfg = {
      mcp: {
        servers: [
          serverCfg("hostile", "mcp-hostile-schema-server.js", {
            env: { API_TOKEN: secret },
          }),
        ],
      },
    } as unknown as HarnessConfig;

    const tools = await createMcpTools(cfg);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__hostile__safe_tool"]);
    const serialized = JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })));
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(secret);
    expect(tools[0]?.inputSchema.required).toEqual(["note"]);
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

  test("drains a chatty server's stderr so initialization cannot deadlock", async () => {
    const client = new McpClient(serverCfg("stderr", "mcp-stderr-server.js"), 3000);
    try {
      await client.initialize();
      expect(client.tools).toEqual([]);
    } finally {
      client.close();
    }
  });

  test("rejects an oversized unterminated frame with a neutral error", async () => {
    const client = new McpClient(serverCfg("oversized", "mcp-oversized-server.js"), 3000);
    try {
      await expect(client.initialize()).rejects.toThrow("oversized JSON-RPC frame");
    } finally {
      client.close();
    }
  });

  test("outputs and call errors redact opaque sensitive env values by default", async () => {
    const secret = "opaque-mcp-call-secret";
    const client = new McpClient(
      serverCfg("secret", "mcp-secret-server.js", { env: { API_TOKEN: secret } }),
      2000,
    );
    try {
      await client.initialize();
      const description = client.tools.find((tool) => tool.name === "reveal")?.description ?? "";
      expect(description).toContain("[REDACTED]");
      expect(description).not.toContain(secret);
      const out = await client.callTool("reveal", {});
      expect(out).toBe("value [REDACTED]");
      await expect(client.callTool("fail", {})).rejects.toThrow("call [REDACTED]");
    } finally {
      client.close();
    }
  });

  test("disabled redaction keeps MCP call output unchanged", async () => {
    const secret = "opaque-disabled-secret";
    const client = new McpClient(
      serverCfg("secret", "mcp-secret-server.js", { env: { API_TOKEN: secret } }),
      2000,
      process.env,
      new Redactor(false),
    );
    try {
      await client.initialize();
      expect(await client.callTool("reveal", {})).toContain(secret);
    } finally {
      client.close();
    }
  });

  test("client exposes only bounded, valid runtime tool specs", async () => {
    const secret = "opaque-client-schema-secret";
    const client = new McpClient(
      serverCfg("hostile", "mcp-hostile-schema-server.js", { env: { API_TOKEN: secret } }),
      2000,
    );
    try {
      await client.initialize();
      expect(client.tools.map((tool) => tool.name)).toEqual(["safe_tool"]);
      expect(JSON.stringify(client.tools)).not.toContain(secret);
    } finally {
      client.close();
    }
  });
});
