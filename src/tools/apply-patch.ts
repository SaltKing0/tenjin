import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDef } from "./registry";
import { atomicWrite } from "./atomic";

/**
 * apply_patch — multi-file unified patch (Roadmap §3 Phase 1 / WP 1.2).
 *
 * Applies a strict, multi-file patch that travels the SAME atomic temp+rename
 * path as the single-file write/edit tools (#339). The whole patch is parsed
 * and every hunk validated against current disk state BEFORE anything is
 * written; on a mid-apply failure the already-touched files are rolled back to
 * their exact pre-patch bytes.
 *
 * Format (strict — any unknown top-level syntax rejects the WHOLE patch):
 *
 *   *** Begin Patch                      (optional wrapper)
 *   *** Add File: <path>
 *   <new file content, verbatim>
 *   *** Update File: <path>
 *   @@ -oldStart,oldCount +newStart,newCount @@
 *    context line
 *   -removed line
 *   +added line
 *   *** Delete File: <path>
 *   *** End Patch                        (optional wrapper)
 *
 * - Add: writes the given content exactly (joined with \n, trailing newline).
 * - Update: hunks are applied in order. Each hunk's old side (context + `-`
 *   lines) must match the current file content at EXACTLY ONE position; zero or
 *   multiple matches reject the whole patch pre-touch (missing/ambiguous).
 * - Delete: removes the file (must exist).
 *
 * Registering with group: "write" routes the tool through the normal guard,
 * approval and budget flow. Each touched file additionally emits its own
 * write_exec audit entry.
 */

type PatchKind = "add" | "update" | "delete";

