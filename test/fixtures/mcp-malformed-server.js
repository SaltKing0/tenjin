// MCP server that emits a non-JSON line as its very first frame, to prove the
// client rejects a malformed JSON-RPC frame cleanly instead of crashing.
process.stdout.write("THIS IS NOT JSON\n");
// Keep the process alive so stdin stays open.
setInterval(() => {}, 1000);
