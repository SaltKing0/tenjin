export interface EmptyState {
  title: string;
  caption?: string;
  cta?: string;
  hash?: string;
}

export const EMPTY_STATES: Record<string, EmptyState>;
export const ROUTES: string[];
export function emptyStateFor(panel: string): EmptyState | null;
