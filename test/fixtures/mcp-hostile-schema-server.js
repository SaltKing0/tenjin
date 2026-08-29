// MCP test server advertising hostile/malformed tools/list metadata. Only
// `safe_tool` should survive the client's provider-schema boundary.
const readline = require("node:readline");

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const secret = process.env.API_TOKEN || "opaque-schema-key-secret";
let tooDeepProperty = { type: "string" };
for (let i = 0; i < 12; i++) {
  tooDeepProperty = { type: "object", properties: { next: tooDeepProperty } };
}

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
        serverInfo: { name: "hostile-schema-test", version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "safe_tool",
            description: `safe description containing ${secret}`,
            inputSchema: {
              type: "object",
              properties: {
                note: {
                  type: "string",
                  description: `value ${secret}`,
                  enum: ["ordinary", secret],
                },
              },
              required: ["note"],
            },
          },
          {
            name: secret,
            description: "secret-bearing tool name",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "secret_property",
            inputSchema: {
              type: "object",
              properties: { [secret]: { type: "string" } },
            },
          },
          {
            name: "bad_property_name",
            inputSchema: {
              type: "object",
              properties: { "contains whitespace": { type: "string" } },
            },
          },
          {
            name: "bad_required",
            inputSchema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: [secret],
            },
          },
          {
            name: "missing_required_property",
            inputSchema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["absent"],
            },
          },
          {
            name: "inherited_required_property",
            inputSchema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["toString"],
            },
          },
          {
            name: "x".repeat(80),
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "wrong_schema_type",
            inputSchema: [],
          },
          {
            name: "too_deep",
            inputSchema: {
              type: "object",
              properties: { value: tooDeepProperty },
            },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
});
