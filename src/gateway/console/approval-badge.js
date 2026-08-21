/* Tenjin Console — approval badge helpers (#296).
 *
 * Pure data module (no DOM) so it is unit-testable headlessly. The TopBar shows
 * a live pending-approval counter fed by SSE `approval.created/resolved`
 * events (#125). This module owns the pure formatting decisions:
 *   - badge text: "⏸ N" when pending, a subtle dot when none;
 *   - browser title: "(N) Tenjin" while pending, "Tenjin" otherwise;
 *   - a one-line summary of a pending request for the dropdown;
 *   - a compact human age for a request timestamp.
 * app.js supplies the live count and the dropdown DOM.
 */
"use strict";

/** Badge label for a pending-approval count (0 -> subtle dot, no number). */
export function approvalBadgeText(count) {
  return count > 0 ? `⏸ ${count}` : "•";
}

/** CSS class: emphasise only when there is a live pending count. */
export function approvalBadgeClass(count) {
  return count > 0 ? "topbar-approvals" : "topbar-approvals idle";
}

/** Browser document title carrying the pending count when non-zero. */
export function browserTitle(count) {
  return count > 0 ? `(${count}) Tenjin` : "Tenjin";
}

/** One-line summary of a pending approval for a dropdown entry. */
export function approvalLine(req) {
  const parts = [];
  if (req.bot) parts.push(req.bot);
  parts.push(req.tool);
  if (req.inputSummary) parts.push(req.inputSummary);
  return parts.join(" · ");
}

/** Compact relative age ("30s ago", "5m ago", "2h ago") of a request time. */
export function approvalAge(ts, now = Date.now()) {
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  if (!Number.isFinite(t)) return "";
  const ms = now - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s <= 0 ? "just now" : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
