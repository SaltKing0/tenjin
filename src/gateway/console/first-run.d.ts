export interface SetupStepView {
  n: number;
  field: string;
  title: string;
  hash: string;
  done: boolean;
}
export interface FirstRunView {
  complete: boolean;
  progress: number;
  done: number;
  steps: SetupStepView[];
}
export const STEPS: Array<{ field: string; title: string; hash: string }>;
export function isSetupComplete(state?: Record<string, unknown>): boolean;
export function shouldShowFirstRun(state?: Record<string, unknown>, skipped?: boolean): boolean;
export function firstRunView(state?: Record<string, unknown>): FirstRunView;
