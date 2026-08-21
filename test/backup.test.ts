import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  backupHome,
  restoreHome,
  BACKUP_META_FILE,
  BACKUP_FORMAT,
  BACKUP_CONTAINER_VERSION,
  buildExportTarArgs,
  type BackupMeta,
} from "../src/backup";
import { ConfigError } from "../src/config/types";
import { CONFIG_SCHEMA_VERSION } from "../src/config/loader";
import { spawnSync } from "node:child_process";
let home: string;
let target: string;
let outFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tenjin-bk-src-"));
  target = mkdtempSync(join(tmpdir(), "tenjin-bk-dst-"));
  outFile = join(tmpdir(), `tenjin-bk-${Math.random().toString(36).slice(2)}.tar.gz`);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  rmSync(outFile, { force: true });
});

/** A home with config, soul, sessions, memory, bots, skills — and secrets. */
function buildHome(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.yaml"), 'provider: anthropic\nmodel: "m"\nversion: 1\n');
  writeFileSync(join(root, "SOUL.md"), "# SOUL\n\nhello\n");
  mkdirSync(join(root, "sessions/s1"), { recursive: true });
  writeFileSync(join(root, "sessions/s1/events.jsonl"), '{"t":"session_start"}\n');
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory/facts.md"), "a durable fact\n");
  mkdirSync(join(root, "bots/researcher"), { recursive: true });
  writeFileSync(join(root, "bots/researcher/SOUL.md"), "you are a researcher\n");
  mkdirSync(join(root, "skills/myskill"), { recursive: true });
  writeFileSync(join(root, "skills/myskill/SKILL.md"), "# my skill\n");
  // secrets that must never travel
  writeFileSync(join(root, "providers.yaml"), "providers:\n  openai:\n    apiKey: sk-SECRETLIVE\n");
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets/key"), "hunter2\n");
  // machine-local AES secret behind #132 — must never travel either
  writeFileSync(join(root, ".tenjin-keyring"), "KEYRING-SECRET-0f3a9c\n");
  // a path longer than 100 chars exercises the USTAR prefix field
  const longRel = `sessions/deep/${"x".repeat(140)}/log.jsonl`;
  mkdirSync(join(root, longRel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, longRel), '{"long":true}\n');
  return root;
}

/* Minimal USTAR writer used only to craft adversarial archives in tests. */
function header(name: string, size: number): Buffer {
  const b = Buffer.alloc(512, 0);
  b.write(name, 0, 100, "ascii");
  b.write(size.toString(8).padStart(11, "0") + "\u0000", 124, 12, "ascii");
  b.write("\u0000", 156, 1, "ascii");
  b.write("ustar", 257, 5, "ascii");
  b.write("00", 263, 2, "ascii");
  const chk = b.reduce((a, x) => a + x, 0).toString(8).padStart(6, "0") + "\u0000 ";
  b.write(chk, 148, 8, "ascii");
  return b;
}

function tarEntry(name: string, data: Buffer): Buffer {
  return Buffer.concat([
    header(name, data.length),
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512, 0),
  ]);
}

/** A minimal but structurally valid backup archive with a custom manifest. */
function craftArchive(meta: BackupMeta, extra: Record<string, Buffer> = {}): Buffer {
  const parts: Buffer[] = [];
  if (extra["../evil"]) parts.push(tarEntry("../evil", extra["../evil"]));
  parts.push(tarEntry(BACKUP_META_FILE, Buffer.from(JSON.stringify(meta))));
  for (const [name, data] of Object.entries(extra)) {
    if (name === "../evil") continue;
    parts.push(tarEntry(name, data));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

test("backup writes an archive that excludes secrets", () => {
  buildHome(home);
  const res = backupHome(home, outFile);
  expect(existsSync(outFile)).toBe(true);
  // secret paths never backed up
  expect(res.files.some((f) => f === "providers.yaml")).toBe(false);
  expect(res.files.some((f) => f.startsWith("secrets/"))).toBe(false);
  // the machine-local keyring never travels either
  expect(res.files.some((f) => f === ".tenjin-keyring")).toBe(false);
  // data is present
  for (const f of [
    "config.yaml",
    "SOUL.md",
    "sessions/s1/events.jsonl",
    "memory/facts.md",
    "bots/researcher/SOUL.md",
    "skills/myskill/SKILL.md",
  ]) {
    expect(res.files).toContain(f);
  }
  // the compressed archive itself must not leak secret bytes
  const rawTar = gunzipSync(readFileSync(outFile));
  expect(rawTar.includes(Buffer.from("sk-SECRETLIVE"))).toBe(false);
  expect(rawTar.includes(Buffer.from("hunter2"))).toBe(false);
  expect(rawTar.includes(Buffer.from("KEYRING-SECRET-0f3a9c"))).toBe(false);
});

test("roundtrip backup -> restore reproduces the home without secrets", () => {
  buildHome(home);
  const res = backupHome(home, outFile);
  const restored = restoreHome(target, outFile);
  expect(restored.count).toBe(res.count);

  for (const f of [
    "config.yaml",
    "SOUL.md",
    "sessions/s1/events.jsonl",
    "memory/facts.md",
    "bots/researcher/SOUL.md",
    "skills/myskill/SKILL.md",
  ]) {
    expect(existsSync(join(target, f))).toBe(true);
    expect(readFileSync(join(target, f), "utf8")).toBe(
      readFileSync(join(home, f), "utf8"),
    );
  }
  const longRel = `sessions/deep/${"x".repeat(140)}/log.jsonl`;
  expect(readFileSync(join(target, longRel), "utf8")).toBe('{"long":true}\n');
  // secrets are never written back, even when the source has them
  expect(existsSync(join(target, "providers.yaml"))).toBe(false);
  expect(existsSync(join(target, "secrets"))).toBe(false);
  expect(existsSync(join(target, ".tenjin-keyring"))).toBe(false);
});

test("restore never overwrites a machine-local keyring from a foreign archive", () => {
  // the target machine already has its own keyring with a different secret
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, ".tenjin-keyring"), "FRESHER-KEYRING-9c42\n");
  writeFileSync(join(target, "config.yaml"), "local-config\n");

  // craft an archive that smuggles a stale keyring and a provider key
  const meta: BackupMeta = {
    format: BACKUP_FORMAT,
    version: BACKUP_CONTAINER_VERSION,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    files: [".tenjin-keyring", "sessions/s1/events.jsonl"],
  };
  const archive = join(tmpdir(), `k-${Math.random().toString(36).slice(2)}.tar.gz`);
  writeFileSync(
    archive,
    craftArchive(meta, {
      ".tenjin-keyring": Buffer.from("STALE-KEYRING-deadbeef\n"),
      "sessions/s1/events.jsonl": Buffer.from('{"t":"session_start"}\n'),
    }),
  );

  restoreHome(target, archive);

  // the fresher local keyring survives untouched, so encrypted keys stay readable
  expect(readFileSync(join(target, ".tenjin-keyring"), "utf8")).toBe("FRESHER-KEYRING-9c42\n");
  // but the legitimate non-secret data from the archive is restored
  expect(readFileSync(join(target, "sessions/s1/events.jsonl"), "utf8")).toBe(
    '{"t":"session_start"}\n',
  );
  rmSync(archive, { force: true });
});