interface HunkLine {
  type: "context" | "remove" | "add";
  text: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

interface PatchOp {
  kind: PatchKind;
  path: string;
  addContent?: string[];
  hunks?: Hunk[];
}

const MARKER = /^\*\*\* (Add File|Update File|Delete File): (.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse the patch text into ops. Throws on ANY unknown/invalid syntax. */
export function parsePatch(text: string): PatchOp[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Optional begin/end wrapper lines are tolerated (not part of a file body).
    if (/^\*\*\* Begin Patch\s*$/.test(line) || /^\*\*\* End Patch\s*$/.test(line)) {
      i++;
      continue;
    }
    const m = MARKER.exec(line);
    if (!m) {
      throw new Error(`unknown top-level syntax on line ${i + 1}: ${JSON.stringify(line)}`);
    }
    const kind: PatchKind =
      m[1] === "Add File" ? "add" : m[1] === "Update File" ? "update" : "delete";
    const path = m[2]!.trim();
    if (!path) throw new Error(`empty path in "${kind}" marker`);

    i++; // consume marker
    const { block, next } = collectBlock(lines, i);
    i = next;

    if (kind === "add") {
      if (block.length === 0) throw new Error(`Add File for ${path} has no content`);
      ops.push({ kind, path, addContent: block });
    } else if (kind === "update") {
      const hunks = parseHunks(block, path);
      ops.push({ kind, path, hunks });
    } else {
      if (block.length > 0) throw new Error(`Delete File for ${path} must not carry a body`);
      ops.push({ kind, path });
    }
  }

  if (ops.length === 0) throw new Error("empty patch (no *** file sections)");
  return ops;
}

/** Collect lines up to the next `*** ` marker, trimming surrounding blanks. */
function collectBlock(lines: string[], start: number): { block: string[]; next: number } {
  const block: string[] = [];
  let i = start;
  while (i < lines.length && !lines[i]!.startsWith("*** ")) {
    block.push(lines[i]!);
    i++;
  }
  while (block.length && block[0]!.trim() === "") block.shift();
  while (block.length && block[block.length - 1]!.trim() === "") block.pop();
  return { block, next: i };
}

function parseHunks(block: string[], path: string): Hunk[] {
  const hunks: Hunk[] = [];
  let j = 0;
  while (j < block.length) {
    const hm = HUNK_HEADER.exec(block[j]!);
    if (!hm) throw new Error(`${path}: expected @@ hunk header, got ${JSON.stringify(block[j])}`);
    const oldStart = Number(hm[1]);
    const oldCount = hm[2] ? Number(hm[2]) : 1;
    const newStart = Number(hm[3]);
    const newCount = hm[4] ? Number(hm[4]) : 1;
    j++;
    const lines: HunkLine[] = [];
    while (j < block.length && !/^@@ /.test(block[j]!)) {
      const l = block[j]!;
      const c = l[0]!;
      if (c === " ") lines.push({ type: "context", text: l.slice(1) });
      else if (c === "-") lines.push({ type: "remove", text: l.slice(1) });
      else if (c === "+") lines.push({ type: "add", text: l.slice(1) });
      else if (c === "\\") throw new Error(`${path}: no-newline marker not supported`);
      else throw new Error(`${path}: unknown hunk line ${JSON.stringify(l)}`);
      j++;
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }
  if (hunks.length === 0) throw new Error(`${path}: Update File requires at least one hunk`);
  return hunks;
}

/** Apply hunks to `cur` (array of lines). Throws if any hunk is not unique. */
function applyHunks(cur: string[], hunks: Hunk[]): string[] {
  const out = cur.slice();
  for (const h of hunks) {
    // Old side = context + removal lines, in order; must match at ONE position.
    const pattern = h.lines.filter((l) => l.type !== "add").map((l) => l.text);
    const matches: number[] = [];
    for (let i = 0; i + pattern.length <= out.length; i++) {
      let ok = true;
      for (let k = 0; k < pattern.length; k++) {
        if (out[i + k] !== pattern[k]) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push(i);
    }
    if (matches.length === 0) throw new Error("hunk context does not match current file content");
    if (matches.length > 1) throw new Error("hunk matches at multiple positions (ambiguous)");
    const idx = matches[0]!;
    // Rebuild the matched span with unified-patch semantics: context lines are
    // preserved, removal (-) lines are dropped and replaced by the addition (+)
    // lines, in their interleaved order.
    const replacement: string[] = [];
    let oldPos = idx;
    for (const l of h.lines) {
      if (l.type === "context") {
        replacement.push(out[oldPos]!);
        oldPos++;
      } else if (l.type === "remove") {
        oldPos++;
      } else {
        replacement.push(l.text);
      }
    }
    out.splice(idx, pattern.length, ...replacement);
  }
  return out;
}

interface Planned {
  kind: PatchKind;
  abs: string;
  display: string;
  original: string | null;
  newContent: string | null;
}

export const applyPatchTool: ToolDef = {
  name: "apply_patch",
  group: "write",
  description:
    "Apply a strict multi-file unified patch with *** Add File / *** Update File / *** Delete File markers. " +
    "Every hunk is validated against current disk state before anything is written; on a mid-apply failure " +
    "already-touched files are rolled back to their exact pre-patch bytes. Emits one audit entry per file.",
  inputSchema: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The multi-file patch text (see tool description for the format)." },
    },
    required: ["patch"],
  },
  async handler(args, ctx) {
    const patchText = String(args.patch);
    let ops: PatchOp[];
    try {
      ops = parsePatch(patchText);
    } catch (e) {
      throw new Error(`apply_patch: ${(e as Error).message}`);
    }

    const cwd = ctx.cwd;

    // ---- PHASE 1: validate EVERYTHING against current disk state, touch nothing.
    const planned: Planned[] = [];
    for (const op of ops) {
      const abs = resolve(cwd, op.path);
      // Per-file guard check (blocked patterns + workspace confinement), reusing
      // write_file's path logic so guard + approval still fire for this write tool.
      const guard = ctx.guard?.checkTool("write_file", { path: abs }, cwd);
      if (guard?.blocked) {
        throw new Error(
          `apply_patch blocked by security policy: ${guard.pattern ?? guard.reason ?? "rejected by policy"}`,
        );
      }
      let exists = false;
      let original: string | null = null;
      try {
        const st = await stat(abs);
        exists = st.isFile();
      } catch {
        exists = false;
      }
      if (exists) original = await readFile(abs, "utf8");

      if (op.kind === "add") {
        if (exists) throw new Error(`apply_patch: add failed — ${op.path} already exists`);
        planned.push({ kind: op.kind, abs, display: op.path, original: null, newContent: op.addContent!.join("\n") + "\n" });
      } else if (op.kind === "update") {
        if (!exists) throw new Error(`apply_patch: update failed — ${op.path} does not exist`);
        let newContent: string;
        try {
          newContent = applyHunks(original!.split("\n"), op.hunks!).join("\n");
        } catch (e) {
          throw new Error(`apply_patch: ${op.path}: ${(e as Error).message}`);
        }
        planned.push({ kind: op.kind, abs, display: op.path, original, newContent });
      } else {
        if (!exists) throw new Error(`apply_patch: delete failed — ${op.path} does not exist`);
        planned.push({ kind: op.kind, abs, display: op.path, original, newContent: null });
      }
    }

    // ---- PHASE 2: apply with rollback on partial failure.
    const applied: Planned[] = [];
    try {
      for (const p of planned) {
        if (p.kind === "delete") {
          await rm(p.abs, { force: true });
        } else {
          // Same atomic temp+rename path as write/edit (#339); toolName "write_file"
          // keeps the TOCTOU containment re-check meaningful.
          await atomicWrite(p.abs, p.newContent!, { guard: ctx.guard, toolName: "write_file", cwd });
        }
        applied.push(p);
        ctx.audit?.("write_exec", `apply_patch ${p.kind} ${p.display}`, ctx.correlationId);
      }
    } catch (e) {
      // Roll back every already-applied file to its exact pre-patch bytes.
      for (const p of applied) {
        try {
          if (p.original !== null) await atomicWrite(p.abs, p.original, { cwd });
          else await rm(p.abs, { force: true });
        } catch {
          // best-effort rollback; surface the original error below.
        }
      }
      throw e;
    }

    const summary = planned.map((p) => `  ${p.kind} ${p.display}`).join("\n");
    return `apply_patch: applied ${planned.length} file(s):\n${summary}`;
  },
};
