export type RunStatus = "ok" | "error" | "timeout" | "never";

export interface RunStatusView {
  label: string;
  tone: "ok" | "err" | "warn" | "dim";
}

export const RUN_STATUS: Record<RunStatus, RunStatusView>;

export function runStatusView(status: string): RunStatusView;
export function stopReasonStatus(stopReason: string): RunStatus;
export function lastRunStatus(job: unknown): RunStatus;
export function historyTones(
  history: Array<{ status?: string }> | null | undefined,
  max?: number,
): string[];
