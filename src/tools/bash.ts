import { closeSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "./registry";
import {
  detectSandbox,
  buildSandboxPrefix,
  openSeccompFd,
  sandboxUnavailable,
  seccompDenyBaseline,
} from "./sandbox";
import {
  buildChildEnvironment,
  type HostEnvironment,
} from "../security/child-env";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 30_000;
const SANDBOX_READY_PREFIX = "__TENJIN_SANDBOX_READY__";

/** Build the exact environment granted to an agent-controlled shell. */
export function buildBashChildEnvironment(
  cwd: string,
  hostEnv: HostEnvironment = process.env,
  isolatedTemp = cwd,
): Record<string, string> {
  const env = buildChildEnvironment(hostEnv, { isolatedHome: cwd });
  // Never point an agent-controlled process at the host's ambient temp tree.
  // Production Bash uses bwrap, which maps these paths to its private tmpfs.
  env.TMPDIR = isolatedTemp;
  env.TMP = isolatedTemp;
  env.TEMP = isolatedTemp;
  return env;
}

function sandboxReadyCommand(command: string, marker: string): string[] {
  return [
    "/bin/bash",
    "-c",
    'printf "%s\\n" "$1"; exec /bin/bash -c "$2"',
    "tenjin-sandbox-wrapper",
    marker,
    command,
  ];
}

export interface BashToolOptions {
  /** Host-only escape hatch. Never controlled by tool input alone. */
  allowUnsandboxed?: boolean;
  /** Injectable probes used to verify fail-closed behavior deterministically. */
  detectSandbox?: typeof detectSandbox;
  buildSandboxPrefix?: typeof buildSandboxPrefix;
}

/** Injectable factory used by the environment-boundary regression tests. */
export function createBashTool(
  hostEnv: HostEnvironment = process.env,
  options: BashToolOptions = {},
): ToolDef {
  return {
    name: "bash",
    group: "write",
    description:
      "Run a shell command in the project directory inside the required native sandbox. Returns exit code, stdout, and stderr.",
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
          description: "Sandbox mode: required (default). Unsandboxed execution requires a separate host policy and cannot be enabled by the agent.",
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
      const sandboxMode = String(args.sandbox ?? "required");
      if (!new Set(["required", "auto", "off"]).has(sandboxMode)) {
        throw new Error(`Invalid bash sandbox mode "${sandboxMode}".`);
      }

      // #349: risk-tiered native sandbox per bash call. Build the sandbox argv
      // prefix; writable roots = the tool cwd (bash is a write-group tool).
      // On Linux, the deny baseline is passed to bwrap as child fd 3. Mount,
      // namespace and capability isolation remain the primary containment;
      // seccomp denies a small additional set of dangerous syscalls.
      const detect = options.detectSandbox ?? detectSandbox;
      const buildPrefix = options.buildSandboxPrefix ?? buildSandboxPrefix;
      const mech = detect();
      // Resolve symlinks before constructing either the sandbox policy or the
      // child cwd. A lexical non-root path must never be usable as an alias for
      // the host root.
      const workspace = realpathSync(resolve(ctx.cwd));
      if (workspace === "/") {
        throw new Error("Refusing to expose the host root as the bash workspace.");
      }

      let argv: string[];
      let readyMarker: string | undefined;
      let seccompHostFd: number | undefined;
      try {
        if (sandboxMode === "off") {
          if (!options.allowUnsandboxed) {
            throw new Error(
              "Unsandboxed bash is disabled by host policy — the tool cannot turn off its own sandbox.",
            );
          }
          argv = ["/bin/bash", "-c", command];
        } else {
          if (!mech) throw new Error(sandboxUnavailable(mech));
          if (mech === "sandbox-exec") {
            // Do not accept Seatbelt even through an injected detector. Its
            // filesystem policy is useful for inspection, but it cannot bind
            // setsid() descendants to this tool turn's lifecycle.
            throw new Error(sandboxUnavailable(mech, "darwin"));
          }
          readyMarker = `${SANDBOX_READY_PREFIX}${randomUUID()}`;
          const prefix = buildPrefix({
            writableRoots: [workspace],
            seccompFd: mech === "bwrap" ? 3 : undefined,
            command: sandboxReadyCommand(command, readyMarker),
          }, mech);
          if (!prefix) {
            // `auto` is retained as a compatibility alias, but is fail-closed.
            // The only unsandboxed path is the separate host capability above.
            throw new Error(sandboxUnavailable(mech));
          }
          argv = prefix;
        }

        if (mech === "bwrap" && sandboxMode !== "off") {
          seccompHostFd = openSeccompFd(
            seccompDenyBaseline(process.arch === "arm64" ? "aarch64" : "x86_64"),
          );
        }
        // A host process group closes bwrap's early-setup race: before
        // --die-with-parent has reached every fork, timeout/output revocation
        // can still kill the complete setup chain. bwrap itself does not call
        // setsid; once the ready marker is possible, PDEATHSIG plus the private
        // PID namespace also covers command-created sessions.
        const hostProcessGroup = sandboxMode === "off" || mech === "bwrap";
        const spawnBase = {
          cwd: workspace,
          env: buildBashChildEnvironment(
            workspace,
            hostEnv,
            sandboxMode === "off" ? workspace : "/tmp",
          ),
          // Production bwrap and the explicit host-only escape hatch both get
          // their own host process group. No controlling terminal is inherited.
          detached: hostProcessGroup,
        };
        const proc = seccompHostFd !== undefined
          ? Bun.spawn(argv, {
              ...spawnBase,
              stdio: ["ignore", "pipe", "pipe", seccompHostFd],
            })
          : Bun.spawn(argv, {
              ...spawnBase,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });
        let sandboxProcessExited = false;
        const exited = proc.exited.then((code) => {
          sandboxProcessExited = true;
          return code;
        });
        const terminate = () => {
          if (mech === "bwrap" && sandboxMode !== "off") {
            // Never signal a numeric PGID after its bwrap leader has exited;
            // the id could have been reused by an unrelated host process.
            if (!sandboxProcessExited) terminateProcessGroup(proc);
          } else if (hostProcessGroup) {
            terminateProcessGroup(proc);
          } else if (!sandboxProcessExited) {
            terminateSandboxProcess(proc);
          }
        };
        if (seccompHostFd !== undefined) {
          const spawnedFd = seccompHostFd;
          seccompHostFd = undefined;
          try {
            closeSync(spawnedFd);
          } catch (error) {
            terminate();
            throw error;
          }
        }

        let timeoutTriggered = false;
        const captureBudget: CaptureBudget = { bytes: 0, overflowed: false };
        const captured = Promise.allSettled([
          readStreamBounded(
            proc.stdout as ReadableStream<Uint8Array>,
            captureBudget,
            terminate,
          ),
          readStreamBounded(
            proc.stderr as ReadableStream<Uint8Array>,
            captureBudget,
            terminate,
          ),
        ]);
        const timer = setTimeout(() => {
          timeoutTriggered = true;
          terminate();
        }, timeoutMs);

        try {
          let code: number;
          try {
            code = await exited;
          } finally {
            // A shell may exit while ordinary background descendants still
            // hold stdout/stderr or continue mutating the workspace.
            clearTimeout(timer);
            terminate();
          }

          const [stdoutResult, stderrResult] = await captured;
          if (
            captureBudget.overflowed ||
            (stdoutResult.status === "rejected" &&
              stdoutResult.reason instanceof OutputLimitExceeded) ||
            (stderrResult.status === "rejected" &&
              stderrResult.reason instanceof OutputLimitExceeded)
          ) {
            throw outputOverflowError();
          }
          if (stdoutResult.status === "rejected" || stderrResult.status === "rejected") {
            throw new Error("Failed to capture bash output.");
          }
          let out = stdoutResult.value;
          const err = stderrResult.value;

          if (readyMarker) {
            const readyLine = `${readyMarker}\n`;
            if (!out.startsWith(readyLine)) {
              // Redact the complete diagnostic before bounding it. Truncating
              // first could split a known token and make the fragment
              // impossible for a format-aware redactor to recognize.
              let detail = (err || out).trim();
              if (ctx.redactor) detail = ctx.redactor.redact(detail);
              detail = detail.slice(0, 500);
              throw new Error(
                `Sandbox failed to initialize (${mech ?? "unknown"}, exit ${code ?? "killed"})${detail ? `: ${detail}` : ""}`,
              );
            }
            out = out.slice(readyLine.length);
          }

          const parts = [`exit: ${code}`];
          if (out.trim()) parts.push(`--- stdout ---\n${out.trimEnd()}`);
          if (err.trim()) parts.push(`--- stderr ---\n${err.trimEnd()}`);
          let output = parts.join("\n");
          // Apply the turn's configured redactor before this tool's own output
          // cap. Truncating first can split a token into a fragment that no
          // format-aware redactor can recognize at the model boundary.
          if (ctx.redactor) output = ctx.redactor.redact(output);
          if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT) {
            throw outputOverflowError();
          }
          if (timeoutTriggered && out === "" && err === "") {
            output += `\n[command killed after ${timeoutMs}ms]`;
          }
          return output;
        } finally {
          clearTimeout(timer);
          terminate();
        }
      } finally {
        if (seccompHostFd !== undefined) closeSync(seccompHostFd);
      }
    },
  };
}

