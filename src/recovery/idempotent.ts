// B3-3 idempotent job reruns (#372): a stable ledger keyed by a stable job /
// invocation id. A rerun after a crash must not double-execute side effects or
// double-spend budget, so once an invocation's side effects are recorded as
// completed, a rerun of the SAME key returns the recorded result instead of
// running again. Fresh scheduled runs use a fresh invocation key and therefore
// still run normally.
export class IdempotencyLedger {
  private readonly completed = new Map<string, unknown>();

  constructor(private readonly audit?: (detail: string) => void) {}

  /** Whether an invocation key has already completed its side effects. */
  isCompleted(key: string): boolean {
    return this.completed.has(key);
  }

  /** Record an invocation's side effects as durably done (idempotent). */
  complete(key: string, value?: unknown): void {
    this.completed.set(key, value);
    this.audit?.(`reason=idempotent_complete key=${key}`);
  }

  /** Forget a key (e.g. a job was removed / reconfigured). */
  clear(key: string): void {
    this.completed.delete(key);
    this.audit?.(`reason=idempotent_clear key=${key}`);
  }

  /**
   * Run `fn` for `key` exactly once. If the key already completed, return the
   * recorded value without invoking `fn` (no duplicate side effect, no
   * double-spend). Audit records the decision with its reason class.
   */
  async runOnce<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; ran: boolean }> {
    if (this.isCompleted(key)) {
      this.audit?.(`reason=idempotent_skip key=${key}`);
      return { value: this.completed.get(key) as T, ran: false };
    }
    const value = await fn();
    this.complete(key, value);
    return { value, ran: true };
  }
}
