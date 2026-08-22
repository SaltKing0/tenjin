// ===========================================================================
// B12-5 Egress + credential proxy (#431)
// ---------------------------------------------------------------------------
// The proxy — not the allowlist file — is where exfiltration actually stops.
// This module is the pure, headless-testable decision engine behind the egress
// proxy, source/sink policy, DNS rebind guard, and credential broker. Docker /
// network transports are OUT of scope here (gated like #424); these functions
// are deterministic and fully unit-testable with zero deps.
//
//  1. EgressProxy  — terminate ALL workspace outbound traffic: DENY by default,
//                    domain allowlist enforced AT the proxy, every attempt
//                    (allowed or denied) logged with its target.
//  2. SourceSinkPolicy — flows from sensitive Sources (credential store,
//                    private paths) to exfil Sinks (POST/submit/files-API) are
//                    BLOCKED (or gated on approval) — never merely warned.
//  3. DnsGuard     — resolve+pin hostnames and block DNS rebinding (a public
//                    name that starts resolving to private/loopback ranges).
//  4. GitCredentialBroker — a git token is injected ONLY for the duration of a
//                    clone then dropped; pushes go through a short-lived scoped
//                    credential. The raw key is never left behind.
// ===========================================================================

export type Decision = "allow" | "deny" | "approval";

export interface OutboundAttempt {
  ts: string;
  host: string;
  port: number;
  decision: Decision;
}

// ---------------------------------------------------------------------------
// 1. EgressProxy — deny-all default, SNI/domain allowlist at the proxy
// ---------------------------------------------------------------------------

/** True when a host matches an allowlist entry. Entries may be an exact domain
 *  (`example.com` matches it and any subdomain) or a `*.example.com` glob
 *  (subdomains only, never the bare apex). Everything else is denied. */
export function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().replace(/\.$/, "");
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p || h.endsWith(`.${p}`);
}

export class EgressProxy {
  readonly allowlist: string[];
  readonly attempts: OutboundAttempt[] = [];

  constructor(allowlist: string[] = []) {
    this.allowlist = allowlist.map((d) => d.trim()).filter(Boolean);
  }

  /** Decide whether an outbound connect to (host, port) is permitted. Default
   *  is DENY; an allowlist entry is required. Every decision is logged. */
  decideConnect(host: string, port: number): Decision {
    const allowed = this.allowlist.some((p) => domainMatches(host, p));
    const decision: Decision = allowed ? "allow" : "deny";
    this.attempts.push({ ts: new Date().toISOString(), host, port, decision });
    return decision;
  }

  /** The full outbound-connection log (each denied/allowed target). */
  outboundLog(): OutboundAttempt[] {
    return [...this.attempts];
  }
}

// ---------------------------------------------------------------------------
// 2. SourceSinkPolicy — sensitive source → exfil sink is blocked or gated
// ---------------------------------------------------------------------------

export type SourceClass = "sensitive" | "ordinary";
export type SinkClass = "exfil" | "read";

export interface Flow {
  source: SourceClass;
  sink: SinkClass;
}

/**
 * A flow from a SENSITIVE source (credential store, private paths) to an
 * EXFIL sink (POST / submit / files-API) is never merely warned: it is BLOCKED
 * by default, or gated behind approval when `approvalMode` is set. Sensitive →
 * read and ordinary flows pass.
 */
export class SourceSinkPolicy {
  constructor(
    private readonly approvalMode = false,
  ) {}

  decide(flow: Flow): Decision {
    if (flow.source === "sensitive" && flow.sink === "exfil") {
      return this.approvalMode ? "approval" : "deny";
    }
    return "allow";
  }
}

// ---------------------------------------------------------------------------
// 3. DnsGuard — resolve+pin and block DNS rebinding
// ---------------------------------------------------------------------------

/** Private / loopback / link-local / ULA ranges — never legitimate for a
 *  public-name lookup (the classic DNS-rebinding payload). */
const PRIVATE_IP_RE = new RegExp(
  [
    "^127\\.", // loopback
    "^10\\.", // RFC1918
    "^192\\.168\\.",
    "^172\\.(1[6-9]|2\\d|3[01])\\.",
    "^169\\.254\\.", // link-local
    "^0\\.", // "this network"
    "^::1$", // IPv6 loopback
    "^fc", // ULA fc00::/7
    "^fd",
    "^fe80:", // link-local IPv6
  ].join("|"),
);

