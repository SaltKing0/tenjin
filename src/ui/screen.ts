/* Tenjin TUI — zero-dependency terminal core (#449).
 *
 * Pure, headless-testable primitives for a raw-ANSI split-pane interface:
 *   - Style + ANSI escape construction (basic 16-color + bold/dim)
 *   - Screen: an in-memory cell buffer with full-repaint rendering to a Writer
 *   - decodeKey: raw stdin bytes -> structured key events
 *   - LineEditor: a cursor-aware input buffer (insert/edit/submit)
 *
 * Nothing here touches the terminal directly (no process.stdin/stdout) except
 * through injected writers, so the whole module is unit-testable.
 */

export interface Style {
  fg?: number; // 0-15 (basic + bright)
  bg?: number; // 0-15
  bold?: boolean;
  dim?: boolean;
}

export const RESET = "\x1b[0m";

function fgAnsi(c: number): string {
  return c < 8 ? `\x1b[${30 + c}m` : `\x1b[${90 + (c - 8)}m`;
}
function bgAnsi(c: number): string {
  return c < 8 ? `\x1b[${40 + c}m` : `\x1b[${100 + (c - 8)}m`;
}

/** ANSI prefix for a style (empty string when there is nothing to style). */
export function styleAnsi(s?: Style): string {
  let out = "";
  if (s?.bold) out += "\x1b[1m";
  if (s?.dim) out += "\x1b[2m";
  if (s?.fg !== undefined) out += fgAnsi(s.fg);
  if (s?.bg !== undefined) out += bgAnsi(s.bg);
  return out;
}

export interface Cell {
  ch: string;
  st: Style;
}

/** Anything with a synchronous write() — stdout or a capture buffer in tests. */
export interface Writer {
  write(s: string): void;
}

const NO_STYLE: Style = {};
function sameStyle(a: Style, b: Style): boolean {
  return (
    (a.fg ?? -1) === (b.fg ?? -1) &&
    (a.bg ?? -1) === (b.bg ?? -1) &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim
  );
}

