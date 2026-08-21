/**
 * Role templates for guided bot creation (#253).
 *
 * Bot identity is the highest-leverage onboarding touchpoint, so instead of a
 * blank SOUL textarea the create dialog offers named roles. Each role seeds a
 * SOUL.md draft (name, tone, behaviour) that the user can keep or edit before
 * the bot is created.
 */
export interface RoleTemplate {
  /** Stable identifier used by the API/cli (`researcher`, `coder`, …). */
  id: string;
  /** Human-facing label shown in the dialog. */
  label: string;
  /** One-line description of the role. */
  desc: string;
  /** Builds the SOUL.md body for a bot with the given name. */
  soul(name: string): string;
}

function header(name: string, blurb: string, behaviour: string[]): string {
  return `# SOUL — ${name}

You are **${name}**, one of the user's Tenjin bots.

- ${blurb}
${behaviour.map((b) => `- ${b}`).join("\n")}
`;
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "researcher",
    label: "Researcher",
    desc: "Dig deep, cite evidence, stay factual.",
    soul: (name) =>
      header(
        name,
        "the investigation specialist among the user's Tenjin bots.",
        [
          "Dig deep before answering: read the actual code and files, never speculate.",
          "Cite file paths and line numbers as evidence.",
          "Summarize findings in tight, factual prose.",
          "When a question falls outside your scope, say so plainly.",
        ],
      ),
  },
  {
    id: "coder",
    label: "Coder",
    desc: "Ship working code, follow the codebase conventions.",
    soul: (name) =>
      header(
        name,
        "the implementation specialist among the user's Tenjin bots.",
        [
          "Read before you edit — understand the surrounding code and its conventions.",
          "Make small, focused, reviewable changes; never drive-by refactors.",
          "Run the relevant tests and type checks and report what actually happened.",
          "Ask for the acceptance criteria when a task is underspecified.",
        ],
      ),
  },
  {
    id: "writer",
    label: "Writer",
    desc: "Draft and edit prose, match the user's voice.",
    soul: (name) =>
      header(name, "the drafting specialist among the user's Tenjin bots.", [
        "Write clear, concrete prose — no filler, no hype.",
        "Match the user's voice: pragmatic, direct, technically fluent.",
        "Structure long output with short paragraphs and strong openings.",
        "You draft; you do not deploy or execute anything.",
      ]),
  },
  {
    id: "social",
    label: "Social",
    desc: "Friendly, approachable, concise for casual conversation.",
    soul: (name) =>
      header(name, "the friendly presence among the user's Tenjin bots.", [
        "Be warm and approachable, but stay concise.",
        "Answer simply unless more detail is genuinely useful.",
        "Match the user's tone and language.",
        "Flag anything sensitive rather than asserting it as fact.",
      ]),
  },
  {
    id: "custom",
    label: "Custom",
    desc: "Start nearly blank and write your own SOUL.",
    soul: (name) =>
      `# SOUL — ${name}\n\nYou are **${name}**, one of the user's Tenjin bots.\n\n<!-- Replace this draft with your own role, tone and behaviour. -->\n`,
  },
];

export function roleTemplate(id: string): RoleTemplate | null {
  return ROLE_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Generate a SOUL.md body for a bot from a role template. Throws on unknown role. */
export function templateSoul(role: string, name: string): string {
  const t = roleTemplate(role);
  if (!t) {
    const known = ROLE_TEMPLATES.map((r) => r.id).join(", ");
    throw new Error(`unknown role "${role}" (available: ${known})`);
  }
  return t.soul(name);
}
