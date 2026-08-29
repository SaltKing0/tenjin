// ===========================================================================
// B15-4 Git-first marketplace (#425)
// ---------------------------------------------------------------------------
// Decentralized Claude/Homebrew-style plugin marketplace. The git repo URL IS
// the source — every fork doubles as a marketplace; we host nothing.
//
// A marketplace is any git repo (or tarball of one) containing a
// `marketplace.json` manifest that lists plugins. Each plugin entry carries a
// `source` of one of four kinds:
//   rel-path:<dir>        a directory inside the marketplace repo
//   github:org/repo       a standalone repo fetched only from github.com
//   git:<path>            a local git repo (plugin at root)
//   {type:"tarball",...}  a local .tar.gz, REQUIRED to pin a sha256 digest
//
// SUPPLY-CHAIN LAW: tarballs are digest-verified (pinned sha256) BEFORE
// install; install-scripts and plugin modules are NEVER executed by the
// installer. Installation is a file-only operation. Installed plugins remain
// inactive/experimental until a separately isolated runtime exists.
// ===========================================================================

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { ConfigError } from "../config/types";
import { tenjinHome } from "../config/loader";

// ---------------------------------------------------------------------------
// Home layout
// ---------------------------------------------------------------------------

/** Root of all plugin marketplaces a user has added. */
export function marketplacesDir(home = tenjinHome()): string {
  return join(home, "marketplaces");
}

/** Local index of added marketplaces: [{name, url, version, addedAt}]. */
export function marketplacesIndexFile(home = tenjinHome()): string {
  return join(marketplacesDir(home), "index.json");
}

/** Root of installed plugins: <home>/plugins/<org>/<plugin>/. */
export function pluginsDir(home = tenjinHome()): string {
  return join(home, "plugins");
}

/** Local index of installed plugins. v0.1 installs are always inactive. */
export function pluginsIndexFile(home = tenjinHome()): string {
  return join(pluginsDir(home), "index.json");
}

// ---------------------------------------------------------------------------
// Manifest + source types
// ---------------------------------------------------------------------------

/** @org/plugin — exactly two segments after the leading @. */
const NAMESPACE_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/;

/** A marketplace.json entry describing one plugin and where to fetch it. */
export interface PluginEntry {
  name: string; // @org/plugin
  version: string; // semver
  description?: string;
  changelog?: string;
  source: PluginSource;
  /** Presence is tolerated but the installer NEVER runs it (supply-chain law). */
  installScript?: string;
}

export type PluginSource =
  | { type: "rel-path"; path: string }
  | { type: "github"; repo: string }
  | { type: "git"; url: string }
  | { type: "tarball"; url: string; sha256: string };

export interface MarketplaceManifest {
  name: string;
  owner?: string;
  version: string; // semver of the manifest itself
  tags?: string[];
  plugins: PluginEntry[];
}

/** A file that will be written as part of an installed plugin. */
export interface PluginFile {
  rel: string;
  content: Buffer;
}

/** Hard resource caps for untrusted marketplace tarballs. */
export const MAX_TARBALL_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_TARBALL_UNPACKED_BYTES = 128 * 1024 * 1024;
export const MAX_PLUGIN_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 4_096;
/** Applies to every source kind, not just archives. */
export const MAX_PLUGIN_TOTAL_BYTES = MAX_TARBALL_UNPACKED_BYTES;
export const MAX_MARKETPLACE_MANIFEST_BYTES = 4 * 1024 * 1024;
export const GIT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_PLUGIN_TRANSACTION_JOURNALS = 64;
const MAX_PLUGIN_TRANSACTION_JOURNAL_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Normalize a source (string shorthand or object) into the discriminated union. */
export function normalizeSource(raw: unknown): PluginSource {
  if (typeof raw === "string") {
    if (raw.startsWith("rel-path:")) {
      const path = raw.slice("rel-path:".length);
      if (!path) throw new ConfigError("rel-path source needs a non-empty path");
      return { type: "rel-path", path };
    }
    if (raw.startsWith("github:")) {
      const repo = raw.slice("github:".length);
      if (!repo) throw new ConfigError("github source needs org/repo");
      return { type: "github", repo };
    }
    if (raw.startsWith("git:")) {
      const url = raw.slice("git:".length);
      if (!url) throw new ConfigError("git source needs a URL");
      return { type: "git", url };
    }
    throw new ConfigError(
      `unknown source shorthand "${raw}" (use rel-path:, github:, git:, or a {type} object)`,
    );
  }
  if (raw && typeof raw === "object") {
    const src = raw as Record<string, unknown>;
    switch (src.type) {
      case "rel-path":
        if (typeof src.path !== "string" || !src.path)
          throw new ConfigError("rel-path source needs a string path");
        return { type: "rel-path", path: src.path };
      case "github":
        if (typeof src.repo !== "string" || !src.repo)
          throw new ConfigError("github source needs org/repo");
        return { type: "github", repo: src.repo };
      case "git":
        if (typeof src.url !== "string" || !src.url)
          throw new ConfigError("git source needs a URL");
        return { type: "git", url: src.url };
      case "tarball": {
        if (typeof src.url !== "string" || !src.url)
          throw new ConfigError("tarball source needs a url");
        if (typeof src.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(src.sha256))
          throw new ConfigError("tarball source must pin a 64-char sha256 digest");
        return { type: "tarball", url: src.url, sha256: src.sha256.toLowerCase() };
      }
      default:
        throw new ConfigError(
          `unknown source type "${String(src.type)}" (rel-path | github | git | tarball)`,
        );
    }
  }
  throw new ConfigError("plugin source must be a string shorthand or a {type} object");
}

function parseSemver(v: string): { major: number; minor: number; patch: number } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v).trim());
  if (!m) throw new ConfigError(`invalid semver version "${v}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 when a < b, 0 when equal, 1 when a > b. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (A.major !== B.major) return A.major < B.major ? -1 : 1;
  if (A.minor !== B.minor) return A.minor < B.minor ? -1 : 1;
  if (A.patch !== B.patch) return A.patch < B.patch ? -1 : 1;
  return 0;
}

/** A bump from `from` to `to` is breaking when the major version increases. */
export function isBreakingChange(from: string, to: string): boolean {
  return parseSemver(to).major > parseSemver(from).major;
}

function validateEntry(entry: unknown, ctx: string): PluginEntry {
  if (!entry || typeof entry !== "object")
    throw new ConfigError(`plugin entry in ${ctx} must be an object`);
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== "string" || !NAMESPACE_RE.test(e.name)) {
    throw new ConfigError(
      `plugin "${String(e.name)}" must be namespaced @org/plugin (e.g. @acme/tools)`,
    );
  }
  if (typeof e.version !== "string") {
    throw new ConfigError(`plugin "${e.name}" is missing a semver version`);
  }
  parseSemver(e.version); // validate now, fail fast
  const source = normalizeSource(e.source);
  return {
    name: e.name,
    version: e.version,
    description: typeof e.description === "string" ? e.description : undefined,
    changelog: typeof e.changelog === "string" ? e.changelog : undefined,
    source,
    installScript: typeof e.installScript === "string" ? e.installScript : undefined,
  };
}

/** Parse + validate a marketplace.json manifest. Throws ConfigError on any
 *  structural problem — manifest-first validation happens before any install. */
export function parseMarketplaceManifest(text: string): MarketplaceManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("marketplace.json is not valid JSON");
  }
  if (!raw || typeof raw !== "object")
    throw new ConfigError("marketplace.json must be an object");
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name)
    throw new ConfigError("marketplace.json is missing a name");
  if (typeof m.version !== "string")
    throw new ConfigError(`marketplace "${m.name}" is missing a semver version`);
  parseSemver(m.version);
  if (!Array.isArray(m.plugins) || m.plugins.length === 0)
    throw new ConfigError(`marketplace "${m.name}" must declare at least one plugin`);
  const plugins = m.plugins.map((p, i) => validateEntry(p, `marketplace "${m.name}" plugin #${i + 1}`));
  return {
    name: m.name,
    owner: typeof m.owner === "string" ? m.owner : undefined,
    version: m.version,
    tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === "string") : undefined,
    plugins,
  };
}

