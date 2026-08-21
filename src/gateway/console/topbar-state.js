/* Tenjin Console — top-bar connection / status view (#256).
 *
 * Pure data module (no DOM) so the connected/disconnected render paths are
 * unit-testable headlessly. app.js turns these views into the top-bar
 * indicator + the offline banner.
 */
"use strict";

export const OFFLINE_BANNER = "offline — reconnecting…";

/** Map the live SSE connection state onto the indicator + banner view. */
export function connectionView(connected) {
  return connected
    ? { label: "live", tone: "ok", banner: null }
    : { label: "offline", tone: "err", banner: OFFLINE_BANNER };
}
