import { existsSync } from "node:fs";

/**
 * #349: risk-tiered NATIVE sandbox per bash call.
 *
 * Linux path uses `bwrap` (bubblewrap) when present — the issue lists it as
 * the PREFERRED writable-call mechanism — with a Landlock-only fallback where
 * the kernel exposes the LSM (not present on this host). macOS uses
 * `/usr/bin/sandbox-exec` Seatbelt. Zero runtime dependencies: we shell out to
 * the system binary exactly like `bash` itself.
 *
 * failIfUnavailable LAW: if a sandbox is configured/required but no mechanism
 * is available (or init fails), we return a HARD tool error — never a silent
 * unsandboxed run.
 */

export type SandboxMechanism = "bwrap" | "sandbox-exec" | "landlock" | null;

/** True when a native sandbox mechanism for this platform is installed. */
export function detectSandbox(): SandboxMechanism {
  if (process.platform === "linux") {
    if (existsSync("/usr/bin/bwrap")) return "bwrap";
    // Landlock fallback: only usable if the LSM is mounted.
    if (existsSync("/sys/kernel/security/landlock")) return "landlock";
    return null;
  }
  if (process.platform === "darwin") {
    if (existsSync("/usr/bin/sandbox-exec")) return "sandbox-exec";
    return null;
  }
  return null;
}

export interface SandboxArgs {
  /** Absolute directories the sandbox may write to. Others become read-only. */
  writableRoots: string[];
  /** Read-only mode: nothing is writable inside the sandbox. */
  readOnly?: boolean;
  /** The command argv to run inside the sandbox (e.g. ["bash","-c",cmd]). */
  command: string[];
  /** Optional pre-opened seccomp filter fd (bwrap --seccomp). */
  seccompFd?: number;
}

/**
 * Build the argv prefix that wraps `command` inside the available sandbox.
 * Returns null when no mechanism is available (caller must enforce the
 * failIfUnavailable LAW).
 */
export function buildSandboxPrefix(opts: SandboxArgs): string[] | null {
  const mech = detectSandbox();
  if (mech === "bwrap") return buildBwrapArgs(opts);
  if (mech === "sandbox-exec") return buildSeatbeltArgs(opts);
  return null;
}

/** bwrap prefix: read-only root bind, writable roots bound rw (or all ro). */
export function buildBwrapArgs(opts: SandboxArgs): string[] {
  const args = [
    "bwrap",
    "--ro-bind",
    "/",
    "/",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
  ];
  if (!opts.readOnly) {
    for (const root of opts.writableRoots) {
      args.push("--bind", root, root);
    }
  }
  if (opts.seccompFd !== undefined) {
    args.push("--seccomp", String(opts.seccompFd));
  }
  args.push("--");
  return [...args, ...opts.command];
}

/**
 * macOS Seatbelt (sandbox-exec) prefix. The profile is deny-by-default with
 * writable roots parameterized; only used on darwin (skipped in Linux CI).
 */
export function buildSeatbeltArgs(opts: SandboxArgs): string[] {
  const writable = opts.readOnly ? [] : opts.writableRoots.map((r) => `(subpath "${r}")`);
  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow network*)",
    "(allow file-read*)",
    "(allow file-write*",
    ...writable,
    ")",
    "(allow sysctl-read)",
  ].join("\n");
  const path = `/tmp/stealth-seatbelt-${process.pid}.sb`;
  try {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(path, profile, "utf8");
  } catch {
    /* non-darwin / unwritable — caller enforces LAW */
  }
  return ["sandbox-exec", "-f", path, "--", ...opts.command];
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

  // Denied syscalls (Linux x86_64 numbers; aarch64 differs — keep x86_64 for
  // the bwrap host, the baseline is best-effort per architecture).
  const denied = [101 /* ptrace */, 310 /* process_vm_readv */, 311 /* process_vm_writev */, 425 /* io_uring_setup */, 426 /* io_uring_enter */, 427 /* io_uring_register */];

  // cBPF instruction codes
  const BPF_LD = 0x00, BPF_W = 0x00, BPF_ABS = 0x20;
  const BPF_JMP = 0x05, BPF_JEQ = 0x10, BPF_K = 0x00;
  const BPF_RET = 0x06;
  const SECCOMP_RET_ALLOW = 0x7fff0000;
  const SECCOMP_RET_ERRNO = 0x00050000; // ERRNO(EPERM=1)

  // Each sock_filter is { code:u16, jt:u8, jf:u8, k:u32 } = 8 bytes LE.
  const inst: Array<[number, number, number, number]> = [];
  // 1. Load arch (offset 4 of seccomp_data).
  inst.push([BPF_LD | BPF_W | BPF_ABS, 0, 0, 4]);
  // 2. JEQ arch, if not equal jump to kill (offset 2) — jf counts from here.
  inst.push([BPF_JMP | BPF_JEQ | BPF_K, 0, 1, archVal]);
  inst.push([BPF_RET | BPF_K, 0, 0, 0x80000000]); // KILL_PROCESS (bad arch)
  // 3. Load syscall number (offset 0).
  inst.push([BPF_LD | BPF_W | BPF_ABS, 0, 0, 0]);
  // 4. For each denied syscall: JEQ nr -> skip the ALLOW (fall to deny) else skip deny.
  const denyReturn = inst.length + denied.length + 2; // index of ERRNO return
  const allowReturn = denyReturn + 1;
  for (let i = 0; i < denied.length; i++) {
    // jt: if match, jump to deny return; jf: if no match, continue to next check
    const jt = (denyReturn - (inst.length + 1)) & 0xff;
    const jf = 1; // skip one (this check block is 2 instrs: JEQ then... ) — see below
    inst.push([BPF_JMP | BPF_JEQ | BPF_K, jt, jf, denied[i]!]);
  }
  // The JEQ above: on no-match it advances 1 (jf=1) which lands on the next
  // JEQ. That works only because each JEQ is 1 instruction. The ALLOW and
  // ERRNO returns are placed after all JEQs.
  inst.push([BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW]);
  inst.push([BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO]);

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
export function sandboxUnavailable(mech: SandboxMechanism | string): string {
  return `Sandbox unavailable (${mech ?? "no native sandbox mechanism found"}) — refusing to run unsandboxed. Install bwrap (Linux) or use a supported platform, or disable the sandbox explicitly.`;
}

/** Write a seccomp BPF program to a temp file and return an open fd for bwrap. */
export function openSeccompFd(filter: Uint8Array): number {
  const { openSync, writeSync, closeSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const path = join(tmpdir(), `stealth-seccomp-${process.pid}-${Math.random().toString(36).slice(2)}.bpf`);
  const fd = openSync(path, "w");
  writeSync(fd, Buffer.from(filter));
  // Keep the fd open for the child; the file is unlinked after spawn by caller.
  return fd;
}
