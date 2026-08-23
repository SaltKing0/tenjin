import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createIssueBotTool } from "../src/bots/issues";
import { createBot } from "../src/bots/profile";
import { dispatch } from "../src/tools/registry";
import { AuditLog, auditPath } from "../src/audit/log";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig, ProviderName } from "../src/config/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-issue-"));
  createBot(home, "researcher", { soul: "You are researcher. Be terse." });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const globalConfig = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 1024,
  budgetUSD: 5,
  approval: {},
  ...over,
});

/** A provider that replays a fixed script of chat responses in order. */
function scriptProvider(script: ChatResponse[]): Provider & { requests: ChatRequest[] } {
  let i = 0;
  const requests: ChatRequest[] = [];
  return {
    name: "script",
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      const next = script[i++];
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
}

/** Build a throwaway git repo with one commit on `main`. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tj-issue-repo-"));
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init", "-b", "main", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
  return dir;
}

const makeTool = (opts: {
  provider?: Provider;
  audit?: (kind: string, detail: string, correlationId?: string) => void;
  cwd?: string;
} = {}) =>
  createIssueBotTool({
    home,
    fromBot: "writer",
    cwd: opts.cwd ?? home,
    getProvider: (_n: ProviderName) => opts.provider ?? scriptProvider([]),
    globalConfig: globalConfig(),
    audit: opts.audit,
  });

const run = (tool: ReturnType<typeof makeTool>, repo: string, args: any) =>
  dispatch([tool], "issue_bot", args, { cwd: repo });

describe("issue_bot (#450)", () => {
  test("creates a worktree from main, runs the worker scoped to it, and reports a bounded contract", async () => {
    const repo = makeGitRepo();
    // worker (end_turn text) then reviewer (APPROVED)
    const provider = scriptProvider([
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "DONE: fixed the bug" }],
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "VERDICT: APPROVED looks good" }],
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
    const tool = makeTool({ provider });
    const r = await run(tool, repo, {
      repo,
      branch: "Fix-Bug-123", // uppercase exercises lowercase normalization
      bot: "researcher",
      task: "fix the bug",
    });

    expect(r.ok).toBe(true);
    expect(r.output).toContain("[delegation contract]");
    expect(r.output).toContain("status: success");

    const wtDir = join(repo, ".tenjin", "issues", "fix-bug-123");
    // contract reports the worktree, branch and diff summary
    expect(r.output).toContain(`worktree: ${wtDir}`);
    expect(r.output).toContain("branch: fix-bug-123");
    expect(r.output).toContain("diff_summary: none");

    // worktree physically exists and is a git worktree
    expect(existsSync(join(wtDir, "README.md"))).toBe(true);
    const wtBranch = spawnSync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(wtBranch).toBe("fix-bug-123");

    // created from main: worktree HEAD equals the repo's main commit
    const wtHead = spawnSync("git", ["-C", wtDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const mainHead = spawnSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).stdout.trim();
    expect(wtHead).toBe(mainHead);

    // worker ran scoped to the worktree: its system prompt carries the worktree cwd
    const workerReq = provider.requests[0];
    expect(workerReq?.system).toContain(wtDir);
    expect(workerReq?.system).toContain("You are researcher. Be terse.");

    // reviewer ran and the gate approved
    expect(r.output).toContain("review: approved");
    expect(r.output).toContain("DONE: fixed the bug");

    rmSync(repo, { recursive: true, force: true });
  });

  test("records a correlated audit chain (issue_started -> delegation -> issue_completed)", async () => {
    const repo = makeGitRepo();
    const log = new AuditLog(auditPath(home));
    const provider = scriptProvider([
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "fixed" }],
        usage: { inputTokens: 10, outputTokens: 10 },
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "VERDICT: APPROVED" }],
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
    const tool = makeTool({
      provider,
      audit: (kind, detail, correlationId) =>
        log.append(kind as never, "user", detail, undefined, correlationId),
    });
    const r = await run(tool, repo, { repo, branch: "audit-chain", bot: "researcher", task: "t" });
    expect(r.ok).toBe(true);

    const started = log.query({ kind: "issue_started" });
    expect(started).toHaveLength(1);
    const corr = started[0]?.correlationId;
    expect(corr).toBeTruthy();

    const chain = log.query({ correlationId: corr });
    const kinds = chain.map((e) => e.kind);
    expect(kinds).toContain("issue_started");
    expect(kinds).toContain("delegation");
    expect(kinds).toContain("issue_completed");
    expect(chain.every((e) => e.correlationId === corr)).toBe(true);

    // ordering: started before delegation before completed
    const idx = (k: string) => chain.findIndex((e) => e.kind === k);
    expect(idx("issue_started")).toBeLessThan(idx("delegation"));
    expect(idx("delegation")).toBeLessThan(idx("issue_completed"));

    rmSync(repo, { recursive: true, force: true });
  });

  test("fails cleanly on a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "tj-plain-"));
    const tool = makeTool();
    const r = await run(tool, plain, { repo: plain, branch: "x", bot: "researcher", task: "x" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not a git repository");
    rmSync(plain, { recursive: true, force: true });
  });
});
