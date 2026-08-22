/**
 * Append-only streaming + persistent status line (Roadmap §16 B13-1, #383).
 *
 * Anti-flicker law for slow/free models: output is append-only — provider
 * deltas are buffered and flushed in ~30ms frames, never per-token, and
 * already-emitted lines are never rewritten. All live widgets (spinner,
 * status line) are gated behind `isTTY`: off-TTY we emit plain log lines only,
 * so headless/pipe use stays clean. A dependency-free spinner + elapsed timer
 * surfaces stalls, and a usage-fed status line shows model, tokens, a context
 * color band, cost, iteration, and the last tool used.
 */

export const FRAME_MS = 30;

export interface FrameBatcherOptions {
  /** Flush frame in ms (default 30). */
  frameMs?: number;
  /** Clock for deterministic tests. */
  now: () => number;
  /** Output sink. */
  write: (s: string) => void;
}

/**
 * Buffers pushed deltas and flushes them at frame boundaries. A burst of N
 * chunks within one frame yields exactly one write (never per-token). Call
 * {@link tick} periodically (or on each push) to trigger frame flushes; call
 * {@link flush} to force remaining buffered text out.
 */
export class FrameBatcher {
  private buf = "";
  private lastFlush: number;

  constructor(private readonly opts: FrameBatcherOptions) {
    this.lastFlush = opts.now();
  }

  /** Characters currently buffered but not yet written. */
  get buffered(): number {
    return this.buf.length;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.buf += chunk;
    this.tick();
  }

  /** Flush if a full frame has elapsed since the last flush. */
  tick(): void {
    const t = this.opts.now();
    if (this.buf && t - this.lastFlush >= (this.opts.frameMs ?? FRAME_MS)) {
      this.opts.write(this.buf);
      this.buf = "";
      this.lastFlush = t;
    }
  }

  /** Force all buffered text out (e.g. at turn end). */
  flush(): void {
    if (this.buf) {
      this.opts.write(this.buf);
      this.buf = "";
    }
    this.lastFlush = this.opts.now();
  }
}

const ANSI = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };

/** Context-pressure color band: green <50, yellow <70, red >=70. */
export function contextBand(pct: number): "green" | "yellow" | "red" {
  if (pct < 50) return "green";
  if (pct < 70) return "yellow";
  return "red";
}

export interface StatusEvent {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  contextPercent?: number;
  costUSD: number;
  iteration?: number;
  total?: number;
  lastTool?: string;
}

/**
 * Render the persistent status line from a usage event. In TTY mode the
 * context percentage carries its color band (green <50 / yellow <70 / red
 * >=70); off-TTY the line is plain text with no ANSI codes.
 */
export function renderStatusLine(ev: StatusEvent, opts: { isTTY?: boolean } = {}): string {
  const tty = opts.isTTY ?? false;
  const pct =
    ev.contextPercent != null
      ? tty
        ? `${ANSI[contextBand(ev.contextPercent)]}${ev.contextPercent}%${ANSI.reset}`
        : `${ev.contextPercent}%`
      : "";
  const iter = ev.iteration != null && ev.total != null ? `${ev.iteration}/${ev.total}` : "";
  const parts = [
    `model ${ev.model}`,
    ev.inputTokens != null ? `in ${ev.inputTokens}` : "",
    ev.outputTokens != null ? `out ${ev.outputTokens}` : "",
    pct,
    `$${ev.costUSD.toFixed(4)}`,
    iter,
    ev.lastTool ? `tool ${ev.lastTool}` : "",
  ].filter((x) => x !== "");
  return parts.join(" · ");
}

export interface StallIndicatorOptions {
  /** Idle threshold in ms before a stall is surfaced. */
  silenceMs: number;
  /** Clock for deterministic tests. */
  now: () => number;
  /** Off-TTY suppresses spinner frames entirely. */
  isTTY?: boolean;
}

/**
 * Dependency-free stall spinner + elapsed timer. Call {@link mark} on every
 * flushed frame; once no frame has arrived for `silenceMs`, {@link render}
 * returns a spinner frame + mm:ss elapsed so free-model stalls become visible.
 */
export class StallIndicator {
  private lastActivity: number;

  constructor(private readonly opts: StallIndicatorOptions) {
    this.lastActivity = opts.now();
  }

  /** Record activity (a frame arrived); resets the stall window. */
  mark(): void {
    this.lastActivity = this.opts.now();
  }

  isStalled(): boolean {
    return this.opts.now() - this.lastActivity >= this.opts.silenceMs;
  }

  elapsedMs(): number {
    return this.opts.now() - this.lastActivity;
  }

  /** Spinner frame + mm:ss when stalled and on a TTY; null otherwise. */
  render(): string | null {
    if (!this.opts.isTTY) return null;
    if (!this.isStalled()) return null;
    const ms = this.elapsedMs();
    const mm = String(Math.floor(ms / 60_000)).padStart(2, "0");
    const ss = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const spin = frames[Math.floor(this.opts.now() / 100) % frames.length];
    return `${spin} ${mm}:${ss}`;
  }
}
