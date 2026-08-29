/* Tenjin Console — first-run setup screen view (#251).
 *
 * Pure data module (no DOM), so the setup-state → screen mapping is
 * unit-testable headlessly. app.js turns this into the 3-step first-run screen
 * (progress, links, advanced-mode skip).
 */
"use strict";

export const STEPS = [
  { field: "hasModel", title: "Connect a provider & choose a model", hash: "#setup/provider" },
  { field: "hasBot", title: "Create your first bot", hash: "#setup/bots" },
  { field: "hasGatewayToken", title: "Secure Console access", hash: "#setup/access" },
];

/** The golden journey is complete once model, bot and Console access exist. */
export function isSetupComplete(state = {}) {
  return !!(state.hasModel && state.hasBot && state.hasGatewayToken);
}

/** True when the first-run screen should show: setup incomplete + not skipped. */
export function shouldShowFirstRun(state = {}, skipped = false) {
  return !isSetupComplete(state) && !skipped;
}

/** Progress + per-step done flags for the 3-step screen. */
export function firstRunView(state = {}) {
  const steps = STEPS.map((s, i) => ({
    n: i + 1,
    field: s.field,
    title: s.title,
    hash: s.hash,
    done: !!state[s.field],
  }));
  const done = steps.filter((s) => s.done).length;
  return {
    complete: done === steps.length,
    progress: Math.round((done / steps.length) * 100),
    done,
    steps,
  };
}
