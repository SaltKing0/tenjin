import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, dirname, isAbsolute } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { ConfigError } from "../config/types";
import { botDir, listBots, resolveBot } from "./profile";

/**
 * Portable bot packages, zero runtime deps.
 *
 * A bot package is a .tar.gz (USTAR) containing the bot's *portable* content
 * only: SOUL.md, config.yaml, and any bundled folders such as `skills/`.
 * Runtime state is deliberately excluded: sessions/, memory/, inbox/, tasks/,
 * and skill-refine proposals — and the global providers.yaml (which holds API
 * keys) never enter the package.
 *
 * We hand-roll a small USTAR writer/reader (plus node:zlib for gzip) instead of
 * depending on an archive library — flattening to the project's zero-dep rule.
 */

const META_FILE = ".tenjin-package.json";
/** Top-level runtime dirs that never travel with a bot. */
const TOP_LEVEL_RUNTIME_DIRS = new Set(["sessions", "memory", "inbox", "tasks"]);
/** Runtime artifacts (refine proposals, #133) that live beside a bundled skill
 * and must also never travel with the package. */
const RUNTIME_SUB_DIR = "refine";

export interface PackageMeta {
  format: "tenjin-bot";
  version: 1;
  name: string;
}

/* ------------------------------------------------------------------ *
 * USTAR tar writer
 * ------------------------------------------------------------------ */

function ustarHeader(
  name: string,
  size: number,
  type: "file" | "dir",
): Buffer {
  if (name.length > 100) {
    throw new ConfigError(`package path too long for tar: ${name}`);
  }
  const block = Buffer.alloc(512, 0);
  writeStr(block, 0, 100, name); // name
  writeOctal(block, 100, 8, 0o644); // mode (file)
  // uid (108), gid (116) — zero
  writeOctal(block, 124, 12, size); // size
  writeOctal(block, 136, 12, Math.floor(Date.now() / 1000)); // mtime
  // chksum field 148..156 left as spaces for now
  block.write("        ", 148, 8, "ascii"); // chkmagic placeholder
  block.write(type === "file" ? "0" : "5", 156, 1, "ascii"); // typeflag
  // linkname 157..257 — zero
  writeStr(block, 257, 6, "ustar");
  writeStr(block, 263, 2, "00");
  // uname 265, gname 297, devmajor 329, devminor 337 — zero
  // prefix 345..500 — zero
  // compute checksum over the whole block with chksum as spaces
  const chksum = block.reduce((a: number, b: number) => a + b, 0);
  const chk = chksum.toString(8).padStart(6, "0") + "\u0000 ";
  writeStr(block, 148, 8, chk);
  return block;
}

function writeStr(buf: Buffer, off: number, len: number, s: string): void {
  buf.write(s, off, len, "ascii");
}

function writeOctal(buf: Buffer, off: number, len: number, value: number): void {
  const s = value.toString(8).padStart(len - 1, "0") + "\u0000";
  writeStr(buf, off, len, s);
}

function tarEntry(
  name: string,
  content: Buffer,
  type: "file" | "dir",
  out: Buffer[],
): void {
  out.push(ustarHeader(name, content.length, type));
  if (content.length > 0) {
    out.push(content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad > 0) out.push(Buffer.alloc(pad, 0));
  }
}

/* ------------------------------------------------------------------ *
 * Collecting files (excludes runtime dirs)
 * ------------------------------------------------------------------ */

export interface PkgFile {
  rel: string; // path relative to bot root
  content: Buffer;
}

export function collectBotFiles(root: string): PkgFile[] {
  const out: PkgFile[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // skip top-level runtime dirs entirely
        if (relDir === "" && TOP_LEVEL_RUNTIME_DIRS.has(entry.name)) continue;
        // skip runtime refine proposals nested under a bundled skill (#206)
        if (
          entry.name === RUNTIME_SUB_DIR &&
          (relDir === "skills" || relDir.startsWith("skills/"))
        ) {
          continue;
        }
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push({ rel, content: readFileSync(abs) });
      }
    }
  };
  walk(root, "");
  // deterministic order
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export interface ExportResult {
  file: string;
  name: string;
  manifest: string[];
}

export function exportBot(
  home: string,
  name: string,
  opts: { cwd?: string } = {},
): ExportResult {
  const root = botDir(home, name);
  const soulPath = join(root, "SOUL.md");
  if (!existsSync(soulPath)) {
    throw new ConfigError(`unknown bot "${name}" — nothing to export`);
  }
  const file = join(opts.cwd ?? process.cwd(), `${name}.tar.gz`);

  const files = collectBotFiles(root);
  const meta: PackageMeta = { format: "tenjin-bot", version: 1, name };
  const metaJson = Buffer.from(JSON.stringify(meta, null, 2), "utf8");

  const chunks: Buffer[] = [];
  tarEntry(META_FILE, metaJson, "file", chunks);
  for (const f of files) {
    tarEntry(f.rel, f.content, "file", chunks);
  }
  // end-of-archive: two zero blocks
  chunks.push(Buffer.alloc(1024, 0));

  const tar = Buffer.concat(chunks);
  writeFileSync(file, gzipSync(tar));
  return {
    file,
    name,
    manifest: files.map((f) => f.rel),
  };
}

