import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvalAria,
  collapseOutput,
  expandCollapsed,
  visibleWindow,
  APPROVAL_STATUS_TOKENS,
} from "../src/gateway/console/a11y.js";

const css = readFileSync(
  join(import.meta.dir, "..", "src", "gateway", "console", "style.css"),
  "utf8",
);

describe("B13-10 a11y: aria attributes + roles on the approval flow", () => {
  test("approval cards expose a modal alert dialog with a polite live region", () => {
    const aria = approvalAria({ id: "a1", tool: "bash" });
    expect(aria.role).toBe("alertdialog");
    expect(aria["aria-modal"]).toBe("true");
    expect(aria["aria-live"]).toBe("polite");
    expect(aria["aria-labelledby"]).toBe("a1-label");
    expect(aria["aria-describedby"]).toBe("a1-desc");
  });

  test("controls are real buttons, not div-clicks", () => {
    const aria = approvalAria({ id: "a1" });
    expect(aria.controls.length).toBeGreaterThan(0);
    for (const c of aria.controls) expect(c.kind).toBe("button");
  });
});

describe("B13-10 reading comfort: collapsed output expands without losing scroll", () => {
  test("output over the threshold collapses to an N-lines pill", () => {
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const d = collapseOutput(big);
    expect(d.collapsed).toBe(true);
    expect(d.pillText).toBe("12 lines");
    expect(d.lineCount).toBe(12);
  });

  test("short output is not collapsed", () => {
    const d = collapseOutput("a\nb");
    expect(d.collapsed).toBe(false);
    expect(d.pillText).toBeNull();
  });

  test("expanding returns the full output (same container => scroll preserved)", () => {
    const big = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const d = collapseOutput(big);
    // the pure contract keeps the full text; the renderer swaps it in-place in
    // the SAME container node, so the user's scroll position is not lost.
    expect(d.full).toBe(big);
    expect(expandCollapsed(d)).toBe(big);
    expect(expandCollapsed(null)).toBe("");
  });
});

describe("B13-10 virtualization: DOM node count stays bounded under long transcripts", () => {
  test("visibleWindow mounts only a bounded window regardless of total length", () => {
    // a 10_000-block transcript with a 20-block viewport
    const w = visibleWindow(5000, 10000, { viewport: 20, overscan: 5 });
    const mounted = w.end - w.start + 1;
    // viewport + 2*overscan, clamped to the list — never the full 10_000
    expect(mounted).toBeLessThanOrEqual(20 + 2 * 5);
    expect(mounted).toBeLessThan(10000);
    expect(w.start).toBeLessThanOrEqual(5000);
    expect(w.end).toBeGreaterThanOrEqual(5000);
  });

  test("the window clamps at the list boundaries without negative indices", () => {
    const w0 = visibleWindow(0, 1000, { viewport: 20, overscan: 5 });
    expect(w0.start).toBe(0);
    expect(w0.end).toBeGreaterThan(0);
    const wEnd = visibleWindow(999, 1000, { viewport: 20, overscan: 5 });
    expect(wEnd.end).toBe(999);
    expect(wEnd.start).toBeLessThan(999);
  });
});

describe("B13-10 design tokens: approval-status semantic mapping", () => {
  test("the approval-status tokens are defined in the :root token block", () => {
    for (const token of Object.values(APPROVAL_STATUS_TOKENS)) {
      expect(css).toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  test("semantic mapping: danger=deny, success=allow-once, info=allow-always", () => {
    expect(APPROVAL_STATUS_TOKENS.deny).toBe("--color-approval-deny");
    expect(APPROVAL_STATUS_TOKENS["allow-once"]).toBe("--color-approval-allow-once");
    expect(APPROVAL_STATUS_TOKENS["allow-always"]).toBe("--color-approval-allow-always");
    expect(APPROVAL_STATUS_TOKENS.pending).toBe("--color-approval-pending");
    // they reference base tokens (token consumption, not raw hex)
    expect(css).toMatch(/--color-approval-deny:\s*var\(--danger\)/);
    expect(css).toMatch(/--color-approval-allow-once:\s*var\(--success\)/);
  });
});
