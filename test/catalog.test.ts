import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { botsDir, createBot, listBots, resolveBot } from "../src/bots/profile";
import {
  parseCatalogRef,
  previewCatalogInstall,
  installCatalogPackage,
  publishBotToCatalog,
  searchCatalog,
  scanInstalledBots,
} from "../src/bots/catalog";
import { ConfigError } from "../src/config/types";

let home: string;
let repo: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-cat-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Create a bare git repo (empty catalog) and return its path. */
function makeCatalogRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tj-cat-repo-"));
  rmSync(repo, { recursive: true, force: true });
  const bare = `${repo}.git`;
  spawnSync("git", ["init", "--bare", "-q", bare], { encoding: "utf8" });
  return bare;
}

/** Build a bot with a config + a skill + runtime dirs holding secret-like bytes. */
function buildRichBot(name = "porter"): void {
  createBot(home, name, { soul: `# SOUL — ${name}\n\nI carry things.\n` });
  const root = join(botsDir(home), name);
  writeFileSync(join(root, "config.yaml"), "model: \"openai:gpt-4o-mini\"\nbudgetUSD: 2\n");
  mkdirSync(join(root, "skills", "pocket"), { recursive: true });
  writeFileSync(join(root, "skills", "pocket", "SKILL.md"), "---\nname: pocket\ndescription: small.\n---\ncarry\n");
  // runtime state that must never be published
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "sessions", "s1.json"), "secret-session");
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", "facts.json"), "secret-memory");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "msg.json"), "secret-inbox");
}

describe("catalog ref parsing", () => {
  test("splits <repo>/<name> on the last slash", () => {
    expect(parseCatalogRef("ghuser/bots/porter")).toEqual({ repo: "ghuser/bots", name: "porter" });
    expect(parseCatalogRef("C:/bots/porter")).toEqual({ repo: "C:/bots", name: "porter" });
  });
  test("rejects refs without a name", () => {
    expect(() => parseCatalogRef("porter")).toThrow(ConfigError);
    expect(() => parseCatalogRef("repo/")).toThrow(ConfigError);
  });
});

describe("bot publish → install roundtrip (local git repo)", () => {
  test("publish to a catalog then install from it produces a functional bot", () => {
    buildRichBot();
    repo = makeCatalogRepo();
    const pub = publishBotToCatalog(home, "porter", repo, { push: true });

    // published file set carries the portable content
    expect(pub.files).toContain("SOUL.md");
    expect(pub.files).toContain("config.yaml");
    expect(pub.files.some((f) => f.startsWith("skills/"))).toBe(true);
    // never secrets / runtime state
    expect(pub.files.some((f) => f.startsWith("sessions"))).toBe(false);
    expect(pub.files.some((f) => f.startsWith("memory"))).toBe(false);
    expect(pub.files.some((f) => f.startsWith("inbox"))).toBe(false);

    // install into a home WITHOUT the bot
    const home2 = mkdtempSync(join(tmpdir(), "tj-cat2-"));
    try {
      const ref = parseCatalogRef(`${repo}/porter`);
      const { preview, cleanup, repoDir } = previewCatalogInstall(home2, ref);
      expect(preview.name).toBe("porter");
      expect(preview.files).toContain("SOUL.md");
      expect(preview.files).toContain("config.yaml");
      const res = installCatalogPackage(home2, repoDir, ref.name, cleanup);
      expect(res.name).toBe("porter");
      expect(listBots(home2)).toEqual(["porter"]);
      const profile = resolveBot(home2, "porter");
      expect(profile.soulText).toContain("I carry things.");
      expect(profile.config.model).toBe("openai:gpt-4o-mini");
      // skill present; runtime dirs NOT restored
      expect(existsSync(join(botsDir(home2), "porter", "skills", "pocket", "SKILL.md"))).toBe(true);
      expect(existsSync(join(botsDir(home2), "porter", "sessions"))).toBe(false);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test("secret bytes never reach the catalog archive", () => {
    buildRichBot();
    repo = makeCatalogRepo();
    publishBotToCatalog(home, "porter", repo, { push: true });

    // clone the catalog and scan every committed blob for secret bytes
    const clone = mkdtempSync(join(tmpdir(), "tj-cat-clone-"));
    spawnSync("git", ["clone", "-q", repo, join(clone, "c")], { encoding: "utf8" });
    try {
      const scan = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of readdirSync(dir)) {
          const abs = join(dir, entry);
          if (statSync(abs).isDirectory()) out.push(...scan(abs));
          else out.push(readFileSync(abs, "utf8"));
        }
        return out;
      };
      const all = scan(join(clone, "c")).join("\n");
      expect(all).not.toContain("secret-session");
      expect(all).not.toContain("secret-memory");
      expect(all).not.toContain("secret-inbox");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("catalog search", () => {
  test("lists published packages and filters by query", () => {
    buildRichBot("porter");
    buildRichBot("courier");
    repo = makeCatalogRepo();
    publishBotToCatalog(home, "porter", repo, { push: true });
    publishBotToCatalog(home, "courier", repo, { push: true });

    const all = searchCatalog(repo);
    expect(all.map((p) => p.name).sort()).toEqual(["courier", "porter"]);
    const filtered = searchCatalog(repo, "port");
    expect(filtered.map((p) => p.name)).toEqual(["porter"]);
  });
});

describe("boot scan (#34 pattern)", () => {
  test("reports broken installed bots with path + reason", () => {
    createBot(home, "good");
    expect(scanInstalledBots(home).ok).toContain("good");
    expect(scanInstalledBots(home).broken).toEqual([]);

    createBot(home, "broken");
    writeFileSync(join(botsDir(home), "broken", "config.yaml"), "model: \"nope:model\"\n");
    const { ok, broken } = scanInstalledBots(home);
    expect(ok).toContain("good");
    expect(broken).toHaveLength(1);
    const b = broken[0]!;
    expect(b.name).toBe("broken");
    expect(b.dir).toBe(join(botsDir(home), "broken"));
    expect(b.reason.length).toBeGreaterThan(0);
  });
});

describe("catalog install validation", () => {
  test("preview throws when the package is missing", () => {
    repo = makeCatalogRepo();
    buildRichBot();
    publishBotToCatalog(home, "porter", repo, { push: true });
    const home2 = mkdtempSync(join(tmpdir(), "tj-cat3-"));
    try {
      expect(() =>
        previewCatalogInstall(home2, parseCatalogRef(`${repo}/ghost`)),
      ).toThrow(ConfigError);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});
