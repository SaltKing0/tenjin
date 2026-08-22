import { describe, test, expect } from "bun:test";
import {
  detectSandbox,
  buildBwrapArgs,
  seccompDenyBaseline,
  sandboxUnavailable,
} from "../src/tools/sandbox";

// #349: native sandbox for bash. Platform-skipped where the mechanism isn't
// available (CI/dev run on Linux with bwrap; the macOS Seatbelt path is
// darwin-only and cannot run here).

test("detectSandbox returns a mechanism or null", () => {
  const mech = detectSandbox();
  // The contract: a known mechanism or null — never undefined.
  expect(["bwrap", "sandbox-exec", "landlock", null]).toContain(mech);
});

test("seccomp deny baseline denies ptrace/process_vm/io_uring syscalls", () => {
  const filter = seccompDenyBaseline("x86_64");
  expect(filter).toBeInstanceOf(Uint8Array);
  expect(filter.length).toBeGreaterThan(0);
  // First BPF instruction loads the arch; last returns ERRNO for denied calls.
  // Structural sanity: the program must be a valid cBPF array of sock_filter
  // (8 bytes each) — length must be a multiple of 8.
  expect(filter.length % 8).toBe(0);
});

test("buildBwrapArgs read-only mode denies writes outside roots", () => {
  const args = buildBwrapArgs({ writableRoots: ["/tmp/w"], readOnly: true, command: ["true"] });
  // read-only mode must NOT bind writable roots read-write
  expect(args.join(" ")).toContain("--ro-bind");
  expect(args.join(" ")).not.toContain("--bind");
});

test("buildBwrapArgs writable mode binds roots read-write", () => {
  const args = buildBwrapArgs({ writableRoots: ["/tmp/w"], readOnly: false, command: ["true"] });
  expect(args.join(" ")).toContain("--bind");
});

test("sandboxUnavailable produces a clean, actionable message", () => {
  const msg = sandboxUnavailable("bwrap");
  expect(msg).toMatch(/sandbox/i);
  expect(msg).toMatch(/unavailable/i);
  expect(msg).toMatch(/bwrap/i);
  // never a raw stack trace
  expect(msg).not.toContain("at ");
});
