import { describe, test, expect } from "bun:test";
import { SETUP_ITEMS, setupChecklist } from "../src/gateway/console/setup-checklist.js";

describe("console setup checklist (#252)", () => {
  test("includes the required setup items, each with a deep-link route", () => {
    const items = new Map(SETUP_ITEMS.map((i) => [i.key, i]));
    for (const key of ["hasModel", "hasGatewayToken", "hasBudgetLimit", "channelsEnabled"]) {
      const item = items.get(key);
      expect(item, `missing setup item ${key}`).toBeTruthy();
      expect(item!.label.length).toBeGreaterThan(0);
      expect(["#settings", "#status"]).toContain(item!.hash!);
    }
  });

  test("marks items ok from the setup/state payload", () => {
    const list = setupChecklist({
      hasModel: true,
      hasGatewayToken: true,
      hasBudgetLimit: false,
      channelsEnabled: true,
    });
    const byKey = new Map(list.map((i) => [i.key, i]));
    expect(byKey.get("hasModel")!.ok).toBe(true);
    expect(byKey.get("hasGatewayToken")!.ok).toBe(true);
    expect(byKey.get("hasBudgetLimit")!.ok).toBe(false);
    expect(byKey.get("channelsEnabled")!.ok).toBe(true);
  });

  test("marks everything missing for an empty payload", () => {
    expect(setupChecklist({}).every((i) => i.ok === false)).toBe(true);
  });
});
