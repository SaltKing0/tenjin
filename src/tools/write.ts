import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDef } from "./registry";

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
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    return `Wrote ${bytes} bytes to ${args.path}`;
  },
};
