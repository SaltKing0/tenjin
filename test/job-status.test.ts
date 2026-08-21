import { describe, test, expect } from "bun:test";
import {
  runStatusView,
  stopReasonStatus,
  lastRunStatus,
  historyTones,
} from "../src/gateway/console/job-status.js";

describe("console job run-status (#285)", () => {
  test("runStatusView maps all four statuses to the right tone + label", () => {
    expect(runStatusView("ok")).toEqual({ label: "ok", tone: "ok" });
    expect(runStatusView("error")).toEqual({ label: "error", tone: "err" });
    expect(runStatusView("timeout")).toEqual({ label: "timeout", tone: "warn" });
    expect(runStatusView("never")).toEqual({ label: "never", tone: "dim" });
  });

  test("runStatusView falls back to never/grey for unknown statuses", () => {
    expect(runStatusView("bogus")).toEqual({ label: "never", tone: "dim" });
  });

  test("stopReasonStatus classifies timeout and error specially", () => {
    expect(stopReasonStatus("timeout")).toBe("timeout");
    expect(stopReasonStatus("error")).toBe("error");
    expect(stopReasonStatus("end_turn")).toBe("ok");
  });

  test("lastRunStatus prefers the classified history[0] status", () => {
    const job = {
      lastRun: { stopReason: "end_turn" },
      history: [{ status: "error", sessionId: "s1" }],
    };
    expect(lastRunStatus(job)).toBe("error");
  });

  test("lastRunStatus falls back to stopReason when no history", () => {
    expect(lastRunStatus({ lastRun: { stopReason: "timeout" } })).toBe("timeout");
    expect(lastRunStatus({ lastRun: { stopReason: "end_turn" } })).toBe("ok");
  });

  test("lastRunStatus returns never for a job with no runs", () => {
    expect(lastRunStatus({})).toBe("never");
    expect(lastRunStatus(null)).toBe("never");
  });

  test("historyTones maps recent runs to tones, newest first, capped at 5", () => {
    const history = [
      { status: "error" },
      { status: "ok" },
      { status: "timeout" },
      { status: "ok" },
      { status: "ok" },
      { status: "error" }, // sixth entry dropped
    ];
    expect(historyTones(history)).toEqual(["err", "ok", "warn", "ok", "ok"]);
  });

  test("historyTones tolerates empty/missing history and unknown statuses", () => {
    expect(historyTones(null)).toEqual([]);
    expect(historyTones([{ status: "weird" }])).toEqual(["dim"]);
  });
});
