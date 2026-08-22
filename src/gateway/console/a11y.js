/* Tenjin Console — a11y + reading comfort (B13-10 #440).
 *
 * Pure data module (no DOM) so it is unit-testable headlessly, matching the
 * approval-card pattern (#295). Owns the ARIA contract for the approval flow,
 * the collapsed-output / expand logic, and the virtualization window for long
 * transcripts. app.js consumes these helpers to render accessible, readable,
 * virtualized console panels.
 */

/** Semantic approval-status tokens (map to the base design-token scale).
 *  danger = deny, success = allow-once, info = allow-always. */
export const APPROVAL_STATUS_TOKENS = {
  pending: "--color-approval-pending",
  deny: "--color-approval-deny",
  "allow-once": "--color-approval-allow-once",
  "allow-always": "--color-approval-allow-always",
};

/**
 * The ARIA contract an approval card must expose: a modal alert dialog with a
 * polite live region, a labelled heading, and real <button> controls. Returns
 * the attribute map so the renderer is declarative and testable.
 */
export function approvalAria(state) {
  const { id = "approval", tool = "" } = state ?? {};
  const labelId = `${id}-label`;
  const descId = `${id}-desc`;
  return {
    role: "alertdialog",
    "aria-modal": "true",
    "aria-live": "polite",
    "aria-labelledby": labelId,
    "aria-describedby": descId,
    labelId,
    descId,
    label: `Approval requested${tool ? ` for ${tool}` : ""}`,
    // a11y: controls are real buttons, never div-click handlers
    controls: [
      { id: `${id}-allow`, kind: "button", label: "Allow" },
      { id: `${id}-deny`, kind: "button", label: "Deny" },
    ],
  };
}

/** Collapse a tool result to an "N lines" pill when it exceeds the threshold
 *  (default 8). Returns the decision so the renderer can show the pill. */
export function collapseOutput(output, opts = {}) {
  const threshold = opts.threshold ?? 8;
  const text = String(output ?? "");
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  if (lineCount <= threshold) {
    return { collapsed: false, lineCount, pillText: null, full: text };
  }
  return { collapsed: true, lineCount, pillText: `${lineCount} lines`, full: text };
}

/** Expand a collapsed output back to its full text. Because the renderer
 *  keeps the SAME container node and only swaps its content, the user's scroll
 *  position is preserved — the pure contract returns the complete output. */
export function expandCollapsed(state) {
  return state && state.full ? state.full : "";
}

/** Bounded virtualization window over a long list: only `viewport` blocks plus
 *  `overscan` on each side are mounted, so DOM node count stays O(viewport)
 *  regardless of total. Returns inclusive [start, end]. */
export function visibleWindow(index, total, opts = {}) {
  const viewport = opts.viewport ?? 20;
  const overscan = opts.overscan ?? 5;
  if (total <= 0) return { start: 0, end: 0 };
  const desired = viewport + 2 * overscan;
  let start = Math.max(0, index - overscan - Math.floor(viewport / 2));
  let end = Math.min(total - 1, start + desired - 1);
  // ran off the end (or total smaller than the window): shift the window up so
  // it stays `desired`-sized and never exceeds the list.
  if (end - start + 1 < Math.min(desired, total)) {
    start = Math.max(0, end - desired + 1);
  }
  return { start, end };
}
