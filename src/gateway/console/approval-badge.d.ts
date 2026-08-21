export function approvalBadgeText(count: number): string;
export function approvalBadgeClass(count: number): string;
export function browserTitle(count: number): string;
export function approvalLine(req: {
  id?: string;
  bot?: string;
  tool: string;
  inputSummary?: string;
}): string;
export function approvalAge(
  ts: string | number,
  now?: number,
): string;
