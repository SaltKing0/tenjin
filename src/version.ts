// Version single-source-of-truth.
//
// The authoritative version is `version` in package.json (the npm/bun
// registry source). src/version.ts derives from it so bumping the release
// version in one place keeps the CLI banner, --version and package metadata
// in lockstep. Falls back to a placeholder if package.json is unreadable
// (e.g. a bundled/dist build without the manifest) rather than crashing.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// `scripts/build-release.ts` replaces this identifier while compiling the
// standalone executable. `typeof` keeps source/dev execution safe when no
// build-time define is present.
declare const __TENJIN_VERSION__: string | undefined;

function loadVersion(): string {
  if (
    typeof __TENJIN_VERSION__ === "string" &&
    __TENJIN_VERSION__.trim()
  ) {
    return __TENJIN_VERSION__.trim();
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    /* fall through to the placeholder */
  }
  return "0.0.0";
}

export const VERSION = loadVersion();
export const PRODUCT = "Tenjin";
