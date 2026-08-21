/* Tenjin Console — memory scope resolution (#274).
 *
 * Pure data module (no DOM) so it is unit-testable headlessly. The console
 * defaults `currentBot` to the chat-fallback scope "solo", which is NOT a
 * valid memory scope (there is no bot profile named "solo"), so a naive
 * `/api/memory/solo` call 400s. This resolves the scope the Memory panel
 * should actually query: keep the current bot when it is real, otherwise fall
 * back to the first configured bot; with no bots at all it returns null so
 * app.js can render a create-a-bot empty state instead of a raw error.
 */
"use strict";

/**
 * Resolve the effective memory scope for a given current-bot selection.
 * @param {string|undefined} currentBot the console's current bot (may be "solo")
 * @param {Array<{name?: string}>|undefined} bots the configured bot list
 * @returns {string|null} the bot name to query memory for, or null when there
 *   is no bot to query (no valid scope).
 */
export function resolveMemoryScope(currentBot, bots) {
  const names = (bots || []).map((b) => b.name).filter(Boolean);
  if (currentBot && names.includes(currentBot)) return currentBot;
  return names.length > 0 ? names[0] : null;
}
