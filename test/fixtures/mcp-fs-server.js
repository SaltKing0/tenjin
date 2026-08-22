// Minimal MCP demo filesystem server used by test/mcp.test.ts.
// Speaks newline-framed JSON-RPC 2.0 over stdio, with no deps.
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.MCP_FS_ROOT || process.cwd();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file from the MCP sandbox root",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list",
    description: "List a directory under the MCP sandbox root",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string" } },
    },
  },
];

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "demo-fs", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "read_file") {
      const p = path.join(root, args.path);
      try {
        const text = fs.readFileSync(p, "utf8");
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e.message) } });
      }
    } else if (name === "list") {
      const d = path.join(root, args.dir || ".");
      try {
        const entries = fs.readdirSync(d).join("\n");
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: entries }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e.message) } });
      }
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } });
    }
  }
  // notifications/initialized: no response
});