// ---------------------------------------------------------------------------
// Git helpers (mirror the bot-catalog pattern)
// ---------------------------------------------------------------------------

interface GitInvocationPolicy {
  allowedProtocols: string;
  isolatedHome?: string;
}

function gitEnvironment(policy: GitInvocationPolicy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Git accepts arbitrary configuration through numbered environment keys.
  // A host filter/transport rewrite must not turn checked-out attributes or a
  // fixed github.com URL into plugin code execution or an unexpected request.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i.test(key)) delete env[key];
  }
  if (policy.isolatedHome) {
    for (const key of Object.keys(env)) {
      if (/^GIT_/i.test(key)) delete env[key];
    }
    env.HOME = policy.isolatedHome;
    env.XDG_CONFIG_HOME = policy.isolatedHome;
    delete env.SSH_AUTH_SOCK;
    delete env.SSH_ASKPASS;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ALLOW_PROTOCOL = policy.allowedProtocols;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  return env;
}

function git(
  repoDir: string | null,
  args: string[],
  msg: string,
  policy: GitInvocationPolicy,
): string {
  const r = spawnSync("git", args, {
    cwd: repoDir ?? process.cwd(),
    encoding: "utf8",
    env: gitEnvironment(policy),
    timeout: GIT_OPERATION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new ConfigError(`${msg}: timed out after ${GIT_OPERATION_TIMEOUT_MS}ms`);
  }
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim().split("\n").pop() ?? "unknown error";
    throw new ConfigError(`${msg}: ${err}`);
  }
  return r.stdout.trim();
}

/** Fresh throwaway clone of a marketplace/git repo. */
function cloneRepo(
  repo: string,
  policy: Omit<GitInvocationPolicy, "isolatedHome"> = {
    allowedProtocols: "file:http:https:ssh:git",
  },
): { dir: string; commit: string; cleanup: () => void } {
  if (repo.startsWith("-")) {
    throw new ConfigError("git repository URL/path must not begin with '-'");
  }
  const parent = mkdtempSync(join(tmpdir(), "tj-mkt-"));
  const dir = join(parent, "clone");
  const invocationPolicy: GitInvocationPolicy = {
    ...policy,
    ...(policy.allowedProtocols === "file:http:https:ssh:git"
      ? {}
      : { isolatedHome: parent }),
  };
  try {
    git(
      null,
      ["clone", "--quiet", "--depth", "1", "--", repo, dir],
      "git clone failed",
      invocationPolicy,
    );
    const commit = git(
      dir,
      ["rev-parse", "HEAD"],
      "git rev-parse failed",
      invocationPolicy,
    );
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new ConfigError("git clone resolved to an invalid commit id");
    }
    return {
      dir,
      commit: commit.toLowerCase(),
      cleanup: () => rmSync(parent, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(parent, { recursive: true, force: true });
    throw e;
  }
}

function readManifestFile(dir: string): MarketplaceManifest {
  const p = join(dir, "marketplace.json");
  return parseMarketplaceManifest(
    readLocalFileLimited(p, MAX_MARKETPLACE_MANIFEST_BYTES, "marketplace.json").toString("utf8"),
  );
}

// ---------------------------------------------------------------------------
// Source resolution -> PluginFile[]
// ---------------------------------------------------------------------------

function readFdLimited(fd: number, maxBytes: number, label: string): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      throw new ConfigError(`${label} exceeds ${maxBytes} bytes — refusing to read`);
    }
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) {
      throw new ConfigError(`${label} exceeds ${maxBytes} bytes — refusing to read`);
    }
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function readLocalFileLimited(
  path: string,
  maxBytes: number,
  label: string,
  sizeDescription = "bytes",
): Buffer {
  let fd: number;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`${label} not found: ${path}`);
    }
    if (code === "ELOOP") throw new ConfigError(`${label} must not be a symlink: ${path}`);
    throw e;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ConfigError(`${label} is not a regular file: ${path}`);
    if (stat.size > maxBytes) {
      throw new ConfigError(`${label} exceeds ${maxBytes} ${sizeDescription} — refusing to read`);
    }
    return readFdLimited(fd, maxBytes, label);
  } finally {
    closeSync(fd);
  }
}

function isGitMetadataName(name: string): boolean {
  return name.toLowerCase() === ".git";
}

/** Recursively read a directory into PluginFile[] (deterministic order). */
function readDirFiles(dir: string): PluginFile[] {
  const out: PluginFile[] = [];
  let totalBytes = 0;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const walk = (d: string, relDir: string): void => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      // A standalone git source is cloned at repository root. Git metadata is
      // never part of the artifact, even when a rel-path selects the root.
      if (isGitMetadataName(entry.name)) continue;
      const abs = join(d, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isSymbolicLink()) {
        throw new ConfigError(`plugin source contains unsupported symlink: ${rel}`);
      } else if (entry.isFile()) {
        if (out.length >= MAX_PLUGIN_FILES) {
          throw new ConfigError(
            `plugin source contains more than ${MAX_PLUGIN_FILES} files — refusing to install`,
          );
        }
        const fd = openSync(abs, constants.O_RDONLY | noFollow);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile()) {
            throw new ConfigError(`plugin source contains unsupported file type: ${rel}`);
          }
          if (stat.size > MAX_PLUGIN_FILE_BYTES) {
            throw new ConfigError(
              `plugin file "${rel}" exceeds ${MAX_PLUGIN_FILE_BYTES} bytes — refusing to install`,
            );
          }
          if (totalBytes + stat.size > MAX_PLUGIN_TOTAL_BYTES) {
            throw new ConfigError(
              `plugin source files exceed ${MAX_PLUGIN_TOTAL_BYTES} bytes — refusing to install`,
            );
          }
          const remainingTotalBytes = MAX_PLUGIN_TOTAL_BYTES - totalBytes;
          const readLimit = Math.min(MAX_PLUGIN_FILE_BYTES, remainingTotalBytes);
          const readLabel =
            readLimit === MAX_PLUGIN_FILE_BYTES
              ? `plugin file "${rel}"`
              : "plugin source files";
          const content = readFdLimited(fd, readLimit, readLabel);
          totalBytes += content.length;
          if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
            throw new ConfigError(
              `plugin source files exceed ${MAX_PLUGIN_TOTAL_BYTES} bytes — refusing to install`,
            );
          }
          out.push({ rel, content });
        } finally {
          closeSync(fd);
        }
      } else {
        throw new ConfigError(`plugin source contains unsupported file type: ${rel}`);
      }
    }
  };
  walk(dir, "");
  return out;
}

