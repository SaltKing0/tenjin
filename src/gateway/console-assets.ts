// Static imports with Bun's `file` loader are embedded into a compiled
// executable. The HTTP server can therefore serve the complete console when
// the installed binary is running in an otherwise empty directory.
import indexPath from "./console/index.html" with { type: "file" };
import bundlePath from "./console/app.bundle.js" with { type: "file" };
import markdownPath from "./console/markdown.js" with { type: "file" };
import emptyStatePath from "./console/empty-state.js" with { type: "file" };
import setupChecklistPath from "./console/setup-checklist.js" with { type: "file" };
import tablesPath from "./console/tables.js" with { type: "file" };
import topbarStatePath from "./console/topbar-state.js" with { type: "file" };
import firstRunPath from "./console/first-run.js" with { type: "file" };
import memoryScopePath from "./console/memory-scope.js" with { type: "file" };
import sidebarBotsPath from "./console/sidebar-bots.js" with { type: "file" };
import scopeDefaultsPath from "./console/scope-defaults.js" with { type: "file" };
import sidebarGroupsPath from "./console/sidebar-groups.js" with { type: "file" };
import jobStatusPath from "./console/job-status.js" with { type: "file" };
import approvalBadgePath from "./console/approval-badge.js" with { type: "file" };
import approvalCardPath from "./console/approval-card.js" with { type: "file" };
import chatHistoryPath from "./console/chat-history.js" with { type: "file" };
import themePath from "./console/theme.js" with { type: "file" };
import logoPath from "./console/tenjinlogo.png" with { type: "file" };
import lightLogoPath from "./console/tenjinlogo-light.png" with { type: "file" };
import stylePath from "./console/style.css" with { type: "file" };

export interface ConsoleAsset {
  body: Blob;
  type: string;
}

function embedded(importedPath: unknown, type: string): ConsoleAsset {
  // TypeScript resolves the source modules' development declarations even
  // though Bun's explicit `file` loader turns each import into a path string.
  const path = importedPath as string;
  return { body: Bun.file(path), type };
}

/** Every public console path the gateway serves, backed by embedded files. */
export const EMBEDDED_CONSOLE_ASSETS: Readonly<Record<string, ConsoleAsset>> = {
  "/": embedded(indexPath, "text/html; charset=utf-8"),
  "/console": embedded(indexPath, "text/html; charset=utf-8"),
  "/console/app.bundle.js": embedded(bundlePath, "application/javascript; charset=utf-8"),
  "/console/markdown.js": embedded(markdownPath, "application/javascript; charset=utf-8"),
  "/console/empty-state.js": embedded(emptyStatePath, "application/javascript; charset=utf-8"),
  "/console/setup-checklist.js": embedded(setupChecklistPath, "application/javascript; charset=utf-8"),
  "/console/tables.js": embedded(tablesPath, "application/javascript; charset=utf-8"),
  "/console/topbar-state.js": embedded(topbarStatePath, "application/javascript; charset=utf-8"),
  "/console/first-run.js": embedded(firstRunPath, "application/javascript; charset=utf-8"),
  "/console/memory-scope.js": embedded(memoryScopePath, "application/javascript; charset=utf-8"),
  "/console/sidebar-bots.js": embedded(sidebarBotsPath, "application/javascript; charset=utf-8"),
  "/console/scope-defaults.js": embedded(scopeDefaultsPath, "application/javascript; charset=utf-8"),
  "/console/sidebar-groups.js": embedded(sidebarGroupsPath, "application/javascript; charset=utf-8"),
  "/console/job-status.js": embedded(jobStatusPath, "application/javascript; charset=utf-8"),
  "/console/approval-badge.js": embedded(approvalBadgePath, "application/javascript; charset=utf-8"),
  "/console/approval-card.js": embedded(approvalCardPath, "application/javascript; charset=utf-8"),
  "/console/chat-history.js": embedded(chatHistoryPath, "application/javascript; charset=utf-8"),
  "/console/theme.js": embedded(themePath, "application/javascript; charset=utf-8"),
  "/console/tenjinlogo.png": embedded(logoPath, "image/png"),
  "/console/tenjinlogo-light.png": embedded(lightLogoPath, "image/png"),
  "/console/style.css": embedded(stylePath, "text/css; charset=utf-8"),
};
