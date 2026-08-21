import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { ConfigError } from "./config/types";
import { CONFIG_SCHEMA_VERSION } from "./config/loader";

/**
 * Whole-home backup/restore, zero runtime deps (#134).
 *
 * A backup is a .tar.gz (USTAR) of the tenjin home directory — config.yaml,
 * SOUL.md, sessions/, memory/, bots/, skills/ — plus a small manifest that
 * records the container format version and the config schema version at backup
 * time. Secrets are deliberately excluded: `providers.yaml` (API keys), a
 * `secrets/` directory and the machine-local `.tenjin-keyring` (the raw AES
 * secret behind #132) never enter the archive, and restore refuses to write
 * any of them back even if one shows up in a foreign archive.
 *
 * We hand-roll a USTAR writer/reader (plus node:zlib for gzip) mirroring the
 * bot package tooling in src/bots/package.ts, keeping the project's zero-dep
 * rule. That writer supports the USTAR `prefix` field so long single-file
 * paths (e.g. deep session logs) survive, unlike the 100-char bot-package
 * writer.
 */

export const BACKUP_META_FILE = ".tenjin-backup.json";
export const BACKUP_FORMAT = "tenjin-home";
/** Backup container format version (independent of the config schema). */
export const BACKUP_CONTAINER_VERSION = 1;

export interface BackupMeta {
  format: typeof BACKUP_FORMAT;
  version: number;
  schemaVersion: number;
  createdAt: string;
  /** Relative paths of every file in the archive. */
  files: string[];
}

/**
 * Top-level home entries that are never backed up (secrets / transient).
 * `.tenjin-keyring` is the machine-local AES secret behind #132 — it must
 * never travel with a backup, and restore must never overwrite it.
 */
const BACKUP_EXCLUDES = new Set(["providers.yaml", "secrets", ".tenjin-keyring"]);

/**
 * Build the `tar` argv for a portable whole-home export (the `tenjin export`
 * CLI command). Mirrors `BACKUP_EXCLUDES` so the same secrets that never enter
 * a backup also never enter an export archive. Because `tar -C parent name`
 * stores members as `name/<entry>`, each exclude is prefixed with the member
 * root so the pattern matches the stored path (GNU tar will then skip the
 * whole `name/secrets` tree by excluding its directory entry).
 */
export function buildExportTarArgs(out: string, parent: string, name: string): string[] {
  const excludes = [...BACKUP_EXCLUDES];
  if (excludes.includes("secrets")) excludes.push("secrets/*");
  const args = ["-czf", out, "-C", parent];
  for (const ex of excludes) args.push("--exclude", `${name}/${ex}`);
  args.push(name);
  return args;
}

interface TarEntry {
  name: string;
  type: "file" | "dir";
  content: Buffer;
}

/* ------------------------------------------------------------------ *
 * USTAR tar writer (with prefix support for paths > 100 chars)
 * ------------------------------------------------------------------ */

function writeStr(buf: Buffer, off: number, len: number, s: string): void {
  buf.write(s, off, len, "ascii");
}

function writeOctal(buf: Buffer, off: number, len: number, value: number): void {
  const s = value.toString(8).padStart(len - 1, "0") + "\u0000";
  writeStr(buf, off, len, s);
}

/** Split a path into USTAR `prefix` + `name` so each fits its field. */
function splitUstarPath(
  name: string,
): { prefix: string; name: string } {
  const MAX_NAME = 100;
  const MAX_PREFIX = 155;
  if (name.length <= MAX_NAME) return { prefix: "", name };
  for (let i = name.length - 1; i >= 0; i--) {
    if (name[i] === "/") {
      const prefix = name.slice(0, i);
      const tail = name.slice(i + 1);
      if (prefix.length <= MAX_PREFIX && tail.length <= MAX_NAME) {
        return { prefix, name: tail };
      }
    }
  }
  throw new ConfigError(`backup path too long for tar: ${name}`);
}

