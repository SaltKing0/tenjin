import { describe, test, expect } from "bun:test";
import {
  approvalCardTitle,
  approvalCardSummary,
  approvalResultLine,
  approvalCountdown,
  approvalIsPending,
} from "../src/gateway/console/approval-card.js";

const req = {
  id: "a1",
  bot: "atlas",
  tool: "bash",
  inputSummary: "ls -la",
  ts: "2026-08-21T10:00:00Z",
  status: "pending",
};

describe("console inline approval card helpers (#295)", () => {
  test("title carries id and tool", () => {
    expect(approvalCardTitle(req)).toBe("[a1] bash");
  });

  test("summary includes bot and input", () => {
    expect(approvalCardSummary(req)).toBe("atlas · bash · ls -la");
    expect(approvalCardSummary({ ...req, inputSummary: "" })).toBe("atlas · bash");
  });

  test("result line formats approved/denied with time and status symbol", () => {
    expect(approvalResultLine("approved", "bash", new Date(Date.UTC(2026, 7, 21, 14, 32)))).toBe(
      "✓ approved bash · 14:32",
    );
    expect(approvalResultLine("denied", "bash", new Date(Date.UTC(2026, 7, 21, 14, 32)))).toBe(
      "✗ denied bash · 14:32",
    );
  });

  test("countdown labels pending vs expired", () => {
    const createdMs = 1_000_000;
    expect(approvalCountdown(createdMs, 120_000, createdMs + 30_000)).toBe("90s left");
    expect(approvalCountdown(createdMs, 120_000, createdMs + 150_000)).toBe("expired");
    expect(approvalCountdown(createdMs, 120_000, createdMs)).toBe("120s left");
  });

  test("isPending reflects status", () => {
    expect(approvalIsPending({ ...req, status: "pending" })).toBe(true);
    expect(approvalIsPending({ ...req, status: "approved" })).toBe(false);
  });
});
