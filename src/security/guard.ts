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

export const GUARD_DISABLED_WARNING =
  "WARNING: security guard is DISABLED (security.disabled: true). Path and command policy is not enforced. Re-enable in config.yaml.";

export function isGuardDisabled(
  security?: { disabled?: boolean } | null,
): boolean {
  return security?.disabled === true;
}

export interface GuardStatus {
  state: "active" | "disabled";
  blockedEvents: number;
}

export function buildGuardStatus(
  security: { disabled?: boolean } | undefined,
  blockedEvents: number,
): GuardStatus {
  return {
    state: isGuardDisabled(security) ? "disabled" : "active",
    blockedEvents,
  };
}

/** Log + audit when `security.disabled` is set. Returns whether a warning was emitted. */
export function announceGuardDisabled(opts: {
  security?: { disabled?: boolean };
  log: (line: string) => void;
  audit?: { append(kind: "guard_disabled", actor: string, detail: string): void };
  actor?: string;
}): boolean {
  if (!isGuardDisabled(opts.security)) return false;
  opts.log(GUARD_DISABLED_WARNING);
  opts.audit?.append("guard_disabled", opts.actor ?? "boot", GUARD_DISABLED_WARNING);
  return true;
}

function globToSource(pattern: string): string {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
}

/* ---- Obfuscation decoding helpers ------------------------------------ *
 * These close trivial guard bypasses: a blocked filename smuggled through
 * base64, hex, or printf escapes decodes back to a plain path that the
 * pattern matcher can then see.
 */

function isPrintableAscii(s: string): boolean {
  return s.length > 0 && /^[\x20-\x7E]+$/.test(s);
}

function decodeBase64Payloads(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{4,}={0,2})(?=$|[^A-Za-z0-9+/=])/g,
  )) {
    const tok = m[1]!;
    if (tok.replace(/=+$/, "").length < 4) continue;
    const decoded = Buffer.from(tok, "base64").toString("utf8");
    if (isPrintableAscii(decoded)) out.push(decoded);
  }
  return out;
}

function decodeHexPayloads(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /(?:^|[^0-9A-Fa-f])([0-9A-Fa-f]{4,})(?=$|[^0-9A-Fa-f])/g,
  )) {
    const run = m[1]!;
    if (run.length % 2 !== 0) continue;
    const decoded = Buffer.from(run, "hex").toString("utf8");
    if (isPrintableAscii(decoded)) out.push(decoded);
  }
  return out;
}

function decodeEscapePayloads(text: string): string[] {
  const out: string[] = [];
  const hexBytes: number[] = [];
  for (const m of text.matchAll(/\\(?:x|X)([0-9A-Fa-f]{2})/g)) {
    hexBytes.push(parseInt(m[1]!, 16));
  }
  if (hexBytes.length) {
    const decoded = Buffer.from(hexBytes).toString("utf8");
    if (isPrintableAscii(decoded)) out.push(decoded);
  }
  const octBytes: number[] = [];
  for (const m of text.matchAll(/\\(?:0)?([0-7]{1,3})(?!\d)/g)) {
    octBytes.push(parseInt(m[1]!, 8));
  }
  if (octBytes.length) {
    const decoded = Buffer.from(octBytes).toString("utf8");
    if (isPrintableAscii(decoded)) out.push(decoded);
  }
  return out;
}

/** Decode and rescan obfuscated payloads embedded anywhere in a command. */
function decodeEncodedPayloads(text: string): string[] {
  return [
    ...decodeEscapePayloads(text),
    ...decodeHexPayloads(text),
    ...decodeBase64Payloads(text),
  ];
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
    const inline = this.scanInlineScript(command);
    if (inline) return inline;
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
    const encoded = this.scanEncoded(command);
    if (encoded) return encoded;
    return { blocked: false };
  }

  /**
   * Decode base64 / hex / printf-escaped payloads anywhere in the command and
   * rescan each decoded result against the pattern table. Pure token matching
   * misses `base64 -d <<< LmVudg==`, `xxd -r -p <<< 2e656e76` and
   * `printf '\x2e\x65\x6e\x76'` because the encoded token itself never looks
   * like the blocked path.
   */
  private scanEncoded(text: string): GuardResult | null {
    for (const payload of decodeEncodedPayloads(text)) {
      const result = this.checkText(payload);
      if (result.blocked) return result;
    }
    return null;
  }

  /**
   * Interpreters invoked with -c / -e / -r run an inline script that plain
   * tokenisation may not see as a path. Extract the quoted script body and
   * scan it directly (including any encoded payloads inside it).
   */
  private scanInlineScript(command: string): GuardResult | null {
    const re = /\b(?:python|python3|node|perl|php|ruby|sh|bash|zsh|ksh|dash|deno|bun)\s+-([a-zA-Z])\s+(["'`])([\s\S]*?)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command))) {
      if (!/^[cerE]$/.test(m[1]!)) continue;
      const script = m[3]!;
      const direct = this.checkText(script);
      if (direct.blocked) return direct;
      const encoded = this.scanEncoded(script);
      if (encoded) return encoded;
    }
    return null;
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
