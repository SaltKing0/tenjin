import { describe, test, expect } from "bun:test";
import {
  approvalBadgeText,
  approvalBadgeClass,
  browserTitle,
  approvalLine,
  approvalAge,
} from "../src/gateway/console/approval-badge.js";

describe("console approval badge helpers (#296)", () => {
  test("badge text shows a number when pending, a plain dot when none", () => {
    expect(approvalBadgeText(0)).toBe("•");
    expect(approvalBadgeText(1)).toBe("⏸ 1");
    expect(approvalBadgeText(7)).toBe("⏸ 7");
  });

  test("badge class signals a live count only when pending", () => {
    expect(approvalBadgeClass(0)).toBe("topbar-approvals idle");
    expect(approvalBadgeClass(3)).toBe("topbar-approvals");
  });

  test("browser title carries the count as a prefix, plain otherwise", () => {
    expect(browserTitle(0)).toBe("Tenjin");
    expect(browserTitle(2)).toBe("(2) Tenjin");
  });

  test("approvalLine summarizes bot, tool, input and id", () => {
    const req = { id: "a1", bot: "atlas", tool: "bash", inputSummary: "ls -la" };
    expect(approvalLine(req)).toBe("atlas · bash · ls -la");
  });

  test("approvalLine handles missing input gracefully", () => {
    expect(approvalLine({ id: "a1", bot: "", tool: "write_file", inputSummary: "" })).toBe("write_file");
  });

  test("approvalAge formats recent vs older requests", () => {
    const now = 1_000_000;
    expect(approvalAge(now - 30_000, now)).toBe("30s ago");
    expect(approvalAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(approvalAge(now - 2 * 3600_000, now)).toBe("2h ago");
    expect(approvalAge(now, now)).toBe("just now");
  });
});