/* ------------------------------------------------------------------ *
 * USTAR tar reader
 * ------------------------------------------------------------------ */

interface TarEntry {
  name: string;
  type: "file" | "dir";
  content: Buffer;
}

function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString("ascii", off, off + 100).replace(/\0.*$/, "");
    const sizeStr = buf
      .toString("ascii", off + 124, off + 136)
      .replace(/\0.*$/, "")
      .trim();
    const typeByte = String.fromCharCode(buf.readUint8(off + 156));
    // end of archive marker: two zero blocks
    if (name === "" || name.length === 0) {
      off += 512;
      continue;
    }
    const size = parseInt(sizeStr || "0", 8);
    const contentStart = off + 512;
    const content = buf.subarray(contentStart, contentStart + size);
    if (typeByte === "0" || typeByte === "\u0000") {
      entries.push({ name, type: "file", content: Buffer.from(content) });
    } else if (typeByte === "5") {
      entries.push({ name, type: "dir", content: Buffer.alloc(0) });
    }
    off = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export interface ImportResult {
  name: string;
  dir: string;
  files: string[];
}

function sanitizeImportName(raw: string): string {
  const name = basename(raw).replace(/\.[^.]+$/, "");
  // keep it simple & safe: letters, digits, dash, underscore
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new ConfigError("package has no usable bot name");
  return cleaned.toLowerCase();
}

function uniqueBotName(home: string, name: string): string {
  const existing = new Set(listBots(home));
  if (!existing.has(name)) return name;
  let i = 2;
  while (existing.has(`${name}-${i}`)) i++;
  return `${name}-${i}`;
}

export function importBot(home: string, archivePath: string): ImportResult {
  let tar: Buffer;
  try {
    tar = gunzipSync(readFileSync(archivePath));
  } catch {
    throw new ConfigError(`not a valid bot package: ${archivePath}`);
  }

  const entries = parseTar(tar);
  const files: PkgFile[] = entries
    .filter((e) => e.type === "file")
    .map((e) => ({ rel: e.name, content: e.content }));
  return installPortableFiles(home, files);
}

/**
 * Core install: given a set of portable package files (from a .tar.gz or from a
 * catalog directory), validate the manifest, pick a safe unique name, write the
 * contents and resolveBot-validate the result — rolling back fully on failure.
 * Shared by `importBot` (tar pipeline) and the git catalog installer.
 */
export function installPortableFiles(home: string, files: PkgFile[]): ImportResult {
  // read meta (required)
  const metaEntry = files.find((f) => f.rel === META_FILE);
  if (!metaEntry) {
    throw new ConfigError(`not a tenjin bot package: missing ${META_FILE}`);
  }
  let meta: PackageMeta;
  try {
    meta = JSON.parse(metaEntry.content.toString("utf8"));
  } catch {
    throw new ConfigError("corrupt package metadata");
  }
  if (meta.format !== "tenjin-bot") {
    throw new ConfigError(`not a tenjin bot package: unknown format ${meta.format}`);
  }
  const baseName = sanitizeImportName(meta.name);
  const botName = uniqueBotName(home, baseName);
  const root = botDir(home, botName);

  // validate paths BEFORE writing anything (no traversal, no absolute)
  const relFiles: string[] = [];
  for (const e of files) {
    if (e.rel === META_FILE) continue;
    if (
      isAbsolute(e.rel) ||
      e.rel.startsWith("..") ||
      e.rel.startsWith("/") ||
      e.rel.includes("\u0000") ||
      e.rel.split("/").some((p) => p === "..")
    ) {
      throw new ConfigError(`package contains unsafe path: ${e.rel}`);
    }
    relFiles.push(e.rel);
  }

  try {
    mkdirSync(root, { recursive: true });
    for (const e of files) {
      if (e.rel === META_FILE) continue;
      const dest = join(root, e.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, e.content);
    }
    // validate the imported bot the same way resolveBot does (model/budget/yaml/security)
    // — throws ConfigError on bad config
    resolveBot(home, botName);
  } catch (err) {
    // roll back a half-created bot so a failed import leaves nothing behind
    rmSync(root, { recursive: true, force: true });
    throw err;
  }

  return { name: botName, dir: root, files: relFiles };
}
