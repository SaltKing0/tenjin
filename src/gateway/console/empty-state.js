/* Tenjin Console — empty-state copy + CTA routing targets (#254).
 *
 * Pure data module (no DOM), so the render path is unit-testable headlessly;
 * app.js turns these descriptors into empty-state cards. All CTA `hash` values
 * are existing console routes (must stay in `ROUTES`, mirroring app.js's
 * PANELS table).
 */
"use strict";

export const EMPTY_STATES = {
  // chat — shown while there are no bots and the user hasn't chatted yet
  chat: {
    title: "Choose a bot or start in Solo mode",
    caption:
      "Create a bot (role + SOUL) in the Status panel, or just start typing — Solo mode uses the default model.",
    cta: "Create a bot",
    hash: "#status",
  },
  // jobs — nothing scheduled yet
  jobs: {
    title: "No scheduled jobs yet",
    caption: "Routines (every/cron) are configured under the `gateway:` block of your config.yaml.",
    cta: "Open settings",
    hash: "#settings",
  },
  // sessions — no history in this scope
  sessions: {
    title: "No history yet",
    caption: "Run anything — your chats and sessions will appear here.",
    cta: "Start a chat",
    hash: "#chat",
  },
  // memory — nothing persisted yet
  memory: {
    title: "No memory yet",
    caption: "After a run, Tenjin records facts, summaries and a vector store automatically.",
    cta: "Start a chat",
    hash: "#chat",
  },
  // approvals — positively empty
  approvals: {
    title: "Nothing to approve ✓",
    caption: "All pending tool calls have already been decided.",
  },
};

/** Valid console routes that an empty-state CTA may target. */
export const ROUTES = [
  "#chat",
  "#settings",
  "#approvals",
  "#jobs",
  "#sessions",
  "#memory",
  "#spend",
  "#audit",
  "#status",
];

/** Resolve the empty-state descriptor for a panel, or null when unknown. */
export function emptyStateFor(panel) {
  return EMPTY_STATES[panel] || null;
}
