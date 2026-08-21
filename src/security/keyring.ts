import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config/types";

/**
 * Secrets at rest (#132). API keys are kept plaintext in providers.yaml today
 * (0600 only); this module encrypts the `apiKey` values under a machine-local
 * secret so a file-read leak (bad backup path, stray commit, another process)
 * doesn't expose every key.
 *
 * The machine-local secret lives in a 0600 keyfile in the home (the portable
 * fallback to a macOS Keychain entry). Encryption is OPT-IN: no keyfile means
 * providers.yaml stays plaintext exactly as before, so existing homes and tests
 * are unaffected. When enabled, keys are encrypted on write and decrypted
 * transparently on load. An encrypted value that can't be decrypted (keyfile
 * missing on this machine) surfaces a clear ConfigError instead of a silent
 * garbage key.
 */

/** Marker prefix so an encrypted value is self-describing and distinct from plaintext. */
export const ENC_PREFIX = "enc:v1:";

export function keyringPath(home: string): string {
  return join(home, ".tenjin-keyring");
}

export function keyringEnabled(home: string): boolean {
  return existsSync(keyringPath(home));
}

export interface Keyring {
  home: string;
  secret: Buffer;
}

/** Open the machine-local keyring; null when it is not initialized (plaintext mode). */
export function openKeyring(home: string): Keyring | null {
  const p = keyringPath(home);
  if (!existsSync(p)) return null;
  // Secrets at rest must be 0600. Refuse to load a keyring with looser perms
  // (a stray umask, backup copy, or bad write) instead of silently trusting it.
  const mode = statSync(p).mode & 0o777;
  if (mode !== 0o600) {
    throw new ConfigError(
      `keyring at ${p} has permissions ${mode.toString(8)}, expected 0600 — re-create it with "tenjin keyring init" so the secret stays machine-local`,
    );
  }
  const secret = Buffer.from(readFileSync(p, "utf8").trim(), "base64");
  return secret.length > 0 ? { home, secret } : null;
}

/** Generate a 32-byte machine-local secret in a 0600 keyfile. Idempotent-guarded. */
export function initKeyring(home: string): string {
  const p = keyringPath(home);
  if (existsSync(p)) {
    throw new ConfigError(`keyring already exists at ${p}`);
  }
  writeFileSync(p, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
  return p;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/** AES-256-GCM encrypt a secret into the self-describing `enc:` blob format. */
export function encrypt(ring: Keyring, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.secret, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** AES-256-GCM decrypt an `enc:` blob. Throws a clear ConfigError on failure. */
export function decrypt(ring: Keyring, blob: string): string {
  const payload = blob.slice(ENC_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new ConfigError("malformed encrypted key value (expected enc:v1:<iv>:<tag>:<ct>)");
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    ring.secret,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new ConfigError("failed to decrypt a key — keyring secret does not match this machine, or the value is corrupt");
  }
}

/**
 * Encrypt every plaintext `apiKey` inside a `providers:` mapping (any provider
 * entry), leaving the rest of the structure untouched. Used before persisting
 * a providers.yaml when a keyring is enabled. Already-encrypted values pass
 * through unchanged.
 */
export function encryptProviders(
  ring: Keyring,
  providers: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, pcfg] of Object.entries(providers)) {
    if (typeof pcfg === "object" && pcfg !== null) {
      const rec = { ...(pcfg as Record<string, unknown>) };
      const apiKey = rec.apiKey;
      if (typeof apiKey === "string" && apiKey && !isEncrypted(apiKey)) {
        rec.apiKey = encrypt(ring, apiKey);
      }
      out[name] = rec;
    } else {
      out[name] = pcfg;
    }
  }
  return out;
}
