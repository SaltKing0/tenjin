import { ConfigError } from "../config/types";
import { realpathSync } from "node:fs";
import { resolve, normalize, isAbsolute, join, dirname, basename, sep } from "node:path";

export const DEFAULT_BLOCKED_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "*credentials*",
  "*.secret",
];

export interface GuardResult {
  blocked: boolean;
  pattern?: string;
  target?: string;
  // Populated for workspace confinement blocks (pattern is not set then).
  reason?: string;
}

export interface WorkspaceOptions {
  // Workspace root enforced for path tools. Defaults to the tool's cwd.
  workspaceRoot?: string;
  // Extra absolute paths that are allowed even if outside the workspace root
  // (e.g. dedicated Memory/Skills directories).
  allowedPaths?: string[];
}

function globToSource(pattern: string): string {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
}

export class SecurityGuard {
  private entries: Array<{ pattern: string; full: RegExp; base: RegExp }>;
  private workspaceRoot?: string;
  private allowedPaths: string[];

  constructor(
    readonly patterns: string[],
    readonly onBlock?: (detail: string) => void,
    options: WorkspaceOptions = {},
  ) {
    this.entries = patterns.map((pattern) => {
      const src = globToSource(pattern);
      return {
        pattern,
        full: new RegExp(`^${src}$`, "i"),
        base: new RegExp(`(?:^|/)${src}$`, "i"),
      };
    });
    this.workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;
    this.allowedPaths = (options.allowedPaths ?? []).map((p) => resolve(p));
  }

  static fromConfig(security: { blockedPatterns?: string[]; disabled?: boolean; workspaceRoot?: string; allowedPaths?: string[] } | undefined, onBlock?: (detail: string) => void): SecurityGuard | null {
    if (security?.disabled) return null;
    const patterns = security?.blockedPatterns ?? [...DEFAULT_BLOCKED_PATTERNS];
    if (!Array.isArray(patterns)) {
      throw new ConfigError("security.blockedPatterns must be a list of globs");
    }
    if (security?.workspaceRoot !== undefined && typeof security.workspaceRoot !== "string") {
      throw new ConfigError("security.workspaceRoot must be a string path");
    }
    if (security?.allowedPaths !== undefined && !Array.isArray(security.allowedPaths)) {
      throw new ConfigError("security.allowedPaths must be a list of paths");
    }
    return new SecurityGuard(patterns, onBlock, {
      workspaceRoot: security?.workspaceRoot,
      allowedPaths: security?.allowedPaths,
    });
  }

  checkText(text: string): GuardResult {
    for (const entry of this.entries) {
      if (entry.full.test(text) || entry.base.test(text)) {
        return { blocked: true, pattern: entry.pattern, target: text };
      }
    }
    return { blocked: false };
  }

  checkCommand(command: string): GuardResult {
    const direct = this.checkText(command);
    if (direct.blocked && !command.includes(" ")) return direct;
    const tokens = command.split(/[\s"'|;&<>()$`]+/).filter(Boolean);
    for (const token of tokens) {
      const result = this.checkText(token);
      if (result.blocked) return result;
    }
    for (const entry of this.entries) {
      if (entry.pattern.startsWith("*") && command.toLowerCase().includes(entry.pattern.slice(1).toLowerCase())) {
        return { blocked: true, pattern: entry.pattern, target: command };
      }
    }
    return { blocked: false };
  }

  /**
   * Resolve a path to its canonical form, following symlinks where possible.
   * If the target itself does not exist (e.g. a write target not created yet),
   * fall back to resolving the nearest existing parent and re-joining the
   * basename, so containment is still enforced for prospective paths.
   */
  private resolveReal(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      try {
        return join(realpathSync(dirname(p)), basename(p));
      } catch {
        return normalize(resolve(p));
      }
    }
  }

  private isInside(target: string, roots: string[]): boolean {
    for (const root of roots) {
      const r = root.endsWith(sep) ? root : root + sep;
      if (target === root || target.startsWith(r)) return true;
    }
    return false;
  }

  /**
   * Workspace confinement for path tools: block access that resolves outside the
   * workspace root (traversal, absolute paths, and symlink escapes).
   */
  private checkWorkspace(raw: string, cwd?: string): GuardResult {
    // Confinement root: configured workspaceRoot, otherwise the tool's cwd.
    const effRoot = this.workspaceRoot ?? (cwd ? resolve(cwd) : undefined);
    if (!effRoot) return { blocked: false };

    const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd ?? effRoot, raw);
    const normalized = normalize(abs);
    // Resolve symlinks so a link inside the root pointing outside is caught.
    const real = this.resolveReal(abs);

    const roots = [effRoot, ...this.allowedPaths];
    if (!this.isInside(normalized, roots) || !this.isInside(real, roots)) {
      return { blocked: true, reason: "outside workspace", target: raw };
    }
    return { blocked: false };
  }

  checkTool(name: string, input: Record<string, unknown>, cwd?: string): GuardResult {
    switch (name) {
      case "read_file":
      case "write_file":
      case "edit_file": {
        const path = input.path;
        if (typeof path !== "string") return { blocked: false };
        const pattern = this.checkText(path);
        if (pattern.blocked) return pattern;
        return this.checkWorkspace(path, cwd);
      }
      case "bash": {
        const command = input.command;
        if (typeof command !== "string") return { blocked: false };
        return this.checkCommand(command);
      }
      default:
        return { blocked: false };
    }
  }
}
