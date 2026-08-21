import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config/loader";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-gb-cfg-"));
  project = mkdtempSync(join(tmpdir(), "tj-gb-proj-"));
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function cfg(yaml: string) {
  writeFileSync(join(home, "config.yaml"), yaml);
  return loadConfig(project, home, { skipModelCheck: true }).config;
}

describe("globalBudget config", () => {
  test("loads daily and monthly limits", () => {
    const config = cfg("globalBudget:\n  dailyUSD: 2.5\n  monthlyUSD: 40\n");
    expect(config.globalBudget?.dailyUSD).toBe(2.5);
    expect(config.globalBudget?.monthlyUSD).toBe(40);
  });

  test("omits limits when unset", () => {
    const config = cfg("model: claude-sonnet-4-5\n");
    expect(config.globalBudget).toBeUndefined();
  });

  test("rejects negative daily limit", () => {
    expect(() => cfg("globalBudget:\n  dailyUSD: -1\n")).toThrow(ConfigError);
  });

  test("rejects negative monthly limit", () => {
    expect(() => cfg("globalBudget:\n  monthlyUSD: -3\n")).toThrow(ConfigError);
  });

  test("rejects non-number limit with clear path", () => {
    expect(() => cfg("globalBudget:\n  dailyUSD: lots\n")).toThrow(/globalBudget\.dailyUSD/);
  });
});
