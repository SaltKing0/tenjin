import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

/**
 * #349: risk-tiered NATIVE sandbox per bash call.
 *
 * Production shell execution uses `bwrap` (bubblewrap) on Linux. Seatbelt
 * profile builders remain available for policy inspection, but macOS is not a
 * production Bash backend: Seatbelt cannot revoke descendants that call
 * setsid() and outlive the original shell. Windows is likewise unsupported.
 * Zero runtime dependencies: the Linux path shells out to the fixed system
 * binary instead of resolving a wrapper through PATH.
 *
 * failIfUnavailable LAW: if a sandbox is configured/required but no mechanism
 * is available (or init fails), we return a HARD tool error — never a silent
 * unsandboxed run.
 */

export type SandboxMechanism = "bwrap" | "sandbox-exec" | null;

/** Return a production-capable shell lifecycle sandbox for this platform. */
export function detectSandbox(): SandboxMechanism {
  if (process.platform === "linux") {
    if (existsSync("/usr/bin/bwrap")) return "bwrap";
    // Landlock policy construction is not implemented. Do not report a
    // mechanism merely because the kernel exposes the LSM.
    return null;
  }
  if (process.platform === "darwin") {
    // Seatbelt constrains inherited capabilities, but it does not provide a
    // revocable process/job boundary. A command can fork, call setsid(), let
    // its original shell exit, and keep mutating an allowed workspace after
    // the tool turn has returned. Until Bash runs in a kernel-managed job
    // whose complete lifetime can be terminated, macOS must fail closed.
    return null;
  }
  return null;
}

export interface SandboxArgs {
  /** Absolute directories the sandbox may write to. Others become read-only. */
  writableRoots: string[];
  /** Read-only workspace mode; private ephemeral files may remain writable. */
  readOnly?: boolean;
  /** The command argv to run inside the sandbox (e.g. ["bash","-c",cmd]). */
  command: string[];
  /** Optional pre-opened seccomp filter fd (bwrap --seccomp). */
  seccompFd?: number;
  /** Private host temp used by Seatbelt; bwrap supplies an in-memory /tmp. */
  temporaryRoot?: string;
}

/**
 * Build the argv prefix that wraps `command` inside the available sandbox.
 * Returns null when no mechanism is available (caller must enforce the
 * failIfUnavailable LAW).
 */
export function buildSandboxPrefix(
  opts: SandboxArgs,
  mech: SandboxMechanism = detectSandbox(),
): string[] | null {
  if (mech === "bwrap") return buildBwrapArgs(opts);
  if (mech === "sandbox-exec") return buildSeatbeltArgs(opts);
  return null;
}

const BWRAP_RUNTIME_DIRS = [
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/lib",
  "/opt/homebrew/Cellar",
  "/opt/homebrew/opt",
  "/opt/homebrew/share",
  "/home/linuxbrew/.linuxbrew/bin",
  "/home/linuxbrew/.linuxbrew/sbin",
  "/home/linuxbrew/.linuxbrew/lib",
  "/home/linuxbrew/.linuxbrew/Cellar",
  "/home/linuxbrew/.linuxbrew/opt",
  "/home/linuxbrew/.linuxbrew/share",
  "/nix/store",
  "/gnu/store",
] as const;

const BWRAP_RUNTIME_FILES = [
  "/etc/alternatives",
  "/etc/ca-certificates",
  "/etc/group",
  "/etc/hosts",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/os-release",
  "/etc/passwd",
  "/etc/pki",
  "/etc/ssl/certs",
] as const;

function normalizedRoots(roots: readonly string[]): string[] {
  return roots.map((root) => {
    if (!isAbsolute(root)) throw new Error(`Sandbox root must be absolute: ${root}`);
    const resolved = normalize(root);
    if (resolved === "/") {
      throw new Error("Refusing to expose the host root as a sandbox workspace");
    }
    return resolved;
  });
}

/**
 * bwrap prefix with an empty root assembled from runtime-only mounts. Host
 * `/`, `/run`, `/var/run`, `/proc`, `/dev` and `/tmp` are never inherited.
 */
