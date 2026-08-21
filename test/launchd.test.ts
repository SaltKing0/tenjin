import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "ops", "tenjin-launchd.sh");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tj-launchd-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake `bun` that records its argv into `marker` and exits 0. */
function writeBunStub(path: string, marker: string): void {
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> "$MARKER_FILE"\nexit 0\n`.replace("$MARKER_FILE", marker),
    { mode: 0o755 },
  );
}

/** A isolation env: isolated HOME, no overrides, no secrets file, no bun dirs. */
const baseEnv = () => ({
  HOME: dir,
  TENJIN_BUN: "",
  TENJIN_REPO: "",
  TENJIN_ENV_FILE: join(dir, "no-env-file"),
  PATH: "/usr/bin:/bin",
});

describe("ops/tenjin-launchd.sh (#242)", () => {
  test("TENJIN_BUN override is exec'd with the gateway command", () => {
    const marker = join(dir, "args.txt");
    const bun = join(dir, "override-bun");
    writeBunStub(bun, marker);
    const r = spawnSync("bash", [SCRIPT], {
      env: { ...baseEnv(), TENJIN_BUN: bun },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const args = readFileSync(marker, "utf8").trim();
    // exec'd as: <bun> run <repo>/src/index.ts gateway
    expect(args.startsWith("run ")).toBe(true);
    expect(args).toContain("src/index.ts");
    expect(args).toContain("gateway");
  });

  test("resolves bun via PATH when TENJIN_BUN is unset (non-Homebrew/Intel)", () => {
    const marker = join(dir, "args.txt");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const bun = join(binDir, "bun");
    writeBunStub(bun, marker);
    const r = spawnSync("bash", [SCRIPT], {
      env: { ...baseEnv(), PATH: `${binDir}:/usr/bin:/bin` },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const args = readFileSync(marker, "utf8").trim();
    expect(args.startsWith("run ")).toBe(true);
    expect(args).toContain("src/index.ts");
    expect(args).toContain("gateway");
  });

  test("fails with a clear message when bun is not found anywhere", () => {
    const r = spawnSync("bash", [SCRIPT], { env: baseEnv(), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TENJIN_BUN");
  });
});
