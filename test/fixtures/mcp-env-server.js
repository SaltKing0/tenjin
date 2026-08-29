// Minimal MCP server that exposes its environment for child-boundary tests.
const readline = require("node:readline");

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const tool = {
  name: "inspect_env",
  description: "Return the MCP child environment",
  inputSchema: { type: "object", properties: {} },
};

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
        serverInfo: { name: "env-test", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [tool] } });
  } else if (msg.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify(process.env) }] },
    });
  }
});
