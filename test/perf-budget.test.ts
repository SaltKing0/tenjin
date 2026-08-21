import { describe, test, expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Performance budget for the console UI (#292 — Tenjin design language).
// The console is served to the browser as ONE minified bundle (app.bundle.js,
// built by scripts/build-console.sh), so the JS budget is measured on that
// real browser load — not on the sum of 15 separate ES modules. This is the
// actual bytes the browser downloads.
// Measured totals are printed so every run reports the current numbers.
const CONSOLE = join(import.meta.dir, "..", "src", "gateway", "console");
const JS_BUDGET_KB = 80; // Epic #292 hard AC (guard ceiling, not warn-only)
const CSS_BUDGET_KB = 25;

function sizeKB(entry: string): number {
  return statSync(join(CONSOLE, entry)).size / 1024;
}

describe("console performance budget (#292)", () => {
  test("console JS bundle (app.bundle.js) is within the 80 KB guard ceiling", () => {
    const bundle = join(CONSOLE, "app.bundle.js");
    expect(readFileSync(bundle, "utf8").length, "app.bundle.js must exist — run scripts/build-console.sh").toBeGreaterThan(0);
    const kb = sizeKB("app.bundle.js");
    console.log(`console JS bundle: ${kb.toFixed(1)} KB`);
    expect(kb).toBeLessThanOrEqual(JS_BUDGET_KB);
  });

  test("the committed bundle is up to date with its source modules", () => {
    // A stale bundle (source edited, build not re-run) means the browser gets
    // old code. Guard that app.bundle.js is newer than the newest source file
    // that feeds it (app.js and the .js modules it imports).
    const src = readFileSync(join(CONSOLE, "app.js"), "utf8");
    const entries = ["app.js", "app.bundle.js"];
    for (const m of src.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
      if (m[1] && m[1].endsWith(".js")) entries.push(m[1]);
    }
    const newest = Math.max(...entries.filter((e) => e !== "app.bundle.js").map((e) => statSync(join(CONSOLE, e)).mtimeMs));
    const bundleMtime = statSync(join(CONSOLE, "app.bundle.js")).mtimeMs;
    // allow a small skew for filesystem timestamp granularity
    expect(bundleMtime + 2000, "app.bundle.js is stale — re-run scripts/build-console.sh").toBeGreaterThanOrEqual(newest);
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