/** The plugin entry file we look for, in priority order. */
const ENTRY_FILES = ["plugin.ts", "plugin.js", "index.ts", "index.js", "index.mts"];

function findEntryFile(files: PluginFile[]): string | undefined {
  const names = new Set(files.map((f) => f.rel));
  return ENTRY_FILES.find((n) => names.has(n));
}

/** Reject paths that could escape the plugin root before writing any file. */
function validatePluginPaths(files: PluginFile[], name: string): void {
  const seen = new Set<string>();
  for (const f of files) {
    const parts = f.rel.split(/[\\/]/);
    if (
      !f.rel ||
      isAbsolute(f.rel) ||
      f.rel.includes("\u0000") ||
      parts.some((part) => part === "..")
    ) {
      throw new ConfigError(`plugin "${name}" contains unsafe path: ${f.rel}`);
    }
    if (parts.some(isGitMetadataName)) {
      throw new ConfigError(`plugin "${name}" contains reserved git metadata path: ${f.rel}`);
    }
    if (seen.has(f.rel)) {
      throw new ConfigError(`plugin "${name}" contains duplicate path: ${f.rel}`);
    }
    seen.add(f.rel);
  }
}

function artifactSha256(files: PluginFile[]): string {
  const hash = createHash("sha256");
  hash.update("tenjin-plugin-artifact-v1\0");
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const file of sorted) {
    const path = Buffer.from(file.rel, "utf8");
    const lengths = Buffer.allocUnsafe(16);
    lengths.writeBigUInt64BE(BigInt(path.length), 0);
    lengths.writeBigUInt64BE(BigInt(file.content.length), 8);
    hash.update(lengths);
    hash.update(path);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/**
 * Minimal tar.gz reader (zero deps) — enough to unpack a plugin tarball into
 * PluginFile[] while skipping directory entries.
 */
function extractTarGz(buf: Buffer): PluginFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(buf, { maxOutputLength: MAX_TARBALL_UNPACKED_BYTES });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/maxOutputLength|larger than|too large|buffer/i.test(message)) {
      throw new ConfigError(
        `tarball expands beyond ${MAX_TARBALL_UNPACKED_BYTES} bytes — refusing to install`,
      );
    }
    throw new ConfigError(`invalid tar.gz archive: ${message}`);
  }
  if (tar.length > MAX_TARBALL_UNPACKED_BYTES) {
    throw new ConfigError(
      `tarball expands beyond ${MAX_TARBALL_UNPACKED_BYTES} bytes — refusing to install`,
    );
  }
  const out: PluginFile[] = [];
  let totalFileBytes = 0;
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString("ascii", off, off + 100).replace(/\0.*$/, "");
    if (name === "") break; // end-of-archive zero block
    const sizeStr = tar.toString("ascii", off + 124, off + 136).replace(/\0.*$/, "").trim();
    const typeByte = String.fromCharCode(tar.readUint8(off + 156));
    const size = parseInt(sizeStr || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new ConfigError(`tarball contains invalid size for "${name}"`);
    }
    const contentStart = off + 512;
    if (typeByte === "0" || typeByte === "\u0000") {
      if (size > MAX_PLUGIN_FILE_BYTES) {
        throw new ConfigError(
          `tarball file "${name}" exceeds ${MAX_PLUGIN_FILE_BYTES} bytes — refusing to install`,
        );
      }
      if (out.length >= MAX_PLUGIN_FILES) {
        throw new ConfigError(
          `tarball contains more than ${MAX_PLUGIN_FILES} files — refusing to install`,
        );
      }
      totalFileBytes += size;
      if (totalFileBytes > MAX_TARBALL_UNPACKED_BYTES) {
        throw new ConfigError(
          `tarball files exceed ${MAX_TARBALL_UNPACKED_BYTES} bytes — refusing to install`,
        );
      }
      if (contentStart + size > tar.length) {
        throw new ConfigError(`tarball file "${name}" is truncated`);
      }
      out.push({ rel: name, content: Buffer.from(tar.subarray(contentStart, contentStart + size)) });
    }
    off = contentStart + Math.ceil(size / 512) * 512;
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function requireLocalSourceReference(value: string, label: string): void {
  // Absolute drive paths are local on Windows. URI schemes, scp-style git
  // remotes and UNC paths are not local authority and therefore require a
  // future explicit host egress grant rather than manifest-controlled I/O.
  if (
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    (!isAbsolute(value) && /^[a-z][a-z0-9+.-]*:/i.test(value)) ||
    /^[^/\\]+@[^/\\]+:/.test(value)
  ) {
    throw new ConfigError(
      `${label} remote/network sources are disabled; use a local filesystem path`,
    );
  }
}

function localGitRepositoryPath(value: string): string {
  requireLocalSourceReference(value, "git");
  if (value.startsWith("-")) {
    throw new ConfigError("git repository path must not begin with '-'");
  }
  let path: string;
  try {
    path = realpathSync(resolve(value));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`local git repository not found: ${value}`);
    }
    throw e;
  }
  requireDirectory(path, "local git repository");
  return path;
}

function githubRepositoryUrl(value: string): string {
  const match = /^([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9][a-z0-9._-]*)$/i.exec(value);
  if (!match || match[2] === "." || match[2] === "..") {
    throw new ConfigError(
      `github source must be a literal org/repo slug; arbitrary URLs are disabled`,
    );
  }
  return `https://github.com/${match[1]}/${match[2]}`;
}