function ustarHeader(
  name: string,
  size: number,
  type: "file" | "dir",
): Buffer {
  const { prefix, name: fname } = splitUstarPath(name);
  const block = Buffer.alloc(512, 0);
  writeStr(block, 0, 100, fname); // name
  writeOctal(block, 100, 8, 0o644); // mode
  // uid (108), gid (116) — zero
  writeOctal(block, 124, 12, size); // size
  writeOctal(block, 136, 12, Math.floor(Date.now() / 1000)); // mtime
  block.write("        ", 148, 8, "ascii"); // chksum placeholder
  block.write(type === "file" ? "0" : "5", 156, 1, "ascii"); // typeflag
  // linkname 157..257 — zero
  writeStr(block, 257, 6, "ustar");
  writeStr(block, 263, 2, "00");
  // uname 265, gname 297, devmajor 329, devminor 337 — zero
  writeStr(block, 345, 155, prefix); // prefix
  // compute checksum over the whole block with chksum as spaces
  const chksum = block.reduce((a: number, b: number) => a + b, 0);
  const chk = chksum.toString(8).padStart(6, "0") + "\u0000 ";
  writeStr(block, 148, 8, chk);
  return block;
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
 * Collecting home files (excludes secrets)
 * ------------------------------------------------------------------ */

interface HomeFile {
  rel: string;
  content: Buffer;
}

function collectHomeFiles(
  root: string,
  skipAbs: Set<string>,
): HomeFile[] {
  const out: HomeFile[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relDir === "" && BACKUP_EXCLUDES.has(entry.name)) continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (skipAbs.has(abs)) continue;
        // top-level secret file (e.g. providers.yaml) — never backed up
        if (relDir === "" && BACKUP_EXCLUDES.has(entry.name)) continue;
        out.push({ rel, content: readFileSync(abs) });
      }
    }
  };
  walk(root, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/* ------------------------------------------------------------------ *
 * USTAR tar reader
 * ------------------------------------------------------------------ */

function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString("ascii", off, off + 100).replace(/\0.*$/, "");
    const prefix = buf
      .toString("ascii", off + 345, off + 500)
      .replace(/\0.*$/, "");
    const sizeStr = buf
      .toString("ascii", off + 124, off + 136)
      .replace(/\0.*$/, "")
      .trim();
    const typeStr = buf.toString("ascii", off + 156, off + 157);
    // end-of-archive marker: two zero blocks
    if (name === "" && prefix === "") {
      off += 512;
      continue;
    }
    const size = parseInt(sizeStr || "0", 8);
    const contentStart = off + 512;
    const content = buf.subarray(contentStart, contentStart + size);
    const fullName = prefix ? `${prefix}/${name}` : name;
    if (typeStr === "0" || typeStr === "\u0000") {
      entries.push({ name: fullName, type: "file", content: Buffer.from(content) });
    } else if (typeStr === "5") {
      entries.push({ name: fullName, type: "dir", content: Buffer.alloc(0) });
    }
    off = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Reject absolute paths, traversal, and NUL bytes before writing anything. */
function assertSafePath(name: string): void {
  if (
    isAbsolute(name) ||
    name.startsWith("..") ||
    name.startsWith("/") ||
    name.includes("\u0000") ||
    name.split("/").some((p) => p === "..")
  ) {
    throw new ConfigError(`backup contains unsafe path: ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------ */

export interface BackupResult {
  file: string;
  count: number;
  files: string[];
}

export function backupHome(home: string, outPath: string): BackupResult {
  if (!existsSync(home)) {
    throw new ConfigError(`home does not exist: ${home}`);
  }
  const tmpPath = `${outPath}.tmp`;
  // Skip both the final archive and its temp sibling so neither the current
  // run nor a stale `.tmp` from an interrupted previous run is collected.
  const skipAbs = new Set<string>([outPath, tmpPath]);
  const files = collectHomeFiles(home, skipAbs);
  const meta: BackupMeta = {
    format: BACKUP_FORMAT,
    version: BACKUP_CONTAINER_VERSION,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    files: files.map((f) => f.rel),
  };

  const chunks: Buffer[] = [];
  tarEntry(
    BACKUP_META_FILE,
    Buffer.from(JSON.stringify(meta, null, 2), "utf8"),
    "file",
    chunks,
  );
  for (const f of files) {
    tarEntry(f.rel, f.content, "file", chunks);
  }
  chunks.push(Buffer.alloc(1024, 0)); // end of archive

  // Write to a sibling temp file and rename over the destination, so a crash or
  // disk-full mid-write never corrupts an existing good backup (it stays intact
  // until the atomic rename).
  writeFileSync(tmpPath, gzipSync(Buffer.concat(chunks)));
  renameSync(tmpPath, outPath);
  return { file: outPath, count: files.length, files: files.map((f) => f.rel) };
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

export interface RestoreResult {
  count: number;
  files: string[];
}

/**
 * Restore a home backup into `home`, validating the whole archive before
 * writing anything. `providers.yaml`, `secrets/` and `.tenjin-keyring` are
 * never written back, even if a foreign archive happens to contain them — a
 * keyring restore must happen out-of-band (`keyring init` + re-saving keys),
 * so restore never clobbers a fresher machine-local secret.
 */
export function restoreHome(home: string, archivePath: string): RestoreResult {
  let tar: Buffer;
  try {
    tar = gunzipSync(readFileSync(archivePath));
  } catch {
    throw new ConfigError(`not a valid tenjin backup: ${archivePath}`);
  }

  const entries = parseTar(tar);
  const files = entries.filter((e) => e.type === "file");

  const metaEntry = files.find((e) => e.name === BACKUP_META_FILE);
  if (!metaEntry) {
    throw new ConfigError(`not a tenjin home backup: missing ${BACKUP_META_FILE}`);
  }
  let meta: BackupMeta;
  try {
    meta = JSON.parse(metaEntry.content.toString("utf8"));
  } catch {
    throw new ConfigError("corrupt backup metadata");
  }
  if (meta.format !== BACKUP_FORMAT) {
    throw new ConfigError(
      `not a tenjin home backup: unknown format "${meta.format}"`,
    );
  }
  if (typeof meta.version === "number" && meta.version > BACKUP_CONTAINER_VERSION) {
    throw new ConfigError(
      `backup uses container format v${meta.version}, this build supports up to v${BACKUP_CONTAINER_VERSION}`,
    );
  }
  if (
    typeof meta.schemaVersion === "number" &&
    meta.schemaVersion > CONFIG_SCHEMA_VERSION
  ) {
    throw new ConfigError(
      `backup was created with config schema v${meta.schemaVersion}, this build supports ${CONFIG_SCHEMA_VERSION} — restore it with a newer Tenjin`,
    );
  }

  // Validate EVERY path before touching the home (no partial restores).
  const restoreFiles = files.filter((e) => e.name !== BACKUP_META_FILE);
  const relFiles: string[] = [];
  for (const e of restoreFiles) {
    const parts = e.name.split("/");
    if (parts[0] && BACKUP_EXCLUDES.has(parts[0])) continue;
    assertSafePath(e.name);
    relFiles.push(e.name);
  }

  mkdirSync(home, { recursive: true });
  for (const e of restoreFiles) {
    const parts = e.name.split("/");
    if (parts[0] && BACKUP_EXCLUDES.has(parts[0])) continue;
    const dest = join(home, e.name);
    mkdirSync(dirname(dest), { recursive: true });
    // Per-file atomic restore: write to a sibling temp then rename, so an
    // interrupted restore never leaves a corrupt/partial file (each file is
    // either the old or the new version, never a torn mix).
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, e.content);
    renameSync(tmp, dest);
  }

  return { count: relFiles.length, files: relFiles };
}
