/* Tenjin Console — mobile table stacking labels (#258).
 *
 * Pure logic module (no DOM): given a table's header texts and the cells of a
 * data row, it returns the `data-label` for each cell. app.js applies these to
 * real <td> elements; the <768px stylesheet then stacks rows into labelled
 * cards instead of overflowing horizontally. Because this module never touches
 * the DOM, the mapping is unit-testable headlessly.
 */
"use strict";

/**
 * Extract the header labels from a table definition.
 *
 * @param {Array<{tag:string, text:string}>} firstRow A representation of the
 *   table's first row: each entry is the tag ("TH"/"TD") and trimmed text.
 * @returns {Array<string>} Header label per column, or [] when the row has no
 *   TH cells (a headerless table → nothing to annotate).
 */
export function headerLabels(firstRow) {
  if (!firstRow) return [];
  const th = firstRow.filter((c) => c && c.tag === "TH");
  if (th.length === 0) return [];
  return firstRow.map((c) => (c && c.tag === "TH" ? c.text : ""));
}

/**
 * Compute the data-label for each cell of a data row.
 *
 * @param {Array<string>} headers Header labels per column (from headerLabels).
 * @param {Array<{tag:string}>} cells The data row's cells (tags are TD).
 * @returns {Array<string|undefined>} A `data-label` per cell (undefined when the
 *   column has no header or the table is headerless).
 */
export function stackLabels(headers, cells) {
  if (headers.length === 0) return [];
  return cells.map((cell, i) => {
    if (cell && cell.tag === "TH") return undefined; // header row itself
    return i < headers.length && headers[i] ? headers[i] : undefined;
  });
}

/** True when a row contains any TH cell (i.e. is itself a header row). */
export function isHeaderRow(row) {
  return Array.isArray(row) && row.some((c) => c && c.tag === "TH");
}
