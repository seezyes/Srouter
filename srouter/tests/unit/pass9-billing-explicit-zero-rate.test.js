// Pass9 billing repair — an explicit numeric zero cached/reasoning/cache-creation
// rate is a real tariff ("this token class is not billed at the input/output
// rate") and must be honored. The previous `||` fallback treated 0 as missing and
// silently charged the class at the input/output rate.
//
// The expected charge is computed independently from the rate table, never from a
// vendor tariff or another tree.
import { describe, expect, it } from "vitest";
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";

const TOKENS = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  cached_tokens: 300,
  cache_creation_input_tokens: 100,
  reasoning_tokens: 20,
};

function expectedCharge(rates) {
  const nonCachedInput = TOKENS.prompt_tokens - TOKENS.cached_tokens - TOKENS.cache_creation_input_tokens;
  return (
    nonCachedInput * rates.input +
    TOKENS.completion_tokens * rates.output +
    TOKENS.cached_tokens * rates.cached +
    TOKENS.cache_creation_input_tokens * rates.cache_creation +
    TOKENS.reasoning_tokens * rates.reasoning
  ) / 1_000_000;
}

describe("pass9 billing explicit-zero rate", () => {
  for (const zero of ["cached", "reasoning", "cache_creation"]) {
    it(`honors an explicit zero ${zero} rate`, () => {
      const rates = { input: 1, output: 2, cached: 0.1, reasoning: 3, cache_creation: 1.2, [zero]: 0 };
      expect(calculateCostFromTokens(TOKENS, rates)).toBeCloseTo(expectedCharge(rates), 12);
      // A zero rate must not fall back to the input/output rate.
      const fallback = zero === "cached" ? rates.input : zero === "reasoning" ? rates.output : rates.input;
      expect(calculateCostFromTokens(TOKENS, rates)).not.toBeCloseTo(
        (expectedCharge({ ...rates, [zero]: fallback })), 12,
      );
    });
  }

  it("still falls back when a rate is null/undefined (not an explicit zero)", () => {
    const base = { input: 1, output: 2, cached: 0.1, reasoning: 3, cache_creation: 1.2 };
    const fallbacks = { ...base, cached: base.input, reasoning: base.output, cache_creation: base.input };
    expect(calculateCostFromTokens(TOKENS, { ...base, cached: undefined, reasoning: undefined, cache_creation: undefined }))
      .toBeCloseTo(expectedCharge(fallbacks), 12);
    expect(calculateCostFromTokens(TOKENS, { ...base, cached: null, reasoning: null, cache_creation: null }))
      .toBeCloseTo(expectedCharge(fallbacks), 12);
  });

  it("keeps ordinary non-zero rates unchanged", () => {
    const rates = { input: 3, output: 15, cached: 0.3, reasoning: 15, cache_creation: 3.75 };
    expect(calculateCostFromTokens(TOKENS, rates)).toBeCloseTo(expectedCharge(rates), 12);
  });

  it("returns 0 for a fully zero rate table", () => {
    expect(calculateCostFromTokens(TOKENS, { input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0 })).toBe(0);
  });
});
