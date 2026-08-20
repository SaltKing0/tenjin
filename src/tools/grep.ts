import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Glob } from "bun";
import type { ToolDef } from "./registry";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".tenjin",
  "dist",
  "build",
  ".cache",
  "vendor",
]);
const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE = 300;

interface GrepArgs {
  pattern: string;
  include?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
}

export const grepTool: ToolDef = {
  name: "grep",
  group: "read",
  description:
    "Search file contents with a regex. Returns path:line:text matches, skipping node_modules/.git/etc.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regex" },
      include: { type: "string", description: 'Filename glob filter, e.g. "*.ts"' },
      caseInsensitive: { type: "boolean" },
      maxResults: { type: "number", description: "Default 100" },
    },
    required: ["pattern"],
  },
  async handler(args, ctx) {
    const a = args as unknown as GrepArgs;
    let regex: RegExp;
    try {
      regex = new RegExp(a.pattern, a.caseInsensitive ? "i" : "");
    } catch (e) {
      throw new Error(`Invalid regex: ${(e as Error).message}`);
    }
    const fileFilter = a.include ? new Glob(a.include) : null;
    const max = Math.min(500, Math.max(1, a.maxResults ?? 100));
    const results: string[] = [];

    await walk(ctx.cwd, ctx.cwd, async (rel, abs) => {
      if (results.length >= max) return;
      if (fileFilter && !fileFilter.match(basename(rel))) return;
      const buf = await readFile(abs).catch(() => null);
      if (!buf || buf.byteLength > MAX_FILE_BYTES) return;
      if (buf.subarray(0, 8192).includes(0)) return;
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= max) break;
        const line = lines[i];
        if (line === undefined || !regex.test(line)) continue;
        results.push(`${rel}:${i + 1}: ${line.trim().slice(0, MAX_LINE)}`);
      }
    });

    if (results.length === 0) return `No matches for /${a.pattern}/`;
    const out = results.join("\n");
    return results.length >= max ? `${out}\n[stopped at ${max} results]` : out;
  },
};

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

async function walk(
  root: string,
  dir: string,
  visitFile: (rel: string, abs: string) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, abs, visitFile);
    } else if (entry.isFile()) {
      await visitFile(relative(root, abs), abs);
    }
  }
}
