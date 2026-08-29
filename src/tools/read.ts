import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./registry";
import { Redactor } from "../security/redact";

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;

export const readTool: ToolDef = {
  name: "read_file",
  group: "read",
  description:
    "Read a text file. Returns numbered lines. Optional 1-based offset and line limit (default 2000).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to cwd or absolute" },
      offset: { type: "number", description: "1-based start line" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["path"],
  },
  async handler(args, ctx) {
    const path = resolve(ctx.cwd, String(args.path));
    const st = await stat(path);
    if (!st.isFile()) throw new Error(`Not a file: ${args.path}`);
    const raw = await readFile(path, "utf8");
    const redactor = ctx.redactor ?? new Redactor();
    // Redact the complete document before selecting/capping lines. Multiline
    // credentials (notably PEM keys) cannot be recognized safely line by line.
    const lines = redactor.redact(raw).split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();

    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(args.limit) || DEFAULT_LIMIT));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const out = slice.map((line, i) => {
      const n = offset + i;
      const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
      return `${n}: ${text}`;
    });
    if (offset - 1 + limit < lines.length) {
      out.push(`[showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}]`);
    }
    if (out.length === 0) return "[empty file or range beyond end]";
    return out.join("\n");
  },
};
