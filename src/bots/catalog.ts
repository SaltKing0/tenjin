import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { ConfigError } from "../config/types";
import { botsDir, listBots, resolveBot } from "./profile";
import {
  collectBotFiles,
  installPortableFiles,
  type PkgFile,
  type PackageMeta,
  type ImportResult,
} from "./package";

/**
 * Bot-Marketplace-lite: a git-based bot registry (issue #140).
 *
 * A catalog is a git repository holding one *portable* bot package per directory
 * under `bots/<name>/`. Each package directory contains exactly the #104 portable
 * content (SOUL.md, config.yaml, bundled folders) plus a `.tenjin-package.json`
 * manifest. Runtime state (sessions/memory/inbox) and API keys never enter a
 * package, so catalog repos are safe to share — no own infrastructure needed.
 */

/** Directory inside the catalog repo that holds the packages. */
export const PKG_DIR = "bots";
const META_FILE = ".tenjin-package.json";

export interface CatalogRef {
  repo: string; // clone-able git repo (URL, ssh, or local path)
  name: string; // package name inside the catalog
}

/** Parse `<repo>/<name>` — split on the LAST `/` so repo paths/URLs survive. */
export function parseCatalogRef(ref: string): CatalogRef {
  const idx = ref.lastIndexOf("/");
  if (idx <= 0 || idx === ref.length - 1) {
    throw new ConfigError(`expected <repo>/<name>, got "${ref}"`);
  }
  return { repo: ref.slice(0, idx), name: ref.slice(idx + 1) };
}

