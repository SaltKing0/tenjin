/* Tenjin Console — setup checklist for the Status panel (#252).
 *
 * Pure data module (no DOM), so the mapping is unit-testable headlessly. It
 * turns the /api/setup/state payload into a checklist of what is still
 * missing, each item with a deep-link route the Status panel renders on the
 * incomplete entries.
 */
"use strict";

export const SETUP_ITEMS = [
  { key: "hasModel", label: "Model configured", hash: "#setup/provider" },
  { key: "hasBot", label: "Bot created", hash: "#setup/bots" },
  { key: "hasGatewayToken", label: "Gateway token set", hash: "#setup/access" },
  { key: "hasBudgetLimit", label: "Budget limits set", hash: "#setup/provider" },
  { key: "channelsEnabled", label: "A channel connected", hash: "#setup/access", optional: true },
];

/** Map the /api/setup/state payload onto the checklist, marking each item. */
export function setupChecklist(state = {}) {
  return SETUP_ITEMS.map((item) => ({ ...item, ok: !!state[item.key] }));
}
