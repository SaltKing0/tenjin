import { describe, test, expect } from "bun:test";
import { Budget, pricingFor, formatUSD } from "../src/agent/budget";

describe("pricingFor", () => {
  test("known model prefixes map to pricing", () => {
    expect(pricingFor("claude-opus-4-20250514")).toEqual({
      inputPerMTok: 15,
      outputPerMTok: 75,
    });
    expect(pricingFor("claude-sonnet-4-5")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(pricingFor("deepseek-chat")).toEqual({ inputPerMTok: 0.27, outputPerMTok: 1.1 });
  });

  test("more specific prefixes win (gpt-4o-mini before gpt-4o)", () => {
    expect(pricingFor("gpt-4o-mini").inputPerMTok).toBe(0.15);
    expect(pricingFor("gpt-4o").inputPerMTok).toBe(2.5);
  });

  test("matching is case-insensitive", () => {
    expect(pricingFor("Claude-Sonnet-4")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  test("unknown model prices at zero (tokens still tracked)", () => {
    expect(pricingFor("mystery-model-v9")).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  test("explicit override beats the table", () => {
    expect(pricingFor("anything", { inputPerMTok: 1, outputPerMTok: 2 })).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 2,
    });
  });
});

describe("Budget", () => {
  const pricing = { inputPerMTok: 3, outputPerMTok: 15 };

  test("add computes cost from usage and accumulates", () => {
    const b = new Budget(10, pricing);
    const c1 = b.add({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(c1).toBeCloseTo(3);
    const c2 = b.add({ inputTokens: 0, outputTokens: 100_000 });
    expect(c2).toBeCloseTo(1.5);
    expect(b.spentUSD).toBeCloseTo(4.5);
  });

  test("not exhausted below cap", () => {
    const b = new Budget(5, pricing);
    b.add({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(b.exhausted).toBe(false);
  });

  test("exhausted at cap", () => {
    const b = new Budget(3, pricing);
    b.add({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(b.exhausted).toBe(true);
  });

  test("capUSD of 0 means unlimited — never exhausted", () => {
    const b = new Budget(0, pricing);
    b.add({ inputTokens: 999_999_999, outputTokens: 999_999_999 });
    expect(b.exhausted).toBe(false);
  });
});

describe("formatUSD", () => {
  test("zero formats as $0", () => {
    expect(formatUSD(0)).toBe("$0");
  });

  test("sub-cent amounts show four decimals", () => {
    expect(formatUSD(0.0042)).toBe("$0.0042");
  });

  test("normal amounts show two decimals", () => {
    expect(formatUSD(1.5)).toBe("$1.50");
    expect(formatUSD(12.345)).toBe("$12.35");
  });
});
