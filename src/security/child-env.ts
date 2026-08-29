/**
 * Minimal environment inherited by agent-controlled child processes.
 *
 * Inheriting `process.env` would hand every provider key, channel token and
 * credential available to Tenjin to arbitrary shell commands and MCP servers.
 * Keep the ambient set deliberately small; callers may add values only through
 * an explicit configuration surface (for example an MCP server's `env` map).
 */

export type HostEnvironment = Readonly<Record<string, string | undefined>>;

export const SAFE_CHILD_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Required by process creation on Windows. These values describe the OS,
  // not user credentials.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

export interface ChildEnvironmentOptions {
  /** A non-host home for tools that expect HOME to exist. */
  isolatedHome?: string;
  /** Values deliberately granted by a caller-specific configuration surface. */
  explicit?: Readonly<Record<string, string | undefined>>;
}

/**
 * Build an allowlisted child environment.
 *
 * `hostEnv` is injectable so security tests do not need to mutate process.env.
 * Explicit values are applied last, allowing an MCP config to intentionally
 * override a harmless base variable or grant a credential to that one server.
 */
export function buildChildEnvironment(
  hostEnv: HostEnvironment = process.env,
  options: ChildEnvironmentOptions = {},
): Record<string, string> {
  const child: Record<string, string> = {};

  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = hostEnv[key];
    if (value !== undefined) child[key] = value;
  }

  if (options.isolatedHome !== undefined) {
    child.HOME = options.isolatedHome;
  }

  for (const [key, value] of Object.entries(options.explicit ?? {})) {
    if (value !== undefined) child[key] = value;
  }

  return child;
}
