import { describe, test, expect } from "bun:test";
import {
  FrameBatcher,
  StallIndicator,
  renderStatusLine,
  contextBand,
} from "../src/ui/stream-ux";

/**
 * B13-1 (#383): append-only streaming + persistent status line — 30ms frame
 * flush (never per-token), isTTY gate (non-TTY = plain lines only), a
 * dependency-free stall spinner, and a usage-fed status line with color bands.
 */

describe("frame batching (append-only, no per-token writes)", () => {
  test("delta burst of 100 chunks produces <= ceil(elapsed/30ms)+2 writes", () => {
    let t = 0;
    let writes = 0;
    let chars = 0;
    const fb = new FrameBatcher({ frameMs: 30, now: () => t, write: (s) => { writes++; chars += s.length; } });
    // 100 chunks land within one frame window -> ZERO writes yet (never per-token).
    for (let i = 0; i < 100; i++) fb.push("a");
    expect(writes).toBe(0);
    // Advance one frame boundary and tick.
    t = 150;
    fb.tick();
    expect(writes).toBe(1);
    expect(chars).toBe(100);
    expect(writes).toBeLessThanOrEqual(Math.ceil(150 / 30) + 2);
  });

  test("flush() forces buffered text out immediately", () => {
    let t = 0;
    let out = "";
    const fb = new FrameBatcher({ frameMs: 30, now: () => t, write: (s) => { out += s; } });
    fb.push("hello");
    fb.flush();
    expect(out).toBe("hello");
    expect(fb.buffered).toBe(0);
  });
});

describe("non-TTY gate", () => {
  test("status line in non-TTY mode emits plain text only — no ANSI", () => {
    const line = renderStatusLine(
      { model: "gpt-4o", inputTokens: 10, outputTokens: 20, contextPercent: 60, costUSD: 0.01, iteration: 2, total: 5, lastTool: "bash" },
      { isTTY: false },
    );
    expect(line).not.toContain("\x1b[");
  });

  test("stall spinner is suppressed in non-TTY mode", () => {
    let t = 0;
    const stall = new StallIndicator({ silenceMs: 1000, now: () => t, isTTY: false });
    stall.mark();
    t = 5000;
    expect(stall.isStalled()).toBe(true);
    expect(stall.render()).toBeNull(); // no spinner frames off-TTY
  });
});

describe("stall spinner", () => {
  test("spinner/elapsed appears after the artificial silence window", () => {
    let t = 0;
    const stall = new StallIndicator({ silenceMs: 5000, now: () => t, isTTY: true });
    stall.mark(); // activity at t=0
    expect(stall.isStalled()).toBe(false);
    t = 6000;
    expect(stall.isStalled()).toBe(true);
    const r = stall.render();
    expect(r).not.toBeNull();
    expect(r).toContain("00:06"); // elapsed mm:ss
  });

  test("mark() resets the stall window", () => {
    let t = 0;
    const stall = new StallIndicator({ silenceMs: 1000, now: () => t, isTTY: true });
    stall.mark();
    t = 2000;
    expect(stall.isStalled()).toBe(true);
    stall.mark();
    expect(stall.isStalled()).toBe(false);
  });
});

describe("status line", () => {
  test("renders all fields from a usage event", () => {
    const line = renderStatusLine(
      { model: "gpt-4o", inputTokens: 100, outputTokens: 50, contextPercent: 40, costUSD: 0.02, iteration: 3, total: 10, lastTool: "edit_file" },
      { isTTY: true },
    );
    expect(line).toContain("gpt-4o");
    expect(line).toContain("100");
    expect(line).toContain("50");
    expect(line).toContain("0.02");
    expect(line).toContain("3/10");
    expect(line).toContain("edit_file");
  });

  test("context color band: green <50, yellow <70, red >=70", () => {
    expect(contextBand(40)).toBe("green");
    expect(contextBand(60)).toBe("yellow");
    expect(contextBand(80)).toBe("red");
  });

  test("TTY status line carries the correct color band for the context %", () => {
    // 40% -> green ANSI code present
    const green = renderStatusLine({ model: "m", inputTokens: 1, outputTokens: 1, contextPercent: 40, costUSD: 0 }, { isTTY: true });
    expect(green).toContain("\x1b[32m");
    // 80% -> red ANSI code present
    const redLine = renderStatusLine({ model: "m", inputTokens: 1, outputTokens: 1, contextPercent: 80, costUSD: 0 }, { isTTY: true });
    expect(redLine).toContain("\x1b[31m");
  });
});
