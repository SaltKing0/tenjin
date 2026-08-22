import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeTokenEmbedding,
  runGoldenSet,
  formatDiffReport,
  type GoldenSet,
} from "../src/memory/retrieval-gate";

const root = process.cwd();
const corpusPath = join(root, "test/fixtures/retrieval/corpus.md");
const goldenPath = join(root, "test/fixtures/retrieval/golden-set.json");

function loadGoldenSet(): GoldenSet {
  return JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenSet;
}

function loadCorpus(): string {
  return readFileSync(corpusPath, "utf8");
}

/**
 * Build the deterministic token-frequency vocabulary from the corpus so the
 * vector path runs with a stable, content-aware embedder in CI (no model).
 */
function corpusEmbedder(corpusText: string): (text: string) => number[] {
  const vocab = [...new Set(corpusText.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean))].sort();
  return makeTokenEmbedding(vocab);
}

describe("B9-15 retrieval CI golden set", () => {
  test("every golden query retrieves its expected chunks above the thresholds", () => {
    const set = loadGoldenSet();
    const corpusText = loadCorpus();
    const report = runGoldenSet(set, { corpusText, embed: corpusEmbedder(corpusText) });

    const reportText = formatDiffReport(report);
    // eslint-disable-next-line no-console
    console.log(`\n${reportText}\n`);

    // Structural integrity: every expected chunk id must exist in the corpus.
    for (const e of report.entries) {
      expect(e.missingFromIndex, `expected chunk missing from corpus for "${e.id}"`).toEqual([]);
    }
    // No query may fall below any threshold — else the build must fail loudly.
    expect(report.thresholdBreach, `golden-set regression:\n${reportText}`).toBe(false);
  });
});
