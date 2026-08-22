import { describe, test, expect } from "bun:test";
import {
  McpServer,
  McpExposedTool,
  UNTRUSTED_MARKER,
  MCP_PROTOCOL_VERSION,
} from "../src/mcp-server";

function makeServer(
  dispatch = async (name: string, args: Record<string, unknown>) => ({
    ok: true as const,
    value: `${name}:${JSON.stringify(args)}`,
  }),
  allowlist: McpExposedTool[] = [
    { name: "read_file", description: "Read a file", inputSchema: { properties: { path: {} }, required: ["path"] } },
    { name: "write_file", description: "Write a file" },
  ],
  hooks = {},
) {
  return new McpServer(dispatch, allowlist, hooks);
}

async function call(server: McpServer, frame: object): Promise<any> {
  const line = await server.handleLine(JSON.stringify(frame));
  return line === null ? null : JSON.parse(line);
}

describe("MCP server handshake + allowlist", () => {
  test("initialize handshake returns server info + capabilities", async () => {
    const res = await call(makeServer(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "client", version: "1" } },
    });
    expect(res.id).toBe(1);
    expect(res.error).toBeUndefined();
    expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(res.result.serverInfo.name).toBe("tenjin");
  });

  test("tools/list shows ONLY allowlisted tools", async () => {
    const res = await call(makeServer(), { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["read_file", "write_file"]);
    // A non-allowlisted native tool is invisible.
    expect(names).not.toContain("bash");
  });

  test("notifications are ignored (no response emitted)", async () => {
    const res = await call(makeServer(), { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    expect(res).toBeNull();
  });
});

describe("remote tool call dispatch", () => {
  test("tools/call executes through dispatch and wraps result as untrusted", async () => {
    const s = makeServer();
    const res = await call(s, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "x" } },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.content[0].text).toContain(UNTRUSTED_MARKER);
    expect(res.result.content[0].text).toContain("read_file");
  });

  test("non-allowlisted tool is invisible AND uncallable", async () => {
    const s = makeServer();
    const list = await call(s, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(list.result.tools.map((t: any) => t.name)).not.toContain("bash");

    const res = await call(s, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(-32602);
  });

  test("guard + budget hooks gate the remote call before dispatch", async () => {
    let dispatchCalls = 0;
    const s = new McpServer(
      async () => {
        dispatchCalls++;
        return { ok: true as const, value: "ok" };
      },
      [{ name: "write_file", description: "w" }],
      {
        guard: { checkMcpTool: (name: string) => ({ blocked: name === "write_file" }) },
        budget: { consume: () => false },
      },
    );
    // Guard blocks the call — dispatch is never reached.
    const blocked = await call(s, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "write_file", arguments: {} },
    });
    expect(blocked.error).toBeTruthy();
    expect(dispatchCalls).toBe(0);

    // Allowlisted + budget-satisfying call reaches dispatch.
    const s2 = new McpServer(
      async () => {
        dispatchCalls++;
        return { ok: true as const, value: "ran" };
      },
      [{ name: "read_file", description: "r" }],
      { guard: { checkMcpTool: () => ({ blocked: false }) }, budget: { consume: () => true } },
    );
    const ran = await call(s2, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_file", arguments: {} },
    });
    expect(ran.error).toBeUndefined();
    expect(ran.result.content[0].text).toContain(UNTRUSTED_MARKER);
  });
});
