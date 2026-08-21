/* Tenjin Console — inline approval card helpers (#295).
 *
 * Pure data module (no DOM) so it is unit-testable headlessly. When a chat run
 * triggers an approval, the chat stream blocks (waitApproval) while the
 * approval is pending — the console renders an inline card in the chat log
 * driven by the global SSE events `approval.created` / `approval.resolved`
 * (#125), so the user can approve/deny in place without leaving the chat.
 * This module owns the pure formatting/state decisions; app.js supplies the
 * card DOM and the SSE wiring.
 */
"use strict";

/** Card heading for a pending approval. */
export function approvalCardTitle(req) {
  return `[${req.id}] ${req.tool}`;
}

/** One-line summary (bot · tool · input) for the card body. */
export function approvalCardSummary(req) {
  const parts = [];
  if (req.bot) parts.push(req.bot);
  parts.push(req.tool);
  if (req.inputSummary) parts.push(req.inputSummary);
  return parts.join(" · ");
}

/** Result line once resolved, e.g. "✓ approved bash · 14:32". */
export function approvalResultLine(status, tool, when) {
  const mark = status === "approved" ? "✓" : "✗";
  const time = when.toTimeString().slice(0, 5);
  return `${mark} ${status} ${tool} · ${time}`;
}

/** Countdown label ("30s left") or "expired" once past the timeout. */
export function approvalCountdown(createdMs, timeoutMs, now = Date.now()) {
  const left = timeoutMs - (now - createdMs);
  if (left <= 0) return "expired";
  const s = Math.ceil(left / 1000);
  return `${s}s left`;
}

/** True while a request is still awaiting a decision. */
export function approvalIsPending(req) {
  return req.status === "pending";
}
