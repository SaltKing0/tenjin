export interface ApprovalRequestLike {
  id: string;
  bot?: string;
  tool: string;
  inputSummary?: string;
  ts?: string;
  status?: string;
}

export function approvalCardTitle(req: ApprovalRequestLike): string;
export function approvalCardSummary(req: ApprovalRequestLike): string;
export function approvalResultLine(
  status: string,
  tool: string,
  when: Date,
): string;
export function approvalCountdown(
  createdMs: number,
  timeoutMs: number,
  now?: number,
): string;
export function approvalIsPending(req: ApprovalRequestLike): boolean;
