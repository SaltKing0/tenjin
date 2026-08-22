import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeFact,
  readFacts,
  queryFacts,
  citationFor,
  type FactInput,
} from "../src/memory/facts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-facts-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function base(over: Partial<FactInput> = {}): FactInput {
  return {
    type: "convention",
    tags: ["project"],
    date: "2026-08-22",
    sourceId: "doc-a",
    validFrom: "2026-01-01",
    validTo: null,
    text: "the rule",
    ...over,
  };
}

describe("B9-4 fact lifecycle (validity window + supersede)", () => {
  test("supersede flags the old fact expired but keeps it retrievable within its window", () => {
    const a = writeFact(home, base({ sourceId: "doc-a", text: "old rule" }));
    const b = writeFact(home, {
      ...base({ sourceId: "doc-b", text: "new rule" }),
      validFrom: "2026-03-01",
      supersedes: a.id,
    });

    // At "now" (well after the switch), the old fact is expired but NOT dropped.
    const nowHits = queryFacts(home);
    const oldAtNow = nowHits.find((h) => h.fact.id === a.id);
    expect(oldAtNow).toBeTruthy();
    expect(oldAtNow!.status).toBe("expired");
    expect(nowHits.find((h) => h.fact.id === b.id)!.status).toBe("active");

    // The old fact is still retrievable WITH its (clamped) window.
    const inWindow = queryFacts(home, { referenceTime: "2026-02-15" });
    const oldInWindow = inWindow.find((h) => h.fact.id === a.id);
    expect(oldInWindow).toBeTruthy();
    expect(oldInWindow!.status).toBe("active");
    // Its stored window was clamped to end where the successor begins.
    expect(oldAtNow!.fact.validTo).toBe("2026-03-01");
  });
});

describe("B9-4 temporal query (reference-time regression)", () => {
  test("returns exactly the fact valid AT reference-time T, not the latest validFrom", () => {
    writeFact(home, {
      ...base({ type: "config", sourceId: "doc-a", text: "early config" }),
      validFrom: "2026-01-01",
      validTo: "2026-06-01",
    });
    writeFact(home, {
      ...base({ type: "config", sourceId: "doc-b", text: "later config" }),
      validFrom: "2026-03-01",
      validTo: null,
    });

    // T sits between the two validFroms: the EARLIER-starting fact is the one
    // valid AT T. A naive "ORDER BY validFrom DESC" would wrongly pick
    // "later config" here — the 41%-failure class.
    const atT = queryFacts(home, { referenceTime: "2026-02-15", type: "config" });
    expect(atT.filter((h) => h.status === "active").map((h) => h.fact.text)).toEqual([
      "early config",
    ]);
  });
});

describe("B9-4 mandatory validity window", () => {
  test("missing validFrom is rejected at write with a field-specific error", () => {
    const { validFrom: _omit, ...rest } = base();
    expect(() => writeFact(home, rest as FactInput)).toThrow(/validFrom/);
  });

  test("missing validTo is rejected at write with a field-specific error", () => {
    const { validTo: _omit, ...rest } = base();
    expect(() => writeFact(home, rest as FactInput)).toThrow(/validTo/);
  });

  test("explicit null validTo is an allowed open end", () => {
    expect(() => writeFact(home, base({ validTo: null }))).not.toThrow();
    const read = readFacts(home)[0]!;
    expect(read.validTo).toBeNull();
  });
});

describe("B9-4 recency decay (stale flagged, not dropped)", () => {
  test("stale facts (valid_to in the past) rank below active ones and stay retrievable", () => {
    writeFact(home, {
      ...base({ sourceId: "doc-a", text: "stale" }),
      validFrom: "2026-01-01",
      validTo: "2026-02-01",
    });
    writeFact(home, {
      ...base({ sourceId: "doc-b", text: "current" }),
      validFrom: "2026-05-01",
      validTo: null,
    });

    const hits = queryFacts(home, { referenceTime: "2026-06-01" });
    // Active first, then expired — stale is ranked below, not dropped.
    expect(hits.map((h) => h.fact.text)).toEqual(["current", "stale"]);
    expect(hits.find((h) => h.fact.text === "stale")!.status).toBe("expired");
  });
});

describe("B9-4 provenance round-trip", () => {
  test("sourceId survives the file round-trip and feeds citations (pairs with B9-14)", () => {
    const w = writeFact(home, base({ sourceId: "chunk-42", text: "the answer" }));
    const read = readFacts(home).find((f) => f.id === w.id)!;
    expect(read.sourceId).toBe("chunk-42");
    const cite = citationFor(read);
    expect(cite).toContain("chunk-42");
    expect(cite).toContain(read.id);
  });
});
