import { describe, test, expect } from "bun:test";
import {
  PRIMARY_NAV,
  ACTIVITY_VIEWS,
  SETUP_VIEWS,
  resolveConsoleRoute,
} from "../src/gateway/console/routes.js";

describe("console product navigation", () => {
  test("mobile and desktop share exactly five primary destinations", () => {
    expect(PRIMARY_NAV.map((item) => item.name)).toEqual([
      "chat", "activity", "approvals", "routines", "setup",
    ]);
  });

  test("legacy observe routes converge into the shared Activity area", () => {
    for (const view of ["sessions", "spend", "audit", "memory", "status"] as const) {
      expect(resolveConsoleRoute(`#${view}`)).toEqual({
        name: "activity",
        subroute: view,
        canonicalHash: `#activity/${view}`,
      });
      expect(ACTIVITY_VIEWS).toContain(view);
    }
  });

  test("legacy bot/settings/jobs links remain useful", () => {
    expect(resolveConsoleRoute("#bots")).toMatchObject({ name: "setup", subroute: "bots" });
    expect(resolveConsoleRoute("#settings")).toMatchObject({ name: "setup", subroute: "provider" });
    expect(resolveConsoleRoute("#jobs")).toMatchObject({ name: "routines" });
    expect(SETUP_VIEWS).toEqual(["bots", "provider", "access"]);
  });

  test("unknown or empty hashes fail safely to Chat", () => {
    expect(resolveConsoleRoute("")).toMatchObject({ name: "chat" });
    expect(resolveConsoleRoute("#dead-link")).toEqual({
      name: "chat", subroute: null, canonicalHash: "#chat",
    });
  });
});
