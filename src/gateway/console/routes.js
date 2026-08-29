/* Tenjin Console — canonical five-area product navigation.
 *
 * Old hashes remain valid so bookmarks and older empty-state links never land
 * on the wrong panel. They resolve into the appropriate sub-view of Activity
 * or Setup while the mobile bottom bar stays at exactly five destinations.
 */
"use strict";

export const PRIMARY_NAV = [
  { name: "chat", label: "Chat", hash: "#chat" },
  { name: "activity", label: "Activity", hash: "#activity" },
  { name: "approvals", label: "Approvals", hash: "#approvals" },
  { name: "routines", label: "Routines", hash: "#routines" },
  { name: "setup", label: "Setup", hash: "#setup/bots" },
];

export const ACTIVITY_VIEWS = ["overview", "sessions", "spend", "audit", "memory", "status"];
export const SETUP_VIEWS = ["bots", "provider", "access"];

const LEGACY = {
  jobs: "routines",
  sessions: "activity/sessions",
  spend: "activity/spend",
  audit: "activity/audit",
  memory: "activity/memory",
  status: "activity/status",
  bots: "setup/bots",
  settings: "setup/provider",
};

/** Resolve a location hash into a canonical primary area + optional sub-view. */
export function resolveConsoleRoute(hash = "") {
  const raw = String(hash).replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  const aliased = (LEGACY[raw] ?? raw) || "chat";
  const [name, requestedSubroute] = aliased.split("/");

  if (name === "activity") {
    const subroute = ACTIVITY_VIEWS.includes(requestedSubroute) ? requestedSubroute : "overview";
    return { name, subroute, canonicalHash: subroute === "overview" ? "#activity" : `#activity/${subroute}` };
  }
  if (name === "setup") {
    const subroute = SETUP_VIEWS.includes(requestedSubroute) ? requestedSubroute : "bots";
    return { name, subroute, canonicalHash: `#setup/${subroute}` };
  }
  if (["chat", "approvals", "routines"].includes(name)) {
    return { name, subroute: null, canonicalHash: `#${name}` };
  }
  return { name: "chat", subroute: null, canonicalHash: "#chat" };
}
