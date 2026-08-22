import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../src/tools/atomic";

// WP 1.1 (#339): atomicWrite must be a same-directory temp+rename swap —
// a crash or partial write mid-call must never corrupt the destination, and
// the temp file is always cleaned up. These tests exercise the helper
// directly (write_file / edit_file are already routed through it).

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenjin-atomic-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tmpResidue = (root: string = dir): string[] =>
  readdirSync(root).filter((e) => e.endsWith(".tmp"));

describe("atomicWrite", () => {
  test("happy path: content lands and no temp residue remains", async () => {
    const target = join(dir, "deep", "nested", "a.txt");
    await atomicWrite(target, "hello world");
    expect(readFileSync(target, "utf8")).toBe("hello world");
    // parent dirs were created; nothing temp left in the target dir
    expect(tmpResidue(join(dir, "deep", "nested"))).toEqual([]);
  });

  test("happy path: overwrite replaces previous bytes, no residue", async () => {
    const target = join(dir, "b.txt");
    writeFileSync(target, "old content");
    await atomicWrite(target, "new content");
    expect(readFileSync(target, "utf8")).toBe("new content");
    expect(tmpResidue()).toEqual([]);
  });

  test("mid-write failure leaves the ORIGINAL file byte-identical", async () => {
    const target = join(dir, "f.txt");
    writeFileSync(target, "original");

    // A read-only target directory makes the temp-file write fail (creating a
    // new file needs directory write permission). Runs as non-root (uid 1000).
    chmodSync(dir, 0o555);
    try {
      await expect(atomicWrite(target, "pwned")).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }

    // The destination was never touched — the rename never happened.
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(tmpResidue()).toEqual([]);
  });

  test("mid-commit failure (rename target collides) cleans up and leaves target intact", async () => {
    // Target is an existing non-empty directory: rename(file, dir) fails, so
    // the swap cannot happen. Deterministic under any uid.
    const target = join(dir, "blocked");
    mkdirSync(target);
    writeFileSync(join(target, "inner.txt"), "inside");

    await expect(atomicWrite(target, "x")).rejects.toThrow();
    expect(readFileSync(join(target, "inner.txt"), "utf8")).toBe("inside");
    expect(tmpResidue()).toEqual([]);
  });

  test("concurrent writers: last complete rename wins, never interleaved bytes", async () => {
    const target = join(dir, "c.txt");
    // Distinct full payloads, all the same length: any interleaved mix would
    // fail to match one of them exactly.
    const payloads = Array.from({ length: 20 }, (_, i) =>
      "A".repeat(i) + "B".repeat(200 - i),
    );
    await Promise.all(payloads.map((p) => atomicWrite(target, p)));

    const final = readFileSync(target, "utf8");
    expect(final.length).toBe(200);
    expect(payloads).toContain(final);
    expect(tmpResidue()).toEqual([]);
  });
});
