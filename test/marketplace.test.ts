import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  addMarketplace,
  installPlugin,
  updatePlugin,
  listInstalled,
  listMarketplaces,
  parseMarketplaceManifest,
  normalizeSource,
  compareVersions,
  isBreakingChange,
  marketplacesIndexFile,
  pluginsDir,
  pluginsIndexFile,
  MAX_PLUGIN_FILES,
  MAX_PLUGIN_FILE_BYTES,
  MAX_MARKETPLACE_MANIFEST_BYTES,
  MAX_TARBALL_COMPRESSED_BYTES,
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

async function startLoopbackRedirectServer(): Promise<{
  baseUrl: string;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (req.url === "/redirect") {
      const address = server.address() as AddressInfo;
      res.statusCode = 302;
      res.setHeader("Location", `http://127.0.0.1:${address.port}/archive.tgz`);
    } else {
      res.statusCode = 200;
    }
    res.end("not an artifact");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    stdio: "pipe",
  });
}

async function runCrashingUpdate(
  home: string,
  name: string,
  point: "after-journal" | "after-backup-rename" | "after-target-rename" | "after-index-write",
): Promise<void> {
  const moduleUrl = new URL("../src/plugins/marketplace.ts", import.meta.url).href;
  const script = [
    `globalThis.__TENJIN_PLUGIN_TRANSACTION_CRASH_AT__ = ${JSON.stringify(point)};`,
    `const { updatePlugin } = await import(${JSON.stringify(moduleUrl)});`,
    `await updatePlugin(${JSON.stringify(home)}, ${JSON.stringify(name)});`,
  ].join("\n");
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(`${stdout}\n${stderr}`).not.toMatch(/error:/i);
  expect(exitCode).toBe(86);
}

/** Create a git repo at `dir` from `files` and commit them. Returns `dir`. */
function makeGitRepo(dir: string, files: Record<string, string>, msg = "init"): string {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
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

/** Tiny archive whose header claims a size without allocating that payload. */
function makeTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "ascii");
  header.write("0000644\u0000", 100, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\u0000", 124, 12, "ascii");
  header.write("00000000000\u0000", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum =
    header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\u0000 ";
  header.write(checksum, 148, 8, "ascii");
  return header;
}

function makeTarGzWithDeclaredSize(name: string, size: number): Buffer {
  const header = makeTarHeader(name, size);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024, 0)]));
}

