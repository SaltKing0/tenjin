import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CapabilityRegistry } from "../src/plugins/registry";
import {
  addMarketplace,
  installPlugin,
  updatePlugin,
  listInstalled,
  parseMarketplaceManifest,
  normalizeSource,
  compareVersions,
  isBreakingChange,
  pluginsDir,
} from "../src/plugins/marketplace";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let ROOT: string;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "tj-mkt-test-"));
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function tmpDir(label: string): string {
  const d = join(ROOT, label);
  mkdirSync(d, { recursive: true });
  return d;
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    stdio: "pipe",
  });
}

/** Create a git repo at `dir` from `files` and commit them. Returns `dir`. */
function makeGitRepo(dir: string, files: Record<string, string>, msg = "init"): string {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(dir, rel).slice(0, -rel.length) || dir, { recursive: true });
    writeFileSync(p, content);
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return dir;
}

/** A tiny deterministic USTAR .tar.gz writer (test-side counterpart to the
 *  zero-dep reader in marketplace.ts). */
function makeTarGz(files: Record<string, string | Buffer>): Buffer {
  const block = (name: string, size: number, type: "file" | "dir"): Buffer => {
    const b = Buffer.alloc(512, 0);
    b.write(name, 0, 100, "ascii");
    const mode = type === "file" ? "0000644\u0000" : "0000755\u0000";
    b.write(mode, 100, 8, "ascii");
    const octal = (off: number, len: number, v: number): void => {
      b.write(v.toString(8).padStart(len - 1, "0") + "\u0000", off, len, "ascii");
    };
    octal(124, 12, size);
    octal(136, 12, 0);
    b.write("        ", 148, 8, "ascii"); // chksum placeholder
    b.write(type === "file" ? "0" : "5", 156, 1, "ascii");
    b.write("ustar", 257, 5, "ascii");
    b.write("00", 263, 2, "ascii");
    const chk = b.reduce((a, x) => a + x, 0).toString(8).padStart(6, "0") + "\u0000 ";
    b.write(chk, 148, 8, "ascii");
    return b;
  };
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const c = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    chunks.push(block(name, c.length, "file"), c);
    const pad = (512 - (c.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** A valid zero-import plugin module source for a fixture. */
function pluginModule(id: string, tool: string): string {
  return [
    `export const id = ${JSON.stringify(id)};`,
    `export const name = ${JSON.stringify(id)};`,
    `export const description = "test plugin";`,
    `export const capabilities = ["tool"];`,
    `export function register(api) { api.registerTool(${JSON.stringify(tool)}, {}); }`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 1. Manifest parsing for all four source types
// ---------------------------------------------------------------------------

describe("B15-4 marketplace.json manifest parsing (all four source types)", () => {
  test("normalizes rel-path, github, git, and tarball sources", () => {
    const manifest = parseMarketplaceManifest(
      JSON.stringify({
        name: "acme-mkt",
        version: "1.0.0",
        tags: ["tools"],
        plugins: [
          { name: "@acme/rel", version: "1.0.0", source: "rel-path:plugins/rel" },
          { name: "@acme/gh", version: "1.0.0", source: "github:acme/tools" },
          { name: "@acme/git", version: "1.0.0", source: "git:https://example.com/tools.git" },
          {
            name: "@acme/tar",
            version: "1.0.0",
            source: { type: "tarball", url: "https://example.com/tools.tgz", sha256: "a".repeat(64) },
          },
        ],
      }),
    );
    expect(manifest.name).toBe("acme-mkt");
    expect(manifest.plugins).toHaveLength(4);
    expect(normalizeSource(manifest.plugins[0]!.source)).toEqual({ type: "rel-path", path: "plugins/rel" });
    expect(normalizeSource(manifest.plugins[1]!.source)).toEqual({ type: "github", repo: "acme/tools" });
    expect(normalizeSource(manifest.plugins[2]!.source)).toEqual({ type: "git", url: "https://example.com/tools.git" });
    expect(normalizeSource(manifest.plugins[3]!.source)).toEqual({
      type: "tarball",
      url: "https://example.com/tools.tgz",
      sha256: "a".repeat(64),
    });
  });

  test("rejects an unknown source type and a tarball without a pinned sha256", () => {
    expect(() =>
      parseMarketplaceManifest(
        JSON.stringify({
          name: "bad",
          version: "1.0.0",
          plugins: [{ name: "@acme/x", version: "1.0.0", source: "npm:foo" }],
        }),
      ),
    ).toThrow(/unknown source shorthand/);
    expect(() =>
      parseMarketplaceManifest(
        JSON.stringify({
          name: "bad",
          version: "1.0.0",
          plugins: [
            { name: "@acme/x", version: "1.0.0", source: { type: "tarball", url: "https://e/f.tgz" } },
          ],
        }),
      ),
    ).toThrow(/sha256 digest/);
  });

  test("rejects non-namespaced plugin names and bad semver", () => {
    expect(() =>
      parseMarketplaceManifest(
        JSON.stringify({
          name: "m",
          version: "1.0.0",
          plugins: [{ name: "acme-plain", version: "1.0.0", source: "git:x" }],
        }),
      ),
    ).toThrow(/@org\/plugin/);
    expect(() =>
      parseMarketplaceManifest(
        JSON.stringify({
          name: "m",
          version: "1.0.0",
          plugins: [{ name: "@acme/x", version: "not-semver", source: "git:x" }],
        }),
      ),
    ).toThrow(/semver/);
  });
});

describe("B15-4 semver helpers", () => {
  test("compareVersions and breaking-change detection", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(isBreakingChange("1.9.0", "2.0.0")).toBe(true);
    expect(isBreakingChange("1.9.0", "1.10.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3 + 5. add / install / update, namespace+collision, install-script
// ---------------------------------------------------------------------------

describe("B15-4 add/install/update against a local git fixture marketplace", () => {
  let home: string;
  let mkt: string;

  beforeAll(() => {
    home = tmpDir("home");
    mkt = tmpDir("mkt");
    const toolsDir = join(mkt, "plugins", "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, "plugin.ts"), pluginModule("acme-tools", "acme_hello"));
    // Plugin declares an installScript that WOULD write a marker if executed.
    const marker = join(home, "PWNED");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "acme-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@acme/tools",
            version: "1.0.0",
            description: "rel-path tools",
            source: { type: "rel-path", path: "plugins/tools" },
            installScript: `touch ${marker}`,
          },
        ],
      }),
      "plugins/tools/plugin.ts": pluginModule("acme-tools", "acme_hello"),
    });
  });

  test("addMarketplace records the marketplace from a local git clone", () => {
    const res = addMarketplace(home, mkt);
    expect(res.name).toBe("acme-mkt");
    expect(res.plugins).toEqual(["@acme/tools"]);
  });

  test("installPlugin installs + registers, and never runs the install-script", async () => {
    const registry = new CapabilityRegistry();
    const res = await installPlugin(home, registry, "@acme/tools");
    expect(res.version).toBe("1.0.0");
    expect(res.pluginId).toBe("acme-tools");
    expect(res.registrySize).toBe(1);
    expect(registry.get("tool", "acme_hello")).toBeDefined();
    expect(registry.get("tool", "acme_hello")?.ownerPluginId).toBe("acme-tools");
    // installed files land under <home>/plugins/<org>/<plugin>/
    expect(existsSync(join(pluginsDir(home), "acme", "tools", "plugin.ts"))).toBe(true);
    // supply-chain law: the declared install-script was flagged but NOT executed
    expect(res.installScriptIgnored).toBeDefined();
    expect(existsSync(join(home, "PWNED"))).toBe(false);
  });

  test("@org/plugin namespace + collision rejection", async () => {
    const registry = new CapabilityRegistry();
    // invalid namespace rejected before any lookup
    await expect(installPlugin(home, registry, "acme-tools")).rejects.toThrow(/@org\/plugin/);
    // already installed => collision rejected
    await expect(installPlugin(home, registry, "@acme/tools")).rejects.toThrow(/already installed/);
    expect(listInstalled(home)).toHaveLength(1);
  });

  test("updatePlugin bumps to the new version and refuses breaking bumps without --yes", async () => {
    // Publish v2.0.0 (minor would not be breaking; use a major for the break test)
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "acme-mkt",
        version: "2.0.0",
        plugins: [
          {
            name: "@acme/tools",
            version: "2.0.0",
            source: { type: "rel-path", path: "plugins/tools" },
          },
        ],
      }),
      "plugins/tools/plugin.ts": pluginModule("acme-tools", "acme_hello"),
    });
    const registry = new CapabilityRegistry();

    // breaking major bump requires --yes (installed is still v1.0.0 from the
    // earlier install test)
    await expect(updatePlugin(home, registry, "@acme/tools")).rejects.toThrow(/BREAKING/);
    const up = await updatePlugin(home, registry, "@acme/tools", { force: true });
    expect(up.from).toBe("1.0.0");
    expect(up.to).toBe("2.0.0");
    expect(up.breaking).toBe(true);
    expect(listInstalled(home).find((p) => p.name === "@acme/tools")?.version).toBe("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// 4. Tampered tarball (bad sha256) rejected pre-install + positive tarball
// ---------------------------------------------------------------------------

describe("B15-4 tarball source: digest verification + extraction", () => {
  let home: string;
  let mkt: string;
  let goodTarball: Buffer;
  let goodSha: string;

  beforeAll(() => {
    home = tmpDir("home-tar");
    mkt = tmpDir("mkt-tar");
    goodTarball = makeTarGz({
      "plugin.ts": pluginModule("acme-tar", "acme_tar_hello"),
    });
    goodSha = sha256(goodTarball);
    // marketplace with two tarball plugins: one correct digest, one tampered
    const tamperedPath = join(mkt, "tampered.tgz");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "tar-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@acme/good",
            version: "1.0.0",
            source: { type: "tarball", url: join(mkt, "good.tgz"), sha256: goodSha },
          },
          {
            name: "@acme/tampered",
            version: "1.0.0",
            source: {
              type: "tarball",
              url: tamperedPath,
              sha256: "0".repeat(64), // WRONG digest — must be rejected
            },
          },
        ],
      }),
    });
    writeFileSync(join(mkt, "good.tgz"), goodTarball);
    // tampered file: same content but a DIFFERENT (wrong) pinned digest above
    writeFileSync(tamperedPath, goodTarball);
    addMarketplace(home, mkt);
  });

  test("a tarball with a correct pinned sha256 installs and extracts", async () => {
    const registry = new CapabilityRegistry();
    const res = await installPlugin(home, registry, "@acme/good");
    expect(res.pluginId).toBe("acme-tar");
    expect(registry.get("tool", "acme_tar_hello")).toBeDefined();
  });

  test("a tampered tarball (bad sha256) is rejected pre-install, nothing written", async () => {
    const registry = new CapabilityRegistry();
    await expect(installPlugin(home, registry, "@acme/tampered")).rejects.toThrow(/sha256 mismatch/);
    // nothing installed, nothing registered
    expect(listInstalled(home).find((p) => p.name === "@acme/tampered")).toBeUndefined();
    expect(registry.size).toBe(0);
    expect(existsSync(join(pluginsDir(home), "acme", "tampered"))).toBe(false);
  });
});
