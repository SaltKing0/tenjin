export interface ScopeBot {
  name: string;
  count: number;
}

export function panelScopeKey(panel: string): string;
export function resolvePanelScope(opts: {
  stored?: string;
  bots: ScopeBot[];
}): string;
export function scopeHint(opts: {
  current: string;
  bots: ScopeBot[];
}): { name: string; count: number } | null;
