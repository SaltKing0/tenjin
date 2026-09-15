import { describe, test, expect } from "bun:test";
import { closeSync, readSync } from "node:fs";
import {
  detectSandbox,
  buildBwrapArgs,
  buildSeatbeltArgs,
  buildSeatbeltProfile,
  openSeccompFd,
  seccompDenyBaseline,
  sandboxUnavailable,
} from "../src/tools/sandbox";

// #349: native sandbox for bash. Argument/profile tests are platform-neutral;
// they do not require either mechanism to be installed.

test("detectSandbox returns a mechanism or null", () => {
  const mech = detectSandbox();
  // The contract: a known mechanism or null — never undefined.
  expect(["bwrap", null]).toContain(mech);
});

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_ALLOW = 0x7fff0000;

/** Minimal cBPF interpreter for the three opcodes emitted by the baseline. */
function evaluateFilter(filter: Uint8Array, arch: number, syscall: number): number {
  const view = new DataView(filter.buffer, filter.byteOffset, filter.byteLength);
  let accumulator = 0;
  let pc = 0;

  for (let steps = 0; steps < 100; steps++) {
    if (pc * 8 >= filter.byteLength) throw new Error(`BPF jumped past program at instruction ${pc}`);
    const offset = pc * 8;
    const code = view.getUint16(offset, true);
    const jumpTrue = view.getUint8(offset + 2);
    const jumpFalse = view.getUint8(offset + 3);
    const constant = view.getUint32(offset + 4, true);

    if (code === 0x20) {
      accumulator = constant === 4 ? arch : syscall;
      pc += 1;
      continue;
    }
    if (code === 0x15) {
      pc += 1 + (accumulator === constant ? jumpTrue : jumpFalse);
      continue;
    }
    if (code === 0x06) return constant;
    throw new Error(`Unsupported BPF opcode 0x${code.toString(16)}`);
  }

  throw new Error("BPF program did not terminate");
}

describe("seccomp deny baseline", () => {
  test("x86_64 denies ptrace, process_vm and io_uring with EPERM", () => {
    const filter = seccompDenyBaseline("x86_64");
    expect(filter).toBeInstanceOf(Uint8Array);
    expect(filter.length % 8).toBe(0);

    for (const syscall of [101, 310, 311, 425, 426, 427]) {
      expect(evaluateFilter(filter, AUDIT_ARCH_X86_64, syscall)).toBe(SECCOMP_RET_ERRNO_EPERM);
    }
    expect(evaluateFilter(filter, AUDIT_ARCH_X86_64, 39)).toBe(SECCOMP_RET_ALLOW);
    expect(evaluateFilter(filter, AUDIT_ARCH_AARCH64, 101)).toBe(SECCOMP_RET_KILL_PROCESS);
  });

  test("aarch64 uses its native ptrace and process_vm syscall numbers", () => {
    const filter = seccompDenyBaseline("aarch64");
    for (const syscall of [117, 270, 271, 425, 426, 427]) {
      expect(evaluateFilter(filter, AUDIT_ARCH_AARCH64, syscall)).toBe(SECCOMP_RET_ERRNO_EPERM);
    }
    expect(evaluateFilter(filter, AUDIT_ARCH_AARCH64, 101)).toBe(SECCOMP_RET_ALLOW);
    expect(evaluateFilter(filter, AUDIT_ARCH_X86_64, 117)).toBe(SECCOMP_RET_KILL_PROCESS);
  });

  test("openSeccompFd returns an unlinked readable fd positioned at byte zero", () => {
    const filter = seccompDenyBaseline("x86_64");
    const fd = openSeccompFd(filter);
    try {
      const actual = Buffer.alloc(filter.length);
      expect(readSync(fd, actual, 0, actual.length, null)).toBe(filter.length);
      expect(actual.equals(Buffer.from(filter))).toBe(true);
    } finally {
      closeSync(fd);
    }
  });
});

function hasSequence(args: string[], ...sequence: string[]): boolean {
  return args.some((_, i) => sequence.every((part, offset) => args[i + offset] === part));
}

function bindSources(args: string[]): string[] {
  const operations = new Set(["--bind", "--bind-try", "--ro-bind", "--ro-bind-try"]);
  return args.flatMap((arg, i) => (operations.has(arg) && args[i + 1] ? [args[i + 1]!] : []));
}

test("buildBwrapArgs creates a minimal root with private proc/dev/tmp/run", () => {
  const args = buildBwrapArgs({
    writableRoots: ["/tmp/w"],
    seccompFd: 3,
    command: ["/bin/true"],
  });
  expect(args[0]).toBe("/usr/bin/bwrap");
  expect(args).toContain("--unshare-all");
  expect(args).toContain("--unshare-pid");
  expect(args).toContain("--die-with-parent");
  expect(args).toContain("--as-pid-1");
  expect(args).not.toContain("--new-session");
  expect(hasSequence(args, "--proc", "/proc")).toBe(true);
  expect(hasSequence(args, "--dev", "/dev")).toBe(true);
  expect(hasSequence(args, "--tmpfs", "/tmp")).toBe(true);
  expect(hasSequence(args, "--tmpfs", "/run")).toBe(true);
  expect(hasSequence(args, "--symlink", "../run", "/var/run")).toBe(true);
  expect(hasSequence(args, "--cap-drop", "ALL")).toBe(true);
  expect(hasSequence(args, "--seccomp", "3")).toBe(true);

  const hostSources = bindSources(args);
  expect(hostSources).not.toContain("/");
  expect(hostSources).not.toContain("/run");
  expect(hostSources).not.toContain("/var/run");
  expect(hostSources).not.toContain("/tmp");
  expect(hostSources).not.toContain("/proc");
  expect(hostSources).not.toContain("/dev");
});

