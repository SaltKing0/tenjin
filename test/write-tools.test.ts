import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/tools/registry";
import { atomicWrite } from "../src/tools/atomic";
import { writeTool } from "../src/tools/write";
import { editTool } from "../src/tools/edit";
import { createBashTool } from "../src/tools/bash";
import { SecurityGuard, DEFAULT_BLOCKED_PATTERNS } from "../src/security/guard";

// Shell behavior is tested independently of native-sandbox availability. The
// production singleton never grants this host-only escape hatch.
const tools = [writeTool, editTool, createBashTool(process.env, { allowUnsandboxed: true })];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenjin-write-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("write_file", () => {
  test("creates file and parent dirs", async () => {
    const r = await dispatch(
      tools,
      "write_file",
      { path: "deep/nested/file.txt", content: "hello" },
      { cwd: dir },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("5 bytes");
    expect(readFileSync(join(dir, "deep/nested/file.txt"), "utf8")).toBe("hello");
  });

  test("overwrites existing file", async () => {
    writeFileSync(join(dir, "f.txt"), "old");
    await dispatch(tools, "write_file", { path: "f.txt", content: "new" }, { cwd: dir });
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("new");
  });
});

// #315: writes go through a same-dir temp file + atomic rename — a crash or
// partial write must never corrupt the destination, and the temp is cleaned up.
describe("atomic writes", () => {
  test("write_file and edit_file leave no temp residue", async () => {
    await dispatch(tools, "write_file", { path: "a.txt", content: "hello" }, { cwd: dir });
    await dispatch(
      tools,
      "edit_file",
      { path: "a.txt", oldString: "hello", newString: "world" },
      { cwd: dir },
    );
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("world");
    expect(readdirSync(dir).filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  // The TOCTOU re-check is what matters: dispatch validates the requested path
  // up front, but a symlink swapped in between that check and the write must not
  // redirect the write outside the workspace. atomicWrite re-resolves the real
  // path immediately before writing and re-checks containment.
  test("write_file blocked when a symlink escapes the workspace (#315)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "tenjin-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "tenjin-out-"));
    const outsideFile = join(outside, "data.txt");
    writeFileSync(outsideFile, "original");
    const link = join(ws, "link.txt");
    symlinkSync(outsideFile, link);
    const guard = new SecurityGuard([...DEFAULT_BLOCKED_PATTERNS], undefined, {
      workspaceRoot: ws,
    });
    try {
      await expect(
        atomicWrite(link, "pwned", { guard, toolName: "write_file", cwd: ws }),
      ).rejects.toThrow(/outside the workspace/);
      expect(readFileSync(outsideFile, "utf8")).toBe("original");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("edit_file", () => {
  beforeEach(() => writeFileSync(join(dir, "code.ts"), "const a = 1;\nconst b = 2;\n"));

  const edit = (args: Record<string, unknown>) =>
    dispatch(tools, "edit_file", args, { cwd: dir });

  test("unique replacement succeeds", async () => {
    const r = await edit({ path: "code.ts", oldString: "const a = 1;", newString: "const a = 42;" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toContain("const a = 42;");
  });

  test("ambiguous match rejected without replaceAll", async () => {
    writeFileSync(join(dir, "dup.ts"), "x\nx\n");
    const r = await edit({ path: "dup.ts", oldString: "x", newString: "y" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("2 occurrences");
    expect(readFileSync(join(dir, "dup.ts"), "utf8")).toBe("x\nx\n");
  });

  test("replaceAll replaces every occurrence", async () => {
    writeFileSync(join(dir, "dup.ts"), "x\nx\n");
    const r = await edit({ path: "dup.ts", oldString: "x", newString: "y", replaceAll: true });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Replaced 2");
    expect(readFileSync(join(dir, "dup.ts"), "utf8")).toBe("y\ny\n");
  });

  test("not found is an error", async () => {
    const r = await edit({ path: "code.ts", oldString: "nope", newString: "yes" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not found");
  });

  test("identical strings rejected", async () => {
    const r = await edit({ path: "code.ts", oldString: "a", newString: "a" });
    expect(r.ok).toBe(false);
  });
});

describe("bash", () => {
  const run = (args: Record<string, unknown>) =>
    dispatch(tools, "bash", { sandbox: "off", ...args }, { cwd: dir });

  test("captures stdout and exit code", async () => {
    const r = await run({ command: "echo hello" });
    expect(r.output).toContain("exit: 0");
    expect(r.output).toContain("hello");
  });

  test("captures stderr of failing commands", async () => {
    const r = await run({ command: "echo oops >&2; exit 3" });
    expect(r.output).toContain("exit: 3");
    expect(r.output).toContain("oops");
  });

  test("runs in tool cwd", async () => {
    const r = await run({ command: "pwd" });
    expect(r.output).toContain(dir);
  });

  test("timeout kills long commands", async () => {
    const r = await run({ command: "sleep 5", timeoutMs: 300 });
    expect(r.output).toMatch(/killed|137/);
  }, 10_000);

  test("missing command arg reported by registry", async () => {
    const r = await run({});
    expect(r.ok).toBe(false);
    expect(r.output).toContain("command");
  });
});
