export type ConnectionState = "connecting" | "online" | "offline";

export interface ConnectionView {
  label: string;
  tone: "ok" | "err" | "";
  banner: string | null;
}

export const OFFLINE_BANNER: string;
export function connectionView(state: ConnectionState | string): ConnectionView;