test("buildBwrapArgs read-only mode exposes the workspace read-only", () => {
  const args = buildBwrapArgs({ writableRoots: ["/tmp/w"], readOnly: true, command: ["/bin/true"] });
  expect(hasSequence(args, "--ro-bind", "/tmp/w", "/tmp/w")).toBe(true);
  expect(hasSequence(args, "--bind", "/tmp/w", "/tmp/w")).toBe(false);
});

test("buildBwrapArgs always isolates the network namespace", () => {
  const args = buildBwrapArgs({ writableRoots: [], command: ["true"] });
  const commandSeparator = args.indexOf("--");
  expect(args.slice(0, commandSeparator)).toContain("--unshare-all");
  expect(args.slice(0, commandSeparator)).toContain("--unshare-net");
  expect(args.slice(0, commandSeparator)).not.toContain("--share-net");
});

test("buildBwrapArgs writable mode binds roots read-write", () => {
  const args = buildBwrapArgs({ writableRoots: ["/tmp/w"], readOnly: false, command: ["/bin/true"] });
  expect(hasSequence(args, "--bind", "/tmp/w", "/tmp/w")).toBe(true);
  expect(hasSequence(args, "--chdir", "/tmp/w")).toBe(true);
});

test("buildBwrapArgs refuses to expose the host root as a workspace", () => {
  expect(() => buildBwrapArgs({ writableRoots: ["/"], command: ["/bin/true"] })).toThrow(
    /host root/,
  );
});

describe("macOS Seatbelt profile (inspection only; not a Bash lifecycle boundary)", () => {
  test("has no global network, process, sysctl, or file-read permission", () => {
    const profile = buildSeatbeltProfile({ writableRoots: ["/tmp/w"] });
    const rules = profile.split("\n");
    expect(profile).toContain("(deny network*)");
    expect(rules).not.toContain("(allow network*)");
    expect(rules).not.toContain("(allow process*)");
    expect(rules).not.toContain("(allow sysctl-read)");
    expect(rules).not.toContain("(allow file-read*)");
    expect(profile).toContain("(allow process-exec)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain('(subpath "/System/Library")');
    expect(profile).toContain('(subpath "/System/Cryptexes/App/System/Library")');
    expect(profile).toContain('(subpath "/tmp/w")');
    expect(profile).not.toContain("/Users/host");
    expect(profile).not.toContain("/var/run");
  });

  test("does not broadly expose System, usr, the Data volume, or usr-local", () => {
    const profile = buildSeatbeltProfile({ writableRoots: ["/tmp/w"] });
    const rules = profile.split("\n");

    expect(rules).not.toContain('(subpath "/System")');
    expect(rules).not.toContain('(subpath "/usr")');
    expect(profile).not.toContain("/System/Volumes/Data");
    expect(profile).not.toContain("/usr/local");
    for (const path of ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share"]) {
      expect(rules).toContain(`(subpath "${path}")`);
    }
  });

  test("read-only mode contains no file-write allowance", () => {
    const profile = buildSeatbeltProfile({ writableRoots: ["/tmp/w"], readOnly: true });
    expect(profile).not.toContain("(allow file-write*");
  });

  test("writable mode scopes writes and escapes profile strings", () => {
    const profile = buildSeatbeltProfile({ writableRoots: ['/tmp/a"b\\c'] });
    expect(profile).toContain("(allow file-write*");
    expect(profile).toContain('(subpath "/tmp/a\\"b\\\\c")');
  });

  test("uses inline profile and scopes an isolated temp directory", () => {
    const args = buildSeatbeltArgs({
      writableRoots: ["/tmp/w"],
      temporaryRoot: "/private/tmp/tenjin-private",
      command: ["/bin/true"],
    });
    expect(args[0]).toBe("/usr/bin/sandbox-exec");
    expect(args[1]).toBe("-p");
    expect(args).not.toContain("-f");
    expect(args[2]).toContain('(subpath "/private/tmp/tenjin-private")');
    expect(args).not.toContain("/tmp/tenjin-seatbelt");
  });
});

test("sandboxUnavailable produces a clean, actionable message", () => {
  const msg = sandboxUnavailable("bwrap");
  expect(msg).toMatch(/sandbox/i);
  expect(msg).toMatch(/unavailable/i);
  expect(msg).toMatch(/bwrap/i);
  // never a raw stack trace
  expect(msg).not.toMatch(/\n\s*at\s/);
});

test("sandboxUnavailable explains the intentionally unsupported Windows boundary", () => {
  const msg = sandboxUnavailable(null, "win32");
  expect(msg).toMatch(/win32/i);
  expect(msg).toMatch(/refusing to run unsandboxed/i);
  expect(msg).toMatch(/linux.*bwrap/i);
});

test("sandboxUnavailable explains why macOS Seatbelt Bash fails closed", () => {
  const msg = sandboxUnavailable("sandbox-exec", "darwin");
  expect(msg).toMatch(/darwin/i);
  expect(msg).toMatch(/refusing to run unsandboxed/i);
  expect(msg).toMatch(/cannot reliably terminate descendants/i);
  expect(msg).toMatch(/linux.*bwrap/i);
});
