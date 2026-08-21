import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initKeyring,
  openKeyring,
  encrypt,
  decrypt,
  keyringPath,
  keyringEnabled,
  encryptProviders,
  ENC_PREFIX,
  type Keyring,
} from "../src/security/keyring";
import { writeProvidersYaml, loadConfig, providersFile } from "../src/config/loader";
import { ConfigError } from "../src/config/types";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-keyring-"));
  project = mkdtempSync(join(tmpdir(), "tj-keyring-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function withConfig(): void {
  writeFileSync(join(home, "config.yaml"), "provider: anthropic\nmodel: \"m\"\n");
}

describe("keyring primitives (#132)", () => {
  test("AES-GCM encrypt/decrypt round-trips", () => {
    initKeyring(home);
    const ring = openKeyring(home)!;
    const blob = encrypt(ring, "sk-live-secret");
    expect(blob.startsWith(ENC_PREFIX)).toBe(true);
    expect(decrypt(ring, blob)).toBe("sk-live-secret");
    expect(blob).not.toContain("sk-live-secret");
  });

  test("decrypt fails clearly on a corrupt value", () => {
    initKeyring(home);
    const ring = openKeyring(home)!;
    expect(() => decrypt(ring, "enc:v1:not-a-blob")).toThrow(ConfigError);
  });

  test("openKeyring is null until initialized; keyfile is 0600", () => {
    expect(openKeyring(home)).toBeNull();
    expect(keyringEnabled(home)).toBe(false);
    const p = initKeyring(home);
    expect(keyringEnabled(home)).toBe(true);
    expect(p).toBe(keyringPath(home));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(openKeyring(home)).not.toBeNull();
  });

  test("initKeyring refuses to overwrite an existing keyring", () => {
    initKeyring(home);
    expect(() => initKeyring(home)).toThrow(/already exists/);
  });
});

describe("encryptProviders (#132)", () => {
  test("encrypts apiKeys, leaves non-key fields and other providers intact", () => {
    initKeyring(home);
    const ring = openKeyring(home)!;
    const out = encryptProviders(ring, {
      anthropic: { apiKey: "sk-a", baseUrl: "https://a" },
      openai: { baseUrl: "https://b", apiKey: "sk-b" },
    });
    const a = out.anthropic as Record<string, unknown>;
    const b = out.openai as Record<string, unknown>;
    expect(String(a.apiKey).startsWith(ENC_PREFIX)).toBe(true);
    expect(String(b.apiKey).startsWith(ENC_PREFIX)).toBe(true);
    expect(a.baseUrl).toBe("https://a");
    // already-encrypted values pass through unchanged
    const again = encryptProviders(ring, { anthropic: { apiKey: String(a.apiKey) } });
    expect((again.anthropic as Record<string, unknown>).apiKey).toBe(a.apiKey);
  });
});

describe("providers.yaml at rest (#132)", () => {
  test("without a keyring, apiKeys stay plaintext (backwards compatible)", () => {
    writeProvidersYaml(home, { providers: { openai: { apiKey: "sk-plain" } } });
    const raw = readFileSync(providersFile(home), "utf8");
    expect(raw).toContain("sk-plain");
    expect(raw).not.toContain(ENC_PREFIX);
  });

  test("with a keyring, keys are encrypted on write and decrypted on load", () => {
    initKeyring(home);
    withConfig();
    writeProvidersYaml(home, {
      providers: { anthropic: { apiKey: "sk-live-1", baseUrl: "https://gw" } },
      models: { default: "anthropic:m" },
    });

    // at rest: no plaintext, encrypted marker present
    const raw = readFileSync(providersFile(home), "utf8");
    expect(raw).not.toContain("sk-live-1");
    expect(raw).toContain(ENC_PREFIX);

    // transparent decrypt on load
    const { config } = loadConfig(project, home, { skipModelCheck: true });
    expect(config.providers?.anthropic?.apiKey).toBe("sk-live-1");
    expect(config.providers?.anthropic?.baseUrl).toBe("https://gw");
  });

  test("plaintext keys are converted to encrypted on the next write once a keyring exists", () => {
    withConfig();
    writeProvidersYaml(home, { providers: { openai: { apiKey: "sk-old-plain" } } });
    expect(readFileSync(providersFile(home), "utf8")).toContain("sk-old-plain");

    initKeyring(home);
    // re-saving with the same key under a keyring encrypts it
    writeProvidersYaml(home, { providers: { openai: { apiKey: "sk-old-plain" } } });
    const raw = readFileSync(providersFile(home), "utf8");
    expect(raw).not.toContain("sk-old-plain");
    expect(raw).toContain(ENC_PREFIX);

    const { config } = loadConfig(project, home, { skipModelCheck: true });
    expect(config.providers?.openai?.apiKey).toBe("sk-old-plain");
  });

  test("an encrypted key with no keyring on this machine errors with clear guidance", () => {
    initKeyring(home);
    withConfig();
    writeProvidersYaml(home, { providers: { openai: { apiKey: "sk-enc-1" } } });

    // lose the machine-local secret (e.g. moved to another machine)
    rmSync(keyringPath(home));
    expect(() => loadConfig(project, home, { skipModelCheck: true })).toThrow(/no keyring/);
    try {
      loadConfig(project, home, { skipModelCheck: true });
    } catch (e) {
      expect((e as Error).message).toContain("tenjin keyring init");
    }
  });
});

describe("decrypt with the wrong secret (#132)", () => {
  test("decrypt with a different secret fails clearly", () => {
    initKeyring(home);
    const a = openKeyring(home)!;
    const path2 = mkdtempSync(join(tmpdir(), "tj-keyring2-"));
    try {
      initKeyring(path2);
      const b = openKeyring(path2)!;
      const blob = encrypt(a, "secret");
      expect(() => decrypt(b, blob)).toThrow(/does not match/);
    } finally {
      rmSync(path2, { recursive: true, force: true });
    }
  });
});

describe("CLI (#132)", () => {
  const run = (args: string[]) =>
    Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), ...args],
      { cwd: join(import.meta.dir, ".."), env: { ...process.env, TENJIN_HOME: home } },
    );

  test("tenjin keyring init creates the keyring; status reports ENABLED", () => {
    const init = run(["keyring", "init"]);
    expect(init.exitCode).toBe(0);
    expect(existsSync(keyringPath(home))).toBe(true);

    const status = run(["keyring", "status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout?.toString() ?? "").toContain("ENABLED");
  });

  test("tenjin doctor warns about plaintext provider keys", () => {
    // plaintext key, no keyring
    writeProvidersYaml(home, { providers: { openai: { apiKey: "sk-plain" } } });
    const proc = run(["doctor"]);
    const out = proc.stdout?.toString() ?? "";
    expect(out).toContain("plaintext");
    expect(out).toContain("apiKeys");
  });
});
