/* Tenjin Console — top-bar connection / status view (#256, #280).
 *
 * Pure data module (no DOM) so the connected/disconnected render paths are
 * unit-testable headlessly. app.js turns these views into the top-bar
 * indicator + the offline banner.
 */
"use strict";

export const OFFLINE_BANNER = "offline — reconnecting…";

/**
 * Map the live SSE connection state onto the indicator + banner view.
 *
 * `state` is one of:
 *   "connecting" — initial, before the first stream has opened. No banner yet,
 *     so a fresh page load doesn't flash a giant offline block even though the
 *     server is healthy; the stream opens a moment later.
 *   "online"     — the stream is open (response headers received; heartbeats
 *     flow even when there are no events).
 *   "offline"    — the connection was lost (fetch failed or the stream closed).
 */
export function connectionView(state) {
  switch (state) {
    case "online":
      return { label: "live", tone: "ok", banner: null };
    case "offline":
      return { label: "offline", tone: "err", banner: OFFLINE_BANNER };
    case "connecting":
    default:
      return { label: "…", tone: "", banner: null };
  }
}
