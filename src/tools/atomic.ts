import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { SecurityGuard } from "../security/guard";

export interface AtomicWriteOptions {
  /** When set, the target's real path is re-resolved and re-checked for
   *  workspace containment immediately before the write (TOCTOU hardening). */
  guard?: SecurityGuard | null;
  /** Tool name used for the containment re-check (e.g. "write_file"). */
  toolName?: string;
  cwd?: string;
}

/**
 * Atomically write `content` to `target` via a same-directory temp file that is
 * renamed over the destination once fully written. POSIX `rename` is atomic on
 * the same filesystem, so a crash or partial write mid-way never leaves a
 * corrupt destination — the previous contents survive untouched until the swap.
 *
 * Mirrors the established pattern in src/bots/inbox.ts and
 * src/memory/summaries.ts. The temp file lives in the same directory so the
 * rename never crosses a filesystem boundary.
 *
 * TOCTOU hardening: the write tools' workspace guard validates the requested
 * path up front (in `dispatch`), but a symlink swapped in after that check
 * could otherwise redirect the write outside the workspace. We therefore
 * re-resolve the real path immediately before the write and re-run the
 * containment check on it, closing that window.
 */
export async function atomicWrite(
  target: string,
  content: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const abs = resolve(target);

  if (opts.guard && opts.toolName) {
    const real = await resolveReal(abs);
    const recheck = opts.guard.checkTool(opts.toolName, { path: real }, opts.cwd);
    if (recheck.blocked) {
      throw new Error(
        `refusing ${opts.toolName}: ${real} resolves outside the workspace (symlink re-check)`,
      );
    }
  }

  await mkdir(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, content);
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Canonical path, falling back to the nearest existing ancestor + basename. */
async function resolveReal(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    try {
      return join(await realpath(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}
