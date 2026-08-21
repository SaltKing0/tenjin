import { describe, test, expect } from "bun:test";
import { EMPTY_STATES, ROUTES, emptyStateFor } from "../src/gateway/console/empty-state.js";

describe("console empty-states (#254)", () => {
  test("defines guidance copy for every required panel", () => {
    for (const panel of ["chat", "jobs", "sessions", "memory", "approvals"]) {
      const def = EMPTY_STATES[panel];
      if (!def) throw new Error(`missing empty-state for ${panel}`);
      expect(def.title.length).toBeGreaterThan(0);
      expect((def.caption ?? "").length).toBeGreaterThan(0);
    }
  });

  test("every CTA targets an existing console route (hash routing)", () => {
    for (const [panel, def] of Object.entries(EMPTY_STATES)) {
      if (!def.cta) continue;
      expect(def.hash, `CTA for ${panel} needs a hash target`).toBeTruthy();
      expect(ROUTES, `CTA hash for ${panel} must be an existing route`).toContain(def.hash!);
    }
  });

  test("approvals is positive and needs no CTA", () => {
    const def = EMPTY_STATES.approvals!;
    expect(def.title).toContain("✓");
    expect(def.cta).toBeUndefined();
  });

  test("emptyStateFor resolves known panels and null for unknown", () => {
    expect(emptyStateFor("chat")).toBe(EMPTY_STATES.chat!);
    expect(emptyStateFor("nope")).toBeNull();
  });

  test("memory_nobots guides the user to create a bot (#274)", () => {
    const def = EMPTY_STATES.memory_nobots!;
    expect(def.title).toBeTruthy();
    expect(def.cta).toBe("Create a bot");
    expect(def.hash).toBe("#status");
    expect(ROUTES).toContain(def.hash!);
  });
});
