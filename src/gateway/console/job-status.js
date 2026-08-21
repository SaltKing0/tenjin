/* Tenjin Console — job run-status view (#285).
 *
 * Pure data module (no DOM) so the status→badge mapping and last-run
 * derivation are unit-testable headlessly. app.js turns these into the
 * prominent run-status badge + history dots in the Jobs panel.
 */
"use strict";

/**
 * Status → badge view. Tones match the console palette: ok=green, err=red,
 * warn=yellow (timeout), dim=grey (never).
 */
export const RUN_STATUS = {
  ok: { label: "ok", tone: "ok" },
  error: { label: "error", tone: "err" },
  timeout: { label: "timeout", tone: "warn" },
  never: { label: "never", tone: "dim" },
};

/** Resolve a status string to its badge view (unknown → never/grey). */
export function runStatusView(status) {
  return RUN_STATUS[status] || RUN_STATUS.never;
}

/** Classify a raw stop reason as a run status. */
export function stopReasonStatus(stopReason) {
  if (stopReason === "timeout") return "timeout";
  if (stopReason === "error") return "error";
  return "ok";
}

/**
 * The effective last-run status for a job.
 * Prefers the classified history[0] (newest run) which carries status +
 * sessionId for the replay link; falls back to classifying lastRun.stopReason;
 * otherwise "never".
 */
export function lastRunStatus(job) {
  const h = job && job.history && job.history[0];
  if (h && h.status) return h.status;
  if (job && job.lastRun) return stopReasonStatus(job.lastRun.stopReason);
  return "never";
}

/**
 * Tones for the compact history dots (newest first, capped at `max`), so the
 * last few runs read as a coloured strip. Unknown statuses render neutral.
 */
export function historyTones(history, max = 5) {
  return (history || [])
    .slice(0, max)
    .map((h) => runStatusView(h && h.status).tone);
}
