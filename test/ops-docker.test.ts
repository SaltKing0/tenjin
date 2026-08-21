import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { statSync, readFileSync } from "node:fs";

const OPS_DIR = resolve(import.meta.dir, "../ops/docker");
const CHECK_TOKEN = resolve(OPS_DIR, "check-token.sh");
const COMPOSE = resolve(OPS_DIR, "docker-compose.yml");

/** Run check-token.sh with a given GATEWAY_TOKEN; returns {code, out}. */
function runTokenCheck(token: string | undefined): { code: number; out: string } {
  const env = { ...process.env } as Record<string, string>;
  if (token === undefined) delete env.GATEWAY_TOKEN;
  else env.GATEWAY_TOKEN = token;
  const res = Bun.spawnSync(["sh", CHECK_TOKEN], { env, stdout: "pipe", stderr: "pipe" });
  return { code: res.exitCode, out: res.stdout.toString() + res.stderr.toString() };
}

describe("docker compose host binding (#239)", () => {
  const compose = readFileSync(COMPOSE, "utf8");

  test("defaults the host port bind to 127.0.0.1", () => {
    expect(compose).toContain("${TENJIN_BIND:-127.0.0.1}:${TENJIN_PORT:-3000}:3000");
  });

  test("does not default GATEWAY_TOKEN to the well-known dev-local-token", () => {
    // The token must come from the operator's .env; the old fallback default
    // that combined a public bind with a known token is gone.
    expect(compose).not.toMatch(/GATEWAY_TOKEN:.*dev-local-token/);
    expect(compose).toContain('GATEWAY_TOKEN: "${GATEWAY_TOKEN:-}"');
  });

  test("entrypoint fails closed before starting the gateway (#239)", () => {
    const entrypoint = readFileSync(resolve(OPS_DIR, "entrypoint.sh"), "utf8");
    // The guard is invoked (resolved relative to the script path so it works
    // under any TENJIN_APP_DIR / mount layout).
    expect(entrypoint).toContain("check-token.sh");
  });
});

describe("docker entrypoint token guard (#239)", () => {
  test("check-token.sh is executable and shipped in the repo", () => {
    const st = statSync(CHECK_TOKEN);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o111).toBeGreaterThan(0);
  });

  test("refuses to start when GATEWAY_TOKEN is unset", () => {
    const { code, out } = runTokenCheck(undefined);
    expect(code).not.toBe(0);
    expect(out).toMatch(/GATEWAY_TOKEN is not set/);
  });

  test("refuses to start when GATEWAY_TOKEN is empty", () => {
    const { code, out } = runTokenCheck("");
    expect(code).not.toBe(0);
    expect(out).toMatch(/GATEWAY_TOKEN is not set/);
  });

  test("refuses to start when GATEWAY_TOKEN is the well-known dev-local-token", () => {
    const { code, out } = runTokenCheck("dev-local-token");
    expect(code).not.toBe(0);
    expect(out).toMatch(/dev-local-token/);
  });

  test("allows start with a strong, non-example token", () => {
    const { code } = runTokenCheck("9f6c9a4b3d1e2f0a8c7b6d5e4f3a2b1c");
    expect(code).toBe(0);
  });
});
