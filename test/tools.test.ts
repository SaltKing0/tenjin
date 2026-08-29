import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, schemas } from "../src/tools/registry";
import { readTool } from "../src/tools/read";
import { globTool } from "../src/tools/glob";
import { grepTool } from "../src/tools/grep";
import { SecurityGuard } from "../src/security/guard";

const tools = [readTool, globTool, grepTool];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenjin-tools-"));
  writeFileSync(join(dir, "a.ts"), "line one\nline two\nline three\n");
  writeFileSync(join(dir, "b.json"), '{\n  "name": "x"\n}\n');
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.ts"), "const needle = 1;\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "d.ts"), "needle in deps\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("schemas expose name/description/inputSchema", () => {
  const s = schemas(tools);
  expect(s.map((t) => t.name)).toEqual(["read_file", "glob", "grep"]);
  expect(s[0]?.inputSchema.required).toEqual(["path"]);
});

test("dispatch reports unknown tool and missing args", async () => {
  expect((await dispatch(tools, "nope", {}, { cwd: dir })).ok).toBe(false);
  const r = await dispatch(tools, "read_file", {}, { cwd: dir });
  expect(r.ok).toBe(false);
  expect(r.output).toContain("path");
});

// --- error-path sweep (#338): a handler exception must surface as a clean,
// actionable one-line message — never "[object Object]" or a raw stack trace. ---

test("handler throwing an Error surfaces its message, not a stack trace", async () => {
  const boomTool = {
    name: "boom",
    group: "read" as const,
    description: "throws",
    inputSchema: { type: "object" as const, properties: {} },
    async handler() {
      throw new Error("boom happened\n    at boom (/app/src/tools/boom.ts:3:5)");
    },
  };
  const r = await dispatch([boomTool], "boom", {}, { cwd: dir });
  expect(r.ok).toBe(false);
  expect(r.output).toBe("boom happened");
  expect(r.output).not.toContain("at boom");
});

test("handler throwing a non-Error object never leaks [object Object]", async () => {
  const boomTool = {
    name: "boom",
    group: "read" as const,
    description: "throws",
    inputSchema: { type: "object" as const, properties: {} },
    async handler() {
      throw { code: 13, detail: "oops" }; // non-Error value
    },
  };
  const r = await dispatch([boomTool], "boom", {}, { cwd: dir });
  expect(r.ok).toBe(false);
  expect(r.output).not.toContain("[object Object]");
  expect(r.output.length).toBeGreaterThan(0);
});

test("handler throwing a bare string surfaces it cleanly", async () => {
  const boomTool = {
    name: "boom",
    group: "read" as const,
    description: "throws",
    inputSchema: { type: "object" as const, properties: {} },
    async handler() {
      throw "disk full"; // bare string
    },
  };
  const r = await dispatch([boomTool], "boom", {}, { cwd: dir });
  expect(r.ok).toBe(false);
  expect(r.output).toBe("disk full");
});

