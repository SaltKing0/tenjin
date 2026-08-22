import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Distribution matrix (Roadmap §18 B15-5, #442).
 *
 * Zero-dep means INSTALLABLE without Bun: `bun build --compile` turns the CLI
 * into a single self-contained binary per platform/arch. This module is the
 * single source of truth for the artifact matrix + checksum helpers shared by
 * the release workflow, the one-command installer, and the smoke tests.
 */

export interface DistTarget {
  platform: "linux" | "darwin" | "windows";
  arch: "x64" | "arm64";
  /** The bun --compile cross-compilation target. */
  bunTarget: string;
  /** Binary filename extension (Windows only). */
  ext: string;
}

/** All six release artifacts: linux/darwin/windows × x64/arm64. */
export const DIST_TARGETS: DistTarget[] = [
  { platform: "linux", arch: "x64", bunTarget: "bun-linux-x64", ext: "" },
  { platform: "linux", arch: "arm64", bunTarget: "bun-linux-arm64", ext: "" },
  { platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64", ext: "" },
  { platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64", ext: "" },
  { platform: "windows", arch: "x64", bunTarget: "bun-windows-x64", ext: ".exe" },
  { platform: "windows", arch: "arm64", bunTarget: "bun-windows-arm64", ext: ".exe" },
];

/**
 * Resolve a (platform, arch) pair to its release target, or null when the
 * combination is unsupported — callers fail gracefully with a clear message.
 */
export function resolveDistTarget(platform: string, arch: string): DistTarget | null {
  return DIST_TARGETS.find((t) => t.platform === platform && t.arch === arch) ?? null;
}

/** Binary artifact name for a target, e.g. `tenjin-linux-x64` (+ `.exe`). */
export function artifactName(t: DistTarget): string {
  return `tenjin-${t.platform}-${t.arch}${t.ext}`;
}

/** sha256 hex digest of a file's contents (Node built-in, no deps). */
export async function computeChecksum(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** Render a SHA256SUMS-style checksum manifest ("<hash>  <name>" per line). */
export function buildChecksumsFile(entries: Array<{ name: string; hash: string }>): string {
  return entries.map((e) => `${e.hash}  ${e.name}`).join("\n") + "\n";
}
