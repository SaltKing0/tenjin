import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

const WORKFLOW_PATH = join(import.meta.dir, "..", ".github", "workflows", "ci.yml");

type WorkflowStep = { uses?: string; run?: string; name?: string; with?: Record<string, unknown> };
type WorkflowJob = {
  "runs-on"?: string;
  "continue-on-error"?: boolean;
  steps?: WorkflowStep[];
};
type Workflow = {
  name?: string;
  on?: {
    pull_request?: { branches?: string[] | string } | null;
    push?: { branches?: string[] | string } | null;
  };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
};

function loadWorkflow(): Workflow {
  expect(existsSync(WORKFLOW_PATH)).toBe(true);
  const raw = readFileSync(WORKFLOW_PATH, "utf8");
  expect(raw.trim().length).toBeGreaterThan(0);
  return YAML.parse(raw) as Workflow;
}

function allSteps(wf: Workflow): WorkflowStep[] {
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function runCommands(wf: Workflow): string[] {
  return allSteps(wf)
    .map((s) => s.run)
    .filter((r): r is string => typeof r === "string");
}

describe("CI workflow", () => {
  test("lives at .github/workflows/ci.yml and is valid YAML", () => {
    const wf = loadWorkflow();
    expect(wf).toBeDefined();
    expect(typeof wf).toBe("object");
  });

  test("runs on pull requests targeting main", () => {
    const wf = loadWorkflow();
    const pr = wf.on?.pull_request;
    expect(pr).toBeDefined();
    const branches = pr && typeof pr === "object" ? pr.branches : undefined;
    const list = Array.isArray(branches) ? branches : branches ? [branches] : [];
    expect(list).toContain("main");
  });

  test("uses a concurrency group with cancel-in-progress", () => {
    const wf = loadWorkflow();
    expect(wf.concurrency).toBeDefined();
    expect(typeof wf.concurrency?.group).toBe("string");
    expect(wf.concurrency?.group?.length).toBeGreaterThan(0);
    expect(wf.concurrency?.["cancel-in-progress"]).toBe(true);
  });

  test("installs bun, typechecks, and runs tests", () => {
    const wf = loadWorkflow();
    const jobs = Object.values(wf.jobs ?? {});
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job["runs-on"]).toBe("ubuntu-latest");
    }

    const uses = allSteps(wf)
      .map((s) => s.uses)
      .filter((u): u is string => typeof u === "string");
    expect(uses.some((u) => u.startsWith("actions/checkout@"))).toBe(true);
    expect(uses.some((u) => u.startsWith("oven-sh/setup-bun@"))).toBe(true);

    const runs = runCommands(wf);
    expect(runs.some((r) => r === "bun install" || r.startsWith("bun install "))).toBe(true);
    expect(runs).toContain("bun run typecheck");
    expect(runs.some((r) => r.startsWith("bun test"))).toBe(true);
  });

  test("also runs on pushes to main", () => {
    const wf = loadWorkflow();
    const push = wf.on?.push;
    expect(push).toBeDefined();
    const branches = push && typeof push === "object" ? push.branches : undefined;
    const list = Array.isArray(branches) ? branches : branches ? [branches] : [];
    expect(list).toContain("main");
  });

  test("soak is isolated in a non-required job and excluded from the fast test run (#188)", () => {
    const wf = loadWorkflow();
    const jobs = Object.entries(wf.jobs ?? {});
    // The dedicated soak job runs the soak file directly (its run references
    // test/soak.test.ts but not the `-not -name` exclusion of the fast job).
    const soakJob = jobs.find(([, j]) =>
      (j.steps ?? []).some(
        (s) =>
          typeof s.run === "string" &&
          s.run.includes("test/soak.test.ts") &&
          !s.run.includes("-not -name"),
      ),
    );
    expect(soakJob).toBeDefined();
    expect(soakJob![1]["continue-on-error"]).toBe(true);

    // The fast, required test run explicitly excludes the flaky soak file.
    const runs = runCommands(wf);
    expect(
      runs.some((r) => r.startsWith("bun test") && r.includes("-not -name 'soak.test.ts'")),
    ).toBe(true);
  });
});
