export interface SidebarBotItem {
  name: string;
  model: string;
  active: boolean;
}

export function botSectionItems(
  bots: Array<{ name?: string; model?: string }> | null | undefined,
  currentBot: string,
): SidebarBotItem[];
