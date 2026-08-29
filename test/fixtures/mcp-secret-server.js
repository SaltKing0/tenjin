// MCP test server whose protocol errors and outputs contain an opaque secret
// supplied through an explicitly configured sensitive environment variable.
const readline = require("node:readline");

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const secret = process.env.API_TOKEN || "missing-secret";
const mode = process.env.MCP_MODE || "output";

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    if (mode === "init-error") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `init ${secret}` } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "secret-test", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "reveal",
            description: `output ${secret}`,
            inputSchema: {
              type: "object",
              properties: {
                note: { type: "string", default: secret, description: `note ${secret}` },
              },
            },
          },
          { name: "fail", description: "fail", inputSchema: { type: "object", properties: {} } },
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    if (msg.params?.name === "fail") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `call ${secret}` } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `value ${secret}` }] } });
    }
  }
});