function makeTarGzWithEmptyFiles(count: number): Buffer {
  const headers = Array.from({ length: count }, (_, i) =>
    makeTarHeader(`file-${String(i).padStart(5, "0")}.txt`, 0),
  );
  return gzipSync(Buffer.concat([...headers, Buffer.alloc(1024, 0)]));
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

/** Module that proves neither top-level code nor register() runs at install. */
function hostilePluginModule(topLevelMarker: string, registerMarker: string): string {
  return [
    `import { writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(topLevelMarker)}, "top-level executed");`,
    `export const id = "hostile-plugin";`,
    `export const name = "hostile-plugin";`,
    `export const description = "must remain inert";`,
    `export const capabilities = ["tool"];`,
    `export function register(api) {`,
    `  writeFileSync(${JSON.stringify(registerMarker)}, "register executed");`,
    `  api.registerTool("hostile_tool", {});`,
    `}`,
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
    expect(res.commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(listMarketplaces(home)[0]?.commit).toBe(res.commit);
  });

  test("installPlugin copies files as inactive and never runs the install-script", async () => {
    const res = await installPlugin(home, "@acme/tools");
    expect(res.version).toBe("1.0.0");
    expect(res.entryFile).toBe("plugin.ts");
    expect(res.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.status).toBe("inactive");
    expect(res.experimental).toBe(true);
    // installed files land under <home>/plugins/<org>/<plugin>/
    expect(existsSync(join(pluginsDir(home), "acme", "tools", "plugin.ts"))).toBe(true);
    // supply-chain law: the declared install-script was flagged but NOT executed
    expect(res.installScriptIgnored).toBeDefined();
    expect(existsSync(join(home, "PWNED"))).toBe(false);
    const installed = listInstalled(home)[0]!;
    expect(installed.artifactSha256).toBe(res.artifactSha256);
    expect(installed.marketplaceCommit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(installed.sourceCommit).toBe(installed.marketplaceCommit);
  });

  test("@org/plugin namespace + collision rejection", async () => {
    // invalid namespace rejected before any lookup
    await expect(installPlugin(home, "acme-tools")).rejects.toThrow(/@org\/plugin/);
    // already installed => collision rejected
    await expect(installPlugin(home, "@acme/tools")).rejects.toThrow(/already installed/);
    expect(listInstalled(home)).toHaveLength(1);
    expect(listInstalled(home)[0]?.status).toBe("inactive");
  });

  test("updatePlugin bumps to the new version and refuses breaking bumps without --yes", async () => {
    const previousDigest = listInstalled(home).find(
      (plugin) => plugin.name === "@acme/tools",
    )?.artifactSha256;
    const topLevelMarker = join(home, "UPDATE_TOP_LEVEL_EXECUTED");
    const registerMarker = join(home, "UPDATE_REGISTER_EXECUTED");
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
      "plugins/tools/plugin.ts": hostilePluginModule(topLevelMarker, registerMarker),
    });
    // breaking major bump requires --yes (installed is still v1.0.0 from the
    // earlier install test)
    await expect(updatePlugin(home, "@acme/tools")).rejects.toThrow(/BREAKING/);
    const up = await updatePlugin(home, "@acme/tools", { force: true });
    expect(up.from).toBe("1.0.0");
    expect(up.to).toBe("2.0.0");
    expect(up.breaking).toBe(true);
    expect(up.status).toBe("inactive");
    const installed = listInstalled(home).find((p) => p.name === "@acme/tools");
    expect(installed?.version).toBe("2.0.0");
    expect(installed?.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(installed?.artifactSha256).not.toBe(previousDigest);
    expect(existsSync(topLevelMarker)).toBe(false);
    expect(existsSync(registerMarker)).toBe(false);
  });

  test("a failed update preserves the installed files and index", async () => {
    const target = join(pluginsDir(home), "acme", "tools", "plugin.ts");
    const before = readFileSync(target);
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "acme-mkt",
        version: "3.0.0",
        plugins: [
          {
            name: "@acme/tools",
            version: "3.0.0",
            source: { type: "rel-path", path: "plugins/broken" },
          },
        ],
      }),
      "plugins/broken/README.md": "no entry module here",
    });

    await expect(updatePlugin(home, "@acme/tools", { force: true })).rejects.toThrow(
      /no entry module/,
    );
    expect(readFileSync(target)).toEqual(before);
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
  let unsafeTarball: Buffer;

  beforeAll(() => {
    home = tmpDir("home-tar");
    mkt = tmpDir("mkt-tar");
    goodTarball = makeTarGz({
      "plugin.ts": pluginModule("acme-tar", "acme_tar_hello"),
    });
    goodSha = sha256(goodTarball);
    unsafeTarball = makeTarGz({
      "plugin.ts": pluginModule("acme-unsafe", "acme_unsafe"),
      "../ESCAPED": "must never be materialised",
    });
    // Marketplace includes a valid archive, a bad digest, and a traversal.
    const tamperedPath = join(mkt, "tampered.tgz");
    const unsafePath = join(mkt, "unsafe.tgz");
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
          {
            name: "@acme/unsafe",
            version: "1.0.0",
            source: { type: "tarball", url: unsafePath, sha256: sha256(unsafeTarball) },
          },
        ],
      }),
    });
    writeFileSync(join(mkt, "good.tgz"), goodTarball);
    // tampered file: same content but a DIFFERENT (wrong) pinned digest above
    writeFileSync(tamperedPath, goodTarball);
    writeFileSync(unsafePath, unsafeTarball);
    addMarketplace(home, mkt);
  });

  test("a tarball with a correct pinned sha256 installs and extracts", async () => {
    const res = await installPlugin(home, "@acme/good");
    expect(res.entryFile).toBe("plugin.ts");
    expect(res.status).toBe("inactive");
  });

  test("a tampered tarball (bad sha256) is rejected pre-install, nothing written", async () => {
    await expect(installPlugin(home, "@acme/tampered")).rejects.toThrow(/sha256 mismatch/);
    // nothing installed
    expect(listInstalled(home).find((p) => p.name === "@acme/tampered")).toBeUndefined();
    expect(existsSync(join(pluginsDir(home), "acme", "tampered"))).toBe(false);
  });

  test("a digest-valid tarball with path traversal is rejected before extraction", async () => {
    await expect(installPlugin(home, "@acme/unsafe")).rejects.toThrow(/unsafe path/);
    expect(listInstalled(home).find((p) => p.name === "@acme/unsafe")).toBeUndefined();
    expect(existsSync(join(pluginsDir(home), "acme", "unsafe"))).toBe(false);
    expect(existsSync(join(home, "ESCAPED"))).toBe(false);
  });
});

