export interface PanelGroup {
  label: string | null;
  names: string[];
}

export const PANEL_GROUPS: PanelGroup[];
export function panelGroups(panelNames: string[]): PanelGroup[];
