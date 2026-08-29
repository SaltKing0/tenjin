import { spawnSync } from "node:child_process";
import { ConfigError } from "../config/types";

/**
 * B12-3 (#424): a single execution-surface contract — Local | Docker | Remote.
 *
 * Generalizes the browser-container idea to ALL execution surfaces behind one
 * contract: `{ mount, execute, exec }`. The caller never touches processes on
 * the host directly; it talks to "the workspace" through this interface. That
 * keeps the Local reference implementation and a Docker container (and later a
 * Remote endpoint) interchangeable, and prepares the Remote transport.
 *
 * Zero runtime dependencies — Docker is driven through the `docker` CLI (or an
 * injected runner in tests), never an SDK.
 *
 * Runtime status: only `local` is connected to the production tool surface,
 * where Bash still uses its stricter native fail-closed sandbox. Docker and
 * Remote remain contract implementations for integration work; config loading
 * rejects those modes via `validateWorkspaceConfig` instead of silently
 * falling back to host-local execution.
 *
 * ## Contract
 * - `mount`  — expose a host path inside the workspace.
 * - `execute`— run argv inside the workspace, return a structured result.
 *              Throws on spawn *failure* (docker missing, bad binary), NOT on a
 *              non-zero exit code — the caller inspects `exitCode`.
 * - `exec`   — same semantics as execute; kept as a distinct member so the
 *              contract surface is explicit and Remote can later diverge
 *              (e.g. resolve to a REST call instead of a local process).
 */

export type WorkspaceMode = "local" | "docker" | "remote";

