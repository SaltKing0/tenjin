// Redaction of secret material before it is written to session / audit logs.
//
// The agent may legitimately read files that contain secrets (config, key
// files) as part of its work. Without a redaction layer, that content is
// written verbatim into session JSONL and the audit log, so a single read can
// put a key permanently on disk. This module masks known secret formats before
// anything is logged. It is defensive: when in doubt it over-masks rather than
// leak.

const MASK = "[REDACTED]";

// -----BEGIN <TYPE> PRIVATE KEY----- ... -----END <TYPE> PRIVATE KEY-----
const PEM_BLOCK =
  /(-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]+ PRIVATE KEY-----)/g;

// OpenAI / Anthropic style API keys: sk-... (incl. sk-ant-..., sk-proj-...)
const OPENAI_SK = /\bsk-[A-Za-z0-9_-]{8,}/g;

// AWS access key id: AKIA + 16 alphanumeric chars
const AWS_AKIA = /\bAKIA[0-9A-Z]{16}\b/g;

// GitHub personal / installation / fine-grained (PAT) tokens
const GITHUB_TOKEN = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g;

// KEY=VALUE assignment lines (e.g. OPENAI_API_KEY=sk-..., SECRET=...). Masks
// the value, keeps the key name so the log stays readable.
const KEY_VALUE =
  /^(\s*)([A-Z][A-Z0-9_]{2,})(\s*=\s*)([^\s].*?)(\s*)$/gm;

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
  constructor(readonly enabled: boolean = true) {}

  static fromConfig(security: RedactionConfig | undefined): Redactor {
    if (security?.disabled) return new Redactor(false);
    return new Redactor(security?.redaction !== false);
  }

  redact(text: string): string {
    if (!this.enabled) return text;
    if (typeof text !== "string") return text;
    let out = text;
    out = out.replace(PEM_BLOCK, (_m, begin: string, end: string) => {
      return `${begin}\n${MASK}\n${end}`;
    });
    out = out.replace(OPENAI_SK, MASK);
    out = out.replace(AWS_AKIA, MASK);
    out = out.replace(GITHUB_TOKEN, MASK);
    out = out.replace(KEY_VALUE, "$1$2$3" + MASK + "$5");
    return out;
  }

  /**
   * Recursively redact string content inside an arbitrary JSON-ish value
   * (tool inputs / outputs). Non-strings are passed through unchanged.
   */
  redactValue(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.redactValue(v);
      }
      return out;
    }
    return value;
  }
}

export { MASK };
