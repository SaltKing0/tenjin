// Redaction of secret material before it is written to session / audit logs.
//
// The agent may legitimately read files that contain secrets (config, key
// files) as part of its work. Without a redaction layer, that content is
// written verbatim into session JSONL and the audit log, so a single read can
// put a key permanently on disk. This module masks known secret formats before
// anything is logged. It is defensive: when in doubt it over-masks rather than
// leak.

const MASK = "[REDACTED]";

// -----BEGIN <TYPE> PRIVATE KEY----- ... -----END <TYPE> PRIVATE KEY-----.
// The footer is optional so a truncated/corrupt key is still masked to EOF.
const PEM_BLOCK =
  /(-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)[\s\S]*?(-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g;

// OpenAI / Anthropic style API keys: sk-... (incl. sk-ant-..., sk-proj-...)
const OPENAI_SK = /\bsk-[A-Za-z0-9_-]{8,}/g;

// AWS access key id: AKIA + 16 alphanumeric chars
const AWS_AKIA = /\bAKIA[0-9A-Z]{16}(?![0-9A-Z])/g;

// GitHub personal / installation / fine-grained (PAT) tokens
const GITHUB_TOKEN = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g;

// Messaging/channel credentials are commonly supplied through the parent
// environment. Child-process isolation is the primary control; these patterns
// are defense-in-depth for tool or connector output crossing into a model.
const SLACK_TOKEN = /\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}\b/g;
const TELEGRAM_BOT_TOKEN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;
const DISCORD_TOKEN = /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,})\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;

// Additional well-known token shapes. Structured secrets which do not have a
// distinctive shape are handled by the key-aware rules below.
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{20,}\b/g;
const GITLAB_TOKEN = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const HUGGING_FACE_TOKEN = /\bhf_[A-Za-z0-9]{20,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// URL credentials otherwise evade line/key-aware matching. Preserve enough of
// the URL for diagnostics while masking the password and sensitive query value.
const URL_BASIC_AUTH = /\b(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const URL_QUERY_PARAMETER = /([?&])([A-Za-z_][A-Za-z0-9_.-]*)(=)([^&#\s]*)/g;
const SENSITIVE_QUERY_KEYS = new Set([
  "KEY",
  "SIG",
  "SIGNATURE",
  "X_AMZ_SIGNATURE",
  "X_GOOG_SIGNATURE",
]);

// A quoted JSON object member can occur anywhere on a line. Preserve the key,
// delimiter and quoting so the redacted value remains valid JSON.
const JSON_STRING_MEMBER =
  /"([A-Za-z_][A-Za-z0-9_.-]*)"(\s*:\s*)"(?:\\.|[^"\\])*"/g;
const SINGLE_QUOTED_MEMBER =
  /'([A-Za-z_][A-Za-z0-9_.-]*)'(\s*:\s*)'(?:\\.|[^'\\])*'/g;

// Dotenv (`KEY=value`, optionally `export`), YAML (`key: value`) and HTTP
// headers (`Authorization: ...`) all share the same line-oriented shape. The
// callback only masks values whose key is actually secret-like; ordinary
// assignments such as MAXCITY=berlin remain byte-for-byte intact.
const STRUCTURED_LINE =
  /^(\s*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*(?:=|:)[ \t]*)([^\r\n]*?)([ \t]*)$/gm;

const SENSITIVE_KEY_PARTS = new Set([
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
]);

const SENSITIVE_KEYS = new Set([
  "AUTHORIZATION",
  "PROXY_AUTHORIZATION",
  "COOKIE",
  "SET_COOKIE",
  "DATABASE_URL",
  "DB_URL",
  "REDIS_URL",
  "CONNECTION_STRING",
]);

/** Whether a structured field name conventionally carries secret material. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (
    normalized.includes("API_KEY") ||
    normalized.includes("APIKEY") ||
    normalized.includes("PRIVATE_KEY") ||
    normalized.includes("SIGNING_KEY") ||
    normalized.includes("ACCESS_KEY")
  ) {
    return true;
  }
  return normalized.split("_").some((part) => SENSITIVE_KEY_PARTS.has(part));
}

function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function isSensitiveQueryKey(key: string): boolean {
  return isSensitiveKey(key) || SENSITIVE_QUERY_KEYS.has(normalizeKey(key));
}

export interface RedactionConfig {
  disabled?: boolean;
  redaction?: boolean;
}

/**
 * Stateful redactor. `enabled` controls whether text is masked; a disabled
 * redactor passes input through untouched (e.g. `security.redaction: off` or
 * the whole security block disabled).
 */
