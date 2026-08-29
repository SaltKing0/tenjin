// Writes enough stderr to fill a pipe before replying. The client must drain
// stderr in the background or initialization deadlocks.
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    process.stderr.write("diagnostic\n".repeat(200_000), () => {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "stderr-test", version: "1.0.0" },
        },
      });
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
  }
});
