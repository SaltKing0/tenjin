/* Tenjin Console — theme resolution (#286).
 *
 * Pure data module (no DOM): resolves the effective theme from the saved
 * choice + system preference, and computes the toggle target. headless-testable.
 */
"use strict";

/** localStorage key for the user's explicit theme choice. */
export const THEME_KEY = "tenjin_theme";
export const THEMES = ["dark", "light"];

/**
 * Effective theme. An explicit saved choice wins; otherwise follow the system
 * `prefers-color-scheme`. Dark is the fallback default.
 */
export function resolveTheme(saved, systemPrefersLight) {
  if (saved === "light" || saved === "dark") return saved;
  return systemPrefersLight ? "light" : "dark";
}

/** The other theme (toggle target). */
export function nextTheme(current) {
  return current === "light" ? "dark" : "light";
}