describe("v0.1 plugin install boundary", () => {
  test("never evaluates plugin top-level code or register() in the host process", async () => {
    const home = tmpDir("home-inert");
    const mkt = tmpDir("mkt-inert");
    const topLevelMarker = join(home, "TOP_LEVEL_EXECUTED");
    const registerMarker = join(home, "REGISTER_EXECUTED");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "inert-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@evil/inert",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/inert" },
          },
        ],
      }),
      "plugins/inert/plugin.ts": hostilePluginModule(topLevelMarker, registerMarker),
    });
    addMarketplace(home, mkt);

    const res = await installPlugin(home, "@evil/inert");

    expect(res.status).toBe("inactive");
    expect(res.experimental).toBe(true);
    expect(existsSync(join(res.dir, "plugin.ts"))).toBe(true);
    expect(existsSync(topLevelMarker)).toBe(false);
    expect(existsSync(registerMarker)).toBe(false);
  });
});

describe("v0.1 marketplace snapshot and provenance", () => {
  test("update stays bound to the marketplace URL selected at install", async () => {
    const home = tmpDir("home-provenance");
    const first = tmpDir("mkt-provenance-first");
    const selected = tmpDir("mkt-provenance-selected");
    makeGitRepo(first, {
      "marketplace.json": JSON.stringify({
        name: "first-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@first/other",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/other" },
          },
        ],
      }),
      "plugins/other/plugin.ts": pluginModule("first-other", "first_other"),
    });
    makeGitRepo(selected, {
      "marketplace.json": JSON.stringify({
        name: "selected-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@acme/provenance",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/provenance" },
          },
        ],
      }),
      "plugins/provenance/plugin.ts": pluginModule("selected-v1", "from_selected_v1"),
    });
    addMarketplace(home, first);
    addMarketplace(home, selected);
    await installPlugin(home, "@acme/provenance");
    expect(listInstalled(home)[0]?.marketplaceUrl).toBe(selected);

    // The earlier marketplace now tries to claim the same namespace/version.
    makeGitRepo(first, {
      "marketplace.json": JSON.stringify({
        name: "first-mkt",
        version: "9.0.0",
        plugins: [
          {
            name: "@acme/provenance",
            version: "9.0.0",
            source: { type: "rel-path", path: "plugins/hijack" },
          },
        ],
      }),
      "plugins/hijack/plugin.ts": pluginModule("hijack", "from_wrong_marketplace"),
    });
    makeGitRepo(selected, {
      "marketplace.json": JSON.stringify({
        name: "selected-mkt",
        version: "1.1.0",
        plugins: [
          {
            name: "@acme/provenance",
            version: "1.1.0",
            source: { type: "rel-path", path: "plugins/provenance" },
          },
        ],
      }),
      "plugins/provenance/plugin.ts": pluginModule("selected-v1.1", "from_selected_v11"),
    });

    const updated = await updatePlugin(home, "@acme/provenance");
    expect(updated.to).toBe("1.1.0");
    const installedSource = readFileSync(
      join(pluginsDir(home), "acme", "provenance", "plugin.ts"),
      "utf8",
    );
    expect(installedSource).toContain("from_selected_v11");
    expect(installedSource).not.toContain("from_wrong_marketplace");
  });

  test("legacy records remain listable but marketplace provenance fails closed", async () => {
    const home = tmpDir("home-legacy-index");
    const mkt = tmpDir("mkt-legacy-index");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "legacy-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@legacy/plugin",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/legacy" },
          },
        ],
      }),
      "plugins/legacy/plugin.ts": pluginModule("legacy-id", "legacy_tool"),
    });
    addMarketplace(home, mkt);
    await installPlugin(home, "@legacy/plugin");
    const current = listInstalled(home)[0]!;
    writeFileSync(
      pluginsIndexFile(home),
      JSON.stringify([
        {
          name: current.name,
          version: current.version,
          pluginId: "legacy-id",
          marketplace: current.marketplace,
          source: current.source,
          installedAt: current.installedAt,
        },
      ]),
    );

    const migrated = listInstalled(home)[0]!;
    expect(migrated.status).toBe("inactive");
    expect(migrated.experimental).toBe(true);
    expect(migrated.entryFile).toBe("plugin.ts");
    expect(migrated.marketplaceUrl).toBeUndefined();
    await expect(updatePlugin(home, "@legacy/plugin")).rejects.toThrow(
      /no unambiguous marketplace provenance/,
    );
  });
});

