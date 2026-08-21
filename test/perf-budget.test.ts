import { describe, test, expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Performance budget for the console UI (#292 — Tenjin design language).
// These guard against unbounded growth and enforce the structural rules
// (system fonts only, style.css within budget) that keep the console fast.
// Measured totals are printed so every run reports the current numbers.
const CONSOLE = join(import.meta.dir, "..", "src", "gateway", "console");
const JS_BUDGET_KB = 100; // guard ceiling; Epic target is 80 KB (see PR body)
const CSS_BUDGET_KB = 25;

/** Resolve the set of console .js modules reachable from `entry` via static imports. */
function importGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(join(CONSOLE, entry), "utf8");
  for (const m of src.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
    if (m[1]) importGraph(m[1], seen);
  }
  return seen;
}

function sizeKB(entry: string): number {
  return statSync(join(CONSOLE, entry)).size / 1024;
}

describe("console performance budget (#292)", () => {
  test("console JS (app.js + reachable modules) is within the guard ceiling", () => {
    const files = [...importGraph("app.js")];
    let total = 0;
    for (const f of files) total += sizeKB(f);
    console.log(`console JS: ${total.toFixed(1)} KB across ${files.length} files`);
    expect(total).toBeLessThanOrEqual(JS_BUDGET_KB);
  });

  test("style.css is within its 25 KB budget", () => {
    const kb = sizeKB("style.css");
    console.log(`style.css: ${kb.toFixed(1)} KB`);
    expect(kb).toBeLessThanOrEqual(CSS_BUDGET_KB);
  });

  test("console uses system fonts only — no @font-face or webfont downloads", () => {
    const css = readFileSync(join(CONSOLE, "style.css"), "utf8");
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(css).toMatch(/ui-monospace|system-ui|SF Mono/);
  });
});