/** Run git, surfacing failures as ConfigError. */
function git(repoDir: string | null, args: string[], msg: string): void {
  const r = spawnSync("git", args, {
    cwd: repoDir ?? process.cwd(),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim().split("\n").pop() ?? "unknown error";
    throw new ConfigError(`${msg}: ${err}`);
  }
}

/** Run git and return its trimmed stdout (empty on failure). */
function gitOut(repoDir: string | null, args: string[]): string {
  const r = spawnSync("git", args, { cwd: repoDir ?? process.cwd(), encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

/**
 * A catalog repo may not have a configured git identity (e.g. a CI runner).
 * Return the `-c user.name=… -c user.email=…` args needed to make `git commit`
 * succeed, only adding them when the repo is missing a name or email.
 */
function commitIdentArgs(repoDir: string): string[] {
  const name = gitOut(repoDir, ["config", "user.name"]);
  const email = gitOut(repoDir, ["config", "user.email"]);
  const args: string[] = [];
  if (!name) args.push("-c", "user.name=tenjin-catalog");
  if (!email) args.push("-c", "user.email=tenjin-catalog@local");
  return args;
}

/** Fresh throwaway clone of a catalog repo. */
function cloneCatalog(repo: string): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "tj-catalog-"));
  git(
    null,
    ["clone", "--quiet", "--depth", "1", repo, join(parent, "clone")],
    `git clone ${repo} failed`,
  );
  const dir = join(parent, "clone");
  return { dir, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

/** Read a package directory's portable files (rel to that package root). */
function readPackageDir(pkgDir: string): { meta: PackageMeta; files: PkgFile[] } {
  const walk = (dir: string, relDir: string): PkgFile[] => {
    const out: PkgFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walk(abs, rel));
      else if (entry.isFile()) out.push({ rel, content: readFileSync(abs) });
    }
    return out;
  };
  const files = walk(pkgDir, "").sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const metaEntry = files.find((f) => f.rel === META_FILE);
  if (!metaEntry) {
    throw new ConfigError(`catalog package is missing ${META_FILE} (not a tenjin bot package)`);
  }
  let meta: PackageMeta;
  try {
    meta = JSON.parse(metaEntry.content.toString("utf8"));
  } catch {
    throw new ConfigError("corrupt package metadata");
  }
  if (meta.format !== "tenjin-bot") {
    throw new ConfigError(`catalog package has unknown format ${meta.format}`);
  }
  return { meta, files };
}

export interface CatalogListing {
  name: string;
  description: string;
}

export interface BrokenBot {
  name: string;
  dir: string;
  reason: string;
}

/**
 * Boot scan (mirrors the #34 broken-skill pattern): resolve every installed bot
 * and surface broken ones with a path + reason instead of failing silently.
 * A single broken bot must never prevent the harness from booting.
 */
export function scanInstalledBots(home: string): { ok: string[]; broken: BrokenBot[] } {
  const ok: string[] = [];
  const broken: BrokenBot[] = [];
  for (const name of listBots(home)) {
    try {
      resolveBot(home, name);
      ok.push(name);
    } catch (e) {
      broken.push({ name, dir: join(botsDir(home), name), reason: (e as Error).message });
    }
  }
  return { ok, broken };
}

/** List the packages available in a catalog repo (search). */
export function searchCatalog(repo: string, query?: string): CatalogListing[] {
  const { dir, cleanup } = cloneCatalog(repo);
  try {
    const pkgsRoot = join(dir, PKG_DIR);
    if (!existsSync(pkgsRoot)) return [];
    const q = query?.trim().toLowerCase();
    const listing: CatalogListing[] = [];
    for (const entry of readdirSync(pkgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(pkgsRoot, entry.name);
      if (!existsSync(join(pkgDir, META_FILE))) continue;
      const name = entry.name;
      let description = "";
      try {
        const soul = join(pkgDir, "SOUL.md");
        if (existsSync(soul)) {
          const text = readFileSync(soul, "utf8");
          const m = /^#\s*(.*)$/m.exec(text);
          description = (m?.[1] ?? text.trim().split("\n")[0] ?? "").trim();
        }
      } catch {
        // leave empty
      }
      if (q && !name.toLowerCase().includes(q) && !description.toLowerCase().includes(q)) continue;
      listing.push({ name, description });
    }
    return listing.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    cleanup();
  }
}

export interface InstallPreview {
  name: string; // resolved bot name that would be created
  files: string[]; // files that will be written
  meta: PackageMeta;
}

/** Clone + validate a package and report what installing would create (no writes). */
export function previewCatalogInstall(home: string, ref: CatalogRef): {
  preview: InstallPreview;
  cleanup: () => void;
  repoDir: string;
} {
  const { dir, cleanup } = cloneCatalog(ref.repo);
  const pkgDir = join(dir, PKG_DIR, ref.name);
  if (!existsSync(pkgDir)) {
    cleanup();
    throw new ConfigError(
      `no package "${ref.name}" in catalog ${ref.repo} (looked in ${PKG_DIR}/${ref.name})`,
    );
  }
  const { meta, files } = readPackageDir(pkgDir);
  // Resolve the name the same way install will (dedupe not applied in preview —
  // a CLI note tells the user the final name may gain a suffix).
  const name = basename(meta.name) || ref.name;
  return {
    preview: { name, files: files.filter((f) => f.rel !== META_FILE).map((f) => f.rel), meta },
    cleanup,
    repoDir: dir,
  };
}

/**
 * Install a package from a catalog into the given home. `repoDir` comes from a
 * prior `previewCatalogInstall` (so validate-then-confirm-then-install all share
 * one clone). Cleans up the clone when done.
 */
export function installCatalogPackage(
  home: string,
  repoDir: string,
  name: string,
  cleanup: () => void,
): ImportResult {
  try {
    const pkgDir = join(repoDir, PKG_DIR, name);
    const { files } = readPackageDir(pkgDir);
    return installPortableFiles(home, files);
  } finally {
    cleanup();
  }
}

export interface PublishResult {
  name: string;
  files: string[];
  commit: string;
}

/**
 * Export a bot (#104 portable format, secrets-free) into a catalog repo and
 * commit it. The catalog must be a git repo (any URL/ssh/local path).
 */
export function publishBotToCatalog(
  home: string,
  botName: string,
  repo: string,
  opts: { push?: boolean } = {},
): PublishResult {
  const root = join(botsDir(home), botName);
  if (!existsSync(join(root, "SOUL.md"))) {
    throw new ConfigError(`unknown bot "${botName}" — nothing to publish`);
  }
  const portable = collectBotFiles(root);
  const meta: PackageMeta = { format: "tenjin-bot", version: 1, name: botName };
  const metaJson = Buffer.from(JSON.stringify(meta, null, 2), "utf8");

  const { dir, cleanup } = cloneCatalog(repo);
  try {
    const pkgDir = join(dir, PKG_DIR, botName);
    rmSync(pkgDir, { recursive: true, force: true });
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, META_FILE), metaJson);
    for (const f of portable) {
      const dest = join(pkgDir, f.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
    git(dir, ["add", "-A"], "git add failed");
    git(dir, [...commitIdentArgs(dir), "commit", "-m", `publish bot ${botName}`], "git commit failed");
    if (opts.push) {
      git(dir, ["push", "origin", "HEAD"], "git push failed");
    }
    const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    return {
      name: botName,
      files: [META_FILE, ...portable.map((f) => f.rel)],
      commit,
    };
  } finally {
    cleanup();
  }
}