export function buildBwrapArgs(opts: SandboxArgs): string[] {
  const roots = normalizedRoots(opts.writableRoots);
  const args = [
    "/usr/bin/bwrap",
    "--unshare-all",
    // Keep the lifecycle namespace explicit: its pid1 reaps descendants and
    // namespace teardown kills even children that create a new POSIX session.
    "--unshare-pid",
    // Keep this explicit even though --unshare-all currently includes it.
    "--unshare-net",
    "--die-with-parent",
    // Make the command PID 1. When it exits, Linux tears down every remaining
    // process in the private PID namespace instead of leaving bwrap's normal
    // reaper alive for background descendants.
    "--as-pid-1",
    "--cap-drop",
    "ALL",
    // `/usr` supplies the core runtime. Optional distro-specific locations are
    // added below without ever binding the host root.
    "--ro-bind",
    "/usr",
    "/usr",
  ];

  for (const path of BWRAP_RUNTIME_DIRS) {
    args.push("--ro-bind-try", path, path);
  }
  for (const path of BWRAP_RUNTIME_FILES) {
    args.push("--ro-bind-try", path, path);
  }

  // Fresh kernel/process/device views and ephemeral storage. /var/run points
  // into the private /run, never at the host daemon sockets.
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--dir",
    "/var",
    "--symlink",
    "../tmp",
    "/var/tmp",
    "--symlink",
    "../run",
    "/var/run",
  );

  for (const root of roots) {
    args.push(opts.readOnly ? "--ro-bind" : "--bind", root, root);
  }
  if (roots[0]) args.push("--chdir", roots[0]);
  if (opts.seccompFd !== undefined) {
    args.push("--seccomp", String(opts.seccompFd));
  }
  args.push("--");
  return [...args, ...opts.command];
}

function seatbeltString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** Build the deny-by-default Seatbelt policy independently for inspection. */
export function buildSeatbeltProfile(
  opts: Pick<SandboxArgs, "writableRoots" | "readOnly" | "temporaryRoot">,
): string {
  const roots = normalizedRoots(opts.writableRoots);
  const runtimeSubpaths = [
    // Keep the sealed macOS runtime readable without admitting the writable
    // Data volume through a broad /System rule. Current macOS releases may
    // resolve parts of the runtime through the App cryptex, so enumerate only
    // the runtime-bearing directories there as well.
    "/System/Library",
    "/System/Cryptexes/App/System/Library",
    "/System/Cryptexes/App/usr/bin",
    "/System/Cryptexes/App/usr/sbin",
    "/System/Cryptexes/App/usr/lib",
    "/System/Cryptexes/App/usr/libexec",
    "/System/Cryptexes/App/usr/share",
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/Library/Frameworks",
    // Explicit, system-wide toolchain locations are a compatibility boundary.
    // Do not discover or admit per-user toolchains/home directories here.
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/opt/homebrew/lib",
    "/opt/homebrew/Cellar",
    "/opt/homebrew/opt",
    "/opt/homebrew/share",
  ];
  const runtimeFiles = [
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
    "/private/etc/group",
    "/private/etc/hosts",
    "/private/etc/localtime",
    "/private/etc/passwd",
  ];
  const temporaryRoot = opts.temporaryRoot;
  const profile = [
    "(version 1)",
    "(deny default)",
    // Shell commands do not get ambient network access. Networked operations
    // must go through a separately governed tool instead.
    "(deny network*)",
    // Permit command execution and pipelines without granting process-info
    // operations that could enumerate host processes or their environments.
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow file-read*",
    ...runtimeSubpaths.map((path) => `(subpath "${seatbeltString(path)}")`),
    ...runtimeFiles.map((path) => `(literal "${seatbeltString(path)}")`),
    ...roots.map((root) => `(subpath "${seatbeltString(root)}")`),
    ...(temporaryRoot ? [`(subpath "${seatbeltString(temporaryRoot)}")`] : []),
    ")",
  ];

  const writable = [
    ...(!opts.readOnly ? roots : []),
    ...(temporaryRoot ? [temporaryRoot] : []),
  ];
  if (writable.length > 0) {
    profile.push(
      "(allow file-write*",
      ...writable.map((root) => `(subpath "${seatbeltString(root)}")`),
      '(literal "/dev/null")',
      ")",
    );
  }

  return profile.join("\n");
}

/**
 * macOS Seatbelt (sandbox-exec) profile utility. This constrains capabilities
 * but is deliberately not selected by detectSandbox(): it is not a complete
 * process-lifecycle boundary for agent-controlled Bash.
 */
export function buildSeatbeltArgs(opts: SandboxArgs): string[] {
  const profile = buildSeatbeltProfile(opts);
  return ["/usr/bin/sandbox-exec", "-p", profile, "--", ...opts.command];
}

/**
 * seccomp deny baseline (B12-2): a cBPF program that returns EPERM for the
 * dangerous syscalls (ptrace, process_vm_readv/writev, io_uring_*) and ALLOW
 * for everything else. Returns a Uint8Array of 8-byte sock_filter structs,
 * ready to be handed to bwrap --seccomp.
 */
