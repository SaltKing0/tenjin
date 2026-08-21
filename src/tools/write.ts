import { resolve } from "node:path";
import type { ToolDef } from "./registry";
import { atomicWrite } from "./atomic";

export const writeTool: ToolDef = {
  name: "write_file",
  group: "write",
  description:
    "Create or overwrite a file with the given content. Parent directories are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to cwd or absolute" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["path", "content"],
  },
  async handler(args, ctx) {
    const path = resolve(ctx.cwd, String(args.path));
    const content = String(args.content);
    // Atomic temp+rename write with a TOCTOU symlink re-check (see atomic.ts).
    await atomicWrite(path, content, {
      guard: ctx.guard,
      toolName: "write_file",
      cwd: ctx.cwd,
    });
    const bytes = Buffer.byteLength(content, "utf8");
    return `Wrote ${bytes} bytes to ${args.path}`;
  },
};
