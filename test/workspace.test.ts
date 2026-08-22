import { describe, test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  LocalWorkspace,
  DockerWorkspace,
  RemoteWorkspace,
  createWorkspace,
  ttlGC,
  trackContainer,
  untrackContainer,
  type DockerRunner,
} from "../src/sandbox/workspace";
import { ConfigError } from "../src/config/types";

/**
 * B12-3 (#424): workspace abstraction Local→Docker→Remote behind one contract
 * {mount, execute, exec}. Local is the reference implementation; Docker is a
 * per-session context manager with GUARANTEED stop+rm (even on crash paths) and
 * orphan TTL GC; Remote is a stubbed interface. Zero deps — docker is driven
 * via the CLI, injected as a fake runner here.
 */

/** Records every docker invocation; simulates the CLI for the happy path. */
function fakeDocker(calls: string[][], execThrows = false): DockerRunner {
  return (argv) => {
    calls.push(argv);
    if (argv[0] === "run") return { exitCode: 0, stdout: "container-abc\n", stderr: "" };
    if (argv[0] === "exec" && execThrows) throw new Error("simulated exec failure");
    if (argv[0] === "exec") return { exitCode: 0, stdout: "hello\n", stderr: "" };
    if (argv[0] === "cp") return { exitCode: 0, stdout: "", stderr: "" };
    if (argv[0] === "stop") return { exitCode: 0, stdout: "", stderr: "" };
    if (argv[0] === "rm") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

afterEach(() => {
  // Never leak tracked containers across tests.
  untrackContainer("tenjin-test-t1");
  untrackContainer("tenjin-test-orphan");
  untrackContainer("tenjin-test-fresh");
});

describe("LocalWorkspace — reference implementation satisfies the full contract", () => {
  test("execute runs argv and returns a structured result", async () => {
    const ws = new LocalWorkspace();
    const res = await ws.execute(["echo", "local works"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("local works");
  });

  test("exec is equivalent to execute for local", async () => {
    const ws = new LocalWorkspace();
    const a = await ws.execute(["printf", "x"]);
    const b = await ws.exec(["printf", "x"]);
    expect(a).toEqual(b);
  });

  test("mount is a no-op (host paths are the workspace)", async () => {
    const ws = new LocalWorkspace();
    await expect(ws.mount({ hostPath: "/tmp", containerPath: "/tmp" })).resolves.toBeUndefined();
    await expect(ws.close()).resolves.toBeUndefined();
  });

  test("non-zero exit does NOT throw — caller inspects exitCode", async () => {
    const ws = new LocalWorkspace();
    const res = await ws.execute(["sh", "-c", "exit 7"]);
    expect(res.exitCode).toBe(7);
  });
});

describe("DockerWorkspace — lifecycle (mocked docker)", () => {
  test("spawn -> execute -> stop+rm in order, hardened run flags", async () => {
    const calls: string[][] = [];
    const ws = new DockerWorkspace({ name: "tenjin-test-t1", run: fakeDocker(calls) });

    const res = await ws.execute(["echo", "hi"]);
    expect(res.stdout).toContain("hello");
    await ws.close();

    const flat = calls.map((c) => c[0]).join(",");
    expect(flat).toBe("run,exec,stop,rm");
    expect(calls[0]![0]).toBe("run");
    // Rootless hardening defaults (B12-4).
    const runArgs = calls[0]!.join(" ");
    expect(runArgs).toContain("--cap-drop=ALL");
    expect(runArgs).toContain("--read-only");
    expect(runArgs).toContain("--user 1000:1000");
    expect(runArgs).toContain("--workdir /workspace");
    expect(runArgs).toContain("sleep infinity");
  });

  test("stop+rm are GUARANTEED even when execute throws mid-session", async () => {
    const calls: string[][] = [];
    const ws = new DockerWorkspace({ name: "tenjin-test-t1", run: fakeDocker(calls, true) });

    await expect(ws.execute(["explode"])).rejects.toThrow("simulated exec failure");
    // close must still stop+rm the container started earlier.
    await expect(ws.close()).resolves.toBeUndefined();

    const flat = calls.map((c) => c[0]).join(",");
    expect(flat).toBe("run,exec,stop,rm");
  });

  test("close is idempotent — second close is a no-op", async () => {
    const calls: string[][] = [];
    const ws = new DockerWorkspace({ name: "tenjin-test-t1", run: fakeDocker(calls) });
    await ws.execute(["echo", "x"]);
    await ws.close();
    await ws.close();
    expect(calls.filter((c) => c[0] === "stop")).toHaveLength(1);
  });

  test("mount copies a path into the container", async () => {
    const calls: string[][] = [];
    const ws = new DockerWorkspace({ name: "tenjin-test-t1", run: fakeDocker(calls) });
    await ws.mount({ hostPath: "/tmp/a", containerPath: "/workspace/a" });
    await ws.close();
    expect(calls.some((c) => c[0] === "cp")).toBe(true);
  });
});

describe("TTL GC — orphaned containers past their deadline are removed", () => {
  test("removes only containers older than the TTL", async () => {
    const calls: string[][] = [];
    const run: DockerRunner = (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const base = 1_000_000;
    trackContainer("tenjin-test-orphan", base);
    trackContainer("tenjin-test-fresh", base + 100);

    const removed = ttlGC({ ttlMs: 100, now: base + 150, run });
    expect(removed).toEqual(["tenjin-test-orphan"]);
    expect(calls).toEqual([["rm", "-f", "tenjin-test-orphan"]]);
    // The fresh container (now - at < ttl) is left alone: a second GC pass at
    // the same deadline removes nothing further.
    expect(ttlGC({ ttlMs: 100, now: base + 150, run })).toEqual([]);
  });

  test("does nothing when nothing is past the deadline", () => {
    const calls: string[][] = [];
    const run: DockerRunner = (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    trackContainer("tenjin-test-fresh", 1_000_000);
    const removed = ttlGC({ ttlMs: 1000, now: 1_000_500, run });
    expect(removed).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("createWorkspace — config switch", () => {
  test("defaults to local", () => {
    expect(createWorkspace().mode).toBe("local");
    expect(createWorkspace({}).mode).toBe("local");
  });

  test("selects each implementation by mode", () => {
    expect(createWorkspace({ mode: "local" })).toBeInstanceOf(LocalWorkspace);
    const calls: string[][] = [];
    expect(createWorkspace({ mode: "docker", docker: { run: fakeDocker(calls) } })).toBeInstanceOf(DockerWorkspace);
    expect(createWorkspace({ mode: "remote" })).toBeInstanceOf(RemoteWorkspace);
  });

  test("unknown mode is a clean ConfigError", () => {
    expect(() => createWorkspace({ mode: "bogus" as never })).toThrow(ConfigError);
    expect(() => createWorkspace({ mode: "bogus" as never })).toThrow(/Unknown workspace mode/);
  });
});

describe("RemoteWorkspace — stubbed interface", () => {
  test("any real call throws a clear 'not wired' error", async () => {
    const ws = new RemoteWorkspace();
    await expect(ws.execute(["echo", "x"])).rejects.toThrow(/stubbed/);
    await expect(ws.mount({ hostPath: "/a", containerPath: "/b" })).rejects.toThrow(/stubbed/);
    // close is safe.
    await expect(ws.close()).resolves.toBeUndefined();
  });
});

// ---- Gated integration test: requires a real docker daemon ----
function dockerAvailable(): boolean {
  try {
    const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
    });
    return r.error === undefined && r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

test.skipIf(!dockerAvailable())(
  "integration: real docker run executes and cleans up (gated)",
  async () => {
    const ws = new DockerWorkspace({
      name: `tenjin-424-${process.pid}-${Date.now()}`,
      image: "alpine",
    });
    try {
      const res = await ws.execute(["echo", "integration-ok"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("integration-ok");
    } finally {
      await ws.close();
    }
  },
);
