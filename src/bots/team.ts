import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

/**
 * Team manifest (#141): a shared `team.yaml` in the home so every bot knows the
 * owner, the team, and who else exists and what each teammate does. This gives
 * bots cross-context identity — more than their own SOUL.md — and lets
 * `send_message` / `ask_bot` address others by role (e.g. "the writer") instead
 * of only by name.
 */

export interface TeamBot {
  name: string;
  role: string;
  description?: string;
  model?: string;
}

export interface TeamManifest {
  owner: string;
  team?: string;
  bots: TeamBot[];
}

/** Example/starting shape, also used by `tenjin team init`. */
export const TEAM_TEMPLATE = `# Team manifest — who we are and who does what.
# Share this file across machines so every bot knows the team.
owner: SaltKing0
team: my-team

bots:
  - name: researcher
    role: researcher
    description: investigates topics and gathers sources
  - name: writer
    role: writer
    description: drafts and polishes prose
    model: anthropic:claude-sonnet-4-5
`;

export function teamPath(home: string): string {
  return join(home, "team.yaml");
}

/**
 * Load and validate the team manifest. Returns null when the file is missing or
 * unparseable/incomplete (needs an owner and at least one bot entry) — a
 * missing team is normal and simply disables team features.
 */
export function loadTeam(home: string): TeamManifest | null {
  const path = teamPath(home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const owner = typeof obj.owner === "string" ? obj.owner.trim() : "";
  const team = typeof obj.team === "string" && obj.team.trim() ? obj.team.trim() : undefined;
  const rawBots = Array.isArray(obj.bots) ? obj.bots : [];

  const bots: TeamBot[] = [];
  for (const raw of rawBots) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Record<string, unknown>;
    if (typeof b.name !== "string" || typeof b.role !== "string") continue;
    const name = b.name.trim();
    const role = b.role.trim();
    if (!name || !role) continue;
    bots.push({
      name,
      role,
      description: typeof b.description === "string" && b.description.trim() ? b.description.trim() : undefined,
      model: typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined,
    });
  }

  if (!owner || bots.length === 0) return null;
  return { owner, team, bots };
}

/**
 * Resolve a send_message/ask_bot target to a concrete bot name: an exact bot
 * name passes through; otherwise a case-insensitive role lookup wins. Returns
 * null when neither matches.
 */
export function resolveTeamTarget(manifest: TeamManifest, target: string): string | null {
  const t = target.trim();
  if (!t) return null;
  if (manifest.bots.some((b) => b.name === t)) return t;
  const byRole = manifest.bots.find((b) => b.role.toLowerCase() === t.toLowerCase());
  return byRole ? byRole.name : null;
}

/**
 * A compact, low-token section injected into a bot's system prompt so it knows
 * the owner/team and who else exists and what they handle — and that teammates
 * can be reached by role.
 */
export function buildTeamSection(manifest: TeamManifest): string {
  const lines: string[] = [
    manifest.team ? `Team "${manifest.team}"` : "Team",
    `Owner: ${manifest.owner}`,
    "You belong to this team of bots. When a task belongs to a teammate, reach them with",
    "ask_bot or send_message by name or role (e.g. \"the writer\").",
  ];
  for (const b of manifest.bots) {
    lines.push(`- ${b.role}: ${b.name}${b.description ? ` — ${b.description}` : ""}${b.model ? ` · ${b.model}` : ""}`);
  }
  return lines.join("\n");
}