describe("v0.1 marketplace source hardening", () => {
  test("standalone git artifacts exclude .git and persist both resolved commits", async () => {
    const home = tmpDir("home-git-artifact");
    const source = tmpDir("plugin-git-artifact");
    const mkt = tmpDir("mkt-git-artifact");
    makeGitRepo(source, {
      "plugin.ts": pluginModule("git-artifact", "git_artifact_tool"),
    });
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "git-artifact-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@git/artifact",
            version: "1.0.0",
            source: { type: "git", url: source },
          },
        ],
      }),
    });
    const added = addMarketplace(home, mkt);
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();

    const installedResult = await installPlugin(home, "@git/artifact");
    expect(installedResult.files).toEqual(["plugin.ts"]);
    expect(existsSync(join(installedResult.dir, ".git"))).toBe(false);
    const record = listInstalled(home)[0]!;
    expect(record.marketplaceCommit).toBe(added.commit);
    expect(record.sourceCommit).toBe(sourceCommit);
    expect(record.artifactSha256).toBe(installedResult.artifactSha256);
  });

  test("rejects option-like marketplace and plugin repository values", async () => {
    const home = tmpDir("home-git-option-injection");
    expect(() => addMarketplace(home, "--help")).toThrow(/must not begin with '-'/);

    const mkt = tmpDir("mkt-git-option-injection");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "option-injection-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@evil/option",
            version: "1.0.0",
            source: { type: "git", url: "--upload-pack=/tmp/never-run" },
          },
        ],
      }),
    });
    addMarketplace(home, mkt);
    await expect(installPlugin(home, "@evil/option")).rejects.toThrow(
      /must not begin with '-'/,
    );
    expect(existsSync(join(pluginsDir(home), "evil", "option"))).toBe(false);
  });

  test("does not invoke external git transport helpers from a manifest", async () => {
    const home = tmpDir("home-git-transport-helper");
    const mkt = tmpDir("mkt-git-transport-helper");
    const marker = join(home, "EXTERNAL_HELPER_RAN");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "transport-helper-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@evil/helper",
            version: "1.0.0",
            source: { type: "git", url: `ext::sh -c 'touch ${marker}'` },
          },
        ],
      }),
    });
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@evil/helper")).rejects.toThrow(
      /remote\/network sources are disabled/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("blocks direct and redirect-capable tarball SSRF before any request", async () => {
    const server = await startLoopbackRedirectServer();
    const home = tmpDir("home-tarball-ssrf");
    const mkt = tmpDir("mkt-tarball-ssrf");
    try {
      makeGitRepo(mkt, {
        "marketplace.json": JSON.stringify({
          name: "tarball-ssrf-mkt",
          version: "1.0.0",
          plugins: [
            {
              name: "@ssrf/direct",
              version: "1.0.0",
              source: {
                type: "tarball",
                url: `${server.baseUrl}/archive.tgz`,
                sha256: "0".repeat(64),
              },
            },
            {
              name: "@ssrf/redirect",
              version: "1.0.0",
              source: {
                type: "tarball",
                url: `${server.baseUrl}/redirect`,
                sha256: "0".repeat(64),
              },
            },
          ],
        }),
      });
      addMarketplace(home, mkt);

      await expect(installPlugin(home, "@ssrf/direct")).rejects.toThrow(
        /remote\/network sources are disabled/i,
      );
      await expect(installPlugin(home, "@ssrf/redirect")).rejects.toThrow(
        /remote\/network sources are disabled/i,
      );
      expect(server.requestCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("blocks a manifest-controlled generic git network URL before connect", async () => {
    const server = await startLoopbackRedirectServer();
    const home = tmpDir("home-git-ssrf");
    const mkt = tmpDir("mkt-git-ssrf");
    try {
      makeGitRepo(mkt, {
        "marketplace.json": JSON.stringify({
          name: "git-ssrf-mkt",
          version: "1.0.0",
          plugins: [
            {
              name: "@ssrf/git",
              version: "1.0.0",
              source: {
                type: "git",
                url: `${server.baseUrl}/repo.git`,
              },
            },
          ],
        }),
      });
      addMarketplace(home, mkt);

      await expect(installPlugin(home, "@ssrf/git")).rejects.toThrow(
        /remote\/network sources are disabled/i,
      );
      expect(server.requestCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("caps marketplace.json before parsing it", () => {
    const home = tmpDir("home-manifest-limit");
    const mkt = tmpDir("mkt-manifest-limit");
    makeGitRepo(mkt, {
      "marketplace.json": " ".repeat(MAX_MARKETPLACE_MANIFEST_BYTES + 1),
    });

    expect(() => addMarketplace(home, mkt)).toThrow(/marketplace\.json exceeds .* bytes/);
    expect(listMarketplaces(home)).toEqual([]);
  });

  test("applies the global file-count cap to git directory sources", async () => {
    const home = tmpDir("home-git-file-limit");
    const source = tmpDir("plugin-git-file-limit");
    const mkt = tmpDir("mkt-git-file-limit");
    const files: Record<string, string> = {
      "plugin.ts": pluginModule("git-file-limit", "git_file_limit_tool"),
    };
    for (let i = 0; i < MAX_PLUGIN_FILES; i++) {
      files[`data/file-${String(i).padStart(5, "0")}.txt`] = "";
    }
    makeGitRepo(source, files);
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "git-file-limit-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@limit/git-files",
            version: "1.0.0",
            source: { type: "git", url: source },
          },
        ],
      }),
    });
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@limit/git-files")).rejects.toThrow(
      /more than .* files/,
    );
    expect(listInstalled(home)).toEqual([]);
  });
});

