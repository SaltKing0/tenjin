import { describe, test, expect } from "bun:test";
import { resolveTheme, nextTheme, THEME_KEY, THEMES } from "../src/gateway/console/theme.js";

describe("console theme resolution (#286)", () => {
  test("an explicit saved choice wins over the system preference", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  test("with no saved choice, follow the system preference (dark default)", () => {
    expect(resolveTheme(null, true)).toBe("light");
    expect(resolveTheme(null, false)).toBe("dark");
    expect(resolveTheme("", false)).toBe("dark");
  });

  test("nextTheme toggles between light and dark", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });

  test("THEMES lists both themes and the storage key is set", () => {
    expect(THEMES).toEqual(["dark", "light"]);
    expect(THEME_KEY.length).toBeGreaterThan(0);
  });
});