export function seccompDenyBaseline(arch: "x86_64" | "aarch64" = "x86_64"): Uint8Array {
  // AUDIT_ARCH values
  const AUDIT_ARCH_X86_64 = 0xc000003e;
  const AUDIT_ARCH_AARCH64 = 0xc00000b7;
  const archVal = arch === "aarch64" ? AUDIT_ARCH_AARCH64 : AUDIT_ARCH_X86_64;

  // Linux syscall numbers differ by architecture. io_uring uses the generic
  // numbering on both architectures, while ptrace and process_vm_* do not.
  const deniedByArch = {
    x86_64: [
      101, // ptrace
      310, // process_vm_readv
      311, // process_vm_writev
      425, // io_uring_setup
      426, // io_uring_enter
      427, // io_uring_register
    ],
    aarch64: [
      117, // ptrace
      270, // process_vm_readv
      271, // process_vm_writev
      425, // io_uring_setup
      426, // io_uring_enter
      427, // io_uring_register
    ],
  } as const;
  const denied = deniedByArch[arch];

  // cBPF instruction codes
  const BPF_LD = 0x00, BPF_W = 0x00, BPF_ABS = 0x20;
  const BPF_JMP = 0x05, BPF_JEQ = 0x10, BPF_K = 0x00;
  const BPF_RET = 0x06;
  const SECCOMP_RET_ALLOW = 0x7fff0000;
  const SECCOMP_RET_ERRNO_EPERM = 0x00050001;

  // Each sock_filter is { code:u16, jt:u8, jf:u8, k:u32 } = 8 bytes LE.
  const inst: Array<[number, number, number, number]> = [];
  // 1. Load arch (offset 4 of seccomp_data).
  inst.push([BPF_LD | BPF_W | BPF_ABS, 0, 0, 4]);
  // 2. A matching arch skips KILL and continues to the syscall-number load.
  // A mismatch falls through to KILL_PROCESS.
  inst.push([BPF_JMP | BPF_JEQ | BPF_K, 1, 0, archVal]);
  inst.push([BPF_RET | BPF_K, 0, 0, 0x80000000]); // KILL_PROCESS (bad arch)
  // 3. Load syscall number (offset 0).
  inst.push([BPF_LD | BPF_W | BPF_ABS, 0, 0, 0]);
  // 4. On a denied syscall jump over the remaining checks and ALLOW to the
  // ERRNO return. A non-match falls through to the very next check.
  const denyReturnIndex = inst.length + denied.length + 1;
  for (const syscall of denied) {
    const jumpToDeny = denyReturnIndex - (inst.length + 1);
    inst.push([BPF_JMP | BPF_JEQ | BPF_K, jumpToDeny, 0, syscall]);
  }
  inst.push([BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW]);
  inst.push([BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO_EPERM]);

  const buf = new Uint8Array(inst.length * 8);
  const dv = new DataView(buf.buffer);
  inst.forEach(([code, jt, jf, k], i) => {
    const off = i * 8;
    dv.setUint16(off, code, true);
    dv.setUint8(off + 2, jt);
    dv.setUint8(off + 3, jf);
    dv.setUint32(off + 4, k, true);
  });
  return buf;
}

/** Clean, actionable message for the failIfUnavailable LAW. */
export function sandboxUnavailable(
  mech: SandboxMechanism | string,
  platform = process.platform,
): string {
  const detail = mech ?? "no native sandbox mechanism found";
  if (platform === "darwin") {
    return "Native bash sandbox unavailable on darwin — refusing to run unsandboxed. macOS Seatbelt limits capabilities but cannot reliably terminate descendants entering a detached session; use Linux with /usr/bin/bwrap.";
  }
  if (platform === "win32") {
    return "Native bash sandbox unavailable on win32 — refusing to run unsandboxed. The bash tool requires Linux with /usr/bin/bwrap.";
  }
  return `Sandbox unavailable on ${platform} (${detail}) — refusing to run unsandboxed. The bash tool requires Linux with /usr/bin/bwrap.`;
}

/**
 * Materialize a seccomp program on an unlinked 0600 file and return a read fd
 * positioned at byte zero. The caller must close the fd after spawning bwrap.
 */
export function openSeccompFd(filter: Uint8Array): number {
  const dir = mkdtempSync(join(tmpdir(), "tenjin-seccomp-"));
  const path = join(dir, "filter.bpf");
  let fd: number | undefined;
  try {
    writeFileSync(path, Buffer.from(filter), { flag: "wx", mode: 0o600 });
    fd = openSync(path, "r");
    unlinkSync(path);
    rmSync(dir, { recursive: true, force: true });
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
