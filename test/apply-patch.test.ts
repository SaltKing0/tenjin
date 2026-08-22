import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/tools/registry";
import { applyPatchTool } from "../src/tools/apply-patch";
import { SecurityGuard, DEFAULT_BLOCKED_PATTERNS } from "../src/security/guard";

const tools = [applyPatchTool];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenjin-patch-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ap = (patch: string, ctx: Record<string, unknown> = {}) =>
  dispatch(tools, "apply_patch", { patch }, { cwd: dir, ...ctx });

describe("apply_patch happy path", () => {
  test("multi-file add/update/delete lands exactly", async () => {
    writeFileSync(join(dir, "existing.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "del.txt"), "bye\n");

    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "hello world",
      "second line",
      "*** Update File: existing.txt",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+line2 changed",
      " line3",
      "*** Delete File: del.txt",
      "*** End Patch",
    ].join("\n");

    const r = await ap(patch);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("applied 3 file(s)");
    // add
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("hello world\nsecond line\n");
    // update — context preserved, removal replaced
    expect(readFileSync(join(dir, "existing.txt"), "utf8")).toBe(
      "line1\nline2 changed\nline3\n",
    );
    // delete
    expect(existsSync(join(dir, "del.txt"))).toBe(false);
  });

  test("group is write so guard/approval/budget apply", () => {
    expect(applyPatchTool.group).toBe("write");
  });
});

describe("apply_patch validation", () => {
  test("malformed hunk rejected BEFORE any file is touched (disk unchanged)", async () => {
    // First section is a perfectly valid add; second is a malformed hunk.
    const patch = [
      "*** Add File: a.txt",
      "created",
      "*** Update File: existing.txt",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "THIS IS NOT A PATCH LINE",
      " line3",
    ].join("\n");
    writeFileSync(join(dir, "existing.txt"), "line1\nline2\nline3\n");

    const r = await ap(patch);
    expect(r.ok).toBe(false);
    // Nothing was touched: a.txt must not exist, existing.txt unchanged.
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
    expect(readFileSync(join(dir, "existing.txt"), "utf8")).toBe("line1\nline2\nline3\n");
  });

  test("add to an existing file is rejected pre-touch", async () => {
    writeFileSync(join(dir, "a.txt"), "old");
    const patch = "*** Add File: a.txt\nnew\n";
    const r = await ap(patch);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("already exists");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old");
  });

  test("update of a missing file is rejected pre-touch", async () => {
    const patch = "*** Update File: nope.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    const r = await ap(patch);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("does not exist");
  });

  test("unknown top-level syntax rejects the whole patch", async () => {
    const r = await ap("garbage line\n*** Add File: a.txt\nx\n");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("unknown top-level syntax");
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });
});

describe("apply_patch rollback", () => {
  test("partial failure rolls back already-applied files (byte-identical)", async () => {
    // a.txt (add) lives in the writable root; sub/b.txt (update) lives in a
    // read-only directory so its atomic write fails after a.txt succeeded.
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.txt"), "x\n");
    chmodSync(join(dir, "sub"), 0o555);
    try {
      const patch = [
        "*** Add File: a.txt",
        "created",
        "*** Update File: sub/b.txt",
        "@@ -1,1 +1,1 @@",
        "-x",
        "+y",
      ].join("\n");
      const r = await ap(patch);
      expect(r.ok).toBe(false);
      // a.txt was created then rolled back — must be gone.
      expect(existsSync(join(dir, "a.txt"))).toBe(false);
      // b.txt untouched, byte-identical.
      expect(readFileSync(join(dir, "sub", "b.txt"), "utf8")).toBe("x\n");
    } finally {
      chmodSync(join(dir, "sub"), 0o755);
    }
  });
});

describe("apply_patch guard + audit", () => {
  test("guard blocks targets outside the workspace pre-touch", async () => {
    const ws = mkdtempSync(join(tmpdir(), "tenjin-patch-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "tenjin-patch-out-"));
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "keep\n");
    const guard = new SecurityGuard([...DEFAULT_BLOCKED_PATTERNS], undefined, {
      workspaceRoot: ws,
    });
    try {
      const patch = [
        "*** Update File: " + outsideFile,
        "@@ -1,1 +1,1 @@",
        "-keep",
        "+pwned",
      ].join("\n");
      const r = await dispatch(tools, "apply_patch", { patch }, { cwd: ws, guard });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("blocked by security policy");
      expect(readFileSync(outsideFile, "utf8")).toBe("keep\n");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("emits one write_exec audit entry per touched file", async () => {
    writeFileSync(join(dir, "existing.txt"), "line1\n");
    const audit: string[] = [];
    let seenCorr: string | undefined;
    const patch = [
      "*** Add File: new.txt",
      "hi",
      "*** Update File: existing.txt",
      "@@ -1,1 +1,2 @@",
      " line1",
      "+line2",
    ].join("\n");
    const r = await ap(patch, {
      audit: (kind: "write_exec", detail: string, corr?: string) => {
        audit.push(`${kind}|${detail}`);
        seenCorr = corr;
      },
      correlationId: "corr-42",
    });
    expect(r.ok).toBe(true);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toBe("write_exec|apply_patch add new.txt");
    expect(audit[1]).toBe("write_exec|apply_patch update existing.txt");
    expect(seenCorr).toBe("corr-42");
  });
});