describe("v0.1 rel-path confinement", () => {
  test("rejects a symlinked manifest-derived plugin namespace parent", async () => {
    const home = tmpDir("home-target-parent-symlink");
    const outside = tmpDir("outside-target-parent-symlink");
    const mkt = tmpDir("mkt-target-parent-symlink");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "target-parent-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@redirected/plugin",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugin" },
          },
        ],
      }),
      "plugin/plugin.ts": pluginModule("redirected", "redirected_tool"),
    });
    addMarketplace(home, mkt);
    symlinkSync(outside, join(pluginsDir(home), "redirected"));

    await expect(installPlugin(home, "@redirected/plugin")).rejects.toThrow(
      /plugin namespace.*not a regular directory/i,
    );
    expect(existsSync(join(outside, "plugin"))).toBe(false);
    expect(listInstalled(home)).toEqual([]);
  });

  test("rejects an absolute rel-path outside the marketplace clone", async () => {
    const home = tmpDir("home-rel-absolute");
    const outside = tmpDir("outside-rel-absolute");
    const mkt = tmpDir("mkt-rel-absolute");
    writeFileSync(join(outside, "plugin.ts"), pluginModule("outside", "outside_tool"));
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "escape-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@evil/absolute",
            version: "1.0.0",
            source: { type: "rel-path", path: outside },
          },
        ],
      }),
    });
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@evil/absolute")).rejects.toThrow(
      /escapes the marketplace repository/,
    );
    expect(existsSync(join(pluginsDir(home), "evil", "absolute"))).toBe(false);
  });

  test("rejects a rel-path symlink that resolves outside the marketplace clone", async () => {
    const home = tmpDir("home-rel-symlink");
    const outside = tmpDir("outside-rel-symlink");
    const mkt = tmpDir("mkt-rel-symlink");
    writeFileSync(join(outside, "plugin.ts"), pluginModule("outside", "outside_tool"));
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "symlink-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@evil/symlink",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/escape" },
          },
        ],
      }),
    });
    mkdirSync(join(mkt, "plugins"), { recursive: true });
    symlinkSync(outside, join(mkt, "plugins", "escape"));
    git(mkt, "add", "-A");
    git(mkt, "commit", "-q", "-m", "add escape symlink");
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@evil/symlink")).rejects.toThrow(
      /resolves outside the marketplace repository/,
    );
    expect(existsSync(join(pluginsDir(home), "evil", "symlink"))).toBe(false);
  });

  test("rejects a rel-path symlink that resolves into marketplace .git metadata", async () => {
    const home = tmpDir("home-rel-git-metadata");
    const mkt = tmpDir("mkt-rel-git-metadata");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "git-metadata-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@evil/git-metadata",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/metadata" },
          },
        ],
      }),
    });
    mkdirSync(join(mkt, "plugins"), { recursive: true });
    symlinkSync("../.git", join(mkt, "plugins", "metadata"));
    git(mkt, "add", "-A");
    git(mkt, "commit", "-q", "-m", "add metadata symlink");
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@evil/git-metadata")).rejects.toThrow(
      /reserved git metadata/,
    );
    expect(existsSync(join(pluginsDir(home), "evil", "git-metadata"))).toBe(false);
  });
});

