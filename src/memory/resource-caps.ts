import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

// ===========================================================================
// B3-5 Resource caps + log rotation (#417)
// ---------------------------------------------------------------------------
// Long-running gateway processes must degrade gracefully instead of growing
// without bound. This module provides the reusable, testable primitives:
//
//   1. CappedStore   — bounded in-memory registry with recency-window
//                      eviction (results inside the protected window are kept,
//                      older entries are evicted oldest-first).
//   2. LogRotator    — audit/session log rotation by SIZE and COUNT (rotate
//                      when the active log crosses maxBytes; keep at most
//                      maxFiles total files).
//   3. MemoryLogTail — bounded in-RAM tail: never holds full history.
//   4. Degradation   — progressive degradation under memory/budget pressure:
//                      shed verbose logging FIRST, then cache depth; the core
//                      loop keeps working.
//
// All pure logic is clock-injectable so it is fully unit-testable headlessly.
// ===========================================================================

// ---- 1. Capped in-memory store with recency-window eviction ---------------

export interface CappedStoreOptions {
  /** Hard cap on entries. */
  maxEntries: number;
  /** Protected recency window (ms): entries last seen within this window of
   *  "now" are never evicted while older ones remain. Default 0 = plain
   *  oldest-first eviction. */
  recencyWindowMs?: number;
  /** Injectable clock (ms epoch). Default Date.now. */
  now?: () => number;
}

interface Slot<V> {
  value: V;
  lastSeen: number;
}

/**
 * Bounded key→value store. When over `maxEntries` it evicts oldest-first
 * (by last access): entries outside the protected recency window first; if all
 * entries are still inside the window, the oldest overall. Every get/set
 * refreshes an entry's recency. Keeps results in the protected window, evicts
 * the rest.
 */
export class CappedStore<K, V> {
  private slots = new Map<K, Slot<V>>();
  private readonly maxEntries: number;
  private readonly recencyWindowMs: number;
  private readonly now: () => number;

  constructor(opts: CappedStoreOptions) {
    this.maxEntries = opts.maxEntries;
    this.recencyWindowMs = opts.recencyWindowMs ?? 0;
    this.now = opts.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    slot.lastSeen = this.now(); // access refreshes recency
    return slot.value;
  }

  has(key: K): boolean {
    return this.slots.has(key);
  }

  set(key: K, value: V): void {
    this.slots.set(key, { value, lastSeen: this.now() });
    if (this.slots.size > this.maxEntries) this.evict();
  }

  get size(): number {
    return this.slots.size;
  }

  keys(): K[] {
    return [...this.slots.keys()];
  }

