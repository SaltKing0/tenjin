/* Tenjin multi-agent dashboard — a registry of detached (background) agents.
 *
 * The AgentRuntime owns each agent's lifecycle as an explicit state machine
 * (idle → running → done | error | cancelled, plus awaiting_approval for the
 * interactive approval channel) and keeps a live record per agent for the
 * dashboard view. The actual turn is performed by an INJECTED `run` function,
 * so the runtime itself is pure and headlessly testable: the TUI wires `run`
 * to runHeadless, tests inject a scripted runner.
 *
 * Interactive approvals: when a background agent requests a WRITE approval,
 * the runtime does not auto-deny — it transitions the agent to
 * `awaiting_approval`, registers a PendingApproval, and blocks until the
 * caller answers via `answerApproval` (reads auto-allow). `onPendingChange`
 * lets the UI re-render; `notify` fires on terminal states AND on
 * awaiting_approval (the ambient ping that an agent needs you).
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

/** A background agent blocked on a write approval, awaiting the user. */
export interface PendingApproval {
  id: string;
  agentId: string;
  tool: string;
  group: "read" | "write";
  summary: string;
  resolve: (allow: boolean) => void;
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
  /** Ambient notification hook — fired on terminal states and on
   *  awaiting_approval (agent needs you). */
  notify?: (rec: AgentRecord) => void;
  /** Called whenever the pending-approval list changes (the TUI re-renders
   *  so the user can see and answer background approvals). */
  onPendingChange?: (pending: PendingApproval[]) => void;
  /** Override the whole approval policy. When absent: reads auto-allow,
   *  writes become interactive PendingApprovals answered via answerApproval. */
  approve?: (tool: string, group: "read" | "write", input: unknown) => Promise<boolean>;
}

export class AgentRuntime {
  private agents = new Map<string, AgentRecord>();
  private controllers = new Map<string, AbortController>();
  private pending: PendingApproval[] = [];
  private seq = 0;
  private apSeq = 0;

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
  pendingApprovals(): PendingApproval[] {
    return this.pending;
  }
  pendingCount(): number {
    return this.pending.length;
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

  /** Request cancellation of a running agent. Any pending approval for it is
   *  resolved as denied; the runner must honour the AbortSignal. */
  abort(id: string): void {
    let cleared = false;
    for (const p of this.pending) {
      if (p.agentId === id) {
        this.pending = this.pending.filter((x) => x !== p);
        p.resolve(false);
        cleared = true;
      }
    }
    if (cleared) this.opts.onPendingChange?.(this.pending);
    this.controllers.get(id)?.abort();
  }

  /** Answer a pending background approval (by pending id or agent id).
   *  Returns true if an approval was resolved. */
  answerApproval(ref: string, allow: boolean): boolean {
    const p = this.pending.find((x) => x.id === ref || x.agentId === ref);
    if (!p) return false;
    this.pending = this.pending.filter((x) => x !== p);
    p.resolve(allow);
    const rec = this.agents.get(p.agentId);
    if (rec && rec.status === "awaiting_approval") {
      rec.status = "running";
      rec.lastEvent = allow ? `✓ ${p.tool}` : `denied ${p.tool}`;
      this.emit(rec);
    }
    this.opts.onPendingChange?.(this.pending);
    return true;
  }

  private async run(id: string, label: string, ctrl: AbortController): Promise<void> {
    const approve =
      this.opts.approve ??
      (async (tool: string, group: "read" | "write", input: unknown) => {
        if (group === "read") return true; // reads auto-allow
        return this.awaitApproval(id, tool, group, input);
      });
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

  /** Block a write approval: transition to awaiting_approval, register a
   *  PendingApproval, ping, and wait for answerApproval. */
  private awaitApproval(
    agentId: string,
    tool: string,
    group: "read" | "write",
    _input: unknown,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const p: PendingApproval = {
        id: `ap-${this.apSeq++}`,
        agentId,
        tool,
        group,
        summary: `${tool} (${group}) — approve?`,
        resolve,
      };
      this.pending.push(p);
      const rec = this.agents.get(agentId);
      if (rec) {
        rec.status = "awaiting_approval";
        rec.lastEvent = `⏳ ${tool}`;
        this.emit(rec);
        this.opts.notify?.(rec);
      }
      this.opts.onPendingChange?.(this.pending);
    });
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