describe("v0.1 plugin commit concurrency", () => {
  test("parallel installs merge their records under the commit lock", async () => {
    const home = tmpDir("home-concurrent");
    const mkt = tmpDir("mkt-concurrent");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "race-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@race/one",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/one" },
          },
          {
            name: "@race/two",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/two" },
          },
        ],
      }),
      "plugins/one/plugin.ts": pluginModule("race-one", "race_one"),
      "plugins/two/plugin.ts": pluginModule("race-two", "race_two"),
    });
    addMarketplace(home, mkt);

    await Promise.all([
      installPlugin(home, "@race/one"),
      installPlugin(home, "@race/two"),
    ]);

    expect(listInstalled(home).map((p) => p.name).sort()).toEqual([
      "@race/one",
      "@race/two",
    ]);
    expect(existsSync(join(pluginsDir(home), "race", "one", "plugin.ts"))).toBe(true);
    expect(existsSync(join(pluginsDir(home), "race", "two", "plugin.ts"))).toBe(true);
    expect(existsSync(join(pluginsDir(home), ".commit.lock"))).toBe(false);
  });

  test("parallel updates re-check the installed version under the lock", async () => {
    const home = tmpDir("home-concurrent-update");
    const mkt = tmpDir("mkt-concurrent-update");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "update-race-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@race/update",
            version: "1.0.0",
            source: { type: "rel-path", path: "plugins/update" },
          },
        ],
      }),
      "plugins/update/plugin.ts": pluginModule("race-update-v1", "race_update_v1"),
    });
    addMarketplace(home, mkt);
    await installPlugin(home, "@race/update");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "update-race-mkt",
        version: "1.1.0",
        plugins: [
          {
            name: "@race/update",
            version: "1.1.0",
            source: { type: "rel-path", path: "plugins/update" },
          },
        ],
      }),
      "plugins/update/plugin.ts": pluginModule("race-update-v1.1", "race_update_v11"),
    });

    const results = await Promise.allSettled([
      updatePlugin(home, "@race/update"),
      updatePlugin(home, "@race/update"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(listInstalled(home)[0]?.version).toBe("1.1.0");
    expect(existsSync(join(pluginsDir(home), ".commit.lock"))).toBe(false);
  });
});

