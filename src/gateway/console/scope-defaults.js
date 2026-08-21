/* Tenjin Console — per-panel scope defaults (#277).
 *
 * Pure data module (no DOM) so it is unit-testable headlessly. The console
 * defaults `currentBot` to the chat-fallback scope "solo", which usually has no
 * persisted data — so Sessions/Memory panels landed empty even when a real bot
 * had data, looking broken to a first-time user. This resolves which scope a
 * scoped panel should actually render:
 *   - a stored per-panel choice is kept when it is still a real bot;
 *   - otherwise fall back to the FIRST bot that has data for this panel;
 *   - with no bot having data, fall back to "solo".
 * It also provides a "another bot has data — switch?" hint.
 */
"use strict";

/** localStorage key for a panel's persisted scope choice. */
export function panelScopeKey(panel) {
  return `tenjin_scope_${panel}`;
}

/**
 * Resolve the scope a scoped panel should render.
 * @param {{stored?: string, bots: Array<{name: string, count: number}>}} opts
 *   `stored` is the persisted per-panel choice (may be ""/undefined);
 *   `bots` lists every selectable scope with its data `count` for this panel.
 * @returns {string} the effective scope to render.
 */
export function resolvePanelScope({ stored, bots }) {
  const names = (bots || []).map((b) => b.name);
  // A stored real-bot choice is respected even if currently empty — the user
  // picked it deliberately. "solo" stored is treated as "no bot chosen".
  if (stored && stored !== "solo" && names.includes(stored)) return stored;
  const firstWithData = (bots || []).find((b) => b.count > 0);
  return firstWithData ? firstWithData.name : "solo";
}

/**
 * Suggest switching to another scope when the current one is empty but another
 * bot has data. Returns null when the current scope already has data, or when
 * no other scope does.
 * @param {{current: string, bots: Array<{name: string, count: number}>}} opts
 * @returns {{name: string, count: number} | null}
 */
export function scopeHint({ current, bots }) {
  const cur = (bots || []).find((b) => b.name === current);
  if (cur && cur.count > 0) return null;
  const alt = (bots || []).find((b) => b.name !== current && b.count > 0);
  return alt ? { name: alt.name, count: alt.count } : null;
}
