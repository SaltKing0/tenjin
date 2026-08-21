import { describe, test, expect } from "bun:test";
import { Redactor, MASK } from "../src/security/redact";

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
  });

  test("masks KEY=VALUE secret lines but keeps the key", () => {
    const out = r.redact("OPENAI_API_KEY=sk-def456789\nMAXCITY=berlin\n");
    expect(out).toContain("OPENAI_API_KEY=");
    expect(out).not.toContain("sk-def456789");
    expect(out).toContain(MASK);
    // a normal prose value is also masked (defense-in-depth)
    expect(out).not.toContain("MAXCITY=berlin");
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
});
