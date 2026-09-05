/* Tenjin multi-agent dashboard — a registry of detached (background) agents.
 *
 * The AgentRuntime owns each agent's lifecycle as an explicit state machine
 * (idle → running → done | error | cancelled, plus awaiting_approval for the
 * future interactive approval channel) and keeps a live record per agent for
 * the dashboard view. The actual turn is performed by an INJECTED `run`
 * function, so the runtime itself is pure and headlessly testable: the TUI
 * wires `run` to runHeadless, tests inject a scripted runner.
 *
 * Ambient/notification hook: `notify` fires on terminal states (done/error/
 * cancelled) so the harness can ping an out-of-band channel (OS notification,
 * mobile webhook) without blocking the TUI. The TUI passes a no-op by default;
 * this is the documented extension point.
 */

export type AgentStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "done"
  | "error"
  | "cancelled";

export interface AgentRecord {
  id: string;
  label: string;
  status: AgentStatus;
  model: string;
  costUSD: number;
  startedAt: number;
  lastEvent: string;
}

/** Pure view mapping: status → { badge, tone } for the dashboard rows. */
export function agentStatusView(status: AgentStatus): { badge: string; tone: string } {
  switch (status) {
    case "running":
      return { badge: "▸", tone: "ok" };
    case "awaiting_approval":
      return { badge: "⏳", tone: "warn" };
    case "done":
      return { badge: "✓", tone: "dim" };
    case "error":
      return { badge: "✗", tone: "err" };
    case "cancelled":
      return { badge: "⊘", tone: "dim" };
    default:
      return { badge: "·", tone: "" }; // idle
  }
}

/** Live side-channels the runner can use to update the agent's lastEvent. */
export interface AgentRunHooks {
  onTextDelta: (delta: string) => void;
  onToolActivity: (name: string) => void;
  onEvent: (e: unknown) => void;
  approve: (tool: string, group: "read" | "write", input: unknown) => Promise<boolean>;
}

export interface AgentRunResult {
  costUSD: number;
}

export interface AgentRuntimeOptions {
  /** Injected runner — performs the actual agent turn. The runtime only
   *  manages lifecycle state around it. Receives the agent id (so the caller
   *  can resolve the backing SessionLog), the label (prompt), the live hooks,
   *  and an AbortSignal for cancellation. */
  run: (
    id: string,
    label: string,
    hooks: AgentRunHooks,
    signal: AbortSignal,
  ) => Promise<AgentRunResult>;
  /** Called on every status/lastEvent change (the TUI re-renders here). */
  onStatusChange?: (rec: AgentRecord) => void;
  /** Ambient notification hook — fired once on each terminal state. */
  notify?: (rec: AgentRecord) => void;
  /** Default approve policy for background agents (auto-allow reads, deny
   *  writes — the safe default; interactive approval is a follow-up). */
  approve?: (tool: string, group: "read" | "write", input: unknown) => Promise<boolean>;
}

export class AgentRuntime {
  private agents = new Map<string, AgentRecord>();
  private controllers = new Map<string, AbortController>();
  private seq = 0;

  constructor(private readonly opts: AgentRuntimeOptions) {}

  list(): AgentRecord[] {
    return [...this.agents.values()];
  }
  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }
  count(): number {
    return this.agents.size;
  }

  /** Spawn a detached background agent. Returns its stable id immediately.
   *  When `id` is omitted a runtime-generated id is used. */
  spawn(label: string, id?: string, model = "default"): string {
    const agentId = id ?? `ag-${this.seq.toString(36)}-${Date.now().toString(36)}`;
    this.seq += 1;
    const rec: AgentRecord = {
      id: agentId,
      label,
      status: "running",
      model,
      costUSD: 0,
      startedAt: Date.now(),
      lastEvent: "spawned",
    };
    this.agents.set(agentId, rec);
    const ctrl = new AbortController();
    this.controllers.set(agentId, ctrl);
    this.emit(rec);
    void this.run(agentId, label, ctrl);
    return agentId;
  }

  /** Request cancellation of a running agent (best-effort; the runner must
   *  honour the AbortSignal). */
  abort(id: string): void {
    this.controllers.get(id)?.abort();
  }

  private async run(id: string, label: string, ctrl: AbortController): Promise<void> {
    const approve = this.opts.approve ?? (async (_t, g) => g === "read");
    const hooks: AgentRunHooks = {
      onTextDelta: (d) => this.touch(id, `…${d.slice(-24)}`),
      onToolActivity: (n) => this.touch(id, `◆ ${n}`),
      onEvent: () => {},
      approve,
    };
    try {
      const result = await this.opts.run(id, label, hooks, ctrl.signal);
      const rec = this.agents.get(id);
      if (rec) rec.costUSD = result.costUSD;
      this.transition(id, "done", `done · ${result.costUSD.toFixed(4)} USD`);
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e as Error)?.name === "AbortError";
      this.transition(
        id,
        aborted ? "cancelled" : "error",
        aborted ? "cancelled" : `error: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  private touch(id: string, lastEvent: string): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    rec.lastEvent = lastEvent;
    this.emit(rec);
  }

  private transition(id: string, status: AgentStatus, lastEvent: string): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    rec.status = status;
    rec.lastEvent = lastEvent;
    this.controllers.delete(id);
    this.emit(rec);
    this.opts.notify?.(rec);
  }

  private emit(rec: AgentRecord): void {
    this.opts.onStatusChange?.(rec);
  }
}
