import { describe, test, expect } from "bun:test";
import { STEPS, isSetupComplete, shouldShowFirstRun, firstRunView } from "../src/gateway/console/first-run.js";

describe("console first-run setup screen (#251)", () => {
  test("isSetupComplete requires model, bot and gateway token", () => {
    expect(isSetupComplete({ hasModel: true, hasBot: true, hasGatewayToken: true })).toBe(true);
    expect(isSetupComplete({ hasModel: true, hasBot: true })).toBe(false);
    expect(isSetupComplete({})).toBe(false);
  });

  test("shouldShowFirstRun: shown when incomplete and not skipped", () => {
    const incomplete = { hasModel: false };
    expect(shouldShowFirstRun(incomplete, false)).toBe(true);
    expect(shouldShowFirstRun(incomplete, true)).toBe(false); // skipped -> advanced mode
    expect(shouldShowFirstRun({ hasModel: true, hasBot: true, hasGatewayToken: true }, false)).toBe(false); // complete
  });

  test("firstRunView computes progress and per-step done flags", () => {
    const v = firstRunView({ hasModel: true, hasBot: false, hasGatewayToken: true });
    expect(v.steps).toHaveLength(3);
    expect(v.steps[0]!.done).toBe(true);
    expect(v.steps[1]!.done).toBe(false);
    expect(v.steps[2]!.done).toBe(true);
    expect(v.done).toBe(2);
    expect(v.progress).toBe(67);
    expect(v.complete).toBe(false);
  });

  test("every step links into an existing panel route", () => {
    for (const s of STEPS) {
      expect(["#settings", "#status"]).toContain(s.hash);
    }
  });
});
