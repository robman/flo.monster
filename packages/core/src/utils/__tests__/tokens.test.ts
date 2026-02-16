import { describe, it, expect } from 'vitest';
import type { TokenUsage } from '../../types/messages.js';
import { accumulateUsage } from '../tokens.js';

describe('accumulateUsage', () => {
  it('sums input and output tokens', () => {
    const current = { input_tokens: 100, output_tokens: 50 };
    const delta = { input_tokens: 200, output_tokens: 30 };
    const result = accumulateUsage(current, delta);
    expect(result.input_tokens).toBe(300);
    expect(result.output_tokens).toBe(80);
  });

  it('keeps cache fields undefined when both are undefined', () => {
    const current = { input_tokens: 10, output_tokens: 5 };
    const delta = { input_tokens: 20, output_tokens: 10 };
    const result = accumulateUsage(current, delta);
    expect(result.cache_creation_input_tokens).toBeUndefined();
    expect(result.cache_read_input_tokens).toBeUndefined();
  });

  it('sets cache field when only current has it', () => {
    const current = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100 };
    const delta = { input_tokens: 20, output_tokens: 10 };
    const result = accumulateUsage(current, delta);
    expect(result.cache_creation_input_tokens).toBe(100);
    expect(result.cache_read_input_tokens).toBeUndefined();
  });

  it('sets cache field when only delta has it', () => {
    const current = { input_tokens: 10, output_tokens: 5 };
    const delta = { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 50 };
    const result = accumulateUsage(current, delta);
    expect(result.cache_read_input_tokens).toBe(50);
    expect(result.cache_creation_input_tokens).toBeUndefined();
  });

  it('sums cache fields when both have them', () => {
    const current = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
    };
    const delta = {
      input_tokens: 20,
      output_tokens: 10,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 75,
    };
    const result = accumulateUsage(current, delta);
    expect(result.cache_creation_input_tokens).toBe(150);
    expect(result.cache_read_input_tokens).toBe(275);
  });

  it('handles zero values correctly', () => {
    const current = { input_tokens: 0, output_tokens: 0 };
    const delta = { input_tokens: 0, output_tokens: 0 };
    const result = accumulateUsage(current, delta);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
  });

  it('handles accumulation over multiple calls', () => {
    let total: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    total = accumulateUsage(total, { input_tokens: 100, output_tokens: 50 });
    total = accumulateUsage(total, { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 30 });
    total = accumulateUsage(total, { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 20 });

    expect(total.input_tokens).toBe(350);
    expect(total.output_tokens).toBe(175);
    expect(total.cache_creation_input_tokens).toBe(50);
    expect(total.cache_read_input_tokens).toBeUndefined();
  });

  it('does not mutate the input objects', () => {
    const current = { input_tokens: 10, output_tokens: 5 };
    const delta = { input_tokens: 20, output_tokens: 10 };
    const result = accumulateUsage(current, delta);

    expect(current.input_tokens).toBe(10);
    expect(current.output_tokens).toBe(5);
    expect(delta.input_tokens).toBe(20);
    expect(delta.output_tokens).toBe(10);
    expect(result).not.toBe(current);
    expect(result).not.toBe(delta);
  });
});
