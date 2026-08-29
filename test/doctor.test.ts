import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type DoctorReport } from "../src/cli/doctor";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-doctor-"));
  project = mkdtempSync(join(tmpdir(), "tj-doctor-project-"));
  writeFileSync(
    join(home, "config.yaml"),
    [
      "provider: openai",
      "model: gpt-doctor",
      "memory:",
      "  enabled: false",
      "gateway:",
      "  listen:",
      "    host: 127.0.0.1",
      "    port: 3000",
      "    token: gateway-doctor-secret",
      "  jobs:",
      "    - name: daily-check",
      "      bot: researcher",
      "      prompt: check the repository",
      "      cron: 0 9 * * *",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(home, "providers.yaml"),
    "providers:\n  openai:\n    apiKey: sk-doctor-secret-value\n",
    { mode: 0o600 },
  );
  chmodSync(join(home, "config.yaml"), 0o600);
  chmodSync(join(home, "providers.yaml"), 0o600);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("runDoctor", () => {
  test("emits a stable JSON report without secrets", async () => {
    let output = "";
    const code = await runDoctor(["--json"], {
      home,
      cwd: project,
      env: {},
      write: (text) => { output += text; },
      detectSandbox: () => "bwrap",
    });
    expect(code).toBe(0);
    expect(output).not.toContain("sk-doctor-secret-value");
    expect(output).not.toContain("gateway-doctor-secret");

    const report = JSON.parse(output) as DoctorReport;
    expect(report).toMatchObject({ schemaVersion: 1, product: "Tenjin", online: false, ok: true });
    expect(report.counts.fail).toBe(0);
    expect(report.checks.find((check) => check.id === "openai_credential")).toMatchObject({ state: "ok" });
    expect(report.checks.find((check) => check.id === "gateway")).toMatchObject({ state: "ok" });
    expect(report.checks.find((check) => check.id === "bash_sandbox")).toMatchObject({ state: "ok" });
  });

  test("online mode probes the exact configured model and redacts provider errors", async () => {
    let output = "";
    const calls: Array<Record<string, unknown>> = [];
    const code = await runDoctor(["--online", "--json"], {
      home,
      cwd: project,
      env: {},
      write: (text) => { output += text; },
      detectSandbox: () => null,
      testProvider: async (input) => {
        calls.push(input);
        return {
          ok: false,
          provider: input.provider,
          status: 401,
          error: `credential sk-doctor-secret-value rejected`,
        };
      },
    });
    expect(code).toBe(1);
    expect(calls).toEqual([{
      provider: "openai",
      model: "gpt-doctor",
      apiKey: "sk-doctor-secret-value",
      baseUrl: undefined,
    }]);
    expect(output).not.toContain("sk-doctor-secret-value");
    const report = JSON.parse(output) as DoctorReport;
    expect(report.online).toBe(true);
    expect(report.checks.find((check) => check.id === "provider_chat")).toMatchObject({
      state: "fail",
      label: "provider chat check failed",
    });
  });

  test("rejects unknown flags with usage exit code", async () => {
    let output = "";
    const code = await runDoctor(["--bogus"], { write: (text) => { output += text; } });
    expect(code).toBe(2);
    expect(output).toContain("unknown doctor option");
    expect(output).toContain("usage: tenjin doctor");
  });
});
