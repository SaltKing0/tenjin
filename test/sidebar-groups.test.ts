import { describe, test, expect } from "bun:test";
import { panelGroups, PANEL_GROUPS, type PanelGroup } from "../src/gateway/console/sidebar-groups.js";

function byLabel(groups: PanelGroup[], label: string | null): PanelGroup {
  const g = groups.find((x) => x.label === label);
  expect(g, `group with label ${JSON.stringify(label)}`).toBeDefined();
  return g!;
}

describe("console sidebar panel grouping (#287)", () => {
  const CURRENT = [
    "chat", "settings", "approvals", "jobs",
    "sessions", "memory", "spend", "audit", "status",
  ];

  test("groups the current panels into Operate / Observe / Settings", () => {
    const groups = panelGroups(CURRENT);
    expect(groups.map((g) => g.label)).toEqual(["Operate", "Observe", null]);
    expect(byLabel(groups, "Operate").names).toEqual(["chat", "approvals", "jobs"]);
    expect(byLabel(groups, "Observe").names).toEqual([
      "sessions", "memory", "spend", "audit", "status",
    ]);
    expect(byLabel(groups, null).names).toEqual(["settings"]);
  });

  test("every live panel lands in exactly one group (nothing dropped)", () => {
    const names = panelGroups(CURRENT).flatMap((g) => g.names);
    expect(names.sort()).toEqual([...CURRENT].sort());
  });

  test("a future panel not in a declared group is appended unlabelled, not dropped", () => {
    const groups = panelGroups([...CURRENT, "widgets"]);
    // Settings keeps its own group; the unknown panel is appended separately.
    expect(byLabel(groups, null).names).toEqual(["settings"]);
    const last = groups[groups.length - 1]!;
    expect(last.label).toBeNull();
    expect(last.names).toEqual(["widgets"]);
  });

  test("a declared-but-absent panel is ignored (e.g. bots before #276 lands)", () => {
    expect(byLabel(panelGroups(CURRENT), "Operate").names).not.toContain("bots");
    // once present, bots slots into Operate
    expect(byLabel(panelGroups([...CURRENT, "bots"]), "Operate").names).toContain("bots");
  });

  test("PANEL_GROUPS declarations are non-empty", () => {
    expect(PANEL_GROUPS.length).toBeGreaterThan(0);
    for (const g of PANEL_GROUPS) {
      expect(g.names.length).toBeGreaterThan(0);
    }
  });
});