/** Fetch a tarball (local path or http(s) URL), verify the pinned sha256, extract. */
async function fetchTarball(source: Extract<PluginSource, { type: "tarball" }>): Promise<{
  files: PluginFile[];
  cleanup: () => void;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "tj-tarball-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    requireLocalSourceReference(source.url, "tarball");
    // Open exactly once, fstat that descriptor, and never read more than the
    // cap. Replacing or growing the pathname cannot bypass the size check.
    const bytes = readLocalFileLimited(
      source.url,
      MAX_TARBALL_COMPRESSED_BYTES,
      `tarball ${source.url}`,
      "compressed bytes",
    );
    if (bytes.length > MAX_TARBALL_COMPRESSED_BYTES) {
      throw new ConfigError(
        `tarball ${source.url} exceeds ${MAX_TARBALL_COMPRESSED_BYTES} compressed bytes — refusing to install`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== source.sha256) {
      throw new ConfigError(
        `tarball sha256 mismatch: pinned ${source.sha256}, got ${digest} — refusing to install (supply-chain)`,
      );
    }
    const files = extractTarGz(bytes);
    // Tar headers are attacker-controlled. Validate before materialising them,
    // including Windows-style separators on Unix hosts.
    validatePluginPaths(files, source.url);
    const tmpDir = join(tmp, "x");
    mkdirSync(tmpDir, { recursive: true });
    // Write out so relative-path resolution is uniform, then re-read.
    for (const f of files) {
      const dest = join(tmpDir, f.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
    return { files: readDirFiles(tmpDir), cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Resolve a plugin entry's source into concrete files + a cleanup handle. */
async function resolveEntryFiles(
  entry: PluginEntry,
  marketplaceDir: string | null,
  marketplaceCommit?: string,
): Promise<{ files: PluginFile[]; sourceCommit?: string; cleanup: () => void }> {
  switch (entry.source.type) {
    case "rel-path": {
      if (!marketplaceDir) throw new ConfigError("rel-path source needs a marketplace clone");
      const cloneRoot = realpathSync(marketplaceDir);
      const candidate = resolve(cloneRoot, entry.source.path);
      if (!isPathInside(cloneRoot, candidate)) {
        throw new ConfigError(
          `rel-path source "${entry.source.path}" escapes the marketplace repository`,
        );
      }
      const candidateRel = relative(cloneRoot, candidate);
      if (candidateRel.split(sep).some(isGitMetadataName)) {
        throw new ConfigError(
          `rel-path source "${entry.source.path}" selects reserved git metadata`,
        );
      }
      if (!existsSync(candidate))
        throw new ConfigError(`rel-path source "${entry.source.path}" not found in marketplace`);
      const sourceRoot = realpathSync(candidate);
      if (!isPathInside(cloneRoot, sourceRoot)) {
        throw new ConfigError(
          `rel-path source "${entry.source.path}" resolves outside the marketplace repository`,
        );
      }
      if (relative(cloneRoot, sourceRoot).split(sep).some(isGitMetadataName)) {
        throw new ConfigError(
          `rel-path source "${entry.source.path}" resolves to reserved git metadata`,
        );
      }
      return {
        files: readDirFiles(sourceRoot),
        sourceCommit: marketplaceCommit,
        cleanup: () => {},
      };
    }
    case "github":
    case "git": {
      let repo: string;
      let allowedProtocols: string;
      if (entry.source.type === "github") {
        repo = githubRepositoryUrl(entry.source.repo);
        allowedProtocols = "https";
      } else {
        repo = localGitRepositoryPath(entry.source.url);
        allowedProtocols = "file";
      }
      const { dir, commit, cleanup } = cloneRepo(repo, {
        allowedProtocols,
      });
      try {
        return { files: readDirFiles(dir), sourceCommit: commit, cleanup };
      } catch (e) {
        cleanup();
        throw e;
      }
    }
    case "tarball":
      return fetchTarball(entry.source);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// ---------------------------------------------------------------------------
// Installed-plugin index (JSON)
// ---------------------------------------------------------------------------

export interface InstalledPlugin {
  name: string;
  version: string;
  marketplace: string;
  /** Exact marketplace URL selected at install; updates never switch it. */
  marketplaceUrl?: string;
  /** Commit of the marketplace snapshot whose manifest selected this entry. */
  marketplaceCommit?: string;
  /** Commit of the concrete source repository (same as marketplace for rel-path). */
  sourceCommit?: string;
  /** Deterministic digest of installed relative paths and file contents. */
  artifactSha256?: string;
  /** Internal commit identity used to recover a tree/index transaction. */
  transactionId?: string;
  source: PluginSource;
  installedAt: string;
  entryFile: string;
  status: "inactive";
  experimental: true;
}

export interface MarketplaceRecord {
  name: string;
  url: string;
  version: string;
  addedAt: string;
  /** Commit resolved when this marketplace record was last added/refreshed. */
  commit?: string;
}

function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new ConfigError(`failed to read plugin state ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConfigError(`plugin state ${file} is not valid JSON; refusing to overwrite it`);
  }
}

function readInstalled(home: string): InstalledPlugin[] {
  const raw = readJson<unknown>(pluginsIndexFile(home), []);
  if (!Array.isArray(raw)) {
    throw new ConfigError(`plugin state ${pluginsIndexFile(home)} must be a JSON array`);
  }
  const installed: InstalledPlugin[] = [];
  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== "object") {
      throw new ConfigError(`installed plugin record #${index + 1} is invalid`);
    }
    const p = value as Record<string, unknown>;
    if (
      typeof p.name !== "string" ||
      !NAMESPACE_RE.test(p.name) ||
      typeof p.version !== "string" ||
      typeof p.marketplace !== "string" ||
      !p.source ||
      typeof p.source !== "object"
    ) {
      throw new ConfigError(`installed plugin record #${index + 1} is invalid`);
    }
    parseSemver(p.version);
    if (
      p.transactionId !== undefined &&
      (typeof p.transactionId !== "string" || !UUID_RE.test(p.transactionId))
    ) {
      throw new ConfigError(`installed plugin record #${index + 1} has an invalid transaction id`);
    }
    const source = normalizeSource(p.source);
    const marketplaceUrl =
      typeof p.marketplaceUrl === "string" && p.marketplaceUrl
        ? p.marketplaceUrl
        : undefined;
    const entryFile =
      typeof p.entryFile === "string" && ENTRY_FILES.includes(p.entryFile)
        ? p.entryFile
        : detectInstalledEntryFile(home, p.name);
    installed.push({
      name: p.name,
      version: p.version,
      marketplace: p.marketplace,
      marketplaceUrl,
      marketplaceCommit:
        typeof p.marketplaceCommit === "string" && /^[0-9a-f]{40,64}$/i.test(p.marketplaceCommit)
          ? p.marketplaceCommit.toLowerCase()
          : undefined,
      sourceCommit:
        typeof p.sourceCommit === "string" && /^[0-9a-f]{40,64}$/i.test(p.sourceCommit)
          ? p.sourceCommit.toLowerCase()
          : undefined,
      artifactSha256:
        typeof p.artifactSha256 === "string" && /^[0-9a-f]{64}$/i.test(p.artifactSha256)
          ? p.artifactSha256.toLowerCase()
          : undefined,
      transactionId:
        typeof p.transactionId === "string" && UUID_RE.test(p.transactionId)
          ? p.transactionId.toLowerCase()
          : undefined,
      source,
      installedAt: typeof p.installedAt === "string" ? p.installedAt : "",
      entryFile,
      status: "inactive",
      experimental: true,
    });
  }
  return installed;
}

function detectInstalledEntryFile(home: string, name: string): string {
  const root = join(pluginsDir(home), ...name.slice(1).split("/"));
  return ENTRY_FILES.find((entry) => existsSync(join(root, entry))) ?? "";
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (e) {
    // Some supported filesystems/platforms reject directory fsync even though
    // file fsync + atomic rename are available. Do not hide other failures.
    const code = (e as NodeJS.ErrnoException).code;
    if (
      !new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF", "EPERM", "EACCES", "ENOSYS"]).has(
        String(code),
      )
    ) {
      throw e;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function renameDurable(from: string, to: string): void {
  renameSync(from, to);
  fsyncDirectory(dirname(from));
  if (dirname(to) !== dirname(from)) fsyncDirectory(dirname(to));
}

function removeDurable(path: string, recursive = false): void {
  rmSync(path, { recursive, force: true });
  fsyncDirectory(dirname(path));
}

function writeFileDurable(path: string, content: Buffer): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameDurable(temp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function writeInstalled(home: string, list: InstalledPlugin[]): void {
  writeJsonAtomic(pluginsIndexFile(home), list);
}

type PluginTransactionPhase =
  | "prepared"
  | "backup-moved"
  | "target-installed"
  | "index-committed";

interface PluginTransactionJournal {
  format: 1;
  id: string;
  name: string;
  phase: PluginTransactionPhase;
  targetExisted: boolean;
  oldIndexFileSha256: string;
  oldTargetArtifactSha256?: string;
  newArtifactSha256: string;
}

function pluginTransactionsDir(home: string): string {
  return join(pluginsDir(home), ".transactions");
}

function pluginTarget(home: string, name: string): string {
  return join(pluginsDir(home), ...name.slice(1).split("/"));
}

function pluginTransactionPaths(
  home: string,
  name: string,
  id: string,
): { target: string; staging: string; backup: string; journal: string } {
  if (!NAMESPACE_RE.test(name) || !UUID_RE.test(id)) {
    throw new ConfigError("plugin transaction contains an invalid identity");
  }
  const target = pluginTarget(home, name);
  return {
    target,
    staging: join(dirname(target), `.${basename(target)}-install-${id}`),
    backup: join(dirname(target), `.${basename(target)}-backup-${id}`),
    journal: join(pluginTransactionsDir(home), `${id}.json`),
  };
}

function pluginIndexFileStateSha256(home: string): string {
  const file = pluginsIndexFile(home);
  try {
    const bytes = readFileSync(file);
    return createHash("sha256").update("present\0").update(bytes).digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return createHash("sha256").update("absent\0").digest("hex");
    }
    throw e;
  }
}

function requireDirectory(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`${label} is missing: ${path}`);
    }
    throw e;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ConfigError(`${label} is not a regular directory: ${path}`);
  }
}

function requirePluginStateRoot(home: string): void {
  requireDirectory(pluginsDir(home), "plugin state root");
}

function requirePluginNamespaceDirectory(home: string, name: string): void {
  requirePluginStateRoot(home);
  const namespace = dirname(pluginTarget(home, name));
  requireDirectory(namespace, `plugin namespace for "${name}"`);
}

function pathExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function pluginTreeSha256(path: string, label: string): string {
  requireDirectory(path, label);
  const files = readDirFiles(path);
  validatePluginPaths(files, label);
  return artifactSha256(files);
}

function parsePluginTransactionJournal(path: string): PluginTransactionJournal {
  const bytes = readLocalFileLimited(
    path,
    MAX_PLUGIN_TRANSACTION_JOURNAL_BYTES,
    "plugin transaction journal",
  );
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ConfigError(`plugin transaction journal is not valid JSON: ${path}`);
  }
  if (!raw || typeof raw !== "object") {
    throw new ConfigError(`plugin transaction journal is invalid: ${path}`);
  }
  const value = raw as Record<string, unknown>;
  const phases = new Set<PluginTransactionPhase>([
    "prepared",
    "backup-moved",
    "target-installed",
    "index-committed",
  ]);
  if (
    value.format !== 1 ||
    typeof value.id !== "string" ||
    !UUID_RE.test(value.id) ||
    typeof value.name !== "string" ||
    !NAMESPACE_RE.test(value.name) ||
    typeof value.phase !== "string" ||
    !phases.has(value.phase as PluginTransactionPhase) ||
    typeof value.targetExisted !== "boolean" ||
    typeof value.oldIndexFileSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.oldIndexFileSha256) ||
    (value.oldTargetArtifactSha256 !== undefined &&
      (typeof value.oldTargetArtifactSha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(value.oldTargetArtifactSha256))) ||
    typeof value.newArtifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.newArtifactSha256)
  ) {
    throw new ConfigError(`plugin transaction journal is invalid: ${path}`);
  }
  if (
    (value.targetExisted === true && value.oldTargetArtifactSha256 === undefined) ||
    (value.targetExisted === false && value.oldTargetArtifactSha256 !== undefined)
  ) {
    throw new ConfigError(`plugin transaction journal has an inconsistent prior target: ${path}`);
  }
  const journal: PluginTransactionJournal = {
    format: 1,
    id: value.id.toLowerCase(),
    name: value.name,
    phase: value.phase as PluginTransactionPhase,
    targetExisted: value.targetExisted,
    oldIndexFileSha256: value.oldIndexFileSha256.toLowerCase(),
    newArtifactSha256: value.newArtifactSha256.toLowerCase(),
  };
  if (typeof value.oldTargetArtifactSha256 === "string") {
    journal.oldTargetArtifactSha256 = value.oldTargetArtifactSha256.toLowerCase();
  }
  if (basename(path) !== `${journal.id}.json`) {
    throw new ConfigError(`plugin transaction journal filename does not match its identity: ${path}`);
  }
  return journal;
}

function writePluginTransactionJournal(home: string, journal: PluginTransactionJournal): void {
  const paths = pluginTransactionPaths(home, journal.name, journal.id);
  mkdirSync(pluginTransactionsDir(home), { recursive: true, mode: 0o700 });
  fsyncDirectory(pluginsDir(home));
  writeJsonAtomic(paths.journal, journal);
}

function removeTransactionDirectory(path: string, label: string): void {
  if (!pathExistsNoFollow(path)) return;
  requireDirectory(path, label);
  removeDurable(path, true);
}

function maybeCrashPluginTransactionForTest(
  point: "after-journal" | "after-backup-rename" | "after-target-rename" | "after-index-write",
): void {
  const selected = (
    globalThis as typeof globalThis & {
      __TENJIN_PLUGIN_TRANSACTION_CRASH_AT__?: string;
    }
  ).__TENJIN_PLUGIN_TRANSACTION_CRASH_AT__;
  if (selected === point) process.exit(86);
}

/** Recover one interrupted tree/index commit. Caller holds the state lock. */
function recoverPluginTransaction(home: string, journalPath: string): void {
  const journal = parsePluginTransactionJournal(journalPath);
  const paths = pluginTransactionPaths(home, journal.name, journal.id);
  if (paths.journal !== journalPath) {
    throw new ConfigError(`plugin transaction journal escaped its state directory: ${journalPath}`);
  }

  const installed = readInstalled(home);
  const committed = installed.filter((record) => record.transactionId === journal.id);
  if (committed.length > 1 || (committed[0] && committed[0].name !== journal.name)) {
    throw new ConfigError(`plugin transaction ${journal.id} has an ambiguous committed index record`);
  }

  if (committed.length === 1) {
    const record = committed[0]!;
    if (record.artifactSha256 !== journal.newArtifactSha256) {
      throw new ConfigError(
        `plugin transaction ${journal.id} index digest does not match its journal`,
      );
    }
    const actual = pluginTreeSha256(paths.target, `committed plugin "${journal.name}"`);
    if (actual !== journal.newArtifactSha256) {
      throw new ConfigError(
        `plugin transaction ${journal.id} committed tree does not match its index; refusing unsafe recovery`,
      );
    }
    if (pathExistsNoFollow(paths.staging)) {
      throw new ConfigError(
        `plugin transaction ${journal.id} has unexpected staging state after index commit`,
      );
    }
    if (pathExistsNoFollow(paths.backup)) {
      if (!journal.targetExisted || journal.oldTargetArtifactSha256 === undefined) {
        throw new ConfigError(
          `plugin transaction ${journal.id} has an unexpected backup; refusing unsafe recovery`,
        );
      }
      const backupDigest = pluginTreeSha256(
        paths.backup,
        "plugin transaction backup directory",
      );
      if (backupDigest !== journal.oldTargetArtifactSha256) {
        throw new ConfigError(
          `plugin transaction ${journal.id} backup was modified; refusing unsafe recovery`,
        );
      }
      removeTransactionDirectory(paths.backup, "plugin transaction backup directory");
    }
    removeDurable(paths.journal);
    return;
  }

  if (pluginIndexFileStateSha256(home) !== journal.oldIndexFileSha256) {
    throw new ConfigError(
      `plugin transaction ${journal.id} found an unexpected index state; refusing unsafe recovery`,
    );
  }

  const backupExists = pathExistsNoFollow(paths.backup);
  const targetExists = pathExistsNoFollow(paths.target);
  if (backupExists) {
    if (!journal.targetExisted || journal.oldTargetArtifactSha256 === undefined) {
      throw new ConfigError(
        `plugin transaction ${journal.id} has an unexpected backup; refusing unsafe recovery`,
      );
    }
    const backupDigest = pluginTreeSha256(
      paths.backup,
      "plugin transaction backup directory",
    );
    if (backupDigest !== journal.oldTargetArtifactSha256) {
      throw new ConfigError(
        `plugin transaction ${journal.id} backup was modified; refusing unsafe recovery`,
      );
    }
    if (targetExists) {
      const targetDigest = pluginTreeSha256(
        paths.target,
        "plugin transaction replacement directory",
      );
      if (targetDigest !== journal.newArtifactSha256) {
        throw new ConfigError(
          `plugin transaction ${journal.id} replacement tree is unexpected; refusing unsafe recovery`,
        );
      }
      removeDurable(paths.target, true);
    }
    renameDurable(paths.backup, paths.target);
  } else if (journal.targetExisted) {
    if (!targetExists) {
      throw new ConfigError(
        `plugin transaction ${journal.id} lost both its target and backup; refusing unsafe recovery`,
      );
    }
    const targetDigest = pluginTreeSha256(paths.target, "original plugin directory");
    if (
      journal.oldTargetArtifactSha256 !== undefined &&
      targetDigest !== journal.oldTargetArtifactSha256
    ) {
      throw new ConfigError(
        `plugin transaction ${journal.id} original tree was modified; refusing unsafe recovery`,
      );
    }
  } else if (targetExists) {
    const targetDigest = pluginTreeSha256(paths.target, "new plugin directory");
    if (targetDigest !== journal.newArtifactSha256) {
      throw new ConfigError(
        `plugin transaction ${journal.id} new tree is unexpected; refusing unsafe recovery`,
      );
    }
    removeDurable(paths.target, true);
  }

  if (pathExistsNoFollow(paths.staging)) {
    const stagingDigest = pluginTreeSha256(
      paths.staging,
      "plugin transaction staging directory",
    );
    if (stagingDigest !== journal.newArtifactSha256) {
      throw new ConfigError(
        `plugin transaction ${journal.id} staging tree was modified; refusing unsafe recovery`,
      );
    }
    removeTransactionDirectory(paths.staging, "plugin transaction staging directory");
  }
  removeDurable(paths.journal);
}

/** Recover all journals left by dead processes. Caller holds the state lock. */
function recoverPendingPluginTransactions(home: string): void {
  const dir = pluginTransactionsDir(home);
  if (!pathExistsNoFollow(dir)) return;
  requireDirectory(dir, "plugin transaction journal directory");
  const journalNames = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (journalNames.length > MAX_PLUGIN_TRANSACTION_JOURNALS) {
    throw new ConfigError(
      `too many pending plugin transactions (${journalNames.length}); refusing unsafe recovery`,
    );
  }
  for (const name of journalNames) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ConfigError(`plugin transaction journal is not a regular file: ${path}`);
    }
    recoverPluginTransaction(home, path);
  }
}