describe("v0.1 shared plugin-state lock", () => {
  test("a live state lock makes synchronous marketplace add fail without losing index data", () => {
    const home = tmpDir("home-marketplace-live-lock");
    const first = tmpDir("mkt-live-lock-first");
    const second = tmpDir("mkt-live-lock-second");
    makeGitRepo(first, {
      "marketplace.json": JSON.stringify({
        name: "live-lock-first",
        version: "1.0.0",
        plugins: [{ name: "@lock/first", version: "1.0.0", source: "rel-path:." }],
      }),
      "plugin.ts": pluginModule("lock-first", "lock_first"),
    });
    makeGitRepo(second, {
      "marketplace.json": JSON.stringify({
        name: "live-lock-second",
        version: "1.0.0",
        plugins: [{ name: "@lock/second", version: "1.0.0", source: "rel-path:." }],
      }),
      "plugin.ts": pluginModule("lock-second", "lock_second"),
    });
    addMarketplace(home, first);
    const lockDir = join(pluginsDir(home), ".commit.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({ pid: process.pid, token: "live-test-owner", createdAt: Date.now() }),
    );
    try {
      expect(() => addMarketplace(home, second)).toThrow(/changed concurrently; retry/);
      expect(listMarketplaces(home).map((record) => record.name)).toEqual(["live-lock-first"]);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("recovers a state lock whose recorded owner process is dead", () => {
    const home = tmpDir("home-marketplace-stale-lock");
    const mkt = tmpDir("mkt-stale-lock");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "stale-lock-mkt",
        version: "1.0.0",
        plugins: [{ name: "@lock/stale", version: "1.0.0", source: "rel-path:." }],
      }),
      "plugin.ts": pluginModule("lock-stale", "lock_stale"),
    });
    const lockDir = join(pluginsDir(home), ".commit.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner"),
      JSON.stringify({ pid: 2_147_483_647, token: "dead-test-owner", createdAt: Date.now() }),
    );

    const added = addMarketplace(home, mkt);
    expect(added.name).toBe("stale-lock-mkt");
    expect(listMarketplaces(home)).toHaveLength(1);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("refuses to overwrite a malformed marketplace index", () => {
    const home = tmpDir("home-marketplace-malformed-index");
    const mkt = tmpDir("mkt-malformed-index");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "malformed-index-mkt",
        version: "1.0.0",
        plugins: [{ name: "@state/safe", version: "1.0.0", source: "rel-path:." }],
      }),
      "plugin.ts": pluginModule("state-safe", "state_safe"),
    });
    mkdirSync(dirname(marketplacesIndexFile(home)), { recursive: true });
    writeFileSync(marketplacesIndexFile(home), "{not-json");

    expect(() => addMarketplace(home, mkt)).toThrow(/not valid JSON; refusing to overwrite/);
    expect(readFileSync(marketplacesIndexFile(home), "utf8")).toBe("{not-json");
    expect(existsSync(join(pluginsDir(home), ".commit.lock"))).toBe(false);
  });
});

