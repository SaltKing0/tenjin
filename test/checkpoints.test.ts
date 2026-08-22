import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  snapshot,
  listCheckpoints,
  restoreFiles,
  restoreConversation,
  restoreBoth,
  DEFAULT_KEEP,
} from "../src/checkpoints/store";
import { runAgentTurn } from "../src/agent/loop";
import { Budget } from "../src/agent/budget";
import { writeTool } from "../src/tools/write";
import type { ChatMessage, ChatResponse, ChatRequest, Provider, StreamCallbacks } from "../src/provider/types";

let root: string;
let project: string;
let store: string;

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], {
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function write(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(p, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "stealth-checkpoints-"));
  project = join(root, "project");
  store = join(root, "shadow");
  mkdirSync(project, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("snapshot / list", () => {
  test("creates checkpoints at prompt AND edit boundaries, ordered newest-first", () => {
    write(project, "a.txt", "v1");
    snapshot({ storeDir: store, sourceDir: project }, "prompt");
    write(project, "a.txt", "v2");
    snapshot({ storeDir: store, sourceDir: project }, "edit:write");
    const list = listCheckpoints(store);
    expect(list.length).toBe(2);
    // Newest first.
    expect(list[0]!.label).toBe("edit:write");
    expect(list[1]!.label).toBe("prompt");
    expect(list[0]!.seq).toBeGreaterThan(list[1]!.seq);
  });

  test("includes untracked files in the snapshot", () => {
    write(project, "untracked-new.txt", "brand new");
    snapshot({ storeDir: store, sourceDir: project }, "edit:write");
    const list = listCheckpoints(store);
    const sha = list[0]!.sha;
    const content = git(store, ["show", `${sha}:untracked-new.txt`]);
    expect(content.ok).toBe(true);
    expect(content.out).toBe("brand new");
  });

  test("never touches the user repo's git history", () => {
    // Turn the project into its own git repo with one commit.
    git(project, ["init", "-q"]);
    git(project, ["add", "-A"]);
    git(project, ["commit", "-q", "-m", "initial"]);
    const beforeHead = git(project, ["rev-parse", "HEAD"]).out;
    const beforeCount = git(project, ["rev-list", "--count", "HEAD"]).out;

    snapshot({ storeDir: store, sourceDir: project }, "prompt");
    write(project, "a.txt", "v3");
    snapshot({ storeDir: store, sourceDir: project }, "edit:write");

    const afterHead = git(project, ["rev-parse", "HEAD"]).out;
    const afterCount = git(project, ["rev-list", "--count", "HEAD"]).out;
    expect(afterHead).toBe(beforeHead);
    expect(afterCount).toBe(beforeCount);
  });
});

describe("three-way restore", () => {
  test("restoreFiles reverts file bytes while leaving the log", () => {
    // Establish a stable checkpoint state (log captured at prompt time).
    write(project, "code.ts", "const a = 1;");
    writeFileSync(join(root, "session.log"), "conversation at prompt");
    const cp = snapshot({ storeDir: store, sourceDir: project, logPath: join(root, "session.log") }, "prompt");

    // Mutate after the checkpoint.
    write(project, "code.ts", "const a = 2; // BROKEN");
    writeFileSync(join(root, "session.log"), "conversation after edit");

    restoreFiles(store, project, cp!.seq);
    expect(readFileSync(join(project, "code.ts"), "utf8")).toBe("const a = 1;");
    // Conversation log untouched by files-restore.
    expect(readFileSync(join(root, "session.log"), "utf8")).toBe("conversation after edit");
  });

  test("restoreConversation rolls the log back while leaving code", () => {
    write(project, "code.ts", "const b = 9;");
    writeFileSync(join(root, "session.log"), "early reasoning");
    const cp = snapshot({ storeDir: store, sourceDir: project, logPath: join(root, "session.log") }, "prompt");

    write(project, "code.ts", "const b = 99;");
    writeFileSync(join(root, "session.log"), "late reasoning");

    restoreConversation(store, join(root, "session.log"), cp!.seq);
    expect(readFileSync(join(root, "session.log"), "utf8")).toBe("early reasoning");
    // Code untouched by conversation-restore.
    expect(readFileSync(join(project, "code.ts"), "utf8")).toBe("const b = 99;");
  });

  test("restoreBoth reverts code and log (full rewind)", () => {
    write(project, "code.ts", "const c = 1;");
    writeFileSync(join(root, "session.log"), "point A");
    const cp = snapshot({ storeDir: store, sourceDir: project, logPath: join(root, "session.log") }, "prompt");

    write(project, "code.ts", "const c = 2;");
    writeFileSync(join(root, "session.log"), "point B");

    restoreBoth(store, project, join(root, "session.log"), cp!.seq);
    expect(readFileSync(join(project, "code.ts"), "utf8")).toBe("const c = 1;");
    expect(readFileSync(join(root, "session.log"), "utf8")).toBe("point A");
  });
});

describe("durability + eviction", () => {
  test("checkpoint list survives a simulated session restart", () => {
    // A brand-new store handle on the same directory sees prior checkpoints.
    const fresh = listCheckpoints(store);
    expect(fresh.length).toBeGreaterThan(0);
    // Re-initialize (as a restarted process would) — still readable.
    expect(existsSync(join(store, ".git"))).toBe(true);
  });

  test("over keep checkpoints: oldest evicted, newest kept", () => {
    const evictStore = join(root, "shadow-evict");
    const evictProject = join(root, "project-evict");
    mkdirSync(evictProject, { recursive: true });
    const keep = 100;
    for (let i = 1; i <= keep + 15; i++) {
      write(evictProject, "f.txt", `content ${i}`);
      snapshot({ storeDir: evictStore, sourceDir: evictProject, keep }, `cp-${i}`);
    }
    const list = listCheckpoints(evictStore);
    expect(list.length).toBe(keep);
    // Newest are retained, oldest evicted.
    expect(list[0]!.label).toBe(`cp-${keep + 15}`);
    const seqs = list.map((c) => c.seq).sort((a, b) => a - b);
    expect(seqs[0]).toBe(16); // 1..15 evicted
    expect(seqs[seqs.length - 1]).toBe(keep + 15);
    expect(DEFAULT_KEEP).toBe(100);
  });
});

describe("loop integration (B13-6)", () => {
  function mockProvider(script: ChatResponse[]): Provider {
    let i = 0;
    return {
      name: "mock",
      async chat(_req: ChatRequest, _cb?: StreamCallbacks) {
        const next = script[i++];
        if (!next) throw new Error("script exhausted");
        return next;
      },
    };
  }
  const endTurn = (text: string): ChatResponse => ({
    stopReason: "end_turn",
    content: [{ type: "text", text }],
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  function gitShow(storeDir: string, sha: string, path: string): string | null {
    const r = spawnSync("git", ["-C", storeDir, "show", `${sha}:${path}`], {
      encoding: "utf8",
    });
    return r.status === 0 ? (r.stdout ?? "") : null;
  }

  test("snapshots at the prompt boundary AND before the edit tool, with correct contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stealth-cp-loop-"));
    try {
      const proj = join(dir, "proj");
      const st = join(dir, "shadow");
      mkdirSync(proj, { recursive: true });
      write(proj, "before.txt", "pre-existing");

      const provider = mockProvider([
        {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "w1",
              name: "write_file",
              input: { path: "edited.txt", content: "brand new content" },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        endTurn("done"),
      ]);
      const messages: ChatMessage[] = [{ role: "user", content: "make a file" }];

      await runAgentTurn({
        provider,
        model: "m",
        system: "sys",
        tools: [writeTool],
        messages,
        maxTokens: 1024,
        cwd: proj,
        approve: async () => true,
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
        checkpoints: { storeDir: st, sourceDir: proj },
      });

      const list = listCheckpoints(st);
      const labels = list.map((c) => c.label);
      expect(labels).toContain("prompt");
      expect(labels).toContain("edit:write_file");

      // Boundary semantics: the edit checkpoint is taken BEFORE the edit runs,
      // so neither snapshot contains the not-yet-created file; the edit one is
      // strictly newer than the prompt one; and the live project got the file
      // (i.e. the edit executed AFTER its pre-edit checkpoint).
      const editCp = list.find((c) => c.label === "edit:write_file");
      const promptCp = list.find((c) => c.label === "prompt");
      expect(editCp).toBeDefined();
      expect(promptCp).toBeDefined();
      expect(editCp!.seq).toBeGreaterThan(promptCp!.seq);
      expect(gitShow(st, editCp!.sha, "edited.txt")).toBeNull();
      expect(gitShow(st, promptCp!.sha, "edited.txt")).toBeNull();
      expect(gitShow(st, promptCp!.sha, "before.txt")).toBe("pre-existing");
      // The write ran after its checkpoint: the live file now exists.
      expect(readFileSync(join(proj, "edited.txt"), "utf8")).toBe("brand new content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkpoint tool", () => {
  test("lists checkpoints and restores files / conversation / both through the tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stealth-cp-tool-"));
    try {
      const proj = join(dir, "proj");
      const st = join(dir, "shadow");
      const log = join(dir, "session.log");
      mkdirSync(proj, { recursive: true });
      write(proj, "code.ts", "const x = 1;");
      writeFileSync(log, "reasoning A");
      const cp = snapshot({ storeDir: st, sourceDir: proj, logPath: log }, "prompt");

      write(proj, "code.ts", "const x = 2;");
      writeFileSync(log, "reasoning B");

      const tool = (await import("../src/tools/checkpoint")).createCheckpointTool({
        storeDir: st,
        sourceDir: proj,
        logPath: log,
      });

      const listing = await tool.handler({ action: "list" }, {} as never);
      expect(listing).toContain("#1");
      expect(listing).toContain("prompt");

      // files restore
      await tool.handler({ action: "restore", mode: "files", ref: String(cp!.seq) }, {} as never);
      expect(readFileSync(join(proj, "code.ts"), "utf8")).toBe("const x = 1;");
      expect(readFileSync(log, "utf8")).toBe("reasoning B"); // untouched

      // conversation restore
      await tool.handler({ action: "restore", mode: "conversation", ref: String(cp!.seq) }, {} as never);
      expect(readFileSync(log, "utf8")).toBe("reasoning A");

      // both restore (full rewind)
      write(proj, "code.ts", "const x = 3;");
      writeFileSync(log, "reasoning C");
      await tool.handler({ action: "restore", mode: "both", ref: String(cp!.seq) }, {} as never);
      expect(readFileSync(join(proj, "code.ts"), "utf8")).toBe("const x = 1;");
      expect(readFileSync(log, "utf8")).toBe("reasoning A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unknown action and unknown restore mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stealth-cp-toolbad-"));
    try {
      const tool = (await import("../src/tools/checkpoint")).createCheckpointTool({
        storeDir: join(dir, "shadow"),
        sourceDir: join(dir, "proj"),
      });
      await expect(tool.handler({ action: "bogus" }, {} as never)).rejects.toThrow(/action/i);
      await expect(
        tool.handler({ action: "restore", mode: "bogus", ref: "1" }, {} as never),
      ).rejects.toThrow(/mode/i);
      await expect(tool.handler({ action: "restore", ref: "" }, {} as never)).rejects.toThrow(/ref/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