const PLUGIN_LOCK_WAIT_MS = 5_000;
const PLUGIN_LOCK_OWNER_GRACE_MS = 1_000;

interface PluginStateLockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

interface StaleLockSnapshot {
  ownerRaw?: string;
  dev: number;
  ino: number;
  kind: "file" | "directory" | "invalid";
}

function parsePluginStateLockOwner(raw: string | undefined): PluginStateLockOwner | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PluginStateLockOwner>;
    if (
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      typeof value.createdAt === "number" &&
      Number.isFinite(value.createdAt)
    ) {
      return value as PluginStateLockOwner;
    }
  } catch {
    // Fall through to the legacy `<pid>-<token>` owner format.
  }
  const legacy = /^(\d+)-/.exec(raw);
  if (!legacy) return undefined;
  const pid = Number(legacy[1]);
  return Number.isSafeInteger(pid) && pid > 0
    ? { pid, token: raw, createdAt: 0 }
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

function readLockOwnerRaw(
  lockPath: string,
  kind?: StaleLockSnapshot["kind"],
): string | undefined {
  let resolvedKind = kind;
  if (!resolvedKind) {
    try {
      const stat = lstatSync(lockPath);
      resolvedKind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "invalid";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  if (resolvedKind === "invalid") return undefined;
  try {
    return readFileSync(resolvedKind === "directory" ? join(lockPath, "owner") : lockPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function staleLockSnapshot(lockPath: string): StaleLockSnapshot | undefined {
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "invalid";
  const ownerRaw = readLockOwnerRaw(lockPath, kind);
  const owner = parsePluginStateLockOwner(ownerRaw);
  if (owner) {
    if (processIsAlive(owner.pid)) return undefined;
  } else if (Date.now() - stat.mtimeMs < PLUGIN_LOCK_OWNER_GRACE_MS) {
    // The owner file may still be in the short creation window.
    return undefined;
  }
  return { ownerRaw, dev: stat.dev, ino: stat.ino, kind };
}

/** Move a demonstrably orphaned lock aside before deleting it. */
function recoverStalePluginStateLock(lockPath: string): boolean {
  const snapshot = staleLockSnapshot(lockPath);
  if (!snapshot) return false;
  let verifiedStat;
  try {
    verifiedStat = lstatSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  if (
    verifiedStat.dev !== snapshot.dev ||
    verifiedStat.ino !== snapshot.ino ||
    readLockOwnerRaw(lockPath, snapshot.kind) !== snapshot.ownerRaw
  ) {
    return false;
  }

  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  // The lock identity and owner were verified immediately before the rename.
  // A dead PID cannot release/reacquire it in between.
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function lockIdentityMatches(lockPath: string, dev: number, ino: number): boolean {
  try {
    const stat = lstatSync(lockPath);
    return stat.isFile() && stat.dev === dev && stat.ino === ino;
  } catch {
    return false;
  }
}

function tryAcquirePluginStateLock(home: string): (() => void) | undefined {
  mkdirSync(pluginsDir(home), { recursive: true });
  requirePluginStateRoot(home);
  fsyncDirectory(dirname(pluginsDir(home)));
  const lockPath = join(pluginsDir(home), ".commit.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner: PluginStateLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };
    const ownerRaw = JSON.stringify(owner);
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!recoverStalePluginStateLock(lockPath)) return undefined;
      continue;
    }
    const identity = fstatSync(fd);
    let writeError: unknown;
    try {
      writeFileSync(fd, ownerRaw);
    } catch (e) {
      writeError = e;
    } finally {
      closeSync(fd);
    }
    if (writeError !== undefined) {
      if (lockIdentityMatches(lockPath, identity.dev, identity.ino)) {
        rmSync(lockPath, { force: true });
      }
      throw writeError;
    }
    if (
      !lockIdentityMatches(lockPath, identity.dev, identity.ino) ||
      readLockOwnerRaw(lockPath, "file") !== ownerRaw
    ) {
      // A stale-lock recovery raced the short owner-write window. The open
      // descriptor was still safe, but this pathname is no longer our lock.
      continue;
    }
    const release = () => {
      try {
        if (
          lockIdentityMatches(lockPath, identity.dev, identity.ino) &&
          readLockOwnerRaw(lockPath, "file") === ownerRaw
        ) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // A missing/replaced lock is no longer ours to release.
      }
    };
    try {
      recoverPendingPluginTransactions(home);
    } catch (e) {
      release();
      throw e;
    }
    return release;
  }
  return undefined;
}

/** Acquire the cross-process lock shared by all plugin-state mutations. */
async function acquirePluginStateLock(home: string): Promise<() => void> {
  const deadline = Date.now() + PLUGIN_LOCK_WAIT_MS;
  while (true) {
    const release = tryAcquirePluginStateLock(home);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new ConfigError("timed out waiting for another plugin state mutation to finish");
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function acquirePluginStateLockSync(home: string): () => void {
  const release = tryAcquirePluginStateLock(home);
  if (!release) {
    throw new ConfigError("plugin state changed concurrently; retry");
  }
  return release;
}

function readMarketplaces(home: string): MarketplaceRecord[] {
  const raw = readJson<unknown>(marketplacesIndexFile(home), []);
  if (!Array.isArray(raw)) {
    throw new ConfigError(`plugin state ${marketplacesIndexFile(home)} must be a JSON array`);
  }
  return raw.map((value, index): MarketplaceRecord => {
    if (!value || typeof value !== "object") {
      throw new ConfigError(`marketplace record #${index + 1} is invalid`);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      typeof record.url !== "string" ||
      typeof record.version !== "string" ||
      typeof record.addedAt !== "string"
    ) {
      throw new ConfigError(`marketplace record #${index + 1} is invalid`);
    }
    parseSemver(record.version);
    if (
      record.commit !== undefined &&
      (typeof record.commit !== "string" || !/^[0-9a-f]{40,64}$/i.test(record.commit))
    ) {
      throw new ConfigError(`marketplace record #${index + 1} has an invalid commit`);
    }
    return {
      name: record.name,
      url: record.url,
      version: record.version,
      addedAt: record.addedAt,
      commit:
        typeof record.commit === "string" && /^[0-9a-f]{40,64}$/i.test(record.commit)
          ? record.commit.toLowerCase()
          : undefined,
    };
  });
}

function writeMarketplaces(home: string, list: MarketplaceRecord[]): void {
  writeJsonAtomic(marketplacesIndexFile(home), list);
}

// ---------------------------------------------------------------------------
// Marketplace add
// ---------------------------------------------------------------------------

export interface AddMarketplaceResult {
  name: string;
  version: string;
  commit: string;
  plugins: string[];
}

/** Clone a marketplace URL, validate its manifest, record it in the index. */
export function addMarketplace(home: string, url: string): AddMarketplaceResult {
  const { dir, commit, cleanup } = cloneRepo(url);
  try {
    const manifest = readManifestFile(dir);
    const releaseLock = acquirePluginStateLockSync(home);
    try {
      const list = readMarketplaces(home);
      const existing = list.find((m) => m.url === url);
      const record: MarketplaceRecord = {
        name: manifest.name,
        url,
        version: manifest.version,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
        commit,
      };
      if (existing) Object.assign(existing, record);
      else list.push(record);
      writeMarketplaces(home, list);
    } finally {
      releaseLock();
    }
    return {
      name: manifest.name,
      version: manifest.version,
      commit,
      plugins: manifest.plugins.map((p) => p.name),
    };
  } finally {
    cleanup();
  }
}

interface PluginSnapshot {
  entry: PluginEntry;
  marketplace: string;
  url: string;
  dir: string;
  commit: string;
  cleanup: () => void;
}

/**
 * Clone one marketplace snapshot and keep it alive for the whole operation.
 * When `marketplaceUrl` is set (updates), no other marketplace is considered.
 */
function findPluginSnapshot(
  home: string,
  name: string,
  marketplaceUrl?: string,
): PluginSnapshot | null {
  const candidates = marketplaceUrl
    ? readMarketplaces(home).filter((m) => m.url === marketplaceUrl)
    : readMarketplaces(home);
  for (const m of candidates) {
    const { dir, commit, cleanup } = cloneRepo(m.url);
    let retained = false;
    try {
      const manifest = readManifestFile(dir);
      const entry = manifest.plugins.find((p) => p.name === name);
      if (entry) {
        retained = true;
        return {
          entry,
          marketplace: manifest.name,
          url: m.url,
          dir,
          commit,
          cleanup,
        };
      }
    } catch {
      // a broken marketplace must not block searching the others
    } finally {
      if (!retained) cleanup();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallResult {
  name: string;
  version: string;
  dir: string;
  files: string[];
  entryFile: string;
  artifactSha256: string;
  status: "inactive";
  experimental: true;
  /** Set when the manifest declared an installScript — we did NOT run it. */
  installScriptIgnored?: string;
}

interface InstallSnapshotOptions {
  force?: boolean;
  expected?: {
    version: string;
    marketplaceUrl: string;
  };
}

/**
 * Install a plugin by @org/plugin name into home as inactive files. Validates
 * the marketplace manifest, entry-file presence and every destination path
 * before committing anything. It deliberately does not import the entry
 * module or call register(): untrusted plugin code must never execute in the
 * Tenjin host process. Never executes install scripts. Rolls back cleanly on
 * failure.
 */
export async function installPlugin(
  home: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  if (!NAMESPACE_RE.test(name))
    throw new ConfigError(`"${name}" is not a valid @org/plugin name`);
  // Recover any transaction left by a dead installer before interpreting the
  // target/index pair. A live mutation makes this read fail closed.
  const releaseRecoveryLock = acquirePluginStateLockSync(home);
  releaseRecoveryLock();
  const target = pluginTarget(home, name);
  if (pathExistsNoFollow(target) && !opts.force) {
    throw new ConfigError(
      `plugin "${name}" is already installed at ${target} (use update for a new version, or remove it first)`,
    );
  }
  const snapshot = findPluginSnapshot(home, name);
  if (!snapshot) throw new ConfigError(`plugin "${name}" not found in any added marketplace`);
  try {
    return await installPluginSnapshot(home, name, snapshot, opts);
  } finally {
    snapshot.cleanup();
  }
}

/** Prepare from one immutable clone, then commit target+index under the lock. */
async function installPluginSnapshot(
  home: string,
  name: string,
  snapshot: PluginSnapshot,
  opts: InstallSnapshotOptions,
): Promise<InstallResult> {
  const { entry, marketplace } = snapshot;
  const target = pluginTarget(home, name);
  // manifest-first: resolve the source into files, require an entry module.
  let cleanup = (): void => {};
  try {
    const resolved = await resolveEntryFiles(entry, snapshot.dir, snapshot.commit);
    const { files } = resolved;
    cleanup = resolved.cleanup;
    const entryFile = findEntryFile(files);
    if (!entryFile)
      throw new ConfigError(
        `plugin "${name}" has no entry module (${ENTRY_FILES.join(", ")}) — refusing to install`,
      );
    validatePluginPaths(files, name);
    const digest = artifactSha256(files);

    const transactionId = randomUUID();
    const transactionPaths = pluginTransactionPaths(home, name, transactionId);
    const record: InstalledPlugin = {
      name,
      version: entry.version,
      marketplace,
      marketplaceUrl: snapshot.url,
      marketplaceCommit: snapshot.commit,
      sourceCommit: resolved.sourceCommit,
      artifactSha256: digest,
      transactionId,
      source: entry.source,
      installedAt: new Date().toISOString(),
      entryFile,
      status: "inactive",
      experimental: true,
    };

    // Stage outside the lock; the lock is held only for target/index commit.
    mkdirSync(dirname(target), { recursive: true });
    requirePluginNamespaceDirectory(home, name);
    fsyncDirectory(pluginsDir(home));
    const staging = transactionPaths.staging;
    mkdirSync(staging, { mode: 0o700 });
    try {
      const stagedDirectories = new Set<string>([staging]);
      for (const f of files) {
        const dest = join(staging, f.rel);
        mkdirSync(dirname(dest), { recursive: true });
        let stagedDir = dirname(dest);
        while (isPathInside(staging, stagedDir)) {
          stagedDirectories.add(stagedDir);
          if (stagedDir === staging) break;
          stagedDir = dirname(stagedDir);
        }
        writeFileDurable(dest, f.content);
      }
      for (const dir of [...stagedDirectories].sort((a, b) => b.length - a.length)) {
        fsyncDirectory(dir);
      }
      fsyncDirectory(dirname(staging));

      let committedBackup: string | undefined;
      const releaseLock = await acquirePluginStateLock(home);
      try {
        // A namespace parent is manifest-derived state. Re-check it after
        // acquiring the lock so a symlink cannot redirect commit destinations.
        requirePluginNamespaceDirectory(home, name);
        // Re-read under lock so concurrent installs are merged rather than
        // overwriting each other's index entries.
        const installedNow = readInstalled(home);
        const current = installedNow.find((p) => p.name === name);
        if (opts.expected) {
          if (!current) {
            throw new ConfigError(`plugin "${name}" changed during update; retry`);
          }
          if (
            current.version !== opts.expected.version ||
            current.marketplaceUrl !== opts.expected.marketplaceUrl
          ) {
            throw new ConfigError(
              `plugin "${name}" changed during update (${current.version}); retry`,
            );
          }
        } else if (!opts.force && (current || existsSync(target))) {
          throw new ConfigError(
            `plugin "${name}" is already installed at ${target} (use update for a new version, or remove it first)`,
          );
        }

        const merged = installedNow.filter((p) => p.name !== name);
        merged.push(record);
        const targetExisted = pathExistsNoFollow(target);
        const oldTargetArtifactSha256 = targetExisted
          ? pluginTreeSha256(target, `existing plugin "${name}"`)
          : undefined;
        const journal: PluginTransactionJournal = {
          format: 1,
          id: transactionId,
          name,
          phase: "prepared",
          targetExisted,
          oldIndexFileSha256: pluginIndexFileStateSha256(home),
          oldTargetArtifactSha256,
          newArtifactSha256: digest,
        };
        let journalWritten = false;
        try {
          writePluginTransactionJournal(home, journal);
          journalWritten = true;
          maybeCrashPluginTransactionForTest("after-journal");

          if (targetExisted) {
            renameDurable(target, transactionPaths.backup);
          }
          maybeCrashPluginTransactionForTest("after-backup-rename");
          journal.phase = "backup-moved";
          writePluginTransactionJournal(home, journal);

          renameDurable(staging, target);
          maybeCrashPluginTransactionForTest("after-target-rename");
          journal.phase = "target-installed";
          writePluginTransactionJournal(home, journal);

          writeInstalled(home, merged);
          maybeCrashPluginTransactionForTest("after-index-write");
          journal.phase = "index-committed";
          writePluginTransactionJournal(home, journal);

          // The new target and index are durable. Removing the journal commits
          // the transaction; a leftover backup is only cleanup residue.
          removeDurable(transactionPaths.journal);
          journalWritten = false;
          if (targetExisted) committedBackup = transactionPaths.backup;
        } catch (e) {
          if (journalWritten && pathExistsNoFollow(transactionPaths.journal)) {
            try {
              recoverPluginTransaction(home, transactionPaths.journal);
            } catch (recoveryError) {
              throw new ConfigError(
                `plugin transaction failed and could not be recovered safely: ${
                  recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
                }`,
              );
            }
          }
          throw e;
        }
      } finally {
        releaseLock();
      }
      if (committedBackup) {
        // The new tree and index are committed and the state lock is already
        // released. Cleanup latency cannot block unrelated state mutations.
        try {
          removeTransactionDirectory(committedBackup, "committed plugin backup directory");
        } catch {
          // A stale hidden backup is safer than undoing committed state.
        }
      }
    } finally {
      if (pathExistsNoFollow(staging)) {
        removeTransactionDirectory(staging, "plugin transaction staging directory");
      }
    }

    return {
      name,
      version: entry.version,
      dir: target,
      files: files.map((f) => f.rel),
      entryFile,
      artifactSha256: digest,
      status: "inactive",
      experimental: true,
      installScriptIgnored: entry.installScript,
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateResult {
  name: string;
  from: string;
  to: string;
  breaking: boolean;
  dir: string;
  status: "inactive";
  experimental: true;
}

/**
 * Update an installed plugin to the newest version published by its
 * marketplace. A major-version (breaking) bump is refused unless `force` is
 * set — the caller surfaces it for confirmation (Claude pattern).
 */
export async function updatePlugin(
  home: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<UpdateResult> {
  const releaseReadLock = acquirePluginStateLockSync(home);
  let installedList: InstalledPlugin[];
  try {
    installedList = readInstalled(home);
  } finally {
    releaseReadLock();
  }
  const cur = installedList.find((p) => p.name === name);
  if (!cur) throw new ConfigError(`plugin "${name}" is not installed (tenjin plugin install ${name})`);
  if (!cur.marketplaceUrl) {
    throw new ConfigError(
      `plugin "${name}" has no unambiguous marketplace provenance; reinstall it before updating`,
    );
  }

  const snapshot = findPluginSnapshot(home, name, cur.marketplaceUrl);
  if (!snapshot)
    throw new ConfigError(`plugin "${name}" no longer exists in its installed marketplace`);
  const { entry } = snapshot;

  try {
    const cmp = compareVersions(entry.version, cur.version);
    if (cmp <= 0)
      throw new ConfigError(`plugin "${name}" is already up to date (${cur.version})`);

    const breaking = isBreakingChange(cur.version, entry.version);
    if (breaking && !opts.force)
      throw new ConfigError(
        `updating "${name}" ${cur.version} -> ${entry.version} is a BREAKING change (major bump) — pass --yes to confirm`,
      );

    const res = await installPluginSnapshot(home, name, snapshot, {
      force: true,
      expected: { version: cur.version, marketplaceUrl: cur.marketplaceUrl },
    });
    return {
      name,
      from: cur.version,
      to: res.version,
      breaking,
      dir: res.dir,
      status: "inactive",
      experimental: true,
    };
  } finally {
    snapshot.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export function listInstalled(home: string): InstalledPlugin[] {
  const releaseLock = acquirePluginStateLockSync(home);
  try {
    return readInstalled(home);
  } finally {
    releaseLock();
  }
}

export function listMarketplaces(home: string): MarketplaceRecord[] {
  return readMarketplaces(home);
}
