export declare const APPROVAL_STATUS_TOKENS: {
  pending: string;
  deny: string;
  "allow-once": string;
  "allow-always": string;
};

export interface ApprovalAria {
  role: string;
  "aria-modal": string;
  "aria-live": string;
  "aria-labelledby": string;
  "aria-describedby": string;
  labelId: string;
  descId: string;
  label: string;
  controls: Array<{ id: string; kind: "button"; label: string }>;
}

export declare function approvalAria(state?: {
  id?: string;
  tool?: string;
}): ApprovalAria;

export interface CollapseDecision {
  collapsed: boolean;
  lineCount: number;
  pillText: string | null;
  full: string;
}

export declare function collapseOutput(
  output: string,
  opts?: { threshold?: number },
): CollapseDecision;

export declare function expandCollapsed(state?: { full?: string } | null): string;

export interface Window {
  start: number;
  end: number;
}

export declare function visibleWindow(
  index: number,
  total: number,
  opts?: { viewport?: number; overscan?: number },
): Window;