export const bashTool = createBashTool();

interface CaptureBudget {
  bytes: number;
  overflowed: boolean;
}

class OutputLimitExceeded extends Error {}

function outputOverflowError(): Error {
  return new Error(
    `Bash output exceeded the ${MAX_OUTPUT}-byte safety limit; the process tree was terminated.`,
  );
}

function terminateProcessGroup(proc: { pid: number; kill(signal?: number | string): void }): void {
  // A negative POSIX pid targets the entire process group created by
  // detached:true. Fall back to the direct subprocess where group signalling
  // is unavailable or the child failed before becoming its group leader.
  if (process.platform !== "win32" && Number.isSafeInteger(proc.pid) && proc.pid > 0) {
    try {
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {}
  }
  try {
    proc.kill(9);
  } catch {}
}

function terminateSandboxProcess(proc: { kill(signal?: number | string): void }): void {
  // Fallback for mechanisms that do not have a POSIX process group.
  try {
    proc.kill(9);
  } catch {}
}

async function readStreamBounded(
  stream: ReadableStream<Uint8Array> | undefined,
  budget: CaptureBudget,
  onOverflow: () => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let localBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (budget.overflowed || budget.bytes + value.byteLength > MAX_OUTPUT) {
        budget.overflowed = true;
        onOverflow();
        try {
          await reader.cancel();
        } catch {}
        throw new OutputLimitExceeded();
      }
      budget.bytes += value.byteLength;
      localBytes += value.byteLength;
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(localBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
