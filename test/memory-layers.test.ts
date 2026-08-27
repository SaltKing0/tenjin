import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LAYER_ORDER,
  writeEntry,
  readLayer,
  resolveEntry,
  buildInjection,
  buildWorkspaceInjection,
  readWorkspaceUserLayer,
  buildLayeredMemory,
  PROFILE_MAX_CHARS,
  MEMORY_MAX_BYTES,
  MEMORY_MAX_LINES,
  writeDailyNote,
  readDailyNote,
  listDailyNotes,
  importToQuarantine,
  quarantinePath,
} from "../src/memory/layers";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stealth-layers-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("layer precedence", () => {
  test("same key at multiple layers resolves managed > user > project > local", () => {
    writeEntry(dir, "local", "theme", "local value");
    writeEntry(dir, "project", "theme", "project value");
    writeEntry(dir, "user", "theme", "user value");
    writeEntry(dir, "managed", "theme", "managed value");

    expect(resolveEntry(dir, "theme")).toEqual({ layer: "managed", content: "managed value" });

    // Removing the higher-precedence layer exposes the next one down.
    writeEntry(dir, "managed", "theme", "");
    expect(resolveEntry(dir, "theme")).toEqual({ layer: "user", content: "user value" });
  });

  test("missing key resolves to null", () => {
    expect(resolveEntry(dir, "does-not-exist")).toBeNull();
  });

  test("LAYER_ORDER encodes the precedence chain", () => {
    expect(LAYER_ORDER).toEqual(["managed", "user", "project", "local"]);
  });

  test("readLayer surfaces only the entries of that layer", () => {
    const local = readLayer(dir, "local");
    expect(local.get("theme")).toBe("local value");
    expect(local.has("managed-only")).toBe(false);
  });
});

describe("daily notes are indexed, not injected", () => {
  test("daily note is absent from per-turn injection", () => {
    writeEntry(dir, "user", "stable", "long-term fact");
    writeDailyNote(dir, "2026-08-22", "this is a dated note that must not be injected");

    const inj = buildInjection(dir);
    expect(inj.text).toContain("long-term fact");
    expect(inj.text).not.toContain("must not be injected");
  });

  test("daily notes are readable and indexable by date", () => {
    writeDailyNote(dir, "2026-08-21", "older note");
    writeDailyNote(dir, "2026-08-22", "newer note");
    expect(readDailyNote(dir, "2026-08-22")).toBe("newer note");
    const all = listDailyNotes(dir).map((n) => n.date);
    expect(all).toContain("2026-08-21");
    expect(all).toContain("2026-08-22");
  });
});

describe("quarantine imports stay isolated", () => {
  test("import lands in quarantine scope and leaves existing layers unchanged", () => {
    writeEntry(dir, "user", "own", "my own fact");
    const before = readLayer(dir, "user");
    expect(before.get("own")).toBe("my own fact");

    const res = importToQuarantine(dir, "foreign-profile", {
      own: "foreign override",
      "new-key": "brand new",
    });

    expect(res.written.length).toBe(2);
    // Existing user layer untouched — no merge.
    expect(readLayer(dir, "user").get("own")).toBe("my own fact");
    // Quarantine value must NOT resolve through the normal precedence chain.
    expect(resolveEntry(dir, "own")).toEqual({ layer: "user", content: "my own fact" });
    // But the import is on disk, isolated.
    expect(existsSync(quarantinePath(dir, "foreign-profile", "new-key"))).toBe(true);
  });
});

describe("injection caps", () => {
  test("profile (managed layer) capped at ~2k chars", () => {
    writeEntry(dir, "managed", "big", "x".repeat(PROFILE_MAX_CHARS + 5000));
    const inj = buildInjection(dir);
    expect(inj.profile!.length).toBeLessThanOrEqual(PROFILE_MAX_CHARS);
  });

  test("MEMORY.md (user layer) capped at 25 KiB / 200 lines", () => {
    writeEntry(dir, "user", "huge", "y".repeat(MEMORY_MAX_BYTES + 50_000));
    const inj = buildInjection(dir);
    expect(inj.memory!.length).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    expect(inj.memory!.split("\n").length).toBeLessThanOrEqual(MEMORY_MAX_LINES);
  });

  test("caps are exported as stable constants", () => {
    expect(PROFILE_MAX_CHARS).toBe(2000);
    expect(MEMORY_MAX_BYTES).toBe(25 * 1024);
    expect(MEMORY_MAX_LINES).toBe(200);
  });
});

describe("learning toggle", () => {
  test("toggle off writes nowhere", () => {
    expect(writeEntry(dir, "user", "off", "nope", { learningEnabled: false })).toBe(false);
    expect(readLayer(dir, "user").has("off")).toBe(false);

    expect(writeDailyNote(dir, "2026-08-23", "off-note", { learningEnabled: false })).toBeNull();
    expect(readDailyNote(dir, "2026-08-23")).toBeNull();

    const res = importToQuarantine(dir, "off-scope", { k: "v" }, { learningEnabled: false });
    expect(res.written.length).toBe(0);
    expect(res.skipped.length).toBe(1);
  });

  test("writing an empty key file is treated as absent (deletable)", () => {
    writeEntry(dir, "user", "gone", "text");
    expect(resolveEntry(dir, "gone")).not.toBeNull();
    writeEntry(dir, "user", "gone", "");
    expect(resolveEntry(dir, "gone")).toBeNull();
  });
});

describe("workspace-convention adapter (B9-9 → #460)", () => {
  let ws: string;
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "stealth-ws-layers-"));
  });
  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  test("readWorkspaceUserLayer maps USER.md → user and MEMORY.md → memory", () => {
    writeFileSync(join(ws, "USER.md"), "Alice prefers German.\n", "utf8");
    writeFileSync(join(ws, "MEMORY.md"), "Long-term fact.\n", "utf8");
    const layer = readWorkspaceUserLayer(ws);
    expect(layer.get("user")).toContain("German");
    expect(layer.get("memory")).toContain("Long-term fact");
  });

  test("buildWorkspaceInjection combines managed + USER/MEMORY with labels", () => {
    mkdirSync(join(ws, "managed"), { recursive: true });
    writeFileSync(join(ws, "managed", "tone.md"), "Be direct.\n", "utf8");
    const inj = buildWorkspaceInjection(ws);
    expect(inj.text).toContain("# Profile (managed)");
    expect(inj.text).toContain("Be direct.");
    expect(inj.text).toContain("# Memory (user)");
    expect(inj.text).toContain("Long-term fact");
    expect(inj.injectedKeys).toContain("user");
    expect(inj.injectedKeys).toContain("memory");
  });

  test("buildLayeredMemory is gated on memory.layers.enabled", () => {
    // disabled → null even with content present
    expect(buildLayeredMemory(ws, {})).toBeNull();
    expect(buildLayeredMemory(ws, { layers: { enabled: false } })).toBeNull();
    // enabled + content → text
    const t = buildLayeredMemory(ws, { layers: { enabled: true } });
    expect(t).toContain("Long-term fact");
  });

  test("buildLayeredMemory returns null when enabled but files are empty", () => {
    const empty = mkdtempSync(join(tmpdir(), "stealth-ws-empty-"));
    try {
      writeFileSync(join(empty, "USER.md"), "   \n", "utf8");
      expect(buildLayeredMemory(empty, { layers: { enabled: true } })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
