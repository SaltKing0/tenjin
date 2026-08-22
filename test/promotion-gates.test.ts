import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitSignal,
  readDailySignals,
  runPromotionPass,
  approveReviewItem,
  dailySignalsPath,
  projectMemoryPath,
  globalMemoryPath,
  reviewQueuePath,
  type Signal,
} from "../src/memory/signals";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-sig-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const T = "2026-08-22T10:00:00.000Z";

function sig(over: Partial<Signal> = {}): Signal {
  return { kind: "accept", scope: "project", payload: "the candidate", context: "q1", ts: T, ...over };
}

function readArr(path: string): unknown[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
}

describe("B9-6 daily layer (signals land here first, never the durable tiers)", () => {
  test("signals accumulate only in the dated daily file at first", () => {
    emitSignal(home, sig({}));
    emitSignal(home, sig({ context: "q2" }));
    expect(readDailySignals(home).length).toBe(2);
    expect(existsSync(dailySignalsPath(home, "2026-08-22"))).toBe(true);
    // No durable tier is written by emitting alone.
    expect(existsSync(projectMemoryPath(home))).toBe(false);
    expect(existsSync(globalMemoryPath(home))).toBe(false);
    expect(existsSync(reviewQueuePath(home))).toBe(false);
  });
});

describe("B9-6 project scope auto-promotes on all gates", () => {
  test("project candidate crossing all gates auto-promotes to project memory", () => {
    emitSignal(home, sig({ context: "q1" }));
    emitSignal(home, sig({ context: "q2" }));
    emitSignal(home, sig({ context: "q1" }));
    const report = runPromotionPass(home);
    expect(report.autoPromoted).toEqual(["the candidate"]);
    expect(report.queued).toEqual([]);
    const proj = readArr(projectMemoryPath(home));
    expect(proj.length).toBe(1);
    expect((proj[0] as any).payload).toBe("the candidate");
    expect((proj[0] as any).source).toBe("auto");
    // Project signals never leak to the global scope.
    expect(existsSync(globalMemoryPath(home))).toBe(false);
  });

  test("a high-frequency but single-context candidate fails the diversity gate", () => {
    emitSignal(home, sig({ context: "q1" }));
    emitSignal(home, sig({ context: "q1" }));
    emitSignal(home, sig({ context: "q1" }));
    const report = runPromotionPass(home);
    expect(report.autoPromoted).toEqual([]);
    expect(report.skipped.some((s) => s.reason === "gates not met")).toBe(true);
    expect(existsSync(projectMemoryPath(home))).toBe(false);
  });

  test("a low accept ratio (many rejects) fails the score gate", () => {
    emitSignal(home, sig({ context: "q1" }));
    emitSignal(home, sig({ context: "q2" }));
    emitSignal(home, sig({ context: "q1", kind: "reject" }));
    emitSignal(home, sig({ context: "q2", kind: "reject" }));
    emitSignal(home, sig({ context: "q1", kind: "reject" }));
    // accept ratio 1/4 = 0.25 < 0.5 -> fails
    const report = runPromotionPass(home);
    expect(report.autoPromoted).toEqual([]);
  });
});

describe("B9-6 global scope parks in the review queue instead", () => {
  test("identical global candidate enters the review queue, not memory", () => {
    emitSignal(home, sig({ scope: "global", context: "q1" }));
    emitSignal(home, sig({ scope: "global", context: "q2" }));
    emitSignal(home, sig({ scope: "global", context: "q1" }));
    const report = runPromotionPass(home);
    expect(report.queued).toEqual(["the candidate"]);
    expect(report.autoPromoted).toEqual([]);
    // Global candidate is NOT written to memory until human approval.
    expect(existsSync(globalMemoryPath(home))).toBe(false);
    const queue = readArr(reviewQueuePath(home));
    expect(queue.length).toBe(1);
    expect((queue[0] as any).scope).toBe("global");
  });
});

describe("B9-6 one-off signals never promote", () => {
  test("a single high-score signal does NOT promote (frequency and diversity fail)", () => {
    emitSignal(home, sig({ kind: "accept" })); // freq 1, 1 context, ratio 1.0
    const report = runPromotionPass(home);
    expect(report.autoPromoted).toEqual([]);
    expect(report.queued).toEqual([]);
    expect(report.skipped.length).toBe(1);
    expect(report.skipped[0]!.reason).toBe("gates not met");
    expect(existsSync(projectMemoryPath(home))).toBe(false);
    expect(existsSync(reviewQueuePath(home))).toBe(false);
  });
});

describe("B9-6 review-queue promotion on human approval", () => {
  test("a queued global item promotes to memory after a recorded approval", () => {
    emitSignal(home, sig({ scope: "global", context: "q1" }));
    emitSignal(home, sig({ scope: "global", context: "q2" }));
    emitSignal(home, sig({ scope: "global", context: "q1" }));
    runPromotionPass(home);
    const queue = readArr(reviewQueuePath(home));
    const id = (queue[0] as any).id as string;
    expect(approveReviewItem(home, id)).toBe(true);
    const global = readArr(globalMemoryPath(home));
    expect(global.length).toBe(1);
    expect((global[0] as any).payload).toBe("the candidate");
    expect((global[0] as any).source).toBe("review");
    // The item is removed from the queue.
    expect(readArr(reviewQueuePath(home)).length).toBe(0);
    // Unknown id writes nothing.
    expect(approveReviewItem(home, "nope")).toBe(false);
  });
});
