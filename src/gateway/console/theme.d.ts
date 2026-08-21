export type Theme = "dark" | "light";

export const THEME_KEY: string;
export const THEMES: Theme[];
export function resolveTheme(
  saved: string | null,
  systemPrefersLight: boolean,
): Theme;
export function nextTheme(current: string): Theme;
