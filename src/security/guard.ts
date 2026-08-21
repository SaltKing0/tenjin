import { ConfigError } from "../config/types";

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
}

function globToSource(pattern: string): string {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
}

export class SecurityGuard {
  private entries: Array<{ pattern: string; full: RegExp; base: RegExp }>;

  constructor(
    readonly patterns: string[],
    readonly onBlock?: (detail: string) => void,
  ) {
    this.entries = patterns.map((pattern) => {
      const src = globToSource(pattern);
      return {
        pattern,
        full: new RegExp(`^${src}$`, "i"),
        base: new RegExp(`(?:^|/)${src}$`, "i"),
      };
    });
  }

  static fromConfig(security: { blockedPatterns?: string[]; disabled?: boolean } | undefined, onBlock?: (detail: string) => void): SecurityGuard | null {
    if (security?.disabled) return null;
    const patterns = security?.blockedPatterns ?? [...DEFAULT_BLOCKED_PATTERNS];
    if (!Array.isArray(patterns)) {
      throw new ConfigError("security.blockedPatterns must be a list of globs");
    }
    return new SecurityGuard(patterns, onBlock);
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

  checkTool(name: string, input: Record<string, unknown>): GuardResult {
    switch (name) {
      case "read_file":
      case "write_file":
      case "edit_file": {
        const path = input.path;
        if (typeof path !== "string") return { blocked: false };
        return this.checkText(path);
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