/** Cursor-move to (row, col), both 0-based. */
const moveTo = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`;

export const ERASE_LINE = "\x1b[K"; // erase to end of line
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

export class Screen {
  rows: number;
  cols: number;
  private buf: Cell[][];
  /** Last rendered frame — cells are only repainted when they differ (#467). */
  private prev: Cell[][] | null = null;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.buf = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ ch: " ", st: NO_STYLE })),
    );
  }

  resize(rows: number, cols: number): void {
    if (rows === this.rows && cols === this.cols) return;
    this.prev = null; // dimensions changed — force a full repaint
    this.rows = rows;
    this.cols = cols;
    const next: Cell[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ ch: " ", st: NO_STYLE })),
    );
    for (let r = 0; r < Math.min(this.rows, this.buf.length); r++) {
      for (let c = 0; c < Math.min(this.cols, this.buf[r]?.length ?? 0); c++) {
        next[r]![c] = this.buf[r]![c]!;
      }
    }
    this.buf = next;
  }

  clear(): void {
    for (const row of this.buf) {
      for (const cell of row) {
        cell.ch = " ";
        cell.st = NO_STYLE;
      }
    }
  }

  /** Place text (clamped to bounds). Multi-line is not handled — use per-row writes. */
  write(row: number, col: number, text: string, st: Style = NO_STYLE): void {
    if (row < 0 || row >= this.rows) return;
    const cells = this.buf[row]!;
    for (let i = 0; i < text.length; i++) {
      const c = col + i;
      if (c >= this.cols) break;
      const ch = text[i]!;
      if (ch === "\n") continue;
      cells[c] = { ch, st: { ...st } };
    }
  }

  /** Raw cell access for tests / compositors. */
  cell(row: number, col: number): Cell {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      return { ch: "", st: NO_STYLE };
    }
    return this.buf[row]![col]!;
  }

  /** Flatten a row's text (styles dropped). */
  rowText(row: number): string {
    if (row < 0 || row >= this.rows) return "";
    return this.buf[row]!.map((c) => c.ch).join("");
  }

  /**
   * Repaint the buffer to the writer, emitting only the rows whose cells
   * changed since the last frame (no full-screen clear → no flicker). The
   * first render and any resize repaint everything.
   */
  render(w: Writer, cursor?: { row: number; col: number }): void {
    w.write(HIDE_CURSOR);
    const prev = this.prev ?? this.seedPrev();
    for (let r = 0; r < this.rows; r++) {
      const row = this.buf[r]!;
      const prow = prev[r]!;
      let changed = false;
      for (let c = 0; c < this.cols; c++) {
        const a = row[c]!;
        const b = prow[c]!;
        if (a.ch !== b.ch || !sameStyle(a.st, b.st)) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      w.write(moveTo(r, 0));
      let last: Style | null = null;
      for (let c = 0; c < this.cols; c++) {
        const cell = row[c]!;
        if (!last || !sameStyle(last, cell.st)) {
          w.write(RESET + styleAnsi(cell.st));
          last = cell.st;
        }
        w.write(cell.ch);
      }
      w.write(RESET + ERASE_LINE);
      for (let c = 0; c < this.cols; c++) prow[c] = { ch: row[c]!.ch, st: { ...row[c]!.st } };
    }
    if (cursor) {
      w.write(moveTo(cursor.row, cursor.col));
    } else {
      w.write(moveTo(this.rows - 1, this.cols - 1));
    }
    w.write(SHOW_CURSOR);
  }

  /** Initialise the diff baseline to blank cells (forces a full first paint). */
  private seedPrev(): Cell[][] {
    this.prev = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ({ ch: "", st: NO_STYLE })),
    );
    return this.prev;
  }
}

/* ------------------------------ key decoding ------------------------------ */

export type KeyEvent =
  | { type: "char"; ch: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pgup" }
  | { type: "pgdown" }
  | { type: "esc" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-k" }
  | { type: "ctrl-l" }
  | { type: "ctrl-n" }
  | { type: "ctrl-p" }
  | { type: "unknown"; bytes: string }
  | { type: "mouse"; x: number; y: number; button: number; pressed: boolean };

/** Decode a single chunk of raw stdin bytes into key events (best effort). */
export function decodeKey(buf: Uint8Array): KeyEvent[] {
  const out: KeyEvent[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i]!;
    // Printable ASCII / UTF-8 lead byte (>= 0x20)
    if (b === 0x0d || b === 0x0a) {
      out.push({ type: "enter" });
      i++;
    } else if (b === 0x09) {
      out.push({ type: "tab" });
      i++;
    } else if (b === 0x7f) {
      out.push({ type: "backspace" });
      i++;
    } else if (b === 0x1b && i + 1 < buf.length && buf[i + 1] === 0x5b) {
      // CSI: ESC [ params/intermediates ... final byte (0x40-0x7e)
      let j = i + 2;
      while (j < buf.length && buf[j]! >= 0x20 && buf[j]! <= 0x7e) j++;
      const seq = String.fromCharCode(...Array.from(buf.slice(i, j)));
      const final = seq[seq.length - 1]!;
      if (final === "A") out.push({ type: "up" });
      else if (final === "B") out.push({ type: "down" });
      else if (final === "C") out.push({ type: "right" });
      else if (final === "D") out.push({ type: "left" });
      else if (final === "H") out.push({ type: "home" });
      else if (final === "F") out.push({ type: "end" });
      else if (final === "M" || final === "m") {
        // SGR mouse report: ESC [ <b ; x ; y (M=press | m=release)
        const m = /\x1b\[<(\d+);(\d+);(\d+)/.exec(seq);
        if (m) {
          out.push({
            type: "mouse",
            button: Number(m[1]),
            x: Number(m[2]) - 1,
            y: Number(m[3]) - 1,
            pressed: final === "M",
          });
        } else {
          out.push({ type: "unknown", bytes: seq });
        }
      }
      else if (final === "~") {
        const m = /\x1b\[(\d+)~$/.exec(seq);
        const num = m ? Number(m[1]) : 0;
        if (num === 5) out.push({ type: "pgup" });
        else if (num === 6) out.push({ type: "pgdown" });
        else if (num === 3) out.push({ type: "delete" });
        else if (num === 1) out.push({ type: "home" });
        else if (num === 4) out.push({ type: "end" });
        else out.push({ type: "unknown", bytes: seq });
      } else {
        out.push({ type: "unknown", bytes: seq });
      }
      i = j;
    } else if (b === 0x1b) {
      // Bare ESC (not a CSI/SS3 sequence) — e.g. GrokBuild-style "Esc:clear".
      out.push({ type: "esc" });
      i++;
    } else if (i + 1 < buf.length && buf[i + 1] === 0x4f) {
      out.push({ type: "home" }); // SS3 H / F
      i += 2;
    } else if (b === 0x03) {
      out.push({ type: "ctrl-c" });
      i++;
    } else if (b === 0x04) {
      out.push({ type: "ctrl-d" });
      i++;
    } else if (b === 0x0b) {
      out.push({ type: "ctrl-k" });
      i++;
    } else if (b === 0x0c) {
      out.push({ type: "ctrl-l" });
      i++;
    } else if (b === 0x0e) {
      out.push({ type: "ctrl-n" });
      i++;
    } else if (b === 0x10) {
      out.push({ type: "ctrl-p" });
      i++;
    } else if (b >= 0x20) {
      // char — handle 1-4 byte UTF-8
      let len = 1;
      if ((b & 0xe0) === 0xc0) len = 2;
      else if ((b & 0xf0) === 0xe0) len = 3;
      else if ((b & 0xf8) === 0xf0) len = 4;
      const bytes = Array.from(buf.slice(i, i + len));
      const ch = new TextDecoder().decode(new Uint8Array(bytes));
      out.push({ type: "char", ch });
      i += len;
    } else {
      out.push({ type: "unknown", bytes: String(b) });
      i++;
    }
  }
  return out;
}

/* ------------------------------- line editor ------------------------------- */

/** A cursor-aware input line. All ops are pure (mutate in place, return void). */
export class LineEditor {
  text = "";
  cursor = 0;

  insert(ch: string): void {
    this.text = this.text.slice(0, this.cursor) + ch + this.text.slice(this.cursor);
    this.cursor += ch.length;
  }
  backspace(): void {
    if (this.cursor <= 0) return;
    this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
    this.cursor--;
  }
  del(): void {
    if (this.cursor >= this.text.length) return;
    this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
  }
  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }
  right(): void {
    this.cursor = Math.min(this.text.length, this.cursor + 1);
  }
  home(): void {
    this.cursor = 0;
  }
  end(): void {
    this.cursor = this.text.length;
  }
  ctrlK(): void {
    this.text = this.text.slice(0, this.cursor);
  }
  clear(): void {
    this.text = "";
    this.cursor = 0;
  }
  submit(): string {
    const v = this.text;
    this.clear();
    return v;
  }
}
