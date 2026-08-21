/* Tenjin Console — sidebar panel grouping (#287).
 *
 * Pure data module (no DOM), so the grouping / ordering is unit-testable
 * headlessly. app.js renders the sidebar nav from these groups. Grouping gives
 * the flat panel list hierarchy: "Operate" (actively drive), "Observe"
 * (inspect), and Settings kept separate at the bottom.
 */
"use strict";

/**
 * Declared panel groups. `label: null` renders as an unlabelled group — used
 * for Settings, kept separate at the bottom of the sidebar. The "bots" panel
 * is listed under Operate for forward-compat (landing via #276); it is ignored
 * until that panel exists in the PANELS table.
 */
export const PANEL_GROUPS = [
  { label: "Operate", names: ["chat", "approvals", "jobs", "bots"] },
  { label: "Observe", names: ["sessions", "memory", "spend", "audit", "status"] },
  { label: null, names: ["settings"] },
];

/**
 * Group a flat list of panel names into labelled sections, preserving the
 * declared order. Names not present in the live panel list are ignored (so a
 * future panel can be added without touching this map); any name not covered
 * by a declared group is appended as an unlabelled group rather than silently
 * dropped.
 */
export function panelGroups(panelNames) {
  const set = new Set(panelNames);
  const groups = [];
  const seen = new Set();
  for (const g of PANEL_GROUPS) {
    const names = g.names.filter((n) => set.has(n));
    if (names.length === 0) continue;
    groups.push({ label: g.label, names });
    names.forEach((n) => seen.add(n));
  }
  const leftover = panelNames.filter((n) => !seen.has(n));
  if (leftover.length > 0) groups.push({ label: null, names: leftover });
  return groups;
}