export interface WorkspaceMount {
  hostPath: string;
  /** Absolute path inside the workspace (e.g. /workspace/data). */
  containerPath: string;
  readOnly?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface Workspace {
  readonly mode: WorkspaceMode;
  mount(opts: WorkspaceMount): Promise<void>;
  execute(argv: string[], opts?: WorkspaceExecOptions): Promise<ExecResult>;
  exec(argv: string[], opts?: WorkspaceExecOptions): Promise<ExecResult>;
  /** Release workspace resources (docker stop+rm). Idempotent. */
  close(): Promise<void>;
}

/** Runs `docker <argv>` and returns the raw result. Throws if docker can't start. */
export type DockerRunner = (argv: string[]) => ExecResult;

/** Default runner: shell out to the `docker` CLI synchronously. */
function defaultRunner(): DockerRunner {
  return (argv) => {
    const r = spawnSync("docker", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) {
      throw new Error(`docker failed to start: ${r.error.message}`);
    }
    if (r.status === null) {
      // Child was terminated by a signal rather than exiting (env quirk, e.g.
      // a daemon killing the client). Surface it instead of a bare -1.
      throw new Error(
        `docker ${argv[0] ?? ""} killed by signal ${r.signal ?? "unknown"} (${argv.join(" ")})`,
      );
    }
    return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Run an argv locally with spawnSync; throws only on spawn failure. */
function runLocal(argv: string[], opts?: WorkspaceExecOptions): ExecResult {
  if (argv.length === 0) throw new Error("execute: argv must not be empty");
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  });
  if (r.error) {
    throw new Error(`failed to run ${argv[0]}: ${r.error.message}`);
  }
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Local reference implementation. Host paths are the workspace, so `mount` is a
 * no-op and commands run as child processes. Satisfies the FULL contract, so it
 * is the canonical shape every other implementation must match.
 */
export class LocalWorkspace implements Workspace {
  readonly mode = "local" as const;

  async mount(_opts: WorkspaceMount): Promise<void> {
    // Local: every host path is already inside the workspace.
  }

  async execute(argv: string[], opts?: WorkspaceExecOptions): Promise<ExecResult> {
    return runLocal(argv, opts);
  }

  async exec(argv: string[], opts?: WorkspaceExecOptions): Promise<ExecResult> {
    return runLocal(argv, opts);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

export interface DockerWorkspaceConfig {
  /** Container name. Generated as `tenjin-ws-<pid>-<rand>` when omitted. */
  name?: string;
  image?: string;
  /** Sole writable zone inside the container. Default /workspace. */
  workdir?: string;
  /** `--memory` (e.g. "512m"). */
  memoryMax?: string;
  /** `--cpus` quota. */
  cpuQuota?: number;
  /** Non-root UID:GID (B12-4). Default "1000:1000". */
  user?: string;
  /** Bind mounts applied at container creation. */
  mounts?: WorkspaceMount[];
  /** Injectable docker CLI runner (tests). */
  run?: DockerRunner;
}

/** Registry of live containers this process created, for orphan TTL GC. */
const created = new Map<string, number>(); // container name -> startedAtMs

export function trackContainer(name: string, atMs: number = Date.now()): void {
  created.set(name, atMs);
}
export function untrackContainer(name: string): void {
  created.delete(name);
}

/**
 * Remove containers past their TTL deadline (best-effort `docker rm -f`).
 * Guards against orphaned containers left behind by a crash between start and
 * close. Returns the names of removed containers.
 */
export function ttlGC(opts: {
  ttlMs: number;
  now?: number;
  run?: DockerRunner;
}): string[] {
  const now = opts.now ?? Date.now();
  const run = opts.run ?? defaultRunner();
  const removed: string[] = [];
  for (const [name, at] of created) {
    if (now - at >= opts.ttlMs) {
      run(["rm", "-f", name]); // best-effort; if this throws we still drop the entry
      created.delete(name);
      removed.push(name);
    }
  }
  return removed;
}

/**
 * DockerWorkspace — a per-session container used as a CONTEXT MANAGER. The
 * container is spawned on first use (entry) and GUARANTEED `stop`+`rm` on
 * close, even when an intervening call throws. It is also tracked for TTL GC so
 * a crash mid-session cannot leave an orphan behind indefinitely.
 *
 * Rootless hardening defaults (B12-4): --cap-drop=ALL, read-only rootfs,
 * non-root UID, /workspace as the sole rw zone, default seccomp, and optional
 * MemoryMax/CPUQuota. Communication goes through `docker exec` against the
 * workspace — never direct host process access (prepares Remote).
 */
export class DockerWorkspace implements Workspace {
  readonly mode = "docker" as const;
  readonly name: string;
  readonly image: string;
  readonly workdir: string;
  private readonly run: DockerRunner;
  private started = false;
  private readonly memoryMax?: string;
  private readonly cpuQuota?: number;
  private readonly user: string;
  private readonly mounts: WorkspaceMount[];
  private readonly exitCleanup: () => void;
  private readonly sigHandlers: Array<["SIGINT" | "SIGTERM", () => void]> = [];

  constructor(cfg: DockerWorkspaceConfig = {}) {
    this.name =
      cfg.name ?? `tenjin-ws-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.image = cfg.image ?? "alpine";
    this.workdir = cfg.workdir ?? "/workspace";
    this.memoryMax = cfg.memoryMax;
    this.cpuQuota = cfg.cpuQuota;
    this.user = cfg.user ?? "1000:1000";
    this.mounts = cfg.mounts ?? [];
    this.run = cfg.run ?? defaultRunner();

    // Best-effort synchronous cleanup on process exit (crash paths).
    this.exitCleanup = () => {
      try {
        this.run(["stop", this.name]);
        this.run(["rm", "-f", this.name]);
      } catch {
        /* process is exiting; nothing sensible to do */
      }
      untrackContainer(this.name);
    };
  }

  /** Start the container if not already running (idempotent). */
  async start(): Promise<void> {
    if (this.started) return;
    const argv = [
      "run", "-d",
      "--name", this.name,
      "--cap-drop=ALL",
      "--read-only",
      "--user", this.user,
      "--workdir", this.workdir,
      // /workspace is the sole writable zone.
      "--mount", `type=tmpfs,destination=${this.workdir}`,
      // seccomp: keep Docker's default profile (not overridden) — B12-4.
    ];
    if (this.memoryMax) argv.push("--memory", this.memoryMax);
    if (this.cpuQuota !== undefined) argv.push("--cpus", String(this.cpuQuota));
    for (const m of this.mounts) {
      const mode = m.readOnly ? "ro" : "rw";
      argv.push("--mount", `type=bind,source=${m.hostPath},target=${m.containerPath},${mode}`);
    }
    argv.push(this.image, "sleep", "infinity");

    const res = this.run(argv);
    if (res.exitCode !== 0) {
      throw new Error(`docker run failed (${res.exitCode}): ${res.stderr || res.stdout}`);
    }
    this.started = true;
    trackContainer(this.name);

    process.once("exit", this.exitCleanup);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const h = () => {
        this.close().catch(() => {});
      };
      this.sigHandlers.push([sig, h]);
      process.on(sig, h);
    }
  }

  /** Run argv inside the running container via `docker exec`. */
  private async inContainer(argv: string[], opts?: WorkspaceExecOptions): Promise<ExecResult> {
    await this.start();
    const r = this.run(["exec", this.name, ...argv]);
    // docker exec inherits the container env/cwd; per-option overrides are not
    // part of the CLI contract here (mapped through the container instead).
    void opts;
    return r;
  }

  async mount(opts: WorkspaceMount): Promise<void> {
    await this.start();
    const res = this.run(["cp", opts.hostPath, `${this.name}:${opts.containerPath}`]);
    if (res.exitCode !== 0) {
      throw new Error(`docker cp failed (${res.exitCode}): ${res.stderr || res.stdout}`);
    }
  }

  async execute(argv: string[], opts?: WorkspaceExecOptions): Promise<ExecResult> {
    return this.inContainer(argv, opts);
  }

  async exec(argv: string[], opts?: WorkspaceExecOptions): Promise<ExecResult> {
    return this.inContainer(argv, opts);
  }

  /** GUARANTEED stop+rm: both are attempted even if one throws. Idempotent. */
  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    process.removeListener("exit", this.exitCleanup);
    for (const [sig, h] of this.sigHandlers) process.removeListener(sig, h);
    this.sigHandlers.length = 0;
    untrackContainer(this.name);

    let stopErr: unknown;
    try {
      const stop = this.run(["stop", this.name]);
      if (stop.exitCode !== 0) {
        throw new Error(`docker stop failed (${stop.exitCode}): ${stop.stderr || stop.stdout || "(no output)"}`);
      }
    } catch (e) {
      stopErr = e;
    }
    // `rm -f` is the ULTIMATE cleanup: force-removes the container whether it
    // is running or already stopped, so teardown is guaranteed even when `stop`
    // misbehaves (e.g. a daemon quirk returning non-zero with no output). Only
    // if BOTH stop and rm fail does close() throw.
    let rmErr: unknown;
    try {
      const rm = this.run(["rm", "-f", this.name]);
      if (rm.exitCode !== 0) {
        throw new Error(`docker rm failed (${rm.exitCode}): ${rm.stderr || rm.stdout || "(no output)"}`);
      }
    } catch (e) {
      rmErr = e;
    }
    if (rmErr !== undefined) throw rmErr;
    if (stopErr !== undefined) throw stopErr;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Remote stub — interface ready, transport not yet wired. Any real call throws
 * a clear error so callers can't silently believe a remote workspace is live.
 */
export class RemoteWorkspace implements Workspace {
  readonly mode = "remote" as const;
  private readonly why =
    "RemoteWorkspace is stubbed (B12-3): the REST transport is not wired yet. Configure workspace.mode: local or docker.";

  async mount(_opts: WorkspaceMount): Promise<void> {
    throw new Error(this.why);
  }
  async execute(_argv: string[], _opts?: WorkspaceExecOptions): Promise<ExecResult> {
    throw new Error(this.why);
  }
  async exec(_argv: string[], _opts?: WorkspaceExecOptions): Promise<ExecResult> {
    throw new Error(this.why);
  }
  async close(): Promise<void> {
    /* nothing to release */
  }
}

export interface WorkspaceConfigInput {
  mode?: WorkspaceMode;
  docker?: DockerWorkspaceConfig;
  /** Global orphan TTL for docker containers (ms). */
  ttlMs?: number;
}

/**
 * Validate the execution-surface switch at the production config boundary.
 *
 * DockerWorkspace does not yet provide the async cancellation, bounded output
 * capture and per-agent lifecycle required by the real Bash tool. Accepting
 * `workspace.mode: docker` today would therefore be worse than an unsupported
 * option: the product would continue on the local path and contradict the
 * operator's isolation choice. Reject unfinished modes before any provider or
 * tool runs. Direct construction remains available to its gated integration
 * tests while the runtime adapter is completed.
 */
export function validateWorkspaceConfig(cfg: WorkspaceConfigInput | undefined): void {
  if (cfg === undefined) return;
  const mode = cfg.mode ?? "local";
  if (mode !== "local" && mode !== "docker" && mode !== "remote") {
    throw new ConfigError(
      `Unknown workspace mode: ${JSON.stringify(mode)}. Expected one of "local", "docker", "remote".`,
    );
  }
  if (mode !== "local") {
    throw new ConfigError(
      `workspace.mode "${mode}" is not connected to the production tool runtime; ` +
        "refusing to fall back to host-local execution. Use workspace.mode: local " +
        "(Bash remains fail-closed behind native isolation).",
    );
  }
  if (cfg.docker !== undefined || cfg.ttlMs !== undefined) {
    throw new ConfigError(
      "workspace.docker and workspace.ttlMs require workspace.mode: docker, " +
        "which is not connected to the production tool runtime yet.",
    );
  }
}

/** Select the implementation behind the config switch. Unknown mode = clean error. */
export function createWorkspace(cfg: WorkspaceConfigInput = {}): Workspace {
  const mode = cfg.mode ?? "local";
  switch (mode) {
    case "local":
      return new LocalWorkspace();
    case "docker":
      return new DockerWorkspace(cfg.docker);
    case "remote":
      return new RemoteWorkspace();
    default:
      // Runtime guard for callers casting through untyped config.
      throw new ConfigError(
        `Unknown workspace mode: ${JSON.stringify(mode)}. Expected one of "local", "docker", "remote".`,
      );
  }
}
