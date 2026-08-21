import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headerLabels, stackLabels, isHeaderRow } from "../src/gateway/console/tables.js";

const H = (t: string) => ({ tag: "TH", text: t });
const D = () => ({ tag: "TD" });

describe("headerLabels", () => {
  test("reads TH texts of a header row", () => {
    expect(headerLabels([H("job"), H("bot"), H("next due")])).toEqual([
      "job",
      "bot",
      "next due",
    ]);
  });

  test("returns [] for a headerless first row", () => {
    expect(headerLabels([D(), D()])).toEqual([]);
  });

  test("returns [] for undefined input", () => {
    expect(headerLabels(null)).toEqual([]);
    expect(headerLabels(undefined)).toEqual([]);
  });
});

describe("stackLabels", () => {
  test("maps each cell to its column header", () => {
    const headers = ["job", "bot", "next due"];
    const labels = stackLabels(headers, [D(), D(), D()]);
    expect(labels).toEqual(["job", "bot", "next due"]);
  });

  test("leaves cells beyond the header count unlabelled", () => {
    const headers = ["job", "bot"];
    const labels = stackLabels(headers, [D(), D(), D()]);
    expect(labels).toEqual(["job", "bot", undefined]);
  });

  test("returns [] when there are no headers", () => {
    expect(stackLabels([], [D()])).toEqual([]);
  });

  test("header row cells are not labelled", () => {
    expect(stackLabels(["job", "bot"], [H("job"), H("bot")])).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("isHeaderRow", () => {
  test("true when any cell is a TH", () => {
    expect(isHeaderRow([H("job"), D()])).toBe(true);
  });
  test("false when all cells are TD", () => {
    expect(isHeaderRow([D(), D()])).toBe(false);
  });
});

// #258: the mobile stylesheet must exist with the responsive breakpoint and the
// touch-target floor. (Full visual verification is documented via screenshots in
// the PR per the issue; this pins the behavioural contract the CSS implements.)
describe("style.css mobile media query", () => {
  const css = readFileSync(
    join(import.meta.dir, "../src/gateway/console/style.css"),
    "utf8",
  );

  test("contains a <768px breakpoint", () => {
    expect(css).toContain("@media (max-width: 767px)");
  });

  test("turns the sidebar into a bottom navigation bar", () => {
    expect(css).toContain(".sidebar nav");
    expect(css).toContain("bottom: 0");
  });

  test("stacks header-labelled tables into cards (no page horizontal scroll)", () => {
    expect(css).toContain("td[data-label]::before");
  });

  test("enforces a 44px touch-target floor on mobile controls", () => {
    expect(css).toContain("min-height: 44px");
  });
});

// #283: two font roles — UI sans for labels/buttons/prose, mono for data/code.
// (Full visual verification is documented via screenshots in the PR per the
// issue; these assertions pin the behavioural contract the CSS implements.)
describe("style.css font roles (#283)", () => {
  const css = readFileSync(
    join(import.meta.dir, "../src/gateway/console/style.css"),
    "utf8",
  );

  test("defines --font-ui (sans) and --font-mono (mono) variables", () => {
    expect(css).toMatch(/--font-ui:\s*-apple-system/);
    expect(css).toMatch(/--font-mono:\s*"SF Mono"/);
  });

  test("body uses the UI (sans) font, not mono", () => {
    expect(css).toMatch(/body\s*\{[\s\S]*font-family:\s*var\(--font-ui\)/);
  });

  test("data/code surfaces are pinned to --font-mono", () => {
    expect(css).toMatch(/pre\s*\{[\s\S]*font-family:\s*var\(--font-mono\)/);
    expect(css).toMatch(/^code\s*\{[\s\S]*font-family:\s*var\(--font-mono\)/m);
    expect(css).toMatch(/\.soul-input[\s\S]*font-family:\s*var\(--font-mono\)/);
    expect(css).toMatch(/\.toolcall summary[\s\S]*font-family:\s*var\(--font-mono\)/);
    expect(css).toMatch(/\.mono\s*\{[\s\S]*font-family:\s*var\(--font-mono\)/);
    expect(css).toMatch(/td\.num[\s\S]*font-family:\s*var\(--font-mono\)/);
  });
});

describe("app.js model IDs are marked mono (#283)", () => {
  const js = readFileSync(
    join(import.meta.dir, "../src/gateway/console/app.js"),
    "utf8",
  );

  test("model badges and usage-table model cells carry the .mono class", () => {
    expect(js).toMatch(/class:\s*"badge mono"/);
    expect(js).toMatch(/class:\s*"dim mono"/);
  });
});

// #283: the stylesheet must stay structurally valid. A missing closing brace on
// an early rule silently swallows every later rule in the browser (this is
// exactly the regression the typography work hit), so pin balanced braces.
describe("style.css braces are balanced (#283)", () => {
  const css = readFileSync(
    join(import.meta.dir, "../src/gateway/console/style.css"),
    "utf8",
  );
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const open = (withoutComments.match(/{/g) || []).length;
  const close = (withoutComments.match(/}/g) || []).length;

  test("every opening brace is closed", () => {
    expect(open).toBe(close);
  });
});

// #302: the dark :root must define --bg-raised/--accent-strong/--on-accent with
// concrete values. A self-referential value (--hover: var(--hover)) is a cyclic
// CSS dependency that computes to unset, breaking button.primary and hover
// backgrounds in the default dark theme. #330 renamed --hover/--primary to the
// token scale (--bg-raised/--accent-strong); this pins the concrete values and
// forbids any self-referential custom property in the stylesheet.
describe("style.css dark theme variable values (#302)", () => {
  const css = readFileSync(
    join(import.meta.dir, "../src/gateway/console/style.css"),
    "utf8",
  );

  test(":root defines concrete --bg-raised / --accent-strong (not self-referential)", () => {
    expect(css).toMatch(/:root\s*\{[\s\S]*?--bg-raised:\s*#[0-9a-fA-F]{3,6};/);
    expect(css).toMatch(/:root\s*\{[\s\S]*?--accent-strong:\s*#[0-9a-fA-F]{3,6};/);
  });

  test("no cyclic var self-references remain anywhere in the stylesheet", () => {
    expect(css).not.toMatch(/--hover:\s*var\(--hover\)/);
    expect(css).not.toMatch(/--primary:\s*var\(--primary\)/);
  });
});