test("restore rejects non-gzip and archives without a manifest", () => {
  buildHome(home);
  // not a gzip stream at all
  const garbage = join(tmpdir(), `g-${Math.random().toString(36).slice(2)}.gz`);
  writeFileSync(garbage, "not a backup");
  expect(() => restoreHome(target, garbage)).toThrow(/not a valid tenjin backup/);
  rmSync(garbage, { force: true });

  // valid gzip but no manifest
  const nometa = join(tmpdir(), `n-${Math.random().toString(36).slice(2)}.gz`);
  writeFileSync(nometa, gzipSync(Buffer.from("tar-without-meta")));
  expect(() => restoreHome(target, nometa)).toThrow(/missing \.tenjin-backup\.json/);
  rmSync(nometa, { force: true });
});

test("restore rejects backups from a newer container or schema version", () => {
  const baseMeta = (): BackupMeta => ({
    format: BACKUP_FORMAT,
    version: BACKUP_CONTAINER_VERSION,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    files: ["config.yaml"],
  });

  const newerContainer = join(tmpdir(), `c-${Math.random().toString(36).slice(2)}.gz`);
  const m1 = baseMeta();
  m1.version = BACKUP_CONTAINER_VERSION + 1;
  writeFileSync(newerContainer, craftArchive(m1, { "config.yaml": Buffer.from("x") }));
  expect(() => restoreHome(target, newerContainer)).toThrow(/container format v/);
  rmSync(newerContainer, { force: true });

  const newerSchema = join(tmpdir(), `s-${Math.random().toString(36).slice(2)}.gz`);
  const m2 = baseMeta();
  m2.schemaVersion = CONFIG_SCHEMA_VERSION + 1;
  writeFileSync(newerSchema, craftArchive(m2, { "config.yaml": Buffer.from("x") }));
  expect(() => restoreHome(target, newerSchema)).toThrow(/config schema/);
  rmSync(newerSchema, { force: true });
});

test("restore rejects traversal / absolute paths before writing", () => {
  const meta: BackupMeta = {
    format: BACKUP_FORMAT,
    version: BACKUP_CONTAINER_VERSION,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    files: ["../evil"],
  };
  const malicious = join(tmpdir(), `m-${Math.random().toString(36).slice(2)}.gz`);
  writeFileSync(malicious, craftArchive(meta, { "../evil": Buffer.from("pwned\n") }));
  expect(() => restoreHome(target, malicious)).toThrow(/unsafe path/);
  // nothing was written outside the target
  expect(existsSync(join(tmpdir(), "evil"))).toBe(false);
  rmSync(malicious, { force: true });
});

// #307: the portable `tenjin export` archive must not carry secrets — the same
// exclusion list backupHome uses (providers.yaml, secrets/, .tenjin-keyring).
test("tenjin export archive excludes secrets from the portable tar (#307)", () => {
  const root = mkdtempSync(join(tmpdir(), "tenjin-export-src-"));
  const out = join(tmpdir(), `tenjin-exp-${Math.random().toString(36).slice(2)}.tar.gz`);
  try {
    buildHome(root); // config + sessions + memory + bots + skills + secrets
    const args = buildExportTarArgs(out, dirname(root), basename(root));
    const run = spawnSync("tar", args);
    expect(run.status).toBe(0);
    const list = spawnSync("tar", ["-tzf", out]);
    const listing = list.stdout.toString();
    // normal content is exported…
    expect(listing).toContain(`${basename(root)}/config.yaml`);
    // …but the secrets never are
    expect(listing).not.toContain("providers.yaml");
    expect(listing).not.toContain(`${basename(root)}/secrets`);
    expect(listing).not.toContain(".tenjin-keyring");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
});
