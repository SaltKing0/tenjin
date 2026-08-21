import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";
import { GUARD_DISABLED_WARNING, buildGuardStatus } from "../src/security/guard";
import { AuditLog } from "../src/audit/log";
import { createBot } from "../src/bots/profile";

const SRC = join(import.meta.dir, "..", "src", "index.ts");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-guard-boot-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(disabled: boolean, extra: string[] = []): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    [
      "provider: anthropic",
      "model: mock-model",
      "memory:",
      "  enabled: false",
      "security:",
      `  disabled: ${disabled}`,
      ...extra,
    ].join("\n") + "\n",
  );
}

describe("boot warning + audit when the guard is disabled", () => {
  test("gateway --dry-run logs a warning and writes a guard_disabled audit event", () => {
    writeConfig(true);
    const proc = Bun.spawnSync(["bun", "run", SRC, "gateway", "--dry-run"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TENJIN_HOME: home },
    });
    const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
    expect(proc.exitCode).toBe(0);
    expect(out).toContain(GUARD_DISABLED_WARNING);
    const auditFile = join(home, "audit.jsonl");
    expect(existsSync(auditFile)).toBe(true);
    const events = new AuditLog(auditFile).query({ kind: "guard_disabled" });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("boot");
    expect(events[0]?.detail).toContain("DISABLED");
  });

  test("gateway --dry-run with the guard on does not warn or audit", () => {
    writeConfig(false);
    const proc = Bun.spawnSync(["bun", "run", SRC, "gateway", "--dry-run"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TENJIN_HOME: home },
    });
    const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
    expect(proc.exitCode).toBe(0);
    expect(out).not.toContain("DISABLED");
    expect(existsSync(join(home, "audit.jsonl"))).toBe(false);
  });

  test("doctor flags a disabled guard as a warning", () => {
    writeConfig(true);
    const proc = Bun.spawnSync(["bun", "run", SRC, "doctor"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TENJIN_HOME: home, ANTHROPIC_API_KEY: "dummy" },
    });
    const out = proc.stdout?.toString() ?? "";
    expect(proc.exitCode).toBe(0);
    expect(out).toMatch(/⚠️.*security guard DISABLED/i);
  });
});

describe("GET /status exposes guard state", () => {
  let server: HttpServerHandle | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  test("status payload reports disabled + blocked event count from audit", async () => {
    writeConfig(true);
    const audit = new AuditLog(join(home, "audit.jsonl"));
    audit.append("tool_block", "user", 'read_file blocked ".env"');
    audit.append("tool_block", "gateway", "bash blocked");
    audit.append("approval", "user", "ok");
    server = startHttpServer({
      config: { port: 0, host: "127.0.0.1", token: "tok" },
      handleMessage: async () => null,
      status: () => ({
        jobs: [],
        channels: [],
        guard: buildGuardStatus({ disabled: true }, audit.query({ kind: "tool_block" }).length),
      }),
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/status`, {
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      guard?: { state?: string; blockedEvents?: number };
    };
    expect(data.guard).toEqual({ state: "disabled", blockedEvents: 2 });
  });

  test("live gateway /status includes guard after a disabled boot", async () => {
    createBot(home, "researcher");
    const port = 41000 + Math.floor(Math.random() * 10000);
    writeConfig(true, [
      "gateway:",
      "  listen:",
      `    port: ${port}`,
      "    token: guard-token",
    ]);
    const proc = Bun.spawn(["bun", "run", SRC, "gateway"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TENJIN_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const auth = { authorization: "Bearer guard-token" };
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await Bun.sleep(100);
        try {
          up = (await fetch(`${base}/status`, { headers: auth })).ok;
        } catch {
          up = false;
        }
      }
      expect(up).toBe(true);
      const res = await fetch(`${base}/status`, { headers: auth });
      const data = (await res.json()) as {
        guard?: { state?: string; blockedEvents?: number };
      };
      expect(data.guard?.state).toBe("disabled");
      expect(data.guard?.blockedEvents).toBe(0);
      const events = new AuditLog(join(home, "audit.jsonl")).query({ kind: "guard_disabled" });
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);
});

test("console status panel JS renders guard state and block count", () => {
  const js = readFileSync(
    join(import.meta.dir, "..", "src", "gateway", "console", "app.js"),
    "utf8",
  );
  expect(js).toContain("status.guard");
  expect(js).toContain("DISABLED");
  expect(js).toContain("blockedEvents");
});