export class Redactor {
  private readonly knownSecrets: string[];

  constructor(
    readonly enabled: boolean = true,
    knownSecrets: Iterable<string> = [],
  ) {
    this.knownSecrets = [...new Set(knownSecrets)]
      // Very short global replacements create destructive false positives
      // (e.g. a configured value "a" masking every prose sentence). Secret
      // fields are still protected by the structured key-aware rules.
      .filter((secret) => secret.length >= 6 && secret !== MASK)
      .sort((a, b) => b.length - a.length);
  }

  static fromConfig(
    security: RedactionConfig | undefined,
    knownSecrets: Iterable<string> = [],
  ): Redactor {
    if (security?.disabled) return new Redactor(false, knownSecrets);
    return new Redactor(security?.redaction !== false, knownSecrets);
  }

  /** Return a redactor with additional exact secret literals registered. */
  withSecrets(secrets: Iterable<string>): Redactor {
    return new Redactor(this.enabled, [...this.knownSecrets, ...secrets]);
  }

  redact(text: string): string {
    if (!this.enabled) return text;
    if (typeof text !== "string") return text;
    let out = text;
    for (const secret of this.knownSecrets) {
      out = out.split(secret).join(MASK);
    }
    out = out.replace(PEM_BLOCK, (match: string, begin: string, end: string) => {
      // Preserve the source's newline count so file:line output remains
      // trustworthy when a complete document is redacted before slicing.
      const newlineCount = match.split("\n").length - 1;
      if (newlineCount === 0) return `${begin}${MASK}${end}`;
      return `${begin}\n${MASK}${"\n".repeat(newlineCount - 1)}${end}`;
    });
    out = out.replace(OPENAI_SK, MASK);
    out = out.replace(AWS_AKIA, MASK);
    out = out.replace(GITHUB_TOKEN, MASK);
    out = out.replace(SLACK_TOKEN, MASK);
    out = out.replace(TELEGRAM_BOT_TOKEN, MASK);
    out = out.replace(DISCORD_TOKEN, MASK);
    out = out.replace(GOOGLE_API_KEY, MASK);
    out = out.replace(NPM_TOKEN, MASK);
    out = out.replace(GITLAB_TOKEN, MASK);
    out = out.replace(HUGGING_FACE_TOKEN, MASK);
    out = out.replace(JWT, MASK);
    out = out.replace(
      URL_BASIC_AUTH,
      (_whole, scheme: string, username: string) => `${scheme}${username}:${MASK}@`,
    );
    out = out.replace(
      URL_QUERY_PARAMETER,
      (whole, prefix: string, key: string, separator: string) =>
        isSensitiveQueryKey(key) ? `${prefix}${key}${separator}${MASK}` : whole,
    );
    out = out.replace(
      JSON_STRING_MEMBER,
      (whole, key: string, separator: string) =>
        isSensitiveKey(key) ? `"${key}"${separator}"${MASK}"` : whole,
    );
    out = out.replace(
      SINGLE_QUOTED_MEMBER,
      (whole, key: string, separator: string) =>
        isSensitiveKey(key) ? `'${key}'${separator}'${MASK}'` : whole,
    );
    out = out.replace(
      STRUCTURED_LINE,
      (whole, prefix: string, key: string, separator: string, _value: string, suffix: string) =>
        isSensitiveKey(key) ? `${prefix}${key}${separator}${MASK}${suffix}` : whole,
    );
    return out;
  }

  /**
   * Recursively redact string content inside an arbitrary JSON-ish value
   * (tool inputs / outputs). Non-strings are passed through unchanged.
   */
  redactValue(value: unknown): unknown {
    if (!this.enabled) return value;
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = isSensitiveKey(k) ? MASK : this.redactValue(v);
      }
      return out;
    }
    return value;
  }
}

export { MASK };