describe("read_file", () => {
  test("numbered lines with default window", async () => {
    const r = await dispatch(tools, "read_file", { path: "a.ts" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("1: line one\n2: line two\n3: line three");
  });

  test("offset/limit window with truncation note", async () => {
    const r = await dispatch(
      tools,
      "read_file",
      { path: "a.ts", offset: 2, limit: 1 },
      { cwd: dir },
    );
    expect(r.output).toContain("2: line two");
    expect(r.output).toContain("[showing lines 2-2 of 3]");
  });

  test("errors on directory and missing file", async () => {
    expect((await dispatch(tools, "read_file", { path: "sub" }, { cwd: dir })).ok).toBe(false);
    expect((await dispatch(tools, "read_file", { path: "nope.ts" }, { cwd: dir })).ok).toBe(false);
  });

  test("redacts a complete secret before the per-line cap can split it", async () => {
    const secret = `AKIA${"A".repeat(16)}`;
    writeFileSync(join(dir, "long-secret.txt"), `${"x".repeat(1987)} ${secret} tail\n`);
    const r = await dispatch(tools, "read_file", { path: "long-secret.txt" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[REDACTED]");
    expect(r.output).not.toContain(secret);
    expect(r.output).not.toContain("AKIA");
  });

  test("redacts a multiline private key before selecting lines", async () => {
    writeFileSync(
      join(dir, "notes.txt"),
      "before\n-----BEGIN PRIVATE KEY-----\nopaque-body-line-one\nopaque-body-line-two\n-----END PRIVATE KEY-----\nafter\n",
    );
    const r = await dispatch(tools, "read_file", { path: "notes.txt" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("2: -----BEGIN PRIVATE KEY-----");
    expect(r.output).toContain("3: [REDACTED]");
    expect(r.output).toContain("5: -----END PRIVATE KEY-----");
    expect(r.output).toContain("6: after");
    expect(r.output).not.toContain("opaque-body");
  });
});

describe("glob", () => {
  test("finds files by pattern, skips directories", async () => {
    const r = await dispatch(tools, "glob", { pattern: "**/*.ts" }, { cwd: dir });
    expect(r.output).toContain("a.ts");
    expect(r.output).toContain(join("sub", "c.ts"));
  });

  test("no matches message", async () => {
    const r = await dispatch(tools, "glob", { pattern: "*.xyz" }, { cwd: dir });
    expect(r.output).toContain("No files match");
  });
});

describe("grep", () => {
  test("regex search with path:line:text output", async () => {
    const r = await dispatch(tools, "grep", { pattern: "needle" }, { cwd: dir });
    expect(r.output).toContain(join("sub", "c.ts") + ":1:");
    expect(r.output).not.toContain("node_modules");
  });

  test("include filter restricts filenames", async () => {
    const r = await dispatch(
      tools,
      "grep",
      { pattern: "name", include: "*.json" },
      { cwd: dir },
    );
    expect(r.output).toContain("b.json");
  });

  test("case insensitive flag", async () => {
    const r = await dispatch(
      tools,
      "grep",
      { pattern: "LINE ONE", caseInsensitive: true },
      { cwd: dir },
    );
    expect(r.output).toContain("a.ts:1:");
  });

  test("invalid regex handled", async () => {
    const r = await dispatch(tools, "grep", { pattern: "(" }, { cwd: dir });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Invalid regex");
  });

  test("binary files skipped without error", async () => {
    writeFileSync(join(dir, "bin.dat"), new Uint8Array([0, 159, 1, 0]));
    const r = await dispatch(tools, "grep", { pattern: "." }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain("bin.dat");
  });

  test("skips files blocked by the security guard (#307)", async () => {
    writeFileSync(join(dir, ".env"), "SECRET=needle\n");
    const guard = new SecurityGuard([".env"]);
    const r = await dispatch(tools, "grep", { pattern: "needle" }, { cwd: dir, guard });
    expect(r.ok).toBe(true);
    // the guarded .env must not leak its contents, but a normal file still matches
    expect(r.output).toContain(join("sub", "c.ts") + ":1:");
    expect(r.output).not.toContain(".env");
    expect(r.output).not.toContain("SECRET");
  });

  test("redacts a complete matching line before its result cap", async () => {
    const secret = `AKIA${"B".repeat(16)}`;
    writeFileSync(join(dir, "long-match.txt"), `${"x".repeat(287)} ${secret} needle\n`);
    const r = await dispatch(tools, "grep", { pattern: "needle" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[REDACTED]");
    expect(r.output).not.toContain(secret);
    expect(r.output).not.toContain("AKIA");
  });

  test("does not expose body lines from a multiline private key", async () => {
    writeFileSync(
      join(dir, "key-notes.txt"),
      "-----BEGIN PRIVATE KEY-----\nopaque-needle-body\n-----END PRIVATE KEY-----\n",
    );
    const r = await dispatch(tools, "grep", { pattern: "opaque|REDACTED" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("key-notes.txt:2: [REDACTED]");
    expect(r.output).not.toContain("opaque-needle-body");
  });
});
