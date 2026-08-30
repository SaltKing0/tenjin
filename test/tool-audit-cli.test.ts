import { expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

test("e2e: tenjin audit-tools runs without config and emits a clean JSON report", () => {
  const proc = Bun.spawnSync(["bun", "run", CLI, "audit-tools", "--json"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TENJIN_HOME: join(import.meta.dir, "missing-tool-audit-home") },
  });
  expect(proc.exitCode).toBe(0);
  const report = JSON.parse(proc.stdout.toString()) as {
    schemaVersion: number;
    toolCount: number;
    ok: boolean;
    errors: number;
  };
  expect(report).toMatchObject({ schemaVersion: 1, toolCount: 9, ok: true, errors: 0 });
});
