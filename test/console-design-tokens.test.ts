import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #293: the console stylesheet is built on a design-token layer. The token
// block in `:root` is the single place where raw values (hex colors, px
// scales, radii, shadows) may appear; every rule below must consume tokens.
// This pins the behavioural contract per the issue; full visual verification
// is documented via screenshots in the PR.

const css = readFileSync(
  join(import.meta.dir, "..", "src", "gateway", "console", "style.css"),
  "utf8",
);

const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
if (!rootMatch) throw new Error("no :root token block found");
const root: string = rootMatch[1] ?? "";
// #286/#308: the light theme is a legitimate second token-OVERRIDE block — it
// re-defines the same custom properties with light-palette values, so it is a
// token region too, not "body". Everything outside :root and [data-theme]
// must consume tokens only.
const lightMatch = css.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
const lightStart = lightMatch ? lightMatch.index! : css.length;
const rootEnd = rootMatch.index! + rootMatch[0].length;
const body =
  css.slice(rootEnd, lightStart) + (lightMatch ? css.slice(lightStart + lightMatch[0].length) : "");

function token(name: string): string | undefined {
  return root.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
}

describe("style.css design tokens (#293)", () => {
  test("token block exists and is documented", () => {
    expect(root).toBeTruthy();
    expect(css).toMatch(/design tokens/i);
    expect(css).toMatch(/ledger desk/i);
  });

  test("color scale: bg/panel/border/text/accent/status with steps", () => {
    for (const name of [
      "bg",
      "bg-raised",
      "panel",
      "panel-raised",
      "border",
      "border-strong",
      "text",
      "text-dim",
      "accent",
      "accent-strong",
      "success",
      "success-wash",
      "warning",
      "warning-wash",
      "danger",
      "danger-wash",
    ]) {
      expect(token(name), `missing token --${name}`).toBeTruthy();
    }
    // translucent helpers used by chat bubbles / previews
    expect(token("accent-line")).toBeTruthy();
    expect(token("wash")).toBeTruthy();
    expect(token("on-accent")).toBeTruthy();
  });

  test("spacing scale on the 4px grid: 4/8/12/16/24/32/48/64", () => {
    const scale: Record<string, string> = {
      "sp-1": "4px",
      "sp-2": "8px",
      "sp-3": "12px",
      "sp-4": "16px",
      "sp-6": "24px",
      "sp-8": "32px",
      "sp-12": "48px",
      "sp-16": "64px",
    };
    for (const [name, value] of Object.entries(scale)) {
      expect(token(name), `missing token --${name}`).toBe(value);
    }
  });

  test("type scale 12/13/14/16/20/28 + line heights", () => {
    const scale: Record<string, string> = {
      "fs-xs": "12px",
      "fs-sm": "13px",
      "fs-base": "14px",
      "fs-md": "16px",
      "fs-lg": "20px",
      "fs-xl": "28px",
    };
    for (const [name, value] of Object.entries(scale)) {
      expect(token(name), `missing token --${name}`).toBe(value);
    }
    expect(token("lh-tight")).toBeTruthy();
    expect(token("lh-body")).toBeTruthy();
  });

  test("radii 4/8/12 plus pill/circle hooks, at most two shadow levels", () => {
    expect(token("radius-sm")).toBe("4px");
    expect(token("radius-md")).toBe("8px");
    expect(token("radius-lg")).toBe("12px");
    expect(token("radius-full")).toBeTruthy();
    const shadows = root.match(/--shadow-\d+\s*:/g) ?? [];
    expect(shadows.length).toBeLessThanOrEqual(2);
    expect(shadows.length).toBeGreaterThanOrEqual(1);
  });

  test("legacy ad-hoc variable names are gone", () => {
    // exact custom-property declarations only ("--warning" must not count as "--warn")
    expect(css).not.toMatch(/--(dim|ok|warn|err)\s*:/);
    expect(css).not.toMatch(/var\(--(dim|ok|warn|err)\)/);
  });

  test("no raw color literals outside the token block", () => {
    // strip comments first: issue references like "#276:" are not colors
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "");
    const magic = code.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [];
    expect(magic, `magic colors below :root: ${magic.join(", ")}`).toEqual([]);
  });

  test("font sizes only via type-scale tokens (body rules)", () => {
    const raw = body.match(/font-size\s*:\s*(?!\s*var\()[^;]+/g) ?? [];
    expect(raw, `raw font-sizes: ${raw.join(" | ")}`).toEqual([]);
  });

  test("border radii only via radius tokens or 50% circles", () => {
    const raw =
      body.match(/border-radius\s*:\s*(?!\s*(?:var\(|50%))[^;]+/g) ?? [];
    expect(raw, `raw radii: ${raw.join(" | ")}`).toEqual([]);
  });

  test("spacing (padding/margin/gap) only via spacing tokens", () => {
    // allowed non-token values: 0, calc()/env() compositions
    const raw =
      body.match(
        /(?:padding|margin|gap|row-gap|column-gap)[a-z-]*\s*:\s*[^;]*\d+px[^;]*/g,
      ) ?? [];
    expect(raw, `raw spacing: ${raw.join(" | ")}`).toEqual([]);
  });

  test("stylesheet stays structurally valid and under budget", () => {
    const opens = (css.match(/\{/g) ?? []).length;
    const closes = (css.match(/\}/g) ?? []).length;
    expect(opens, "unbalanced braces").toBe(closes);
    expect(css).toContain("@media (max-width: 767px)");
    expect(Buffer.byteLength(css), "style.css over 25 KB budget")
      .toBeLessThanOrEqual(25 * 1024);
  });
});
