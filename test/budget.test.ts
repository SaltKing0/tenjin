import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  Budget,
  createBudget,
  pricingFor,
  formatUSD,
  DEFAULT_PRICING,
  resetUnknownModelWarnings,
} from "../src/agent/budget";

beforeEach(() => {
  resetUnknownModelWarnings();
});

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

  test("unknown model uses built-in default pricing (not zero)", () => {
    expect(pricingFor("mystery-model-v9")).toEqual(DEFAULT_PRICING);
  });

  test("unknown model uses configured default when provided", () => {
    expect(
      pricingFor("mystery-model-v9", undefined, { inputPerMTok: 1.5, outputPerMTok: 6 }),
    ).toEqual({ inputPerMTok: 1.5, outputPerMTok: 6 });
  });

  test("explicit override beats the table and the default", () => {
    expect(pricingFor("anything", { inputPerMTok: 1, outputPerMTok: 2 })).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 2,
    });
    expect(
      pricingFor("mystery-model-v9", { inputPerMTok: 9, outputPerMTok: 9 }, DEFAULT_PRICING),
    ).toEqual({ inputPerMTok: 9, outputPerMTok: 9 });
  });

  test("unknown model warns once", () => {
    const warn = spyOn(console, "warn");
    pricingFor("mystery-model-v9");
    pricingFor("mystery-model-v9");
    pricingFor("MYSTERY-MODEL-V9");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/unknown model "mystery-model-v9"/);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/pricing\.default/);
    warn.mockRestore();
  });
});

describe("Budget", () => {
  const pricing = { inputPerMTok: 3, outputPerMTok: 15 };

  test("add computes cost from usage and accumulates", () => {
    const b = new Budget(10, pricing);
    const c1 = b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "m");
    expect(c1).toBeCloseTo(3);
    const c2 = b.add({ inputTokens: 0, outputTokens: 100_000 }, "m");
    expect(c2).toBeCloseTo(1.5);
    expect(b.spentUSD).toBeCloseTo(4.5);
  });

  test("pricing resolved per model on each add", () => {
    const b = new Budget(1000);
    const cheap = b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "gpt-4o-mini");
    const dear = b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "claude-opus-4");
    expect(cheap).toBeCloseTo(0.15);
    expect(dear).toBeCloseTo(15);
    expect(b.spentUSD).toBeCloseTo(15.15);
  });

  test("breakdown sorts models by spend descending", () => {
    const b = new Budget(0);
    b.add({ inputTokens: 100_000, outputTokens: 0 }, "claude-opus-4");
    b.add({ inputTokens: 5_000_000, outputTokens: 0 }, "gpt-4o-mini");
    b.add({ inputTokens: 200_000, outputTokens: 0 }, "claude-opus-4");
    const bd = b.breakdown();
    expect(bd.map((e) => e.model)).toEqual(["claude-opus-4", "gpt-4o-mini"]);
    expect(bd[0]?.usd).toBeCloseTo(4.5);
    expect(bd[1]?.usd).toBeCloseTo(0.75);
  });

  test("not exhausted below cap", () => {
    const b = new Budget(5, pricing);
    b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "m");
    expect(b.exhausted).toBe(false);
  });

  test("exhausted at cap", () => {
    const b = new Budget(3, pricing);
    b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "m");
    expect(b.exhausted).toBe(true);
  });

  test("capUSD of 0 means unlimited — never exhausted", () => {
    const b = new Budget(0, pricing);
    b.add({ inputTokens: 999_999_999, outputTokens: 999_999_999 }, "m");
    expect(b.exhausted).toBe(false);
  });

  test("unknown model uses default price so the cap actually bites", () => {
    const b = createBudget(5, {
      default: { inputPerMTok: 5, outputPerMTok: 15 },
    });
    b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "local-llama-3");
    expect(b.spentUSD).toBeCloseTo(5);
    expect(b.exhausted).toBe(true);
  });

  test("unknown model with built-in default is not free", () => {
    const b = new Budget(1);
    const cost = b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "mystery-model-v9");
    expect(cost).toBeCloseTo(DEFAULT_PRICING.inputPerMTok);
    expect(b.exhausted).toBe(true);
  });

  test("createBudget full override still prices every model the same", () => {
    const b = createBudget(100, { inputPerMTok: 1, outputPerMTok: 2 });
    const known = b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "claude-sonnet-4-5");
    const unknown = b.add({ inputTokens: 1_000_000, outputTokens: 0 }, "mystery-model-v9");
    expect(known).toBeCloseTo(1);
    expect(unknown).toBeCloseTo(1);
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
