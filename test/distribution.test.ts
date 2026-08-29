import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DIST_TARGETS,
  resolveDistTarget,
  computeChecksum,
  buildChecksumsFile,
} from "../src/dist";

describe("distribution target matrix (6 artifacts)", () => {
  test("covers linux/darwin/windows × x64/arm64", () => {
    expect(DIST_TARGETS).toHaveLength(6);
    const key = (t: { platform: string; arch: string }) => `${t.platform}/${t.arch}`;
    expect(new Set(DIST_TARGETS.map(key))).toEqual(
      new Set([
        "linux/x64",
        "linux/arm64",
        "darwin/x64",
        "darwin/arm64",
        "windows/x64",
        "windows/arm64",
      ]),
    );
  });

  test("each target maps to a bun --compile target with correct extension", () => {
    expect(resolveDistTarget("linux", "x64")?.bunTarget).toBe("bun-linux-x64");
    expect(resolveDistTarget("linux", "x64")?.ext).toBe("");
    expect(resolveDistTarget("darwin", "arm64")?.bunTarget).toBe("bun-darwin-arm64");
    expect(resolveDistTarget("windows", "x64")?.bunTarget).toBe("bun-windows-x64");
    expect(resolveDistTarget("windows", "x64")?.ext).toBe(".exe");
  });

  test("unsupported platform/arch resolves to null (graceful failure)", () => {
    expect(resolveDistTarget("linux", "mips")).toBeNull();
    expect(resolveDistTarget("plan9", "x64")).toBeNull();
    expect(resolveDistTarget("windows", "riscv")).toBeNull();
  });
});

describe("checksums", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dist-checksum-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("computeChecksum is a stable sha256 and verifies round-trip", async () => {
    const f = join(dir, "tenjin.bin");
    writeFileSync(f, "hello checksum\n");
    const cs = await computeChecksum(f);
    expect(cs).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeChecksum(f)).toBe(cs); // deterministic
  });

  test("buildChecksumsFile emits sha256-style lines", async () => {
    const f = join(dir, "tenjin.bin");
    writeFileSync(f, "hello checksum\n");
    const cs = await computeChecksum(f);
    const file = buildChecksumsFile([{ name: "tenjin.bin", hash: cs }]);
    expect(file).toBe(`${cs}  tenjin.bin\n`);
  });
});

describe("installer script", () => {
  const installer = join(import.meta.dir, "..", "install.sh");

  test("fails gracefully on an unsupported platform", () => {
    let stderr = "";
    let code = 0;
    try {
      execFileSync("sh", [installer, "--platform=plan9", "--arch=x64"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      code = e.status ?? 1;
      stderr = String(e.stderr ?? "");
    }
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/unsupported|unknown|not supported/i);
  });

  test("shell syntax is valid (shellcheck-clean baseline)", () => {
    // `sh -n` parses without executing — a syntax error would throw here.
    execFileSync("sh", ["-n", installer]);
  });

  test("installs under the stable tenjin command name", () => {
    const destination = mkdtempSync(join(tmpdir(), "tenjin-installer-name-"));
    try {
      const result = execFileSync(
        "sh",
        [installer, "--platform=linux", "--arch=x64", `--dir=${destination}`],
        {
          env: { ...process.env, SKIP_DOWNLOAD: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).toString();
      void result;
    } catch (error: any) {
      throw new Error(String(error.stderr ?? error));
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }

    const script = readFileSync(installer, "utf8");
    expect(script).toContain('INSTALL_NAME="tenjin${EXT}"');
    expect(script).toContain('mv "$DOWNLOADED" "${DEST}/${INSTALL_NAME}"');
  });

  test("uses authenticated gh downloads for a private release", () => {
    const root = mkdtempSync(join(tmpdir(), "tenjin-private-installer-"));
    const fakeBin = join(root, "fake-bin");
    const destination = join(root, "install");
    mkdirSync(fakeBin);
    mkdirSync(destination);
    const payload = "private release binary";
    const hash = createHash("sha256").update(payload).digest("hex");
    const fakeGh = join(fakeBin, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
[ "\${GH_TOKEN:-}" = "test-private-token" ] || exit 42
DEST=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--dir" ]; then
    shift
    DEST="$1"
  fi
  shift
done
[ -n "$DEST" ] || exit 43
printf '%s' '${payload}' > "$DEST/tenjin-linux-x64"
printf '%s  %s\n' '${hash}' 'tenjin-linux-x64' > "$DEST/SHA256SUMS"
`,
    );
    chmodSync(fakeGh, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      GH_TOKEN: "test-private-token",
      GITHUB_TOKEN: "",
      SKIP_DOWNLOAD: "",
    };
    delete env.TENJIN_RELEASES_URL;

    try {
      const output = execFileSync(
        "sh",
        [
          installer,
          "--platform=linux",
          "--arch=x64",
          "--version=v0.1.0-rc.2",
          `--dir=${destination}`,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      ).toString();
      expect(output).toContain("checksum ok");
      expect(readFileSync(join(destination, "tenjin"), "utf8")).toBe(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
