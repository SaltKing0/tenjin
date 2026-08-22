import { resolve } from "node:path";
import type { ToolDef } from "./registry";
import {
  detectSandbox,
  buildSandboxPrefix,
  sandboxUnavailable,
} from "./sandbox";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 30_000;

export const bashTool: ToolDef = {
  name: "bash",
  group: "write",
  description:
    "Run a shell command in the project directory (natively sandboxed when available). Returns exit code, stdout, and stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      timeoutMs: {
        type: "number",
        description: `Kill the command after this many ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
      },
      sandbox: {
        type: "string",
        description: "Sandbox mode: auto (default), required (hard error if unavailable), off.",
      },
    },
    required: ["command"],
  },
  async handler(args, ctx) {
    const command = String(args.command);
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS),
    );
    const sandboxMode = String(args.sandbox ?? "auto");

    // #349: risk-tiered native sandbox per bash call. Build the sandbox argv
    // prefix; writable roots = the tool cwd (bash is a write-group tool).
    // The seccomp deny baseline (B12-2) is a best-effort extra: bwrap reads it
    // from an inherited fd, but Bun.spawn has no reliable fd-passing primitive
    // (extraFds is not a real SpawnOption), so we do not attach --seccomp here;
    // the bwrap ro-bind + unshare sandbox still provides the core containment.
    let argv: string[];
    const mech = detectSandbox();
    if (sandboxMode === "off") {
      argv = ["bash", "-c", command];
    } else {
      const prefix = buildSandboxPrefix({
        writableRoots: [resolve(ctx.cwd)],
        command: ["bash", "-c", command],
      });
      if (!prefix && sandboxMode === "required") {
        // failIfUnavailable LAW: never silently run unsandboxed when required.
        throw new Error(sandboxUnavailable(mech));
      }
      argv = prefix ?? ["bash", "-c", command];
    }

    const proc = Bun.spawn(argv, {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: process.env,
    });

    const timer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {}
    }, timeoutMs);

    try {
      const [out, err] = await Promise.all([
        readStream(proc.stdout as ReadableStream<Uint8Array>),
        readStream(proc.stderr as ReadableStream<Uint8Array>),
      ]);
      const code = await proc.exited;
      const timedOut = code === null || code === 137;

      const parts = [`exit: ${code ?? "killed"}`];
      if (out.trim()) parts.push(`--- stdout ---\n${out.trimEnd()}`);
      if (err.trim()) parts.push(`--- stderr ---\n${err.trimEnd()}`);
      let output = parts.join("\n");
      if (output.length > MAX_OUTPUT) {
        output = `${output.slice(0, MAX_OUTPUT)}\n[output truncated]`;
      }
      if (timedOut && out === "" && err === "") {
        output += `\n[command killed after ${timeoutMs}ms]`;
      }
      return output;
    } finally {
      clearTimeout(timer);
    }
  },
};

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}
