import { describe, test, expect } from "bun:test";
import { resolvePanelScope, scopeHint, panelScopeKey } from "../src/gateway/console/scope-defaults.js";

// bots carry a per-panel data `count` (e.g. session count, memory entries).
const bots = [
  { name: "solo", count: 0 },
  { name: "atlas", count: 2 },
  { name: "nova", count: 0 },
];

describe("console per-panel scope defaults (#277)", () => {
  test("panelScopeKey is stable and per-panel", () => {
    expect(panelScopeKey("sessions")).toBe("tenjin_scope_sessions");
    expect(panelScopeKey("memory")).toBe("tenjin_scope_memory");
    expect(panelScopeKey("sessions")).not.toBe(panelScopeKey("spend"));
  });

  test("no stored choice and no data -> solo", () => {
    expect(resolvePanelScope({ stored: "", bots: [{ name: "solo", count: 0 }] })).toBe("solo");
  });

  test("no stored choice -> first bot WITH data wins over solo", () => {
    expect(resolvePanelScope({ stored: "", bots })).toBe("atlas");
  });

  test("stored choice that is still a real bot is kept even when empty", () => {
    expect(resolvePanelScope({ stored: "nova", bots })).toBe("nova");
  });

  test("stored choice no longer exists -> falls back to first bot with data", () => {
    expect(resolvePanelScope({ stored: "ghost", bots })).toBe("atlas");
  });

  test("stored solo with data elsewhere -> first bot with data (solo is a fallback, not a real scope)", () => {
    expect(resolvePanelScope({ stored: "solo", bots })).toBe("atlas");
  });

  test("scopeHint: current scope has data -> no hint", () => {
    expect(scopeHint({ current: "atlas", bots })).toBeNull();
  });

  test("scopeHint: empty current scope -> suggests first bot with data", () => {
    expect(scopeHint({ current: "solo", bots })).toEqual({ name: "atlas", count: 2 });
    expect(scopeHint({ current: "nova", bots })).toEqual({ name: "atlas", count: 2 });
  });

  test("scopeHint: no other bot has data -> null", () => {
    expect(scopeHint({ current: "solo", bots: [{ name: "solo", count: 0 }] })).toBeNull();
  });
});
