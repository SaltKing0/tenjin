export type PrimaryRoute = "chat" | "activity" | "approvals" | "routines" | "setup";
export type ActivityView = "overview" | "sessions" | "spend" | "audit" | "memory" | "status";
export type SetupView = "bots" | "provider" | "access";

export interface PrimaryNavItem {
  name: PrimaryRoute;
  label: string;
  hash: string;
}

export interface ConsoleRoute {
  name: PrimaryRoute;
  subroute: ActivityView | SetupView | null;
  canonicalHash: string;
}

export const PRIMARY_NAV: PrimaryNavItem[];
export const ACTIVITY_VIEWS: ActivityView[];
export const SETUP_VIEWS: SetupView[];
export function resolveConsoleRoute(hash?: string): ConsoleRoute;
