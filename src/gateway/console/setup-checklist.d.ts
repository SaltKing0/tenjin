export interface SetupChecklistItem {
  key: string;
  label: string;
  hash?: string;
  optional?: boolean;
  ok: boolean;
}

export const SETUP_ITEMS: SetupChecklistItem[];
export function setupChecklist(state?: Record<string, unknown>): SetupChecklistItem[];
