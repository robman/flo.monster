import { describe, it, expect } from 'vitest';
import { calculateCost, estimateCostForModel } from '../cost-utils.js';
import { MODEL_PRICING } from '../../data/model-pricing.js';
import type { TokenUsage } from '../../types/messages.js';
import type { ModelInfo } from '../../types/provider.js';

describe('calculateCost', () => {
  const basicPricing: ModelInfo['pricing'] = {
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
  };

  const cachePricing: ModelInfo['pricing'] = {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheCreationPerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  };

  it('calculates basic input and output cost', () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
    const cost = calculateCost(usage, basicPricing);

    expect(cost.inputCost).toBeCloseTo(0.0025);  // 1000/1M * 2.5
    expect(cost.outputCost).toBeCloseTo(0.005);   // 500/1M * 10.0
    expect(cost.totalCost).toBeCloseTo(0.0075);
    expect(cost.currency).toBe('USD');
  });

  it('handles zero tokens', () => {
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    const cost = calculateCost(usage, basicPricing);

    expect(cost.inputCost).toBe(0);
    expect(cost.outputCost).toBe(0);
    expect(cost.totalCost).toBe(0);
  });

  it('includes cache creation costs when present', () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
    };
    const cost = calculateCost(usage, cachePricing);

    // inputCost = (1000/1M * 3.0) + (200/1M * 3.75) = 0.003 + 0.00075 = 0.00375
    // outputCost = 500/1M * 15.0 = 0.0075
    // total = 0.00375 + 0.0075 = 0.01125
    expect(cost.inputCost).toBeCloseTo(0.00375);
    expect(cost.outputCost).toBeCloseTo(0.0075);
    expect(cost.totalCost).toBeCloseTo(0.01125);
  });

  it('includes cache read costs when present', () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 300,
    };
    const cost = calculateCost(usage, cachePricing);

    // inputCost = (1000/1M * 3.0) + (300/1M * 0.3) = 0.003 + 0.00009 = 0.00309
    // outputCost = 500/1M * 15.0 = 0.0075
    expect(cost.inputCost).toBeCloseTo(0.00309);
    expect(cost.totalCost).toBeCloseTo(0.01059);
  });

  it('includes both cache creation and read costs', () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    };
    const cost = calculateCost(usage, cachePricing);

    // inputCost = (1000/1M * 3.0) + (200/1M * 3.75) + (300/1M * 0.3)
    //           = 0.003 + 0.00075 + 0.00009 = 0.00384
    // outputCost = 500/1M * 15.0 = 0.0075
    expect(cost.inputCost).toBeCloseTo(0.00384);
    expect(cost.totalCost).toBeCloseTo(0.01134);
  });

  it('ignores cache tokens when pricing has no cache rates', () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    };
    const cost = calculateCost(usage, basicPricing);

    // Should be same as basic: no cache pricing fields
    expect(cost.inputCost).toBeCloseTo(0.0025);
    expect(cost.outputCost).toBeCloseTo(0.005);
    expect(cost.totalCost).toBeCloseTo(0.0075);
  });

  it('handles large token counts', () => {
    const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 500_000 };
    const cost = calculateCost(usage, basicPricing);

    expect(cost.inputCost).toBeCloseTo(2.5);
    expect(cost.outputCost).toBeCloseTo(5.0);
    expect(cost.totalCost).toBeCloseTo(7.5);
  });

  it('always returns currency USD', () => {
    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    const cost = calculateCost(usage, basicPricing);
    expect(cost.currency).toBe('USD');
  });
});

describe('estimateCostForModel', () => {
  it('calculates cost using centralized model pricing', () => {
    const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 100_000 };
    const cost = estimateCostForModel('claude-sonnet-4-6', usage);
    // Sonnet 4.6: $3/MTok input, $15/MTok output
    expect(cost.inputCost).toBeCloseTo(3.0);
    expect(cost.outputCost).toBeCloseTo(1.5);
    expect(cost.totalCost).toBeCloseTo(4.5);
  });

  it('returns zero cost for unknown models', () => {
    const usage: TokenUsage = { input_tokens: 1000, output_tokens: 500 };
    const cost = estimateCostForModel('unknown-model', usage);
    expect(cost.totalCost).toBe(0);
  });

  it('resolves model aliases', () => {
    // claude-sonnet-4-5-20251101 aliases to claude-sonnet-4-5-20250929
    const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    const cost = estimateCostForModel('claude-sonnet-4-5-20251101', usage);
    expect(cost.inputCost).toBeCloseTo(3.0); // Sonnet 4.5: $3/MTok input
  });
});

describe('MODEL_PRICING validation', () => {
  it('has all required fields for every model', () => {
    for (const [id, model] of Object.entries(MODEL_PRICING)) {
      expect(model.id).toBe(id);
      expect(model.displayName).toBeTruthy();
      expect(model.provider).toBeTruthy();
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
      expect(model.pricing.inputPerMillion).toBeGreaterThan(0);
      expect(model.pricing.outputPerMillion).toBeGreaterThan(0);
    }
  });

  it('has models for all three providers', () => {
    const providers = new Set(Object.values(MODEL_PRICING).map(m => m.provider));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('gemini')).toBe(true);
  });
});
