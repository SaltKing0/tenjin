import { describe, test, expect } from "bun:test";
import {
  MODE_LADDER_ORDER,
  DEFAULT_MODE,
  decideModeAction,
  RecentlyDeniedList,
  validateMode,
  isIsolationEnvReady,
  type ModeLadder,
} from "../src/security/mode-ladder";

/**
 * B13-5 (#437): mode ladder manual | acceptEdits | auto | dontAsk | bypass.
 * VETO BOUNDARY: no plan/readonly rung. NO mode auto-approves a T2 call.
 * Pure/headless decision over the T0/T1/T2 risk matrix from #401.
 */

type A = ReturnType<typeof decideModeAction>["action"];

function dec(mode: ModeLadder, tier: "T0" | "T1" | "T2", tool = "bash", extra: Partial<Parameters<typeof decideModeAction>[0]> = {}) {
  return decideModeAction({ mode, tier, tool, ...extra }).action;
}

describe("B13-5 mode ladder — T0/T1/T2 matrix", () => {
  test("T0 read-only is ALLOW in every mode (bypass given its isolation flag)", () => {
    for (const mode of MODE_LADDER_ORDER) {
      const bypassEnvReady = mode === "bypass"; // bypass needs its flag to be usable
      expect(dec(mode, "T0", "read_file", { bypassEnvReady }), `${mode} T0`).toBe("ALLOW");
    }
  });

  test("manual asks on T1 and T2, allows pre-allowed T1", () => {
    expect(dec("manual", "T1")).toBe("ASK");
    expect(dec("manual", "T2")).toBe("ASK");
    expect(dec("manual", "T1", "bash", { preAllowed: ["bash"] })).toBe("ALLOW");
  });

  test("acceptEdits lets T1 edits flow but still asks on non-edit T1 and T2", () => {
    expect(dec("acceptEdits", "T1", "write_file")).toBe("ALLOW");
    expect(dec("acceptEdits", "T1", "edit_file")).toBe("ALLOW");
    expect(dec("acceptEdits", "T1", "apply_patch")).toBe("ALLOW");
    expect(dec("acceptEdits", "T1", "bash")).toBe("ASK"); // non-edit T1
    expect(dec("acceptEdits", "T2", "bash")).toBe("ASK");
  });

  test("auto approves routine T1, refuses nothing but never T2-approves", () => {
    expect(dec("auto", "T1", "bash")).toBe("ALLOW");
    expect(dec("auto", "T1", "web_fetch")).toBe("ALLOW");
    expect(dec("auto", "T2", "bash")).toBe("ASK"); // T2 veto holds in auto
  });

  test("bypass (with isolation flag) lets T1 flow but never T2", () => {
    expect(dec("bypass", "T1", "bash", { bypassEnvReady: true })).toBe("ALLOW");
    expect(dec("bypass", "T2", "bash", { bypassEnvReady: true })).toBe("ASK");
  });
});

describe("B13-5 mode ladder — ask-rule overrides auto", () => {
  test("an explicit ask-rule forces a human checkpoint even in auto", () => {
    // e.g. git push is a configured ask-rule: it must ASK, not auto-approve.
    expect(dec("auto", "T1", "bash", { askRules: ["bash"] })).toBe("ASK");
    // A non-listed tool still flows.
    expect(dec("auto", "T1", "write_file", { askRules: ["bash"] })).toBe("ALLOW");
    // ask-rule does not override the T2 veto — T2 is already ASK.
    expect(dec("auto", "T2", "bash", { askRules: ["bash"] })).toBe("ASK");
  });
});

describe("B13-5 mode ladder — dontAsk fail-fast", () => {
  test("dontAsk denies instead of prompting (headless fail-fast)", () => {
    expect(dec("dontAsk", "T1", "bash")).toBe("DENY");
    expect(dec("dontAsk", "T1", "write_file")).toBe("DENY");
    expect(dec("dontAsk", "T2", "bash")).toBe("DENY");
    // T0 reads still work in dontAsk (they never prompt).
    expect(dec("dontAsk", "T0", "read_file")).toBe("ALLOW");
  });

  test("dontAsk allows only explicitly pre-allowed non-T0 tools", () => {
    expect(dec("dontAsk", "T1", "bash", { preAllowed: ["bash"] })).toBe("ALLOW");
    expect(dec("dontAsk", "T1", "write_file", { preAllowed: ["bash"] })).toBe("DENY");
  });
});

describe("B13-5 mode ladder — bypass refused without isolation flag", () => {
  test("bypass REFUSES unless the isolation env flag is set", () => {
    expect(dec("bypass", "T1", "bash", { bypassEnvReady: false })).toBe("REFUSE");
    expect(dec("bypass", "T1", "bash", { bypassEnvReady: undefined })).toBe("REFUSE");
  });

  test("isIsolationEnvReady detects a set, truthy flag", () => {
    expect(isIsolationEnvReady("TENJIN_ISOLATION", { TENJIN_ISOLATION: "1" })).toBe(true);
    expect(isIsolationEnvReady("TENJIN_ISOLATION", { TENJIN_ISOLATION: "true" })).toBe(true);
    expect(isIsolationEnvReady("TENJIN_ISOLATION", { TENJIN_ISOLATION: "0" })).toBe(false);
    expect(isIsolationEnvReady("TENJIN_ISOLATION", {})).toBe(false);
    expect(isIsolationEnvReady(undefined, {})).toBe(false);
  });
});

describe("B13-5 mode ladder — no mode auto-approves T2", () => {
  test("T2 is never ALLOW in ANY mode, even pre-allowed or bypass", () => {
    for (const mode of MODE_LADDER_ORDER) {
      const withFlag = mode === "bypass";
      expect(dec(mode, "T2", "bash", { bypassEnvReady: withFlag, preAllowed: ["bash"], askRules: [] }), mode).toBe(mode === "dontAsk" ? "DENY" : "ASK");
    }
  });

  test("pre-allowed T2 is still not auto-approved", () => {
    expect(dec("manual", "T2", "bash", { preAllowed: ["bash"] })).toBe("ASK");
    expect(dec("auto", "T2", "bash", { preAllowed: ["bash"] })).toBe("ASK");
  });
});

describe("B13-5 mode ladder — recently denied review list + validation", () => {
  test("RecentlyDeniedList records bounded denials for tuning", () => {
    const list = new RecentlyDeniedList(2);
    list.add({ tool: "bash", tier: "T1", reason: "dontAsk" }, 1);
    list.add({ tool: "write_file", tier: "T1", reason: "dontAsk" }, 2);
    expect(list.size).toBe(2);
    list.add({ tool: "bash", tier: "T2", reason: "veto" }, 3);
    expect(list.size).toBe(2); // bounded
    expect(list.list()[0]!.tool).toBe("write_file"); // oldest evicted
  });

  test("validateMode rejects unknown rungs and has no plan rung", () => {
    expect(validateMode("manual")).toBe("manual");
    expect(validateMode("auto")).toBe("auto");
    expect(() => validateMode("plan")).toThrow(/no plan\/readonly rung/i);
    expect(() => validateMode("readonly")).toThrow();
    expect(() => validateMode("nope")).toThrow();
  });

  test("default mode is manual", () => {
    expect(DEFAULT_MODE).toBe("manual");
  });
});
