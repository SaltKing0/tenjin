import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./registry";

export const editTool: ToolDef = {
  name: "edit_file",
  group: "write",
  description:
    "Replace an exact string in a file. oldString must match exactly and be unique unless replaceAll is set.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to cwd or absolute" },
      oldString: { type: "string", description: "Exact text to replace" },
      newString: { type: "string", description: "Replacement text" },
      replaceAll: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "oldString", "newString"],
  },
  async handler(args, ctx) {
    const path = resolve(ctx.cwd, String(args.path));
    const oldString = String(args.oldString);
    const newString = String(args.newString);
    if (oldString === "") throw new Error("oldString must not be empty");
    if (oldString === newString) throw new Error("oldString and newString are identical");

    const text = await readFile(path, "utf8");
    const occurrences = text.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(`oldString not found in ${args.path}`);
    }
    if (occurrences > 1 && !args.replaceAll) {
      throw new Error(
        `Found ${occurrences} occurrences of oldString in ${args.path}. ` +
          `Provide more surrounding context or set replaceAll: true.`,
      );
    }
    const updated = args.replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);
    await writeFile(path, updated, "utf8");
    return `Replaced ${args.replaceAll ? occurrences : 1} occurrence(s) in ${args.path}`;
  },
};
