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
