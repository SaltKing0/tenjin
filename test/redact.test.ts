import { describe, test, expect } from "bun:test";
import { Redactor, MASK, isSensitiveKey } from "../src/security/redact";

describe("Redactor redact", () => {
  const r = new Redactor();

  test("masks openai/anthropic-style sk- tokens", () => {
    const out = r.redact("my key is sk-abc123DEFghi_456XYZ and that's it");
    expect(out).not.toContain("sk-abc123DEFghi_456XYZ");
    expect(out).toContain(MASK);
    expect(out).toContain("my key is");
  });

  test("masks AWS access key ids (AKIA…)", () => {
    const out = r.redact("access key AKIAIOSFODNN7EXAMPLE here");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain(MASK);
  });

  test("masks GitHub tokens (ghp_… and github_pat_…)", () => {
    const out = r.redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain(MASK);

    const out2 = r.redact("pat github_pat_1234567890_ABCDEFGHIJKLMNOPQRSTUV");
    expect(out2).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
    expect(out2).toContain(MASK);
  });

  test("masks Slack, Telegram, Discord, and Google channel credentials", () => {
    const credentials = [
      "xoxb-123456789012-abcdefghijklmnopqrstuvwxyz",
      "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_12345",
      "abcdefghijklmnopqrstuvwx.ABCDEF.abcdefghijklmnopqrstuvwxyz1234",
      "AIzaSyA12345678901234567890123456789012",
    ];
    for (const credential of credentials) {
      const out = r.redact(`credential ${credential}`);
      expect(out).not.toContain(credential);
      expect(out).toContain(MASK);
    }
  });

  test("masks PEM private-key blocks body, keeps header/footer", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEowIBAAKCAQEA1234567890abcdef=\n" +
      "-----END RSA PRIVATE KEY-----\n";
    const out = r.redact(pem);
    expect(out).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(out).toContain("-----END RSA PRIVATE KEY-----");
    expect(out).not.toContain("MIIEowIBAAKCAQEA1234567890abcdef=");
    expect(out).toContain(MASK);
    expect(out.split("\n")).toHaveLength(pem.split("\n").length);
  });

  test("masks an unterminated PEM private key through end-of-input", () => {
    const pem = "prefix\n-----BEGIN PRIVATE KEY-----\nopaque-key-body-without-footer";
    const out = r.redact(pem);
    expect(out).toContain("-----BEGIN PRIVATE KEY-----");
    expect(out).toContain(MASK);
    expect(out).not.toContain("opaque-key-body-without-footer");
  });

  test("masks secret-key assignments but preserves ordinary uppercase values", () => {
    const out = r.redact("OPENAI_API_KEY=sk-def456789\nMAXCITY=berlin\n");
    expect(out).toContain("OPENAI_API_KEY=");
    expect(out).not.toContain("sk-def456789");
    expect(out).toContain(MASK);
    expect(out).toContain("MAXCITY=berlin");
  });

  test("masks secret fields in dotenv, YAML, JSON, and HTTP headers", () => {
    const input = [
      "export CLIENT_SECRET=opaque-dotenv-value",
      "password: opaque-yaml-value",
      '{"apiKey":"opaque-json-value","city":"berlin"}',
      "Authorization: Bearer opaque-header-value",
    ].join("\n");
    const out = r.redact(input);
    for (const secret of [
      "opaque-dotenv-value",
      "opaque-yaml-value",
      "opaque-json-value",
      "opaque-header-value",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"city":"berlin"');
  });

  test("masks a JSON secret containing escaped quotes without leaking a suffix", () => {
    const input = '{"password":"opaque\\\"secret-suffix","city":"berlin"}';
    const out = r.redact(input);
    expect(JSON.parse(out)).toEqual({ password: MASK, city: "berlin" });
    expect(out).not.toContain("secret-suffix");
  });

  test("masks optional explicitly-known secret literals", () => {
    const literal = "opaque-value-with-no-token-shape";
    const out = new Redactor(true, [literal]).redact(`prefix ${literal} suffix`);
    expect(out).toBe(`prefix ${MASK} suffix`);
  });

  test("does not globally replace extremely short known literals", () => {
    expect(new Redactor(true, ["a"]).redact("a normal sentence")).toBe("a normal sentence");
    expect(new Redactor(true, ["tiny"]).redact("tiny value")).toBe("tiny value");
  });

  test("masks additional common token formats", () => {
    const values = [
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "glpat-abcdefghijklmnopqrstuvwxyz012345",
      "hf_abcdefghijklmnopqrstuvwxyz012345",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz",
    ];
    for (const value of values) {
      expect(r.redact(value)).toBe(MASK);
    }
  });

  test("masks URL basic-auth passwords and sensitive query parameters", () => {
    const input =
      "open https://alice:swordfish@example.com/cb?access_token=opaque-redirect-secret&lang=en " +
      "and https://storage.example/file?X-Amz-Signature=opaque-signature&monkey=banana";
    const out = r.redact(input);
    expect(out).toContain(`https://alice:${MASK}@example.com`);
    expect(out).toContain(`access_token=${MASK}`);
    expect(out).toContain(`X-Amz-Signature=${MASK}`);
    expect(out).toContain("lang=en");
    expect(out).toContain("monkey=banana");
    expect(out).not.toContain("swordfish");
    expect(out).not.toContain("opaque-redirect-secret");
    expect(out).not.toContain("opaque-signature");
  });

  test("accepts any lowercase xox Slack token subtype", () => {
    expect(r.redact("xoxz-abcdefghijklmnopqrstuvwxyz")).toBe(MASK);
  });

  test("leaves normal text unchanged", () => {
    const input =
      "The build finished and the test suite is green. No secrets here. next line.\nAnother line, all fine.\n";
    expect(r.redact(input)).toBe(input);
  });
});

describe("Redactor disabled", () => {
  test("returns input untouched", () => {
    const r = new Redactor(false);
    expect(r.redact("token sk-abc1234567890")).toBe("token sk-abc1234567890");
  });

  test("preserves URL credentials when redaction is explicitly disabled", () => {
    const input = "https://alice:swordfish@example.com/?access_token=opaque";
    expect(new Redactor(false).redact(input)).toBe(input);
  });

  test("fromConfig disabled → disabled", () => {
    expect(Redactor.fromConfig({ disabled: true }).enabled).toBe(false);
  });

  test("fromConfig redaction:false → disabled", () => {
    expect(Redactor.fromConfig({ redaction: false }).enabled).toBe(false);
  });

  test("fromConfig undefined / redaction:true → enabled", () => {
    expect(Redactor.fromConfig(undefined).enabled).toBe(true);
    expect(Redactor.fromConfig({ redaction: true }).enabled).toBe(true);
  });
});

describe("Redactor redactValue", () => {
  const r = new Redactor();

  test("redacts nested secrets in object values", () => {
    const value = {
      path: "note.txt",
      env: { OPENAI_API_KEY: "sk-1234567890abcdef" },
      ok: true,
    };
    const out = r.redactValue(value) as {
      path: string;
      ok: boolean;
      env: { OPENAI_API_KEY: string };
    };
    expect(out.ok).toBe(true);
    expect(out.path).toBe("note.txt");
    expect(out.env.OPENAI_API_KEY).toContain(MASK);
    expect(out.env.OPENAI_API_KEY).not.toContain("sk-1234567890abcdef");
  });

  test("redacts strings in arrays", () => {
    const out = r.redactValue(["ok", "AKIAIOSFODNN7EXAMPLE"]) as string[];
    expect(out[0]).toBe("ok");
    expect(out[1]).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("leaves non-string scalars untouched", () => {
    expect(r.redactValue(42)).toBe(42);
  });

  test("masks opaque values based on object keys", () => {
    const out = r.redactValue({ apiKey: "opaque", inputTokens: 42, city: "berlin" }) as Record<string, unknown>;
    expect(out.apiKey).toBe(MASK);
    expect(out.inputTokens).toBe(42);
    expect(out.city).toBe("berlin");
  });

  test("disabled redactValue returns the original value untouched", () => {
    const value = { password: "opaque" };
    expect(new Redactor(false).redactValue(value)).toBe(value);
  });
});

describe("isSensitiveKey", () => {
  test("recognizes conventional secret keys without matching ordinary fields", () => {
    for (const key of ["OPENAI_API_KEY", "apiKey", "client-secret", "Authorization", "db_password"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ["MAXCITY", "inputTokens", "city", "tokenizer"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});
