// MCP server that answers initialize + tools/list but never answers tools/call.
// Used to prove the client's per-call timeout kills and reaps the hung child.
const readline = require("node:readline");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

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
      result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "hang", version: "1" } },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{ name: "stall", description: "never responds", inputSchema: { type: "object", properties: {} } }],
      },
    });
  }
  // tools/call: deliberately no response.
});
