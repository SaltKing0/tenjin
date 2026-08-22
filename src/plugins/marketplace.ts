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
//   github:org/repo       a standalone GitHub repo (the plugin lives at root)
//   git:<url>             any clone-able git repo (plugin at root)
//   {type:"tarball",...}  a .tar.gz, REQUIRED to pin a sha256 digest
//
// SUPPLY-CHAIN LAW: tarballs are digest-verified (pinned sha256) BEFORE
// install; npm is usable only as a transport and install-scripts are NEVER
// executed — installing is copy-files + register(api), nothing more.
// Installed plugins land in the capability registry (#414) only AFTER
// manifest-first validation has passed.
// ===========================================================================

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ConfigError } from "../config/types";
import { tenjinHome } from "../config/loader";
import {
  CapabilityRegistry,
  loadPlugin,
  type PluginContract,
} from "./registry";

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

/** Local index of installed plugins: [{name, version, pluginId, marketplace, source}]. */
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

function git(repoDir: string | null, args: string[], msg: string): void {
  const r = spawnSync("git", args, { cwd: repoDir ?? process.cwd(), encoding: "utf8" });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim().split("\n").pop() ?? "unknown error";
    throw new ConfigError(`${msg}: ${err}`);
  }
}

/** Fresh throwaway clone of a marketplace/git repo. */
function cloneRepo(repo: string): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "tj-mkt-"));
  git(null, ["clone", "--quiet", "--depth", "1", repo, join(parent, "clone")], `git clone ${repo} failed`);
  return { dir: join(parent, "clone"), cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function readManifestFile(dir: string): MarketplaceManifest {
  const p = join(dir, "marketplace.json");
  if (!existsSync(p)) throw new ConfigError(`no marketplace.json in ${dir}`);
  return parseMarketplaceManifest(readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// Source resolution -> PluginFile[]
// ---------------------------------------------------------------------------

/** Recursively read a directory into PluginFile[] (deterministic order). */
function readDirFiles(dir: string): PluginFile[] {
  const out: PluginFile[] = [];
  const walk = (d: string, relDir: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.push({ rel, content: readFileSync(abs) });
    }
  };
  walk(dir, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** The plugin entry file we look for, in priority order. */
const ENTRY_FILES = ["plugin.ts", "plugin.js", "index.ts", "index.js", "index.mts"];

function findEntryFile(files: PluginFile[]): string | undefined {
  const names = new Set(files.map((f) => f.rel));
  return ENTRY_FILES.find((n) => names.has(n));
}

/**
 * Minimal tar.gz reader (zero deps) — enough to unpack a plugin tarball into
 * PluginFile[] while skipping directory entries.
 */
function extractTarGz(buf: Buffer): PluginFile[] {
  const tar = gunzipSync(buf);
  const out: PluginFile[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString("ascii", off, off + 100).replace(/\0.*$/, "");
    if (name === "") break; // end-of-archive zero block
    const sizeStr = tar.toString("ascii", off + 124, off + 136).replace(/\0.*$/, "").trim();
    const typeByte = String.fromCharCode(tar.readUint8(off + 156));
    const size = parseInt(sizeStr || "0", 8);
    const contentStart = off + 512;
    if (typeByte === "0" || typeByte === "\u0000") {
      out.push({ rel: name, content: Buffer.from(tar.subarray(contentStart, contentStart + size)) });
    }
    off = contentStart + Math.ceil(size / 512) * 512;
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Fetch a tarball (local path or http(s) URL), verify the pinned sha256, extract. */
async function fetchTarball(source: Extract<PluginSource, { type: "tarball" }>): Promise<{
  files: PluginFile[];
  cleanup: () => void;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "tj-tarball-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    let bytes: Buffer;
    if (/^https?:\/\//i.test(source.url)) {
      const res = await fetch(source.url);
      if (!res.ok) throw new ConfigError(`fetch ${source.url} failed: HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } else {
      const p = source.url;
      if (!existsSync(p)) throw new ConfigError(`tarball not found: ${p}`);
      bytes = readFileSync(p);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== source.sha256) {
      throw new ConfigError(
        `tarball sha256 mismatch: pinned ${source.sha256}, got ${digest} — refusing to install (supply-chain)`,
      );
    }
    const files = extractTarGz(bytes);
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
): Promise<{ files: PluginFile[]; cleanup: () => void }> {
  switch (entry.source.type) {
    case "rel-path": {
      if (!marketplaceDir) throw new ConfigError("rel-path source needs a marketplace clone");
      const dir = join(marketplaceDir, entry.source.path);
      if (!existsSync(dir))
        throw new ConfigError(`rel-path source "${entry.source.path}" not found in marketplace`);
      return { files: readDirFiles(dir), cleanup: () => {} };
    }
    case "github":
    case "git": {
      const repo = entry.source.type === "github" ? `https://github.com/${entry.source.repo}` : entry.source.url;
      const { dir, cleanup } = cloneRepo(repo);
      return { files: readDirFiles(dir), cleanup };
    }
    case "tarball":
      return fetchTarball(entry.source);
  }
}

// ---------------------------------------------------------------------------
// Installed-plugin index (JSON)
// ---------------------------------------------------------------------------

interface InstalledPlugin {
  name: string;
  version: string;
  pluginId: string;
  marketplace: string;
  source: PluginSource;
  installedAt: string;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readInstalled(home: string): InstalledPlugin[] {
  return readJson<InstalledPlugin[]>(pluginsIndexFile(home), []);
}

function writeInstalled(home: string, list: InstalledPlugin[]): void {
  mkdirSync(pluginsDir(home), { recursive: true });
  writeFileSync(pluginsIndexFile(home), JSON.stringify(list, null, 2));
}

function readMarketplaces(home: string): Array<{ name: string; url: string; version: string; addedAt: string }> {
  return readJson(marketplacesIndexFile(home), []);
}

function writeMarketplaces(home: string, list: Array<{ name: string; url: string; version: string; addedAt: string }>): void {
  mkdirSync(marketplacesDir(home), { recursive: true });
  writeFileSync(marketplacesIndexFile(home), JSON.stringify(list, null, 2));
}

function sanitizeDirName(raw: string): string {
  const cleaned = basename(raw).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "marketplace";
}

// ---------------------------------------------------------------------------
// Marketplace add
// ---------------------------------------------------------------------------

export interface AddMarketplaceResult {
  name: string;
  version: string;
  plugins: string[];
}

/** Clone a marketplace URL, validate its manifest, record it in the index. */
export function addMarketplace(home: string, url: string): AddMarketplaceResult {
  const { dir, cleanup } = cloneRepo(url);
  try {
    const manifest = readManifestFile(dir);
    const list = readMarketplaces(home);
    const existing = list.find((m) => m.url === url);
    const record = {
      name: manifest.name,
      url,
      version: manifest.version,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    };
    if (existing) Object.assign(existing, record);
    else list.push(record);
    writeMarketplaces(home, list);
    return {
      name: manifest.name,
      version: manifest.version,
      plugins: manifest.plugins.map((p) => p.name),
    };
  } finally {
    cleanup();
  }
}

/** Find the first added marketplace containing a plugin with `name`. */
function findPluginEntry(
  home: string,
  name: string,
): { entry: PluginEntry; marketplace: string; url: string } | null {
  for (const m of readMarketplaces(home)) {
    const { dir, cleanup } = cloneRepo(m.url);
    try {
      const manifest = readManifestFile(dir);
      const entry = manifest.plugins.find((p) => p.name === name);
      if (entry) return { entry, marketplace: m.name, url: m.url };
    } catch {
      // a broken marketplace must not block searching the others
    } finally {
      cleanup();
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
  pluginId: string;
  registrySize: number;
  /** Set when the manifest declared an installScript — we did NOT run it. */
  installScriptIgnored?: string;
}

/**
 * Install a plugin by @org/plugin name into home and load it into the
 * capability registry. Validates the marketplace manifest and the plugin's own
 * entry module BEFORE writing anything (manifest-first). Never executes any
 * install script. Rolls back cleanly on failure.
 */
export async function installPlugin(
  home: string,
  registry: CapabilityRegistry,
  name: string,
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  if (!NAMESPACE_RE.test(name))
    throw new ConfigError(`"${name}" is not a valid @org/plugin name`);
  const found = findPluginEntry(home, name);
  if (!found) throw new ConfigError(`plugin "${name}" not found in any added marketplace`);
  const { entry, marketplace } = found;

  const target = join(pluginsDir(home), ...name.slice(1).split("/"));
  if (existsSync(target)) {
    if (!opts.force)
      throw new ConfigError(
        `plugin "${name}" is already installed at ${target} (use update for a new version, or remove it first)`,
      );
    rmSync(target, { recursive: true, force: true });
  }

  // manifest-first: resolve the source into files, require an entry module.
  // A rel-path source needs the marketplace clone itself; other sources fetch
  // independently (git clone / tarball) and ignore the marketplace dir.
  let mktCleanup: (() => void) | undefined;
  let marketplaceDir: string | null = null;
  if (entry.source.type === "rel-path") {
    const c = cloneRepo(found.url);
    marketplaceDir = c.dir;
    mktCleanup = c.cleanup;
  }
  const { files, cleanup } = await resolveEntryFiles(entry, marketplaceDir);
  try {
    const entryFile = findEntryFile(files);
    if (!entryFile)
      throw new ConfigError(
        `plugin "${name}" has no entry module (${ENTRY_FILES.join(", ")}) — refusing to install`,
      );
    // safe path validation before writing (no traversal / absolute)
    for (const f of files) {
      if (isAbsolute(f.rel) || f.rel.startsWith("..") || f.rel.includes("\u0000") || f.rel.split("/").some((p) => p === "..")) {
        throw new ConfigError(`plugin "${name}" contains unsafe path: ${f.rel}`);
      }
    }

    mkdirSync(target, { recursive: true });
    for (const f of files) {
      const dest = join(target, f.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }

    // Load into the registry; a throwing plugin rolls back the install.
    let plugin: PluginContract;
    try {
      const mod = (await import(pathToFileURL(join(target, entryFile)).href)) as { default?: PluginContract } & PluginContract;
      plugin = (mod.default ?? mod) as PluginContract;
      if (!plugin || typeof plugin.register !== "function")
        throw new ConfigError(`plugin "${name}" does not export register(api)`);
    } catch (e) {
      rmSync(target, { recursive: true, force: true });
      throw e instanceof ConfigError ? e : new ConfigError(`failed to load plugin "${name}": ${(e as Error).message}`);
    }

    const res = loadPlugin(registry, plugin);
    if (!res.ok) {
      rmSync(target, { recursive: true, force: true });
      throw new ConfigError(`plugin "${name}" failed to register: ${res.error}`);
    }

    const installed = readInstalled(home).filter((p) => p.name !== name);
    installed.push({
      name,
      version: entry.version,
      pluginId: plugin.id,
      marketplace,
      source: entry.source,
      installedAt: new Date().toISOString(),
    });
    writeInstalled(home, installed);

    return {
      name,
      version: entry.version,
      dir: target,
      files: files.map((f) => f.rel),
      pluginId: plugin.id,
      registrySize: registry.size,
      installScriptIgnored: entry.installScript,
    };
  } finally {
    cleanup();
    mktCleanup?.();
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
  pluginId: string;
}

/**
 * Update an installed plugin to the newest version published by its
 * marketplace. A major-version (breaking) bump is refused unless `force` is
 * set — the caller surfaces it for confirmation (Claude pattern).
 */
export async function updatePlugin(
  home: string,
  registry: CapabilityRegistry,
  name: string,
  opts: { force?: boolean } = {},
): Promise<UpdateResult> {
  const installedList = readInstalled(home);
  const cur = installedList.find((p) => p.name === name);
  if (!cur) throw new ConfigError(`plugin "${name}" is not installed (tenjin plugin install ${name})`);

  const found = findPluginEntry(home, name);
  if (!found) throw new ConfigError(`plugin "${name}" no longer exists in its marketplace`);
  const { entry } = found;

  const cmp = compareVersions(entry.version, cur.version);
  if (cmp <= 0)
    throw new ConfigError(`plugin "${name}" is already up to date (${cur.version})`);

  const breaking = isBreakingChange(cur.version, entry.version);
  if (breaking && !opts.force)
    throw new ConfigError(
      `updating "${name}" ${cur.version} -> ${entry.version} is a BREAKING change (major bump) — pass --yes to confirm`,
    );

  // The re-register would collide with the still-loaded old entries — drop the
  // old plugin's capabilities from the live registry first (owner-scoped).
  if (registry.listByOwner(cur.pluginId).length > 0) registry.unloadOwner(cur.pluginId);

  const res = await installPlugin(home, registry, name, { force: true });
  return {
    name,
    from: cur.version,
    to: entry.version,
    breaking,
    dir: res.dir,
    pluginId: res.pluginId,
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export function listInstalled(home: string): InstalledPlugin[] {
  return readInstalled(home);
}

export function listMarketplaces(home: string): Array<{ name: string; url: string; version: string; addedAt: string }> {
  return readMarketplaces(home);
}
