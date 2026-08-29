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
      "Create a bot (role + SOUL) in the Bots panel, or just start typing — Solo mode uses the default model.",
    cta: "Create a bot",
    hash: "#setup/bots",
  },
  // chat_history — bots exist but this bot has no saved transcript yet (#284)
  chat_history: {
    title: "No chat history yet",
    caption:
      "Messages you send and the replies will appear here. Prefix @botname to address a specific bot, or just start typing in Solo mode.",
  },
  // jobs — nothing scheduled yet
  jobs: {
    title: "No scheduled jobs yet",
    caption: "Run `tenjin onboard` for the daily repo watch, or add one with `tenjin job add`.",
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
  // memory — no bot exists to scope memory to (#274): the console defaults the
  // Memory panel to the chat-fallback scope "solo", which has no memory store,
  // so guide the user to create a bot first.
  memory_nobots: {
    title: "No bot to remember yet",
    caption: "Memory is scoped per bot. Create a bot (role + SOUL) first, then come back here.",
    cta: "Create a bot",
    hash: "#setup/bots",
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
  "#approvals",
  "#routines",
  "#activity",
  "#activity/sessions",
  "#activity/memory",
  "#activity/spend",
  "#activity/audit",
  "#activity/status",
  "#setup/bots",
  "#setup/provider",
  "#setup/access",
];

/** Resolve the empty-state descriptor for a panel, or null when unknown. */
export function emptyStateFor(panel) {
  return EMPTY_STATES[panel] || null;
}
