import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Glob } from "bun";
import type { ToolDef } from "./registry";

const MAX_RESULTS = 200;

export const globTool: ToolDef = {
  name: "glob",
  group: "read",
  description:
    "Find files by glob pattern (e.g. \"src/**/*.ts\", \"*.json\"). Returns relative paths, files only.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to cwd" },
    },
    required: ["pattern"],
  },
  async handler(args, ctx) {
    const pattern = String(args.pattern);
    const glob = new Glob(pattern);
    const matches: string[] = [];
    for await (const rel of glob.scan({ cwd: ctx.cwd, dot: true })) {
      const st = await stat(resolve(ctx.cwd, rel)).catch(() => null);
      if (!st?.isFile()) continue;
      matches.push(rel);
      if (matches.length >= MAX_RESULTS) break;
    }
    if (matches.length === 0) return `No files match ${pattern}`;
    matches.sort();
    const out = matches.join("\n");
    return matches.length >= MAX_RESULTS
      ? `${out}\n[stopped at ${MAX_RESULTS} results]`
      : out;
  },
};