  private evict(): void {
    const t = this.now();
    const cutoff = t - this.recencyWindowMs;
    // Candidates: entries older than the protected recency window.
    const candidates = [...this.slots.entries()]
      .filter(([, s]) => s.lastSeen < cutoff)
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    let excess = this.slots.size - this.maxEntries;
    for (const [key] of candidates) {
      if (excess <= 0) break;
      this.slots.delete(key);
      excess--;
    }
    // Still over (everything protected): evict oldest overall.
    if (this.slots.size > this.maxEntries) {
      const all = [...this.slots.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      let remaining = this.slots.size - this.maxEntries;
      for (const [key] of all) {
        if (remaining <= 0) break;
        this.slots.delete(key);
        remaining--;
      }
    }
  }
}

// ---- 2. Log rotation by size and count ------------------------------------

/** A rotated log file's index: `.1` is the most recent rotation. */
export function rotatedLogName(activeName: string, index: number): string {
  return `${activeName}.${index}`;
}

/**
 * Pure rotation plan: given the active log's size and the current rotated-file
 * set, decide the next layout. Returns the next rotated-file list (index 1 =
 * newest) after rotation, or null when no rotation is needed. Used by
 * {@link LogRotator} and unit-testable without touching the filesystem.
 */
export function rotationPlan(args: {
  activeBytes: number;
  maxBytes: number;
  maxFiles: number;
  rotatedNames: string[];
  activeName: string;
}): string[] | null {
  if (args.activeBytes <= args.maxBytes) return null;
  // New rotation: the current active becomes the newest rotated file.
  const next = [args.activeName, ...args.rotatedNames];
  // Keep at most maxFiles - 1 rotated files (maxFiles total incl. active).
  const cap = Math.max(0, args.maxFiles - 1);
  return next.slice(0, cap);
}

/**
 * Filesystem-backed log rotation for a single active log in a directory.
 * rotate() renames the active file to `.1`, shifts older rotations up, and
 * drops any beyond the count cap. Returns the number of files now on disk.
 */
export class LogRotator {
  constructor(
    private readonly dir: string,
    private readonly activeName: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {}

  get activePath(): string {
    return join(this.dir, this.activeName);
  }

  private rotatedPath(index: number): string {
    return join(this.dir, rotatedLogName(this.activeName, index));
  }

  private activeBytes(): number {
    const p = this.activePath;
    if (!existsSync(p)) return 0;
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  }

  private existingRotated(): string[] {
    if (!existsSync(this.dir)) return [];
    const idx: Array<{ i: number; name: string }> = [];
    for (const f of readdirSync(this.dir)) {
      const m = new RegExp(`^${this.activeName}\\.(\\d+)$`).exec(f);
      if (m) idx.push({ i: Number(m[1]), name: f });
    }
    return idx.sort((a, b) => a.i - b.i).map((x) => x.name);
  }

  /** True when the active log exceeds the size threshold. */
  needsRotation(): boolean {
    return this.activeBytes() > this.maxBytes;
  }

  /** Rotate when over the size threshold. Returns true when a rotation ran. */
  rotate(): boolean {
    mkdirSync(this.dir, { recursive: true });
    const plan = rotationPlan({
      activeBytes: this.activeBytes(),
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      rotatedNames: this.existingRotated(),
      activeName: this.activeName,
    });
    if (!plan) return false;

    // Drop any rotated file that no longer fits the plan (beyond the cap).
    const keep = new Set(plan);
    for (const name of this.existingRotated()) {
      if (!keep.has(name)) {
        try {
          rmSync(join(this.dir, name), { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    // Shift existing rotations up by one index (newest first).
    const names = plan.slice(1); // plan[0] is the current active
    for (let i = names.length - 1; i >= 0; i--) {
      const from = rotatedLogName(this.activeName, i + 1);
      const to = rotatedLogName(this.activeName, i + 2);
      if (existsSync(join(this.dir, from))) {
        try {
          renameSync(join(this.dir, from), join(this.dir, to));
        } catch {
          /* best-effort */
        }
      }
    }
    // The active becomes the newest rotation.
    try {
      renameSync(this.activePath, join(this.dir, rotatedLogName(this.activeName, 1)));
    } catch {
      /* best-effort */
    }
    return true;
  }

  /** Number of rotated files currently on disk. */
  rotatedCount(): number {
    return this.existingRotated().length;
  }
}

// ---- 3. Bounded in-memory log tail ----------------------------------------

/**
 * In-RAM tail of a log that never exceeds `maxItems` — the tail keeps only the
 * most recent entries and drops the oldest on overflow, so sustained writes
 * never grow memory without bound.
 */
export class MemoryLogTail<T> {
  private items: T[] = [];
  constructor(private readonly maxItems: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxItems) this.items.shift();
  }

  get length(): number {
    return this.items.length;
  }

  /** The current tail, oldest-first. */
  get(): T[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

// ---- 4. Progressive degradation -------------------------------------------

export type DegradationLevel = "normal" | "shed-verbose" | "shed-cache-depth" | "core-only";

export interface ResourcePressure {
  /** Used / budget memory ratio (0..1). */
  memoryRatio: number;
  /** Used / budget spend ratio (0..1). */
  budgetRatio: number;
}

/** Map raw pressure to a degradation level. Verbose logging is shed before
 *  cache depth, and the core loop is the last thing ever degraded. */
export function degradationLevel(pressure: ResourcePressure): DegradationLevel {
  if (pressure.memoryRatio >= 0.9 || pressure.budgetRatio >= 0.9) return "core-only";
  if (pressure.memoryRatio >= 0.7 || pressure.budgetRatio >= 0.8) return "shed-cache-depth";
  if (pressure.memoryRatio >= 0.5 || pressure.budgetRatio >= 0.6) return "shed-verbose";
  return "normal";
}

export type DegradableFeature = "verbose-log" | "cache-depth" | "core";

/**
 * Which features survive at a given degradation level. Asserted by the test to
 * guarantee ORDER: verbose logging is shed first, then cache depth; core
 * functionality is the last to be shed (it only goes at "core-only").
 */
export function featureEnabled(level: DegradationLevel, feature: DegradableFeature): boolean {
  switch (level) {
    case "normal":
      return true;
    case "shed-verbose":
      return feature !== "verbose-log";
    case "shed-cache-depth":
      return feature !== "verbose-log" && feature !== "cache-depth";
    case "core-only":
      return feature === "core";
  }
}
