/* Tenjin Console — sidebar "Bots" section data (#276).
 *
 * Pure data module (no DOM), so the render path is unit-testable headlessly;
 * app.js turns these descriptors into the sidebar's Bots section rendered
 * under the panel nav. Only real bots appear here — "solo" is a scope, not a
 * bot, and lives in the top-bar / panel switchers.
 */
"use strict";

/**
 * Build the sidebar Bots-section items from the loaded bot list.
 * Each item carries the bot name, its model badge text, and whether it is the
 * currently selected bot (drives active highlighting). Filtered to non-empty
 * names; malformed entries are dropped rather than rendered as dead links.
 */
export function botSectionItems(bots, currentBot) {
  return (bots || [])
    .filter((b) => b && b.name)
    .map((b) => ({
      name: b.name,
      model: b.model || "",
      active: b.name === currentBot,
    }));
}
