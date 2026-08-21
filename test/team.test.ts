import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTeam,
  buildTeamSection,
  resolveTeamTarget,
  teamPath,
} from "../src/bots/team";
import { buildSystemPrompt } from "../src/agent/prompt";
import { createBot } from "../src/bots/profile";
import { createSendMessageTool } from "../src/bots/tools";
import { createAskBotTool } from "../src/bots/delegate";
import { unreadMessages } from "../src/bots/inbox";
import { dispatch } from "../src/tools/registry";
import type { HarnessConfig, ProviderName } from "../src/config/types";
import type { Provider, ChatRequest, ChatResponse } from "../src/provider/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-team-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const TEAM = `owner: SaltKing0
team: test-team
bots:
  - name: writer
    role: draftsman
    description: writes prose
  - name: researcher
    role: investigator
    description: finds facts
`;

function writeTeam(): void {
  writeFileSync(join(home, "team.yaml"), TEAM);
}

const globalConfig = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 1024,
  budgetUSD: 5,
  approval: {},
  ...over,
});

describe("team manifest loading (#141)", () => {
  test("loadTeam returns null when team.yaml is missing", () => {
    expect(loadTeam(home)).toBeNull();
    expect(teamPath(home)).toBe(join(home, "team.yaml"));
  });

  test("loadTeam parses a valid team.yaml", () => {
    writeTeam();
    const t = loadTeam(home);
    expect(t?.owner).toBe("SaltKing0");
    expect(t?.team).toBe("test-team");
    expect(t?.bots).toHaveLength(2);
    expect(t?.bots[0]).toEqual({
      name: "writer",
      role: "draftsman",
      description: "writes prose",
      model: undefined,
    });
  });

  test("loadTeam returns null for an invalid manifest", () => {
    writeFileSync(join(home, "team.yaml"), "owner: x\nbots: not-a-list\n");
    expect(loadTeam(home)).toBeNull();
  });
});

describe("buildTeamSection (#141)", () => {
  test("includes owner, team and each bot's role/description", () => {
    writeTeam();
    const section = buildTeamSection(loadTeam(home)!);
    expect(section).toContain('Team "test-team"');
    expect(section).toContain("Owner: SaltKing0");
    expect(section).toContain("- draftsman: writer — writes prose");
    expect(section).toContain("- investigator: researcher — finds facts");
  });
});

describe("resolveTeamTarget (#141)", () => {
  test("an exact bot name passes through", () => {
    writeTeam();
    const t = loadTeam(home)!;
    expect(resolveTeamTarget(t, "writer")).toBe("writer");
  });

  test("a role resolves to the bot (case-insensitive)", () => {
    writeTeam();
    const t = loadTeam(home)!;
    expect(resolveTeamTarget(t, "draftsman")).toBe("writer");
    expect(resolveTeamTarget(t, "DRAFTSMAN")).toBe("writer");
  });

  test("an unknown target returns null", () => {
    writeTeam();
    const t = loadTeam(home)!;
    expect(resolveTeamTarget(t, "nobody")).toBeNull();
    expect(resolveTeamTarget(t, "")).toBeNull();
  });
});

describe("prompt injection (#141)", () => {
  test("buildSystemPrompt includes a team section when provided", () => {
    const system = buildSystemPrompt({
      soulText: "s",
      agentsMd: null,
      cwd: "/c",
      teamSection: 'Team "test-team"\nOwner: SaltKing0',
    });
    expect(system).toContain("# Team");
    expect(system).toContain('Team "test-team"');
  });

  test("no team section when absent", () => {
    const system = buildSystemPrompt({ soulText: "s", agentsMd: null, cwd: "/c" });
    expect(system).not.toContain("# Team");
  });
});

describe("role addressing (#141)", () => {
  test("send_message to a role lands in the right bot's inbox", async () => {
    createBot(home, "writer");
    createBot(home, "researcher");
    writeTeam();
    const tool = createSendMessageTool({ home, fromBot: "sender" });
    const r = await dispatch(
      [tool],
      "send_message",
      { to: "draftsman", subject: "s", body: "please write" },
      { cwd: home },
    );
    expect(r.ok).toBe(true);
    // role "draftsman" → bot "writer"
    expect(r.output).toContain("Delivered to writer");
    const msgs = unreadMessages(join(home, "bots", "writer", "inbox"));
    expect(msgs.some((m) => m.from === "sender" && m.to === "writer")).toBe(true);
  });

  test("ask_bot to a role runs the writer's soul, not the researcher's", async () => {
    createBot(home, "writer", { soul: "I am the WRITER bot." });
    createBot(home, "researcher", { soul: "I am the RESEARCHER bot." });
    writeTeam();

    let systemPrompt = "";
    const provider: Provider & { requests: ChatRequest[] } = {
      name: "mock",
      requests: [],
      async chat(req: ChatRequest): Promise<ChatResponse> {
        systemPrompt = String(req.system ?? "");
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: "ok" }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const tool = createAskBotTool({
      home,
      fromBot: "boss",
      cwd: home,
      getProvider: (_n: ProviderName) => provider,
      globalConfig: globalConfig(),
    });

    const r = await dispatch(
      [tool],
      "ask_bot",
      { bot: "draftsman", message: "get writing" },
      { cwd: home },
    );
    expect(r.ok).toBe(true);
    // the delegated prompt used the writer's soul + the team section
    expect(systemPrompt).toContain("WRITER bot");
    expect(systemPrompt).not.toContain("RESEARCHER bot");
    expect(systemPrompt).toContain("# Team");
  });

  test("tenjin team init writes a starter team.yaml", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "team", "init"],
      { cwd: join(import.meta.dir, ".."), env: { ...process.env, TENJIN_HOME: home } },
    );
    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(home, "team.yaml"))).toBe(true);
    const t = loadTeam(home);
    expect(t?.owner).toBe("SaltKing0");
    expect(t?.bots.length).toBeGreaterThan(0);

    // a second run is a no-op
    const again = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "team", "init"],
      { cwd: join(import.meta.dir, ".."), env: { ...process.env, TENJIN_HOME: home } },
    );
    expect(again.exitCode).toBe(0);
    expect(readFileSync(join(home, "team.yaml"), "utf8")).toContain("owner: SaltKing0");
  });
});
