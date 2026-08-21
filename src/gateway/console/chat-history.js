/* Tenjin Console — chat history from session events (#284).
 *
 * Pure data module (no DOM): extracts the ordered user/assistant transcript
 * from a session's event log so the Chat panel can render prior context on
 * open. headless-testable.
 */
"use strict";

/** Extract plain text from a session message event (string or content blocks). */
export function messageText(ev) {
  if (ev.role === "user") {
    return typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content);
  }
  return typeof ev.content === "string"
    ? ev.content
    : (ev.content || []).map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
}

/** The ordered user/assistant transcript from a session's events. */
export function sessionMessages(events) {
  return (events || [])
    .filter((e) => e && e.t === "message")
    .map((e) => ({ role: e.role, text: messageText(e) }));
}
