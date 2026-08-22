// B13-6 (#369): the checkpoint tool — the agent-visible surface for the
// shadow-git snapshot store. List checkpoints, or restore files / the
// conversation / both to an earlier checkpoint. This is what makes undo an
// approval-saver: a bad edit can be rolled back byte-exact.
import type { ToolDef } from "./registry";
import {
  listCheckpoints,
  restoreBoth,
  restoreConversation,
  restoreFiles,
} from "../checkpoints/store";

export function createCheckpointTool(deps: {
  storeDir: string;
  sourceDir: string;
  /** Session/conversation log path, needed for conversation/both restore. */
  logPath?: string;
}): ToolDef {
  return {
    name: "checkpoint",
    group: "read",
    description:
      "List shadow-git checkpoints, or restore the project to an earlier one. " +
      "Restore modes: files (code back, conversation stays), conversation " +
      "(reasoning rolls back, code stays), both (full rewind). bash-driven " +
      "changes (rm/mv/cp) are NOT captured by snapshots — for those use `git " +
      "reflog` in the user repo as the fallback.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "restore"],
          description: "list checkpoints, or restore to one",
        },
        mode: {
          type: "string",
          enum: ["files", "conversation", "both"],
          description: "What to restore (files / conversation / both)",
        },
        ref: {
          type: "string",
          description: "Checkpoint sequence number (e.g. \"3\") or commit sha to restore to",
        },
      },
      required: ["action"],
    },
    async handler(args, _ctx) {
      const action = String(args.action);
      if (action === "list") {
        const list = listCheckpoints(deps.storeDir);
        if (list.length === 0) return "No checkpoints yet.";
        return (
          "Checkpoints (newest first):\n" +
          list
            .map((c) => `  #${c.seq} ${c.label} (${c.sha.slice(0, 8)})`)
            .join("\n")
        );
      }
      if (action === "restore") {
        const mode = String(args.mode ?? "files");
        const ref = String(args.ref ?? "");
        if (!ref) {
          throw new Error("restore requires a `ref` (checkpoint sequence or sha).");
        }
        const numeric = Number(ref);
        const key = Number.isFinite(numeric) && ref.trim() !== "" ? numeric : ref;
        switch (mode) {
          case "files":
            restoreFiles(deps.storeDir, deps.sourceDir, key);
            return `Restored project files to checkpoint ${ref}.`;
          case "conversation":
            restoreConversation(deps.storeDir, deps.logPath, key);
            return `Restored conversation to checkpoint ${ref}.`;
          case "both":
            restoreBoth(deps.storeDir, deps.sourceDir, deps.logPath, key);
            return `Restored files and conversation to checkpoint ${ref}.`;
          default:
            throw new Error(`Unknown restore mode "${mode}". Valid: files, conversation, both.`);
        }
      }
      throw new Error(`Unknown checkpoint action "${action}". Valid: list, restore.`);
    },
  };
}