describe("v0.1 crash-recoverable plugin tree/index transaction", () => {
  const crashPoints = [
    "after-journal",
    "after-backup-rename",
    "after-target-rename",
    "after-index-write",
  ] as const;

  for (const point of crashPoints) {
    test(`recovers a process crash at ${point}`, async () => {
      const suffix = point.replaceAll("-", "_");
      const home = tmpDir(`home-transaction-${suffix}`);
      const mkt = tmpDir(`mkt-transaction-${suffix}`);
      const name = "@recovery/plugin";
      makeGitRepo(mkt, {
        "marketplace.json": JSON.stringify({
          name: "recovery-mkt",
          version: "1.0.0",
          plugins: [
            {
              name,
              version: "1.0.0",
              source: { type: "rel-path", path: "plugins/recovery" },
            },
          ],
        }),
        "plugins/recovery/plugin.ts": pluginModule("recovery-v1", "recovery_v1"),
      });
      addMarketplace(home, mkt);
      await installPlugin(home, name);
      makeGitRepo(mkt, {
        "marketplace.json": JSON.stringify({
          name: "recovery-mkt",
          version: "1.1.0",
          plugins: [
            {
              name,
              version: "1.1.0",
              source: { type: "rel-path", path: "plugins/recovery" },
            },
          ],
        }),
        "plugins/recovery/plugin.ts": pluginModule("recovery-v1.1", "recovery_v11"),
      });

      await runCrashingUpdate(home, name, point);

      // listInstalled acquires the state lock, recovers the dead owner's
      // journal, and only then exposes the index/tree pair.
      const recovered = listInstalled(home);
      const committed = point === "after-index-write";
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.version).toBe(committed ? "1.1.0" : "1.0.0");
      const source = readFileSync(
        join(pluginsDir(home), "recovery", "plugin", "plugin.ts"),
        "utf8",
      );
      expect(source).toContain(committed ? "recovery_v11" : "recovery_v1");
      if (!committed) expect(source).not.toContain("recovery_v11");

      const orgEntries = readdirSync(join(pluginsDir(home), "recovery"));
      expect(orgEntries.filter((entry) => /^\.plugin-(?:install|backup)-/.test(entry))).toEqual([]);
      const transactionDir = join(pluginsDir(home), ".transactions");
      expect(
        existsSync(transactionDir)
          ? readdirSync(transactionDir).filter((entry) => entry.endsWith(".json"))
          : [],
      ).toEqual([]);
      expect(existsSync(join(pluginsDir(home), ".commit.lock"))).toBe(false);
    });
  }
});

describe("v0.1 tarball resource limits", () => {
  test("rejects an oversized declared file before allocating its payload", async () => {
    const home = tmpDir("home-tar-limit-file");
    const mkt = tmpDir("mkt-tar-limit-file");
    const tarball = makeTarGzWithDeclaredSize("plugin.ts", MAX_PLUGIN_FILE_BYTES + 1);
    const tarballPath = join(mkt, "oversized-file.tgz");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "limit-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@limit/file",
            version: "1.0.0",
            source: { type: "tarball", url: tarballPath, sha256: sha256(tarball) },
          },
        ],
      }),
    });
    writeFileSync(tarballPath, tarball);
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@limit/file")).rejects.toThrow(/exceeds .* bytes/);
  });

  test("rejects an archive with more than the allowed file count", async () => {
    const home = tmpDir("home-tar-limit-count");
    const mkt = tmpDir("mkt-tar-limit-count");
    const tarball = makeTarGzWithEmptyFiles(MAX_PLUGIN_FILES + 1);
    const tarballPath = join(mkt, "too-many-files.tgz");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "count-limit-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@limit/count",
            version: "1.0.0",
            source: { type: "tarball", url: tarballPath, sha256: sha256(tarball) },
          },
        ],
      }),
    });
    writeFileSync(tarballPath, tarball);
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@limit/count")).rejects.toThrow(/more than .* files/);
  });

  test("rejects an oversized local compressed file from stat before reading it", async () => {
    const home = tmpDir("home-tar-limit-compressed");
    const mkt = tmpDir("mkt-tar-limit-compressed");
    const tarballPath = join(mkt, "oversized-compressed.tgz");
    makeGitRepo(mkt, {
      "marketplace.json": JSON.stringify({
        name: "compressed-limit-mkt",
        version: "1.0.0",
        plugins: [
          {
            name: "@limit/compressed",
            version: "1.0.0",
            source: { type: "tarball", url: tarballPath, sha256: "0".repeat(64) },
          },
        ],
      }),
    });
    writeFileSync(tarballPath, "");
    truncateSync(tarballPath, MAX_TARBALL_COMPRESSED_BYTES + 1);
    addMarketplace(home, mkt);

    await expect(installPlugin(home, "@limit/compressed")).rejects.toThrow(
      /compressed bytes/,
    );
  });
});
