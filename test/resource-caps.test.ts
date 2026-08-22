import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CappedStore,
  LogRotator,
  rotationPlan,
  MemoryLogTail,
  degradationLevel,
  featureEnabled,
} from "../src/memory/resource-caps";

describe("B3-5 CappedStore eviction (oldest-first + recency window)", () => {
  test("registry over cap evicts oldest-first", () => {
    const store = new CappedStore<string, number>({ maxEntries: 3 });
    store.set("A", 1);
    store.set("B", 2);
    store.set("C", 3);
    store.set("D", 4);
    store.set("E", 5);
    expect(store.size).toBe(3);
    expect(store.keys()).toEqual(["C", "D", "E"]);
    expect(store.has("A")).toBe(false);
    expect(store.has("B")).toBe(false);
  });

  test("recency window protects recent entries; older are evicted first", () => {
    let clock = 0;
    const now = () => clock;
    const store = new CappedStore<string, number>({ maxEntries: 2, recencyWindowMs: 150, now });
    clock = 0;
    store.set("A", 1);
    clock = 100;
    store.set("B", 2);
    clock = 200;
    store.set("C", 3); // over cap; cutoff=50 -> A (lastSeen 0) evicted, B protected
    expect(store.has("A")).toBe(false);
    expect(store.keys().sort()).toEqual(["B", "C"]);
    clock = 500;
    store.set("D", 4); // cutoff=350 -> B (lastSeen 100) and C (200) both old; oldest first
    expect(store.keys().sort()).toEqual(["C", "D"]);
  });
});

describe("B3-5 log rotation (size threshold + count cap)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tj-rot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rotation triggers at the size threshold and file count respects the cap", () => {
    writeFileSync(join(dir, "app.log"), "x".repeat(1000));
    const rot = new LogRotator(dir, "app.log", 500, 3); // maxBytes 500, maxFiles 3
    expect(rot.needsRotation()).toBe(true);
    expect(rot.rotate()).toBe(true);
    expect(existsSync(join(dir, "app.log.1"))).toBe(true);
    expect(rot.rotatedCount()).toBe(1);

    writeFileSync(join(dir, "app.log"), "y".repeat(1000));
    expect(rot.rotate()).toBe(true);
    expect(rot.rotatedCount()).toBe(2);

    // Third rotation stays within the cap (maxFiles-1 rotated = 2).
    writeFileSync(join(dir, "app.log"), "z".repeat(1000));
    expect(rot.rotate()).toBe(true);
    expect(rot.rotatedCount()).toBe(2);
    expect(existsSync(join(dir, "app.log.3"))).toBe(false); // beyond cap dropped

    // A small active log does not rotate.
    writeFileSync(join(dir, "app.log"), "short");
    expect(rot.needsRotation()).toBe(false);
    expect(rot.rotate()).toBe(false);
  });

  test("rotationPlan pure function caps the count", () => {
    expect(
      rotationPlan({
        activeBytes: 100,
        maxBytes: 50,
        maxFiles: 3,
        rotatedNames: ["a.1", "a.2", "a.3"],
        activeName: "a",
      }),
    ).toEqual(["a", "a.1"]);
    expect(
      rotationPlan({ activeBytes: 10, maxBytes: 50, maxFiles: 3, rotatedNames: [], activeName: "a" }),
    ).toBeNull();
  });
});

describe("B3-5 MemoryLogTail stays bounded under sustained writes", () => {
  test("the in-memory tail never exceeds its bound", () => {
    const tail = new MemoryLogTail<number>(50);
    for (let i = 0; i < 1000; i++) {
      tail.push(i);
      expect(tail.length).toBeLessThanOrEqual(50);
    }
    expect(tail.length).toBe(50);
    // Keeps only the most recent entries.
    expect(tail.get()[0]).toBe(950);
    expect(tail.get()[49]).toBe(999);
  });
});

describe("B3-5 progressive degradation order", () => {
  test("verbose logging is shed before cache depth before core", () => {
    // Ascending pressure maps to escalating degradation.
    expect(degradationLevel({ memoryRatio: 0.3, budgetRatio: 0.3 })).toBe("normal");
    expect(degradationLevel({ memoryRatio: 0.6, budgetRatio: 0.3 })).toBe("shed-verbose");
    expect(degradationLevel({ memoryRatio: 0.8, budgetRatio: 0.3 })).toBe("shed-cache-depth");
    expect(degradationLevel({ memoryRatio: 0.95, budgetRatio: 0.3 })).toBe("core-only");
    expect(degradationLevel({ memoryRatio: 0.3, budgetRatio: 0.7 })).toBe("shed-verbose");
    expect(degradationLevel({ memoryRatio: 0.3, budgetRatio: 0.85 })).toBe("shed-cache-depth");
  });

  test("feature gating sheds verbose first and never drops core until core-only", () => {
    expect(featureEnabled("shed-verbose", "verbose-log")).toBe(false);
    expect(featureEnabled("shed-verbose", "cache-depth")).toBe(true);
    expect(featureEnabled("shed-verbose", "core")).toBe(true);

    expect(featureEnabled("shed-cache-depth", "cache-depth")).toBe(false);
    expect(featureEnabled("shed-cache-depth", "core")).toBe(true);

    expect(featureEnabled("core-only", "core")).toBe(true);
    expect(featureEnabled("core-only", "cache-depth")).toBe(false);
    expect(featureEnabled("core-only", "verbose-log")).toBe(false);

    // Core survives at every level above core-only.
    for (const l of ["normal", "shed-verbose", "shed-cache-depth"] as const) {
      expect(featureEnabled(l, "core")).toBe(true);
    }
  });
});