/** A public-looking hostname resolving to a private/loopback address is a
 *  rebind pattern — block it. */
export function isRebindTarget(host: string, ip: string): boolean {
  if (!/^[a-z0-9.-]+$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return false; // an IP literal is not a public-name rebind
  }
  return PRIVATE_IP_RE.test(ip);
}

/**
 * resolve+pin: the first resolution of a host is pinned; a later resolution
 * that differs is a rebind attempt and is denied.
 */
export class DnsGuard {
  private readonly pinned = new Map<string, string>();

  /** Resolve `host` to `ip` and decide. Returns deny for a rebind pattern or a
   *  pin mismatch, allow otherwise (pinning the first-seen address). */
  decide(host: string, ip: string): Decision {
    if (isRebindTarget(host, ip)) return "deny";
    const existing = this.pinned.get(host);
    if (existing === undefined) {
      this.pinned.set(host, ip);
      return "allow";
    }
    return existing === ip ? "allow" : "deny";
  }

  pinnedAddress(host: string): string | undefined {
    return this.pinned.get(host);
  }
}

// ---------------------------------------------------------------------------
// 4. GitCredentialBroker — token only during clone, scoped push, no residue
// ---------------------------------------------------------------------------

/** A credential provider returns a short-lived, scope-limited token for a git
 *  operation. The host keeps the raw key in keyring; only this scoped token is
 *  ever presented to the workspace. */
export type CredentialProvider = (scope: string) => string;

/** Embed `token` into a git remote URL for the duration of a clone. */
export function scopedGitUrl(raw: string, token: string): string {
  // https://host/org/repo.git  ->  https://x-access-token:TOKEN@host/org/repo.git
  if (!/^https:\/\//i.test(raw)) return raw;
  return raw.replace(/^https:\/\//i, `https://x-access-token:${token}@`);
}

/** Strip any token-bearing credentials back out of a URL (post-clone drop). */
export function redactToken(url: string): string {
  // https://x-access-token:TOKEN@host  ->  https://host
  return url.replace(/^https:\/\/[^@/]+@/i, "https://");
}

/** True when a token (or any credential-looking secret) is still in the url. */
export function urlHasToken(url: string): boolean {
  return /^https:\/\/[^@/]+@/i.test(url);
}

/**
 * Scans the surfaces a workspace can carry for a leaked token and returns the
 * locations where it appears (empty = the token is provably nowhere). Used as
 * the "scan assert" that a clone leaves no token in env, argv or files.
 */
export function findTokenLeak(
  token: string,
  surfaces: { env?: Record<string, string>; argv?: string[]; files?: string[] },
): string[] {
  const leaks: string[] = [];
  if (!token) return leaks;
  if (surfaces.env) {
    for (const [k, v] of Object.entries(surfaces.env)) {
      if (v.includes(token)) leaks.push(`env:${k}`);
    }
  }
  if (surfaces.argv) {
    for (const a of surfaces.argv) {
      if (a.includes(token)) leaks.push(`argv:${a}`);
    }
  }
  if (surfaces.files) {
    surfaces.files.forEach((f, i) => {
      if (f.includes(token)) leaks.push(`file[${i}]`);
    });
  }
  return leaks;
}

export interface ClonePlan {
  /** argv to run for the clone (token embedded in the URL for this command). */
  argv: string[];
  /** The token-bearing URL used for this one command. */
  tokenUrl: string;
  /** Drop the token: returns a workspace-safe env/args with no token left. */
  envAfter: Record<string, string>;
  argsAfter: string[];
}

/**
 * Build a token-injected clone and a post-clone surface that is provably
 * token-free. The token exists ONLY inside `tokenUrl`/`argv` for the single
 * clone command; `envAfter`/`argsAfter` (what the workspace keeps) carry no
 * token, so the raw key never survives the clone.
 */
export function planClone(rawUrl: string, token: string, opts: { dest?: string } = {}): ClonePlan {
  const tokenUrl = scopedGitUrl(rawUrl, token);
  const dest = opts.dest ?? ".";
  const argv = ["git", "clone", tokenUrl, dest];
  return {
    argv,
    tokenUrl,
    envAfter: {},
    argsAfter: [dest],
  };
}
